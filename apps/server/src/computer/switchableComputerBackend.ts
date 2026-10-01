/**
 * A backend slot whose occupant can change after the manager was built on it.
 *
 * Two things need that on Linux. Startup must not wait for backend selection
 * and its passive probe — both ask the session bus, and a wedged bus holds
 * each question for its full D-Bus timeout, which stalled boot for about
 * twenty seconds — so the service may start on a placeholder that answers
 * "checking" and put the chosen backend in when selection finishes. And a
 * compositor backend whose desktop is gone for good (the Hyprland instance it
 * was bound to exited) can be replaced by whatever selection picks now.
 *
 * The manager binds a backend once, at construction, and reads optional
 * members by presence (`backend.waitForSettle !== undefined`), so the slot is
 * a `Proxy` rather than a class: every member read goes to the current
 * occupant, and an optional method the occupant lacks is absent here too. The
 * few members that must outlive a swap are the slot's own — the event stream,
 * the preview stream, and disposal.
 *
 * @module computer/switchableComputerBackend
 */
import type { ComputerAvailability, ComputerHealth, ComputerId } from "@spiritdevs/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import {
  DEFAULT_COMPUTER_ID,
  NO_COMPUTER_CAPABILITIES,
  type ComputerBackend,
  type ComputerBackendEvent,
} from "./ComputerBackend.ts";
import { ComputerBackendError } from "./computerErrors.ts";

/**
 * Stands in while selection is still running. It reports `checking` and
 * refuses every desktop call with a retryable error: guessing a desktop would
 * be worse than saying "not yet", and on a healthy host this window never
 * opens, because the service waits out a short budget before starting on it.
 *
 * `agentDialect` and `dedicatedSeat` are the profile every Linux tier
 * declares, so guidance rendered during the window already describes the kind
 * of desktop selection will produce.
 */
export class CheckingComputerBackend implements ComputerBackend {
  readonly computerId = DEFAULT_COMPUTER_ID as ComputerId;
  readonly agentDialect = "linux" as const;
  readonly dedicatedSeat = true;

  private readonly message: string;

  constructor(message: string) {
    this.message = message;
  }

  private readonly refuse = <A = never>(): Effect.Effect<A, ComputerBackendError> =>
    Effect.fail(new ComputerBackendError({ message: this.message, retryable: true }));

  readonly probeAvailability = () =>
    Effect.succeed<ComputerAvailability>({ kind: "checking", message: this.message });

  readonly availability = this.probeAvailability;

  /** The idle placeholder health: nothing connected, nothing failed. */
  readonly health = (): ComputerHealth => ({
    status: "unavailable",
    consecutiveFailures: 0,
    reconnects: 0,
    captureAvailable: false,
  });

  readonly capabilities = () => NO_COMPUTER_CAPABILITIES;

  /** A pane may attach before the desktop is known; the slot replays it on swap. */
  readonly attachStream = () => Effect.void;
  readonly detachStream = () => Effect.void;

  readonly listWindows = this.refuse;
  readonly getScreenSize = this.refuse;
  readonly getState = this.refuse;
  readonly captureScreenshot = this.refuse;
  readonly launchApp = this.refuse;
  readonly click = this.refuse;
  readonly doubleClick = this.refuse;
  readonly rightClick = this.refuse;
  readonly moveCursor = this.refuse;
  readonly drag = this.refuse;
  readonly scroll = this.refuse;
  readonly typeText = this.refuse;
  readonly pressKey = this.refuse;
  readonly hotkey = this.refuse;
  readonly setValue = this.refuse;
  readonly performAction = this.refuse;
  readonly selectText = this.refuse;

  readonly dispose = () => Effect.void;
}

export interface ComputerBackendSwapOptions {
  /**
   * The old occupant drove a different desktop. Standing consent and the
   * window list the manager remembers belong to that desktop, so the slot
   * announces an interruption (the manager revokes task grants on it) and an
   * empty window list before the new occupant reports its own.
   */
  readonly desktopChanged?: boolean;
}

export interface SwitchableComputerBackendOptions {
  /** The occupant reported its desktop gone for good; see `desktop-gone`. */
  readonly onDesktopGone?: (backend: ComputerBackend, message: string) => Effect.Effect<void>;
}

export interface SwitchableComputerBackend {
  /** What the manager is built on; every read resolves against the occupant. */
  readonly backend: ComputerBackend;
  readonly current: () => ComputerBackend;
  /**
   * Puts `next` in the slot. The manager hears the new health and capability
   * set as ordinary backend events, and a preview stream that was attached to
   * the old occupant is attached to the new one. The old occupant is only
   * unsubscribed here; disposing it is the caller's decision, because the
   * placeholder has nothing to dispose and a replaced desktop backend does.
   */
  readonly swap: (
    next: ComputerBackend,
    options?: ComputerBackendSwapOptions,
  ) => Effect.Effect<void>;
}

/**
 * Builds a slot holding `initial`. Its event forwarding lives in the current
 * scope; the slot's `dispose` disposes whichever backend occupies it then.
 */
export const makeSwitchableComputerBackend = (
  initial: ComputerBackend,
  options: SwitchableComputerBackendOptions = {},
): Effect.Effect<SwitchableComputerBackend, never, Scope.Scope> =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const hub = yield* PubSub.unbounded<ComputerBackendEvent>();
    yield* Effect.addFinalizer(() => PubSub.shutdown(hub));
    const state = {
      occupant: initial,
      forwarding: undefined as Fiber.Fiber<void> | undefined,
      streamAttached: false,
      disposed: false,
    };

    const publish = (event: ComputerBackendEvent) => Effect.asVoid(PubSub.publish(hub, event));

    /** Forwards `backend`'s events for as long as it is the occupant. */
    const subscribe = (backend: ComputerBackend) =>
      Effect.gen(function* () {
        const events = backend.events;
        if (events === undefined) return;
        state.forwarding = yield* events.pipe(
          Stream.runForEach((event) => {
            if (backend !== state.occupant) return Effect.void;
            const gone =
              event.type === "desktop-gone"
                ? (options.onDesktopGone?.(backend, event.message) ?? Effect.void)
                : Effect.void;
            return Effect.andThen(gone, publish(event));
          }),
          // Subscribed before `swap` returns, so nothing the occupant says
          // right after is lost.
          Effect.forkIn(scope, { startImmediately: true }),
        );
      });

    const unsubscribe = Effect.suspend(() => {
      const forwarding = state.forwarding;
      state.forwarding = undefined;
      return forwarding === undefined ? Effect.void : Fiber.interrupt(forwarding);
    });

    yield* subscribe(initial);

    const own: Partial<Record<keyof ComputerBackend, unknown>> = {
      events: Stream.fromPubSub(hub),
      attachStream: () =>
        Effect.suspend(() => {
          state.streamAttached = true;
          return state.occupant.attachStream();
        }),
      detachStream: () =>
        Effect.suspend(() => {
          state.streamAttached = false;
          return state.occupant.detachStream();
        }),
      dispose: () =>
        Effect.suspend(() => {
          state.disposed = true;
          return Effect.andThen(unsubscribe, state.occupant.dispose());
        }),
    };

    const backend = new Proxy({} as ComputerBackend, {
      get: (_target, property) => {
        if (Object.hasOwn(own, property)) return own[property as keyof ComputerBackend];
        const occupant = state.occupant;
        const value: unknown = Reflect.get(occupant, property, occupant);
        return typeof value === "function" ? value.bind(occupant) : value;
      },
      has: (_target, property) => Object.hasOwn(own, property) || property in state.occupant,
      getPrototypeOf: () => Object.getPrototypeOf(state.occupant) as object | null,
    });

    const swap = (next: ComputerBackend, swapOptions: ComputerBackendSwapOptions = {}) =>
      Effect.gen(function* () {
        if (state.disposed) return yield* next.dispose();
        const previous = state.occupant;
        if (previous === next) return;
        yield* unsubscribe;
        state.occupant = next;
        yield* subscribe(next);
        if (swapOptions.desktopChanged) {
          yield* publish({ type: "desktop-interrupted", pauses: [] });
          yield* publish({ type: "windows-changed", windows: [] });
        }
        yield* publish({ type: "capabilities-changed", capabilities: next.capabilities() });
        yield* publish({ type: "health-changed", health: next.health() });
        if (!state.streamAttached) return;
        yield* Effect.ignore(previous.detachStream());
        // A failed attach is the new occupant's to report through its health;
        // the pane's next keyframe request retries against it.
        if (state.streamAttached && state.occupant === next) {
          yield* Effect.ignore(next.attachStream());
        }
      });

    return {
      backend,
      current: () => state.occupant,
      swap,
    } satisfies SwitchableComputerBackend;
  });
