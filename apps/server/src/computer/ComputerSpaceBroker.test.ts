import type { ComputerSpaceInventory, ComputerWindow } from "@spiritdevs/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import { type ComputerSpaceSnapshot, makeComputerSpaceBroker } from "./ComputerSpaceBroker.ts";

const owner = { threadId: "a", turnId: "one" };
const other = { threadId: "b", turnId: "two" };
const window: ComputerWindow = {
  id: "cua:10:20",
  title: "Fixture",
  appName: "Fixture",
  pid: 10,
  focused: false,
  visible: false,
  minimized: false,
  spaceIds: [2],
  currentSpaceId: 1,
  onCurrentSpace: false,
};
function inventory(current = 1): ComputerSpaceInventory {
  return {
    source: "macos-managed-spaces",
    complete: true,
    spaces: [1, 2, 3].map((id) => ({
      id,
      uuid: `uuid-${id}`,
      displayId: "display-a",
      kind: "desktop" as const,
      current: id === current,
    })),
  };
}

/**
 * A broker over a settable snapshot. `hold` makes the next read signal
 * `entered` and wait on `gate`, so a test can interleave a concurrent call.
 */
function setup() {
  let snapshot: ComputerSpaceSnapshot = { inventory: inventory(), windows: [window] };
  let reads = 0;
  let held: Effect.Effect<ComputerSpaceSnapshot> | undefined;
  const broker = makeComputerSpaceBroker({
    readSnapshot: Effect.suspend(() => {
      reads += 1;
      const next = held;
      held = undefined;
      return next ?? Effect.sync(() => snapshot);
    }),
    assertActive: Effect.void,
  });
  return {
    broker,
    reads: () => reads,
    set: (value: ComputerSpaceSnapshot) => {
      snapshot = value;
    },
    snapshot: () => snapshot,
    hold: Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const gate = yield* Deferred.make<ComputerSpaceSnapshot>();
      held = Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(gate)));
      return { entered, gate };
    }),
  };
}

describe("ComputerSpaceBroker", () => {
  it.effect("lists native empty Spaces and reserves/selects without any desktop mutation", () =>
    Effect.gen(function* () {
      const { broker } = setup();
      expect((yield* broker.inspect()).inventory.spaces).toHaveLength(3);
      const reservation = yield* broker.reserve(owner, 2, [2], window.id);
      expect(reservation).toMatchObject({
        spaceId: 2,
        selectedWindowId: window.id,
        selectedPid: 10,
      });
      yield* broker.assertWindowAllowed(owner, window);
      expect((yield* broker.inspect(3)).windows).toEqual([]);
    }),
  );

  it.effect("requires user designation before reading or reserving", () =>
    Effect.gen(function* () {
      const { broker, reads } = setup();
      const error = yield* Effect.flip(broker.reserve(owner, 2, [], window.id));
      expect(error).toMatchObject({ code: "computer_space_not_designated" });
      expect(reads()).toBe(0);
    }),
  );

  it.effect("refuses current, unproven and unsupported Space identities", () =>
    Effect.gen(function* () {
      const { broker, set } = setup();
      expect(yield* Effect.flip(broker.reserve(owner, 1, [1]))).toMatchObject({
        code: "computer_space_current",
      });
      for (const patch of [{ uuid: null }, { current: null }, { kind: "fullscreen" as const }]) {
        const value = inventory();
        set({
          inventory: {
            ...value,
            spaces: value.spaces.map((s) => (s.id === 2 ? { ...s, ...patch } : s)),
          },
          windows: [window],
        });
        expect(yield* Effect.flip(broker.reserve(owner, 2, [2]))).toMatchObject({
          code: "computer_space_identity_unproven",
        });
      }
    }),
  );

  it.effect("excludes other tasks and requires one exact noncurrent window", () =>
    Effect.gen(function* () {
      const { broker, set } = setup();
      yield* broker.reserve(owner, 2, [2]);
      expect(yield* Effect.flip(broker.reserve(other, 2, [2]))).toMatchObject({
        code: "computer_space_reserved",
      });
      expect(yield* Effect.flip(broker.assertWindowAllowed(other, window))).toMatchObject({
        code: "computer_space_reserved",
      });
      expect(yield* Effect.flip(broker.assertWindowAllowed(owner, window))).toMatchObject({
        code: "computer_space_window_not_selected",
      });
      for (const candidate of [
        { ...window, spaceIds: [1, 2] },
        { ...window, onCurrentSpace: true },
        { ...window, spaceIds: [] },
      ]) {
        set({ inventory: inventory(), windows: [candidate] });
        expect(yield* Effect.flip(broker.select(owner, candidate.id))).toMatchObject({
          code: "computer_space_target_membership_unproven",
        });
      }
    }),
  );

  it.effect("invalidates on current-Space entry and does not silently resume after departure", () =>
    Effect.gen(function* () {
      const { broker, set } = setup();
      yield* broker.reserve(owner, 2, [2], window.id);
      set({ inventory: inventory(2), windows: [{ ...window, onCurrentSpace: true }] });
      expect(yield* Effect.flip(broker.assertWindowAllowed(owner, window))).toMatchObject({
        code: "computer_space_current",
      });
      set({ inventory: inventory(), windows: [window] });
      expect(yield* Effect.flip(broker.assertWindowAllowed(owner, window))).toMatchObject({
        code: "computer_space_current",
      });
      yield* broker.reserve(owner, 2, [2], window.id);
      yield* broker.assertWindowAllowed(owner, window);
    }),
  );

  it.effect.each([{ uuid: "new-uuid" }, { displayId: "display-b" }])(
    "invalidates session-ID reuse or display churn: %j",
    (patch) =>
      Effect.gen(function* () {
        const { broker, set } = setup();
        yield* broker.reserve(owner, 2, [2], window.id);
        const value = inventory();
        set({
          inventory: {
            ...value,
            spaces: value.spaces.map((s) => (s.id === 2 ? { ...s, ...patch } : s)),
          },
          windows: [window],
        });
        expect(yield* Effect.flip(broker.assertWindowAllowed(owner, window))).toMatchObject({
          code: "computer_space_reservation_changed",
        });
      }),
  );

  it.effect("rejects a replaced PID and a window moved out of the reservation", () =>
    Effect.gen(function* () {
      const { broker, set } = setup();
      yield* broker.reserve(owner, 2, [2], window.id);
      set({ inventory: inventory(), windows: [{ ...window, pid: 11 }] });
      expect(yield* Effect.flip(broker.assertWindowAllowed(owner, window))).toMatchObject({
        code: "computer_space_window_not_selected",
      });
      set({ inventory: inventory(), windows: [{ ...window, spaceIds: [3] }] });
      expect(yield* Effect.flip(broker.assertWindowAllowed(owner, window))).toMatchObject({
        code: "computer_space_target_outside_reservation",
      });
    }),
  );

  it.effect(
    "fences an old noncurrent read after a newer observation invalidates the reservation",
    () =>
      Effect.gen(function* () {
        const { broker, set, snapshot, hold } = setup();
        yield* broker.reserve(owner, 2, [2], window.id);
        const oldSnapshot = snapshot();
        const { entered, gate } = yield* hold;
        const pending = yield* Effect.forkChild(
          Effect.flip(broker.reserve(owner, 2, [2], window.id)),
        );
        yield* Deferred.await(entered);
        set({ inventory: inventory(2), windows: [window] });
        yield* broker.inspect();
        yield* Deferred.succeed(gate, oldSnapshot);
        expect(yield* Fiber.join(pending)).toMatchObject({
          code: "computer_space_reservation_changed",
        });
        expect(broker.reservationFor(owner)?.invalidReason).toBe("computer_space_current");
      }),
  );

  it.effect(
    "turn teardown fences pending replacement without releasing a different stored turn",
    () =>
      Effect.gen(function* () {
        const { broker, snapshot, hold } = setup();
        yield* broker.reserve(owner, 2, [2], window.id);
        const { entered, gate } = yield* hold;
        const next = { ...owner, turnId: "next" };
        const pending = yield* Effect.forkChild(Effect.flip(broker.reserve(next, 3, [3])));
        yield* Deferred.await(entered);
        broker.release(owner.threadId, next.turnId);
        expect(broker.reservationFor(owner)).not.toBeNull();
        yield* Deferred.succeed(gate, snapshot());
        expect(yield* Fiber.join(pending)).toMatchObject({
          code: "computer_space_reservation_changed",
        });
        broker.release(owner.threadId, owner.turnId);
        expect(broker.reservationFor(owner)).toBeNull();
      }),
  );

  it.effect("disposal and latest user revocation prevent pending reservation commit", () =>
    Effect.gen(function* () {
      const { broker, snapshot, hold } = setup();
      expect(
        yield* Effect.flip(broker.reserve(owner, 2, [2], window.id, Effect.succeed(false))),
      ).toMatchObject({ code: "computer_space_not_designated" });
      const { entered, gate } = yield* hold;
      const pending = yield* Effect.forkChild(Effect.flip(broker.reserve(owner, 2, [2])));
      yield* Deferred.await(entered);
      broker.dispose();
      yield* Deferred.succeed(gate, snapshot());
      expect(yield* Fiber.join(pending)).toMatchObject({
        code: "computer_space_reservation_changed",
      });
    }),
  );

  it.effect("refuses native launch, app-wide changes and unscoped input while reserved", () =>
    Effect.gen(function* () {
      const { broker } = setup();
      yield* broker.reserve(owner, 2, [2], window.id);
      expect(yield* Effect.flip(broker.assertNativeLaunchAllowed(owner.threadId))).toMatchObject({
        code: "computer_space_operation_unsupported",
      });
      expect(yield* Effect.flip(broker.assertNativeLaunchAllowed(other.threadId))).toMatchObject({
        code: "computer_space_operation_unsupported",
      });
      expect(yield* Effect.flip(broker.assertTargetBound(owner.threadId, undefined))).toMatchObject(
        { code: "computer_space_window_not_selected" },
      );
      expect(yield* Effect.flip(broker.assertAppMutationAllowed(owner, 10))).toMatchObject({
        code: "computer_space_operation_unsupported",
      });
      expect(yield* Effect.flip(broker.assertAppMutationAllowed(other, 10))).toMatchObject({
        code: "computer_space_reserved",
      });
    }),
  );

  it.effect("does no inventory work on ordinary input when no task has a reservation", () =>
    Effect.gen(function* () {
      const { broker, reads } = setup();
      yield* broker.assertWindowAllowed(owner, window);
      yield* broker.assertAppMutationAllowed(owner, 10);
      yield* broker.assertNativeLaunchAllowed(owner.threadId);
      yield* broker.assertTargetBound(owner.threadId, undefined);
      expect(reads()).toBe(0);
    }),
  );

  it.effect("ambiguous duplicate inventory cannot preserve a reservation", () =>
    Effect.gen(function* () {
      const { broker, set } = setup();
      yield* broker.reserve(owner, 2, [2], window.id);
      const value = inventory();
      set({
        inventory: { ...value, spaces: [...value.spaces, { ...value.spaces[1]!, current: true }] },
        windows: [window],
      });
      expect(yield* Effect.flip(broker.assertWindowAllowed(owner, window))).toMatchObject({
        code: "computer_space_reservation_changed",
      });
    }),
  );
});
