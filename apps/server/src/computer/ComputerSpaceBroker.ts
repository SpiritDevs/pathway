/**
 * Task reservations of existing, user-designated macOS Spaces.
 *
 * @module computer/ComputerSpaceBroker
 */
import type {
  ComputerSpace,
  ComputerSpaceErrorCode,
  ComputerSpaceInventory,
  ComputerSpaceReservation,
  ComputerWindow,
} from "@spiritdevs/contracts";
import * as Effect from "effect/Effect";

import { ComputerSpaceError, type ComputerOperationError } from "./computerErrors.ts";

export interface ComputerSpaceOwner {
  readonly threadId: string;
  readonly turnId: string | null;
}

export interface ComputerSpaceSnapshot {
  readonly inventory: ComputerSpaceInventory;
  readonly windows: readonly ComputerWindow[];
}

export interface ComputerSpaceBrokerOptions {
  /** Reads the managed-Space inventory and the current windows together. */
  readonly readSnapshot: Effect.Effect<ComputerSpaceSnapshot, ComputerOperationError>;
  /** Fails once the calling desktop operation has been cancelled. */
  readonly assertActive: Effect.Effect<void, ComputerOperationError>;
}

/**
 * Reserves an existing user-designated Space for one Pathway task. It never
 * creates, moves, activates or destroys a native Space/window. Every guarded
 * action rechecks native identity and current-Space membership; a reservation
 * invalidated by user intervention stays invalid until explicitly replaced.
 */
export interface ComputerSpaceBroker {
  /** The current inventory, narrowed to one Space and its windows when `spaceId` is given. */
  readonly inspect: (
    spaceId?: number,
  ) => Effect.Effect<ComputerSpaceSnapshot, ComputerOperationError>;
  readonly reservationFor: (owner: ComputerSpaceOwner) => ComputerSpaceReservation | null;
  /**
   * Reserves `spaceId` for the owner, optionally selecting one of its windows.
   * `recheckDesignation` re-reads the user's designation after the desktop
   * read so a revocation during that read wins.
   */
  readonly reserve: (
    owner: ComputerSpaceOwner,
    spaceId: number,
    userDesignatedSpaceIds: readonly number[],
    windowId?: string,
    recheckDesignation?: Effect.Effect<boolean, ComputerOperationError>,
  ) => Effect.Effect<ComputerSpaceReservation, ComputerOperationError>;
  readonly select: (
    owner: ComputerSpaceOwner,
    windowId: string,
  ) => Effect.Effect<ComputerSpaceReservation, ComputerOperationError>;
  /** Drops the thread's reservation (only `turnId`'s, when given) and fences pending reserves. */
  readonly release: (threadId: string, turnId?: string) => void;
  readonly assertNativeLaunchAllowed: (
    threadId: string | undefined,
  ) => Effect.Effect<void, ComputerSpaceError>;
  readonly assertForegroundAllowed: (
    threadId: string | undefined,
  ) => Effect.Effect<void, ComputerSpaceError>;
  readonly assertTargetBound: (
    threadId: string | undefined,
    windowId: string | undefined,
  ) => Effect.Effect<void, ComputerSpaceError>;
  /** Application-wide side effects cannot be confined to one selected window. */
  readonly assertAppMutationAllowed: (
    owner: ComputerSpaceOwner,
    pid: number,
  ) => Effect.Effect<void, ComputerOperationError>;
  /** Called on the resolved exact window before native input admission. Idle cost is zero. */
  readonly assertWindowAllowed: (
    owner: ComputerSpaceOwner,
    window: ComputerWindow,
  ) => Effect.Effect<void, ComputerOperationError>;
  readonly dispose: () => void;
}

const MAX_RESERVATIONS = 64;

function sameOwner(reservation: ComputerSpaceReservation, owner: ComputerSpaceOwner): boolean {
  return reservation.threadId === owner.threadId && reservation.turnId === owner.turnId;
}

const refuse = (code: ComputerSpaceErrorCode, message: string) =>
  Effect.fail(new ComputerSpaceError(code, message));

export function makeComputerSpaceBroker(options: ComputerSpaceBrokerOptions): ComputerSpaceBroker {
  const reservations = new Map<string, ComputerSpaceReservation>();
  let revision = 0;
  let disposed = false;

  const snapshot = Effect.gen(function* () {
    yield* options.assertActive;
    if (disposed) {
      return yield* refuse("computer_space_reservation_changed", "The Space broker has closed.");
    }
    const value = yield* options.readSnapshot;
    yield* options.assertActive;
    if (disposed) {
      return yield* refuse(
        "computer_space_reservation_changed",
        "The Space broker closed while reading the desktop.",
      );
    }
    return value;
  });

  const assertUnchanged = (expected: number) =>
    Effect.suspend(() =>
      revision === expected
        ? Effect.void
        : refuse(
            "computer_space_reservation_changed",
            "Space reservations changed while reading the desktop. Observe the current reservation before continuing.",
          ),
    );

  const findSpace = (inventory: ComputerSpaceInventory, id: number) => {
    const matches = inventory.spaces.filter((space) => space.id === id);
    return matches.length === 1
      ? Effect.succeed(matches[0]!)
      : refuse(
          "computer_space_not_found",
          "That Space is absent or ambiguous in the current managed-display inventory. List Spaces again.",
        );
  };

  const reservableSpace = (inventory: ComputerSpaceInventory, id: number) =>
    Effect.flatMap(
      findSpace(inventory, id),
      (space): Effect.Effect<ComputerSpace & { readonly uuid: string }, ComputerSpaceError> => {
        if (space.current === true) {
          return refuse(
            "computer_space_current",
            "The user is currently on this Space. Pathway will not reserve or switch it. Choose an existing noncurrent Space explicitly designated by the user.",
          );
        }
        if (
          !inventory.complete ||
          space.current === null ||
          !space.uuid ||
          space.kind !== "desktop"
        ) {
          return refuse(
            "computer_space_identity_unproven",
            "This Space has incomplete identity, current-state information or unsupported fullscreen behavior. It cannot be reserved safely.",
          );
        }
        return Effect.succeed({ ...space, uuid: space.uuid });
      },
    );

  const exactWindow = (
    value: ComputerSpaceSnapshot,
    id: string,
    spaceId: number,
  ): Effect.Effect<ComputerWindow & { readonly pid: number }, ComputerSpaceError> => {
    const window = value.windows.find((candidate) => candidate.id === id);
    if (
      !window?.pid ||
      !window.spaceIds ||
      window.spaceIds.length !== 1 ||
      window.onCurrentSpace !== false
    ) {
      return refuse(
        "computer_space_target_membership_unproven",
        "This window's exact noncurrent Space membership is not proven. List windows again; do not switch Spaces as a workaround.",
      );
    }
    if (window.spaceIds[0] !== spaceId || window.currentSpaceId === spaceId) {
      return refuse(
        "computer_space_target_outside_reservation",
        "This window is outside the reserved Space. Select an existing window in that Space; Pathway will not move it there.",
      );
    }
    return Effect.succeed({ ...window, pid: window.pid });
  };

  const reconcile = (inventory: ComputerSpaceInventory): void => {
    for (const [threadId, entry] of reservations) {
      if (entry.invalidReason !== null) continue;
      const matches = inventory.spaces.filter((candidate) => candidate.id === entry.spaceId);
      const space = matches.length === 1 ? matches[0] : undefined;
      const reason =
        space?.current === true
          ? "computer_space_current"
          : !inventory.complete ||
              !space ||
              space.uuid !== entry.spaceUuid ||
              space.displayId !== entry.displayId ||
              space.current !== false
            ? "computer_space_reservation_changed"
            : null;
      if (reason) {
        reservations.set(threadId, { ...entry, invalidReason: reason });
        revision += 1;
      }
    }
  };

  /** Reads the desktop, fails if reservations moved meanwhile, then reconciles. */
  const observe = Effect.gen(function* () {
    const expected = revision;
    const value = yield* snapshot;
    yield* assertUnchanged(expected);
    reconcile(value.inventory);
    return value;
  });

  const reservationFor = (owner: ComputerSpaceOwner): ComputerSpaceReservation | null => {
    const reservation = reservations.get(owner.threadId);
    return reservation && sameOwner(reservation, owner) ? { ...reservation } : null;
  };

  const requireReservation = (owner: ComputerSpaceOwner) =>
    Effect.suspend(() => {
      const reservation = reservationFor(owner);
      if (!reservation) {
        return refuse(
          "computer_space_reservation_required",
          "Reserve an existing noncurrent Space explicitly designated by the user before selecting its windows.",
        );
      }
      if (reservation.invalidReason) {
        return refuse(
          reservation.invalidReason,
          "The reserved Space became current or its identity changed. No input was sent. Inspect Spaces and explicitly reserve a safe target again; Pathway will not move the user away.",
        );
      }
      return Effect.succeed(reservation);
    });

  const inspect = Effect.fn("ComputerSpaceBroker.inspect")(function* (spaceId?: number) {
    const value = yield* snapshot;
    reconcile(value.inventory);
    if (spaceId === undefined) return value;
    yield* findSpace(value.inventory, spaceId);
    return {
      inventory: {
        ...value.inventory,
        spaces: value.inventory.spaces.filter((space) => space.id === spaceId),
      },
      windows: value.windows.filter((window) => window.spaceIds?.includes(spaceId)),
    };
  });

  const reserve = Effect.fn("ComputerSpaceBroker.reserve")(function* (
    owner: ComputerSpaceOwner,
    spaceId: number,
    userDesignatedSpaceIds: readonly number[],
    windowId?: string,
    recheckDesignation?: Effect.Effect<boolean, ComputerOperationError>,
  ) {
    if (!userDesignatedSpaceIds.includes(spaceId)) {
      return yield* refuse(
        "computer_space_not_designated",
        "The user has not designated this existing Space for this task. Ask them to say " +
          `“Use Space ID ${spaceId} for this task.” A tool argument or full access is not that designation.`,
      );
    }
    const value = yield* observe;
    const space = yield* reservableSpace(value.inventory, spaceId);
    const occupied = [...reservations.values()].find(
      (entry) =>
        entry.invalidReason === null && entry.spaceId === spaceId && !sameOwner(entry, owner),
    );
    if (occupied) {
      return yield* refuse(
        "computer_space_reserved",
        "Another Pathway task reserved this Space. Use a different user-designated Space or wait for that task to finish.",
      );
    }
    if (!reservations.has(owner.threadId) && reservations.size >= MAX_RESERVATIONS) {
      return yield* refuse(
        "computer_space_reservation_limit",
        "Too many tasks have Space reservations. Release an unused reservation first.",
      );
    }
    const selected =
      windowId === undefined ? undefined : yield* exactWindow(value, windowId, spaceId);
    const admissionRevision = revision;
    if (recheckDesignation && !(yield* recheckDesignation)) {
      return yield* refuse(
        "computer_space_not_designated",
        "The user's current Space designation changed while reading the desktop. No reservation was created.",
      );
    }
    yield* options.assertActive;
    yield* assertUnchanged(admissionRevision);
    const reservation: ComputerSpaceReservation = {
      threadId: owner.threadId,
      turnId: owner.turnId,
      spaceId,
      spaceUuid: space.uuid,
      displayId: space.displayId,
      selectedWindowId: selected?.id ?? null,
      selectedPid: selected?.pid ?? null,
      invalidReason: null,
    };
    yield* options.assertActive;
    reservations.set(owner.threadId, reservation);
    revision += 1;
    return { ...reservation };
  });

  const select = Effect.fn("ComputerSpaceBroker.select")(function* (
    owner: ComputerSpaceOwner,
    windowId: string,
  ) {
    const value = yield* observe;
    const reservation = yield* requireReservation(owner);
    const window = yield* exactWindow(value, windowId, reservation.spaceId);
    const selected = { ...reservation, selectedWindowId: window.id, selectedPid: window.pid };
    yield* options.assertActive;
    reservations.set(owner.threadId, selected);
    revision += 1;
    return { ...selected };
  });

  const release = (threadId: string, turnId?: string): void => {
    // Fence pending replacements even when an older turn still owns the stored record.
    revision += 1;
    const reservation = reservations.get(threadId);
    if (reservation && turnId !== undefined && reservation.turnId !== turnId) return;
    reservations.delete(threadId);
  };

  const whileReserved = (
    applies: boolean,
    code: "computer_space_operation_unsupported" | "computer_space_window_not_selected",
    message: string,
  ) =>
    Effect.suspend(() => (applies && reservations.size > 0 ? refuse(code, message) : Effect.void));

  const assertNativeLaunchAllowed = (threadId: string | undefined) =>
    whileReserved(
      threadId !== undefined,
      "computer_space_operation_unsupported",
      "This backend cannot launch a native app into the reserved Space. Drive an existing window there in place, or use an isolated headless browser; no app was launched.",
    );

  const assertForegroundAllowed = (threadId: string | undefined) =>
    whileReserved(
      threadId !== undefined,
      "computer_space_operation_unsupported",
      "A foreground excursion or visible browser launch cannot be confined to a reserved Space. Drive the existing window in place or use an isolated headless browser; no desktop was activated.",
    );

  const assertTargetBound = (threadId: string | undefined, windowId: string | undefined) =>
    whileReserved(
      threadId !== undefined && windowId === undefined,
      "computer_space_window_not_selected",
      "While a task holds a Space reservation, native input must name an exact current window. Select an existing window and pass its window_id; unscoped input was not sent.",
    );

  const assertAppMutationAllowed = Effect.fn("ComputerSpaceBroker.assertAppMutationAllowed")(
    function* (owner: ComputerSpaceOwner, pid: number) {
      if (reservations.size === 0) return;
      if (reservations.has(owner.threadId)) {
        return yield* refuse(
          "computer_space_operation_unsupported",
          "Application-wide or window-visibility changes cannot be confined to a reserved Space. Drive the selected existing window in place; no app or window was changed.",
        );
      }
      const value = yield* observe;
      for (const window of value.windows.filter((candidate) => candidate.pid === pid)) {
        const spaceIds = window.spaceIds;
        if (!spaceIds || spaceIds.length === 0) {
          return yield* refuse(
            "computer_space_target_membership_unproven",
            "This application's Space membership is unknown while a task holds a reservation. No application-wide action was sent.",
          );
        }
        if (
          [...reservations.values()].some(
            (entry) => entry.invalidReason === null && spaceIds.includes(entry.spaceId),
          )
        ) {
          return yield* refuse(
            "computer_space_reserved",
            "This application has a window in another task's reserved Space. No application-wide action was sent.",
          );
        }
      }
    },
  );

  const assertWindowAllowed = Effect.fn("ComputerSpaceBroker.assertWindowAllowed")(function* (
    owner: ComputerSpaceOwner,
    window: ComputerWindow,
  ) {
    if (reservations.size === 0) return;
    const value = yield* observe;
    const own = reservations.get(owner.threadId);
    if (own && !sameOwner(own, owner)) {
      return yield* refuse(
        "computer_space_reservation_changed",
        "This Space reservation belongs to another turn. Reserve it again for the current task.",
      );
    }
    if (own) {
      yield* requireReservation(owner);
      const current = yield* exactWindow(value, window.id, own.spaceId);
      if (
        current.pid !== window.pid ||
        current.pid !== own.selectedPid ||
        current.id !== own.selectedWindowId
      ) {
        return yield* refuse(
          "computer_space_window_not_selected",
          "Select this exact current window with computer_spaces before driving it. Space selection does not activate or move the window.",
        );
      }
      return;
    }
    const current = value.windows.find(
      (candidate) => candidate.id === window.id && candidate.pid === window.pid,
    );
    const spaceIds = current?.spaceIds;
    if (!spaceIds || spaceIds.length === 0) {
      return yield* refuse(
        "computer_space_target_membership_unproven",
        "The target's current Space membership is unknown while another task holds a reservation. Read fresh window state before choosing a target.",
      );
    }
    if (
      [...reservations.values()].some(
        (entry) => entry.invalidReason === null && spaceIds.includes(entry.spaceId),
      )
    ) {
      return yield* refuse(
        "computer_space_reserved",
        "This window belongs to a Space reserved by another Pathway task. No input was sent.",
      );
    }
  });

  const dispose = (): void => {
    disposed = true;
    revision += 1;
    reservations.clear();
  };

  return {
    inspect,
    reservationFor,
    reserve,
    select,
    release,
    assertNativeLaunchAllowed,
    assertForegroundAllowed,
    assertTargetBound,
    assertAppMutationAllowed,
    assertWindowAllowed,
    dispose,
  };
}
