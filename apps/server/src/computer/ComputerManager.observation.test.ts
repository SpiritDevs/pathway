import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import type { ComputerEvent, ComputerWindow, ThreadComputerState } from "@spiritdevs/contracts";
import { decodeComputerFrame } from "@spiritdevs/shared/computerFrame";
import type { FrameSink } from "@spiritdevs/shared/frameTransport";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";

import { COMPUTER_ACTION_OBSERVATION_MAX_DIMENSION } from "./ComputerBackend.ts";
import { ComputerManager } from "./ComputerManager.ts";
import { ComputerBackendError } from "./computerErrors.ts";
import { FakeComputerBackend } from "./FakeComputerBackend.ts";

/** A frame sink that records every frame and lets a test wait for a count. */
class RecordingSink implements FrameSink {
  readonly received: Uint8Array[] = [];
  open = true;
  private readonly waiters: { readonly count: number; readonly done: Deferred.Deferred<void> }[] =
    [];

  send = (bytes: Uint8Array): void => {
    this.received.push(bytes);
    for (const waiter of this.waiters) {
      if (this.received.length >= waiter.count) Deferred.doneUnsafe(waiter.done, Effect.void);
    }
  };
  bufferedAmount = (): number => 0;
  isOpen = (): boolean => this.open;

  /** Resolves once `count` frames have arrived. */
  waitFor(count: number): Effect.Effect<void> {
    return Effect.suspend(() => {
      if (this.received.length >= count) return Effect.void;
      const done = Deferred.makeUnsafe<void>();
      this.waiters.push({ count, done });
      return Deferred.await(done);
    });
  }
}

/**
 * The manager's event channel as a test reads it: every event pulled so far
 * lands in `seen`, `until` pulls until one matches, and `drain` takes whatever
 * is already buffered without waiting.
 */
const watchEvents = (manager: ComputerManager) =>
  Effect.gen(function* () {
    const subscription = yield* manager.subscribeEvents;
    const seen: ComputerEvent[] = [];
    const until = (predicate: (event: ComputerEvent) => boolean) =>
      Effect.gen(function* () {
        while (true) {
          const event = yield* PubSub.take(subscription);
          seen.push(event);
          if (predicate(event)) return event;
        }
      });
    const drain = Effect.map(PubSub.takeUpTo(subscription, Number.MAX_SAFE_INTEGER), (events) => {
      seen.push(...events);
      return seen;
    });
    return { seen, until, drain };
  });

type EventWatch = Effect.Success<ReturnType<typeof watchEvents>>;

/** Subscribes `sink` in its own scope; the returned effect unsubscribes it. */
const subscribeFrames = (manager: ComputerManager, sink: FrameSink) =>
  Effect.gen(function* () {
    const subscription = yield* Scope.make();
    yield* manager.subscribeFrames(sink).pipe(Scope.provide(subscription));
    return Scope.close(subscription, Exit.void);
  });

/** Emits a window change and waits until the manager has taken it in. */
const emitWindows = (
  backend: FakeComputerBackend,
  watch: EventWatch,
  windows: readonly ComputerWindow[],
) =>
  Effect.suspend(() => {
    backend.emitWindowsChanged(windows);
    return watch.until((event) => event.type === "computer.windows-changed");
  });

const windowIdOf = (observed: unknown): string | undefined =>
  typeof observed === "object" && observed !== null && "windowId" in observed
    ? (observed as { readonly windowId?: string }).windowId
    : undefined;

const SETTLE_MS = 60;

/**
 * A clock that records the fixed scroll-leg settle instead of waiting it out,
 * and hands every other sleep to the test clock. The Effect analog of spying
 * on `setTimeout` for the settle's delay.
 */
function settleRecordingClock(base: Clock.Clock, settles: number[]): Clock.Clock {
  return {
    currentTimeMillisUnsafe: () => base.currentTimeMillisUnsafe(),
    currentTimeMillis: base.currentTimeMillis,
    currentTimeNanosUnsafe: () => base.currentTimeNanosUnsafe(),
    currentTimeNanos: base.currentTimeNanos,
    monotonicTimeNanosUnsafe: () => base.monotonicTimeNanosUnsafe(),
    monotonicTimeNanos: base.monotonicTimeNanos,
    sleep: (duration) => {
      const millis = Duration.toMillis(duration);
      if (millis !== SETTLE_MS) return base.sleep(duration);
      settles.push(millis);
      return Effect.void;
    },
  };
}

/** Sets one env var for the rest of the enclosing scope. */
const withEnv = (name: string, value: string) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const previous = process.env[name];
      process.env[name] = value;
      return previous;
    }),
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) delete process.env[name];
        else process.env[name] = previous;
      }),
  );

/**
 * A manager whose travel measurement is scripted, so the tests exercise the
 * closed loop rather than the correlator (which has its own unit tests). Each
 * queued screenshot makes one capture's bytes differ from the last, because
 * byte-identical captures short-circuit to "did not move" before measuring.
 */
const calibratedScrollFixture = (
  travels: readonly (number | undefined)[],
  backend = new FakeComputerBackend(),
) =>
  Effect.gen(function* () {
    const measured: number[] = [];
    const manager = yield* ComputerManager.make({
      backend,
      actionSettleMs: 0,
      measureScrollTravel: () => Effect.sync(() => travels[measured.push(0) - 1]),
    });
    backend.queueScreenshots(Array.from({ length: 12 }, (_unused, index) => `capture-${index}`));
    return { backend, manager, measurements: measured };
  });

/**
 * The scripted-measurement fixture with a nonzero settle, so whether the leg
 * waited is visible on the clock. Screenshots are queued one per capture so
 * byte identity cannot short-circuit the measurement before it runs.
 */
const settleScrollFixture = (
  travels: readonly (number | undefined)[],
  backend = new FakeComputerBackend(),
  screenshotCount = 16,
) =>
  Effect.gen(function* () {
    const queue = [...travels];
    const manager = yield* ComputerManager.make({
      backend,
      actionSettleMs: SETTLE_MS,
      measureScrollTravel: () => Effect.sync(() => queue.shift()),
    });
    backend.queueScreenshots(
      Array.from({ length: screenshotCount }, (_unused, index) => `capture-${index}`),
    );
    const settles: number[] = [];
    const clock = settleRecordingClock(yield* Clock.Clock, settles);
    const scroll = () =>
      manager
        .scrollCalibrated("thread-1", { x: 1_100, y: 200 }, 0, 400, { observe: true })
        .pipe(Effect.provideService(Clock.Clock, clock));
    return { backend, manager, settles, scroll };
  });

it.layer(NodeServices.layer)("ComputerManager and FakeComputerBackend (observation)", (it) => {
  it.effect("does not tear down a renewed lease for a stale deferred release", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = new FakeComputerBackend();
        const manager = yield* ComputerManager.make({ backend });
        yield* manager.getThreadState("thread-a");
        yield* manager.getThreadState("thread-b");

        const started = yield* Deferred.make<void>();
        const releaseRecorded = yield* Deferred.make<void>();
        const finish = yield* Deferred.make<void>();
        const inFlight = yield* Effect.forkChild(
          manager.withAgentActivity(
            "thread-a",
            Effect.gen(function* () {
              yield* manager.click("thread-a", { x: 10, y: 10 });
              yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(releaseRecorded);
              // Turn two renews the lease while turn one's release is still only
              // recorded — the deferred release must not tear the renewal down.
              yield* manager.withAgentActivity(
                "thread-a",
                manager.click("thread-a", { x: 11, y: 11 }),
                undefined,
                "turn-2",
              );
              yield* Deferred.await(finish);
            }),
            undefined,
            "turn-1",
          ),
          { startImmediately: true },
        );
        yield* Deferred.await(started);
        yield* manager.releaseDesktopControl("thread-a", "turn-1");
        yield* Deferred.succeed(releaseRecorded, undefined);
        yield* Deferred.succeed(finish, undefined);
        yield* Fiber.join(inFlight);

        // Turn one's deferred release matched the stamped turn and left turn
        // two's lease alone: the desktop still belongs to thread-a.
        expect(yield* manager.getThreadState("thread-b")).toMatchObject({
          controlledByOtherThread: true,
        });
        expect((yield* Effect.flip(manager.typeText("thread-b", "hi"))).message).toMatch(
          /another conversation/,
        );

        // The owning turn can still release normally.
        yield* manager.releaseDesktopControl("thread-a", "turn-2");
        expect(yield* manager.getThreadState("thread-b")).toMatchObject({
          controlledByOtherThread: false,
        });
      }),
    ),
  );

  it.effect("does not let a queued thread-level release tear down a newer turn", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const endTaskCalls: (readonly [string, string | undefined])[] = [];
        const backend = Object.assign(new FakeComputerBackend(), {
          endTask: (threadId: string, turnId?: string) => {
            endTaskCalls.push([threadId, turnId]);
            return Effect.void;
          },
        });
        const manager = yield* ComputerManager.make({ backend });
        const started = yield* Deferred.make<void>();
        const finish = yield* Deferred.make<void>();
        yield* manager.withAgentActivity(
          "thread-a",
          manager.click("thread-a", { x: 10, y: 10 }),
          undefined,
          "turn-old",
        );
        const blocker = yield* Effect.forkChild(
          manager.withAgentActivity(
            "reader",
            Effect.gen(function* () {
              yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(finish);
            }),
          ),
          { startImmediately: true },
        );
        yield* Deferred.await(started);
        const renewed = yield* Effect.forkChild(
          manager.withAgentActivity(
            "thread-a",
            manager.click("thread-a", { x: 20, y: 20 }),
            undefined,
            "turn-new",
          ),
          { startImmediately: true },
        );
        const released = yield* Effect.forkChild(manager.releaseDesktopControl("thread-a"), {
          startImmediately: true,
        });
        yield* Deferred.succeed(finish, undefined);
        yield* Fiber.join(blocker);
        yield* Fiber.join(renewed);
        yield* Fiber.join(released);
        expect(endTaskCalls).toEqual([["thread-a", "turn-old"]]);
        expect(yield* Effect.flip(manager.typeText("thread-b", "second"))).toMatchObject({
          code: "computer_controlled_by_other_thread",
        });
        yield* manager.releaseDesktopControl("thread-a", "turn-new");
        expect(yield* manager.typeText("thread-b", "second")).toMatchObject({
          action: "computer_type_text",
        });
      }),
    ),
  );

  it.effect("does not stamp a released turn onto a later turnId-less claim", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = new FakeComputerBackend();
        const manager = yield* ComputerManager.make({ backend });
        yield* manager.getThreadState("thread-a");
        yield* manager.getThreadState("thread-b");

        yield* manager.withAgentActivity(
          "thread-a",
          manager.click("thread-a", { x: 10, y: 10 }),
          undefined,
          "turn-1",
        );
        yield* manager.releaseDesktopControl("thread-a", "turn-1");

        // The turn ended and released; a turnId-less caller claims anonymously —
        // inheriting turn-1's stamp would refuse the real turn's own release.
        yield* manager.withAgentActivity("thread-a", manager.click("thread-a", { x: 11, y: 11 }));
        expect(yield* manager.getThreadState("thread-b")).toMatchObject({
          controlledByOtherThread: true,
        });
        yield* manager.releaseDesktopControl("thread-a", "turn-2");
        expect(yield* manager.getThreadState("thread-b")).toMatchObject({
          controlledByOtherThread: false,
        });
      }),
    ),
  );

  it.effect("still fully removes a thread whose stop rejects in preview cleanup", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = Object.assign(new FakeComputerBackend(), {
          endTask: () =>
            Effect.fail(new ComputerBackendError({ message: "Preview cleanup failed" })),
        });
        const manager = yield* ComputerManager.make({ backend });
        yield* manager.getThreadState("thread-b");
        yield* manager.launchApp("thread-a", "kcalc");

        // A rejected cleanup must not fail the removal itself — every step still
        // runs: the lease released, the thread's state gone, nobody left blocked.
        yield* manager.handleThreadRemoved("thread-a");
        expect(yield* manager.getThreadState("thread-b")).toMatchObject({
          controlledByOtherThread: false,
        });
        expect(yield* manager.typeText("thread-b", "hi")).toMatchObject({
          action: "computer_type_text",
        });
      }),
    ),
  );

  it.effect("clears an evicted owner's turn stamp along with its stale lease", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = new FakeComputerBackend();
        yield* TestClock.setTime(0);
        const manager = yield* ComputerManager.make({ backend, leaseIdleMs: 1_000 });
        yield* manager.getThreadState("thread-a");
        yield* manager.getThreadState("thread-b");

        // thread-a holds the desktop under turn-1, then goes silent past idle.
        yield* manager.withAgentActivity(
          "thread-a",
          manager.click("thread-a", { x: 10, y: 10 }),
          undefined,
          "turn-1",
        );
        yield* TestClock.setTime(2_000);
        // thread-b evicts the stale lease — turn-1's authority dies with it.
        yield* manager.withAgentActivity(
          "thread-b",
          manager.click("thread-b", { x: 10, y: 10 }),
          undefined,
          "turn-9",
        );
        // thread-b goes idle too; thread-a re-claims with no turn attribution.
        yield* TestClock.setTime(4_000);
        yield* manager.withAgentActivity("thread-a", manager.click("thread-a", { x: 11, y: 11 }));
        // Had the dead stamp survived eviction, this release would be refused as
        // turn-mismatched — the anonymous lease must release for any named turn.
        yield* manager.releaseDesktopControl("thread-a", "turn-5");
        expect(yield* manager.getThreadState("thread-b")).toMatchObject({
          controlledByOtherThread: false,
        });
      }),
    ),
  );

  it.effect("drops an anonymous deferred release once a turn renews the lease", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = new FakeComputerBackend();
        const manager = yield* ComputerManager.make({ backend });
        yield* manager.getThreadState("thread-a");
        yield* manager.getThreadState("thread-b");

        const started = yield* Deferred.make<void>();
        const releaseRecorded = yield* Deferred.make<void>();
        const finish = yield* Deferred.make<void>();
        const inFlight = yield* Effect.forkChild(
          manager.withAgentActivity(
            "thread-a",
            Effect.gen(function* () {
              yield* manager.click("thread-a", { x: 10, y: 10 });
              yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(releaseRecorded);
              // A real turn renews while the anonymous release is only recorded.
              yield* manager.withAgentActivity(
                "thread-a",
                manager.click("thread-a", { x: 11, y: 11 }),
                undefined,
                "turn-2",
              );
              yield* Deferred.await(finish);
            }),
          ),
          { startImmediately: true },
        );
        yield* Deferred.await(started);
        // A thread-level (turnId-less) release on an anonymous lease: nothing to
        // match later, so it must not outlive the turn-2 renewal.
        yield* manager.releaseDesktopControl("thread-a");
        yield* Deferred.succeed(releaseRecorded, undefined);
        yield* Deferred.succeed(finish, undefined);
        yield* Fiber.join(inFlight);

        expect(yield* manager.getThreadState("thread-b")).toMatchObject({
          controlledByOtherThread: true,
        });
        expect((yield* Effect.flip(manager.typeText("thread-b", "hi"))).message).toMatch(
          /another conversation/,
        );
      }),
    ),
  );

  it.effect("reacquires the lease for a new turn after the previous operation drains", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = new FakeComputerBackend();
        const manager = yield* ComputerManager.make({ backend });
        yield* manager.getThreadState("thread-a");

        const started = yield* Deferred.make<void>();
        const finish = yield* Deferred.make<void>();
        const inFlight = yield* Effect.forkChild(
          manager.withAgentActivity(
            "thread-a",
            Effect.gen(function* () {
              yield* manager.click("thread-a", { x: 10, y: 10 });
              yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(finish);
            }),
          ),
          { startImmediately: true },
        );
        yield* Deferred.await(started);
        yield* manager.releaseDesktopControl("thread-a");
        // The next turn waits for the old operation, then takes a fresh lease.
        const nextTurn = yield* Effect.forkChild(manager.click("thread-a", { x: 20, y: 20 }), {
          startImmediately: true,
        });
        yield* Effect.yieldNow;
        expect(backend.callsFor("click")).toHaveLength(1);
        yield* Deferred.succeed(finish, undefined);
        yield* Fiber.join(inFlight);
        yield* Fiber.join(nextTurn);

        expect((yield* Effect.flip(manager.typeText("thread-b", "hi"))).message).toMatch(
          /another conversation/,
        );
        expect(yield* manager.getThreadState("thread-b")).toMatchObject({
          controlledByOtherThread: true,
        });
      }),
    ),
  );

  it.effect("expires an idle lease as a backstop, but never one whose owner is still acting", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = new FakeComputerBackend();
        yield* TestClock.setTime(0);
        const manager = yield* ComputerManager.make({ backend, leaseIdleMs: 1_000 });
        yield* manager.getThreadState("thread-a");

        yield* manager.click("thread-a", { x: 10, y: 10 });
        yield* TestClock.setTime(999);
        expect((yield* Effect.flip(manager.click("thread-b", { x: 20, y: 20 }))).message).toMatch(
          /another conversation/,
        );

        // An owner that is mid-call still holds the pointer, however long ago the
        // call started — the crash this backstop exists for leaves nothing running.
        yield* TestClock.setTime(10_000);
        const started = yield* Deferred.make<void>();
        const finish = yield* Deferred.make<void>();
        const inFlight = yield* Effect.forkChild(
          manager.withAgentActivity(
            "thread-a",
            Effect.gen(function* () {
              yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(finish);
            }),
          ),
          { startImmediately: true },
        );
        yield* Deferred.await(started);
        expect((yield* Effect.flip(manager.click("thread-b", { x: 20, y: 20 }))).message).toMatch(
          /another conversation/,
        );
        yield* Deferred.succeed(finish, undefined);
        yield* Fiber.join(inFlight);

        expect(yield* manager.click("thread-b", { x: 20, y: 20 })).toMatchObject({
          action: "computer_click",
        });
        expect((yield* Effect.flip(manager.click("thread-a", { x: 10, y: 10 }))).message).toMatch(
          /another conversation/,
        );
      }),
    ),
  );

  /**
   * The same backstop, on the backend that ships: a visible desktop surfaces no
   * pane, so nothing ever created a runtime record for an agent thread, and the
   * in-flight guard read zero from a thread that was mid-drag. The desktop could
   * then be taken from under it by another conversation.
   */
  it.effect("counts an agent's in-flight call even when no panel ever asked about it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = new FakeComputerBackend({
          capabilities: {
            ...new FakeComputerBackend().capabilities(),
            visibleDesktop: true,
          },
        });
        yield* TestClock.setTime(0);
        const manager = yield* ComputerManager.make({ backend, leaseIdleMs: 1_000 });

        const started = yield* Deferred.make<void>();
        const finish = yield* Deferred.make<void>();
        // Nothing here asks for thread state: this is a thread whose only contact
        // with the manager is the tool calls it makes.
        const inFlight = yield* Effect.forkChild(
          manager.withAgentActivity(
            "thread-a",
            Effect.gen(function* () {
              yield* manager.click("thread-a", { x: 10, y: 10 });
              yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(finish);
            }),
          ),
          { startImmediately: true },
        );
        yield* Deferred.await(started);

        yield* TestClock.setTime(10_000);
        expect((yield* Effect.flip(manager.click("thread-b", { x: 20, y: 20 }))).message).toMatch(
          /another conversation/,
        );

        yield* Deferred.succeed(finish, undefined);
        yield* Fiber.join(inFlight);
        // Once the call really has finished, the idle lease is up for grabs again.
        expect(yield* manager.click("thread-b", { x: 20, y: 20 })).toMatchObject({
          action: "computer_click",
        });
      }),
    ),
  );

  /**
   * Every publish reads the window list, and every window read can report a
   * change, so one change used to schedule a pass whose own reads scheduled the
   * next — multiplied by thread count, on a desktop where nothing more than a
   * clock title was moving.
   */
  it.effect("coalesces a burst of window changes into a single publish pass", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = new FakeComputerBackend();
        const manager = yield* ComputerManager.make({ backend, windowsPublishDebounceMs: 5 });
        // The churn this coalesces comes from a live backend, which by definition
        // something has already used. Engaging before either thread exists keeps the
        // republish that engagement triggers out of the count below.
        yield* manager.listWindows();
        yield* manager.getThreadState("thread-a");
        yield* manager.getThreadState("thread-b");

        const watch = yield* watchEvents(manager);
        const readsBefore = backend.callsFor("listWindows").length;

        for (let index = 0; index < 20; index += 1) {
          yield* emitWindows(backend, watch, [
            {
              id: "clock",
              title: `Clock — 12:00:${index}`,
              bounds: { x: 0, y: 0, width: 100, height: 40 },
              focused: false,
              minimized: false,
              visible: true,
            },
          ]);
        }
        yield* TestClock.adjust(40);
        let published = 0;
        yield* watch.until(
          (event) => event.type === "computer.thread-state" && (published += 1) === 2,
        );
        // Any second pass would be scheduled by now; let its timer fire too.
        yield* TestClock.adjust(40);
        const publishes = (yield* watch.drain).flatMap((event) =>
          event.type === "computer.thread-state" ? [event.state.threadId] : [],
        );

        // One pass, one thread state each, one window read each — not twenty.
        expect(publishes).toEqual(["thread-a", "thread-b"]);
        expect(backend.callsFor("listWindows").length - readsBefore).toBe(1);
      }),
    ),
  );

  it.effect("lets one thread keep driving across a long think, and keeps perception free", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = new FakeComputerBackend();
        yield* TestClock.setTime(0);
        const manager = yield* ComputerManager.make({ backend, leaseIdleMs: 1_000 });

        yield* manager.click("thread-a", { x: 10, y: 10 });
        // Nobody else asked for the desktop while the model thought, so the owner
        // simply picks it back up: expiry is a chance for others, not a revocation.
        yield* TestClock.setTime(60_000);
        expect(yield* manager.click("thread-a", { x: 10, y: 10 })).toMatchObject({
          action: "computer_click",
        });
        // Perception from another thread neither takes the lease nor renews it.
        yield* manager.getState({});
        yield* manager.listWindows();
        expect(yield* manager.click("thread-a", { x: 10, y: 10 })).toMatchObject({
          action: "computer_click",
        });
      }),
    ),
  );

  it.effect("runs the synthetic frame attach, publish, and detach loop", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = new FakeComputerBackend();
        const manager = yield* ComputerManager.make({ backend });
        const sink = new RecordingSink();
        const watch = yield* watchEvents(manager);
        const unsubscribe = yield* subscribeFrames(manager, sink);
        yield* manager.flushStreamTransitions;

        expect(backend.callsFor("attachStream")).toHaveLength(1);
        yield* sink.waitFor(2);
        expect(sink.received).toHaveLength(2);
        expect(decodeComputerFrame(sink.received[0]!).ok).toBe(true);
        yield* backend.emitFrame(false, false, Uint8Array.of(7, 8));
        yield* sink.waitFor(3);
        expect(sink.received).toHaveLength(3);

        yield* unsubscribe;
        yield* manager.flushStreamTransitions;
        expect(backend.callsFor("detachStream")).toHaveLength(1);
        const count = sink.received.length;
        yield* backend.emitFrame(true, false);
        yield* Effect.yieldNow;
        expect(sink.received).toHaveLength(count);

        // Frames ride the binary transport alone. The JSON event channel used to
        // carry a `computer.frame` header beside every one of them, which its only
        // consumer read and dropped.
        const eventTypes = (yield* watch.drain).map((event) => event.type);
        expect(eventTypes).not.toContain("computer.frame");
      }),
    ),
  );

  it.effect("drops late frames and state updates after a thread is removed", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = new FakeComputerBackend();
        const manager = yield* ComputerManager.make({ backend });
        const sink = new RecordingSink();
        const unsubscribe = yield* subscribeFrames(manager, sink);
        yield* manager.flushStreamTransitions;
        yield* manager.getThreadState("thread-removed");
        yield* manager.handleThreadRemoved("thread-removed");

        yield* backend.emitFrame(false, false, Uint8Array.of(9));
        const refused = yield* Effect.flip(
          manager.withAgentActivity("thread-removed", Effect.succeed(undefined)),
        );
        expect(refused.message).toContain("revoked");
        yield* manager.recordThreadError("thread-removed", "late error");

        const threads = (manager as unknown as { threads: Map<string, unknown> }).threads;
        expect(threads.has("thread-removed")).toBe(false);

        yield* unsubscribe;
      }),
    ),
  );

  it.effect("does not reattach a stream after disposal wins during keyframe recovery", () =>
    Effect.gen(function* () {
      const backend = new FakeComputerBackend();
      const detachStarted = yield* Deferred.make<void>();
      const allowDetach = yield* Deferred.make<void>();
      const detachStream = backend.detachStream.bind(backend);
      Object.defineProperty(backend, "requestKeyframe", { value: undefined });
      backend.detachStream = () =>
        Effect.gen(function* () {
          yield* Deferred.succeed(detachStarted, undefined);
          yield* Deferred.await(allowDetach);
          yield* detachStream();
        });
      const scope = yield* Scope.make();
      const manager = yield* ComputerManager.make({ backend }).pipe(Scope.provide(scope));
      const unsubscribe = yield* subscribeFrames(manager, new RecordingSink());
      yield* manager.flushStreamTransitions;

      const request = yield* Effect.forkChild(manager.requestKeyframe(), {
        startImmediately: true,
      });
      yield* Deferred.await(detachStarted);
      const disposal = yield* Effect.forkChild(Scope.close(scope, Exit.void), {
        startImmediately: true,
      });
      yield* Deferred.succeed(allowDetach, undefined);
      yield* Fiber.join(request);
      yield* Fiber.join(disposal);

      expect(backend.callsFor("attachStream")).toHaveLength(1);
      expect(backend.callsFor("detachStream")).toHaveLength(1);
      yield* unsubscribe;
    }),
  );

  it.effect("finishes keyframe recovery when its caller is interrupted", () =>
    Effect.gen(function* () {
      const backend = new FakeComputerBackend();
      const detachStarted = yield* Deferred.make<void>();
      const allowDetach = yield* Deferred.make<void>();
      const detachStream = backend.detachStream.bind(backend);
      Object.defineProperty(backend, "requestKeyframe", { value: undefined });
      backend.detachStream = () =>
        Effect.gen(function* () {
          yield* Deferred.succeed(detachStarted, undefined);
          yield* Deferred.await(allowDetach);
          yield* detachStream();
        });
      const scope = yield* Scope.make();
      const manager = yield* ComputerManager.make({ backend }).pipe(Scope.provide(scope));
      const unsubscribe = yield* subscribeFrames(manager, new RecordingSink());
      yield* manager.flushStreamTransitions;

      const request = yield* Effect.forkChild(manager.requestKeyframe(), {
        startImmediately: true,
      });
      yield* Deferred.await(detachStarted);
      yield* Fiber.interrupt(request);
      yield* Deferred.succeed(allowDetach, undefined);
      yield* manager.flushStreamTransitions;

      // The watched stream came back rather than staying detached.
      expect(backend.callsFor("attachStream")).toHaveLength(2);
      yield* Scope.close(scope, Exit.void);
      expect(backend.callsFor("detachStream")).toHaveLength(2);
      yield* unsubscribe;
    }),
  );

  it.effect("carries the backend's capabilities onto every thread snapshot", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // The panel decides which controls to offer from this field alone, so a
        // backend that cannot report geometry has to say so in the snapshot rather
        // than let the panel offer window-scoped actions that will be refused.
        const backend = new FakeComputerBackend({
          capabilities: {
            windows: true,
            windowBounds: false,
            stacking: false,
            capture: true,
            input: true,
            clipboard: false,
            focus: false,
            raise: false,
            ghostCursor: false,
            visibleDesktop: false,
          },
        });
        const manager = yield* ComputerManager.make({ backend });

        const state = yield* manager.getThreadState("thread-1");

        expect(state.capabilities).toEqual(backend.capabilities());
      }),
    ),
  );

  it.effect("refuses a window-scoped click when the desktop reports no geometry", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // Passing window_id is a request for a guarantee — that the point lands in
        // that window. Without bounds nothing can check it, and clicking anyway
        // would drop the guarantee silently instead of telling the agent to drop
        // the scope or target by label.
        const backend = new FakeComputerBackend({
          windows: [
            {
              id: "boundless",
              title: "Calculator",
              appName: "org.kde.kcalc",
              focused: true,
              minimized: false,
              visible: true,
            },
          ],
        });
        const manager = yield* ComputerManager.make({ backend });

        expect(
          yield* Effect.flip(manager.click("thread-1", { x: 100, y: 100, windowId: "boundless" })),
        ).toMatchObject({ code: "computer_target_offscreen" });
        expect(backend.callsFor("click")).toHaveLength(0);
      }),
    ),
  );

  it.effect("returns perception payloads with optional text and screenshot", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = new FakeComputerBackend();
        const manager = yield* ComputerManager.make({ backend });
        const state = yield* manager.getState({
          includeScreenshot: true,
          includeText: true,
        });

        expect(state.screenshot?.mimeType).toBe("image/png");
        expect(state.screenshot?.bytesBase64.length).toBeGreaterThan(0);
        expect(state.text).toContain("Calculate");
        expect(state.root?.children.length).toBeGreaterThan(0);
      }),
    ),
  );

  it.effect(
    "captures the focused window, and the workspace when nothing capturable has focus",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const backend = new FakeComputerBackend();
          const manager = yield* ComputerManager.make({ backend, actionSettleMs: 0 });
          const watch = yield* watchEvents(manager);

          const focused = yield* manager.captureFocusedWindow();
          expect(focused.windowId).toBe("fake-terminal");
          expect(backend.callsFor("captureScreenshot").at(-1)?.args[0]).toEqual({
            kind: "window",
            windowId: "fake-terminal",
          });

          // A minimized focus holder and an unfocused rest leave nothing with focus
          // on screen except the calculator, the topmost visible window.
          yield* emitWindows(backend, watch, [
            {
              id: "fake-terminal",
              title: "Terminal",
              bounds: { x: 40, y: 40, width: 960, height: 720 },
              focused: true,
              minimized: true,
              visible: false,
              stackingIndex: 1,
            },
            {
              id: "fake-calculator",
              title: "Calculator",
              bounds: { x: 1_050, y: 120, width: 420, height: 620 },
              focused: false,
              minimized: false,
              visible: true,
              stackingIndex: 0,
            },
          ]);
          const topmost = yield* manager.captureFocusedWindow();
          expect(topmost.windowId).toBe("fake-calculator");

          // With no capturable window at all, the whole workspace is the answer.
          yield* emitWindows(backend, watch, []);
          const workspace = yield* manager.captureFocusedWindow(1_024);
          expect(workspace.windowId).toBeUndefined();
          expect(backend.callsFor("captureScreenshot").at(-1)?.args[0]).toEqual({
            kind: "region",
            region: { x: 0, y: 0, width: 1_920, height: 1_080 },
            maxDimension: 1_024,
          });
        }),
      ),
  );

  it.effect(
    "captures the action's window on a hint, reports a vanished target, and never throws",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const backend = new FakeComputerBackend();
          const manager = yield* ComputerManager.make({ backend, actionSettleMs: 0 });

          const hinted = yield* manager.captureActionScreenshot("fake-calculator");
          expect(windowIdOf(hinted)).toBe("fake-calculator");

          // A hint naming a window the action closed is a result in its own right,
          // never a substitute capture of whatever holds focus — on a live desktop
          // the focused window is the human's once the agent's target is gone.
          const closed = yield* manager.captureActionScreenshot("gone-window");
          expect(closed).toEqual({ targetWindowClosed: true });

          // A transient capture failure on a window that still exists yields no
          // screenshot, not a picture of some other window.
          backend.failNext("captureScreenshot");
          expect(yield* manager.captureActionScreenshot("fake-calculator")).toBeUndefined();

          // A capture failure returns nothing rather than failing the finished action.
          backend.failNext("captureScreenshot");
          expect(yield* manager.captureActionScreenshot()).toBeUndefined();
        }),
      ),
  );

  it.effect(
    "observes only the agent's focus target after an untargeted action, never the active window",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const backend = new FakeComputerBackend();
          const manager = yield* ComputerManager.make({ backend, actionSettleMs: 0 });
          const watch = yield* watchEvents(manager);

          // No window holds the agent's focus; the human's browser is active and
          // topmost. Action observation must widen to the workspace rather than
          // zoom into the human's window.
          yield* emitWindows(backend, watch, [
            {
              id: "human-browser",
              title: "Browser",
              bounds: { x: 100, y: 100, width: 1_200, height: 800 },
              focused: false,
              active: true,
              minimized: false,
              visible: true,
              stackingIndex: 0,
            },
          ]);
          const observed = yield* manager.captureActionScreenshot();
          expect(windowIdOf(observed)).toBe(undefined);
          expect(backend.callsFor("captureScreenshot").at(-1)?.args[0]).toMatchObject({
            kind: "region",
          });

          // The perception path keeps its wider fallback: an explicit untargeted
          // screenshot request may still show the active window.
          const perception = yield* manager.captureFocusedWindow();
          expect(perception.windowId).toBe("human-browser");
        }),
      ),
  );

  it.effect(
    "photographs the window under an untargeted action's point instead of the workspace",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const backend = new FakeComputerBackend();
          const manager = yield* ComputerManager.make({ backend, actionSettleMs: 0 });

          // The scroll-hunting run this fixes: an unscoped pointer action cleared
          // the agent's explicit target, and the old fallback answered with a
          // workspace-wide downscale too small to read. The action's own
          // coordinates name the window it touched, so that window is the picture.
          const observed = yield* manager.captureActionScreenshot(undefined, {
            x: 1_100,
            y: 200,
          });
          expect(windowIdOf(observed)).toBe("fake-calculator");
          expect(backend.callsFor("captureScreenshot").at(-1)?.args[0]).toEqual({
            kind: "window",
            windowId: "fake-calculator",
            maxDimension: COMPUTER_ACTION_OBSERVATION_MAX_DIMENSION,
          });

          // A point over bare desktop identifies no window; the agent-focus step
          // still answers (the fake terminal holds the agent's focus by default).
          const desktop = yield* manager.captureActionScreenshot(undefined, {
            x: 1_800,
            y: 1_000,
          });
          expect(windowIdOf(desktop)).toBe("fake-terminal");
        }),
      ),
  );

  it.effect(
    "resolves overlapping point candidates by stacking order and refuses to guess without one",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const backend = new FakeComputerBackend();
          const manager = yield* ComputerManager.make({ backend, actionSettleMs: 0 });
          const watch = yield* watchEvents(manager);
          const overlapping = (stacked: boolean): ComputerWindow[] => [
            {
              id: "under",
              title: "Under",
              bounds: { x: 100, y: 100, width: 800, height: 600 },
              focused: false,
              minimized: false,
              visible: true,
              ...(stacked ? { stackingIndex: 1 } : {}),
            },
            {
              id: "over",
              title: "Over",
              bounds: { x: 300, y: 200, width: 400, height: 300 },
              focused: false,
              minimized: false,
              visible: true,
              ...(stacked ? { stackingIndex: 0 } : {}),
            },
          ];

          yield* emitWindows(backend, watch, overlapping(true));
          const observed = yield* manager.captureActionScreenshot(undefined, { x: 400, y: 300 });
          expect(windowIdOf(observed)).toBe("over");

          // The same overlap with no stacking order: a guess could photograph a
          // window the action never touched, so the workspace fallback answers.
          yield* emitWindows(backend, watch, overlapping(false));
          const widened = yield* manager.captureActionScreenshot(undefined, { x: 400, y: 300 });
          expect(windowIdOf(widened)).toBe(undefined);
          expect(backend.callsFor("captureScreenshot").at(-1)?.args[0]).toMatchObject({
            kind: "region",
          });
        }),
      ),
  );

  it.effect("falls back to the focus path when the point window vanishes before its capture", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = new FakeComputerBackend();
        const manager = yield* ComputerManager.make({ backend, actionSettleMs: 0 });

        // The point resolved to the calculator, but its capture fails — the
        // window closed in the race. The caller never named it, so the answer is
        // the ordinary focus fallback, not targetWindowClosed and not an error.
        backend.failNext("captureScreenshot");
        const observed = yield* manager.captureActionScreenshot(undefined, { x: 1_100, y: 200 });
        expect(windowIdOf(observed)).toBe("fake-terminal");
      }),
    ),
  );

  it.effect("skips the post-action capture entirely on a backend that cannot capture", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = new FakeComputerBackend({
          capabilities: {
            ...new FakeComputerBackend().capabilities(),
            capture: false,
          },
        });
        const manager = yield* ComputerManager.make({ backend, actionSettleMs: 0 });

        expect(yield* manager.captureActionScreenshot("fake-terminal")).toBeUndefined();
        expect(backend.callsFor("captureScreenshot")).toHaveLength(0);
      }),
    ),
  );

  /**
   * The first backend call establishes the backend.
   * Panels are seeded for every chat the web app renders, so the seeding path
   * must stay passive, and the first real use is what pays.
   */
  it.effect("seeds panels from the passive probe, and goes live from the first real use", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = new FakeComputerBackend();
        const manager = yield* ComputerManager.make({ backend, actionSettleMs: 0 });
        const watch = yield* watchEvents(manager);

        const seeded = yield* manager.getThreadState("thread-1");
        expect(seeded.availability).toEqual({ kind: "available", backend: "fake" });
        expect(seeded.windows).toEqual([]);
        expect(seeded.screenSize).toEqual({ width: 1, height: 1 });
        expect(backend.calls.map((call) => call.method)).toEqual(["probeAvailability"]);

        // The panel is asked again and again while the chat is open; none of that
        // reaches the desktop either.
        yield* manager.getThreadState("thread-1");
        yield* manager.getThreadState("thread-2");
        expect(backend.calls.map((call) => call.method)).toEqual([
          "probeAvailability",
          "probeAvailability",
          "probeAvailability",
        ]);

        // One agent tool call, and every panel gets the real desktop.
        yield* manager.withAgentActivity("thread-1", manager.listWindows());
        const live = yield* manager.getThreadState("thread-1");
        expect(live.windows.map((window) => window.title)).toEqual(["Terminal", "Calculator"]);
        expect(live.screenSize).toEqual({ width: 1_920, height: 1_080, scale: 1 });
        expect(backend.callsFor("availability").length).toBeGreaterThan(0);
        // The engagement republish reaches the thread nobody acted in, too.
        yield* watch.until(
          (event) =>
            event.type === "computer.thread-state" &&
            event.state.threadId === "thread-2" &&
            event.state.windows.length > 0,
        );
        yield* watch.drain;
        const states = watch.seen.flatMap((event): ThreadComputerState[] =>
          event.type === "computer.thread-state" ? [event.state] : [],
        );
        expect(states.findLast((state) => state.threadId === "thread-2")?.windows).toHaveLength(2);
      }),
    ),
  );

  it.effect("engages the backend when the pane attaches or the human drives it", () =>
    Effect.gen(function* () {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const paneBackend = new FakeComputerBackend();
          const paneManager = yield* ComputerManager.make({ backend: paneBackend });
          const sink = new RecordingSink();
          const detach = yield* subscribeFrames(paneManager, sink);
          yield* paneManager.flushStreamTransitions;
          expect(paneBackend.callsFor("attachStream")).toHaveLength(1);
          expect((yield* paneManager.getThreadState("thread-pane")).windows).toHaveLength(2);
          yield* detach;
        }),
      );

      // Pane input carries no thread and takes no lease, and is still the human
      // asking this backend to drive their desktop.
      yield* Effect.scoped(
        Effect.gen(function* () {
          const inputBackend = new FakeComputerBackend();
          const inputManager = yield* ComputerManager.make({ backend: inputBackend });
          yield* inputManager.click(undefined, { x: 10, y: 10 });
          expect((yield* inputManager.getThreadState("thread-pane")).windows).toHaveLength(2);
        }),
      );
    }),
  );

  /**
   * Image tokens scale with pixel area, and a mutating action attaches a shot
   * every time, so the observation spends a quarter of the perception budget.
   * The mapping metadata is what keeps that free: the agent converts pixels to
   * desktop coordinates through region and scale either way.
   */
  it.effect("downscales large action observations while keeping the coordinate mapping exact", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const tall = COMPUTER_ACTION_OBSERVATION_MAX_DIMENSION + 1_000;
        const backend = new FakeComputerBackend({
          screenSize: { width: 3_000, height: tall + 400, scale: 1 },
          windows: [
            {
              id: "fake-editor",
              title: "Editor",
              bounds: { x: 100, y: 100, width: 1_280, height: tall },
              focused: true,
              minimized: false,
              visible: true,
            },
          ],
        });
        const manager = yield* ComputerManager.make({ backend, actionSettleMs: 0 });

        const observed = yield* manager.captureActionScreenshot("fake-editor");
        expect(backend.callsFor("captureScreenshot").at(-1)?.args[0]).toEqual({
          kind: "window",
          windowId: "fake-editor",
          maxDimension: COMPUTER_ACTION_OBSERVATION_MAX_DIMENSION,
        });
        if (observed === undefined || !("screenshot" in observed)) {
          return assert.fail("the action observation carried no screenshot");
        }
        const { region, scale, width, height } = observed.screenshot;
        // A window taller than the budget scales down to it, and the region still
        // names the window's own rect, so screenshot (x, y) maps back exactly.
        expect(scale).toBeCloseTo(COMPUTER_ACTION_OBSERVATION_MAX_DIMENSION / tall, 10);
        expect(region).toEqual({ x: 100, y: 100, width: 1_280, height: tall });
        // The middle of the image is still the middle of the window: region.x +
        // screenshot_x / scale, the mapping every computer tool describes.
        if (region === undefined || scale === undefined) {
          return assert.fail("no coordinate mapping");
        }
        expect(region.x + width / 2 / scale).toBeCloseTo(region.x + region.width / 2, 0);
        expect(region.y + height / 2 / scale).toBeCloseTo(region.y + region.height / 2, 0);

        // Perception keeps the full budget: zooming back in is how the agent reads
        // detail the observation lost.
        yield* manager.captureFocusedWindow();
        expect(backend.callsFor("captureScreenshot").at(-1)?.args[0]).toEqual({
          kind: "window",
          windowId: "fake-editor",
        });
      }),
    ),
  );

  it.effect("returns every capture for the gateway to compare with delivered screenshots", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = new FakeComputerBackend();
        const manager = yield* ComputerManager.make({ backend, actionSettleMs: 0 });
        const first = yield* manager.captureActionScreenshot("fake-terminal");
        const second = yield* manager.captureActionScreenshot("fake-terminal");
        if (!first || !("screenshot" in first)) {
          return assert.fail("Expected a captured screenshot");
        }
        expect(second).toEqual({
          ...first,
          screenshot: { ...first.screenshot, capturedAt: expect.any(String) },
        });
        expect(backend.callsFor("captureScreenshot")).toHaveLength(2);
      }),
    ),
  );

  it.effect("probes an unmeasured window, then delivers the remainder pre-corrected", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // A GTK-hosted browser gears a pixel delta up by ~7x, and nothing in the
        // protocol says so. Sending the whole request first would travel beyond
        // what the correlator can measure, so the first large scroll goes out as a
        // 48px probe (which travels 336 at 7x — measurable), and the remainder —
        // the request minus what the probe already covered — is divided by the
        // gearing the probe just taught. The first scroll lands on target.
        const { backend, manager } = yield* calibratedScrollFixture([336, 64, 400]);

        const first = yield* manager.scrollCalibrated("thread-1", { x: 1_100, y: 200 }, 0, 400, {
          observe: true,
        });
        expect(first.result.scroll).toEqual({
          requested: { deltaX: 0, deltaY: 400 },
          // Reported to two decimals; the backend gets the unrounded deltas.
          injected: { deltaX: 0, deltaY: 57.14 },
          traveledY: 400,
          gearing: 7,
          routes: ["wheel", "wheel"],
        });
        const legs = backend.callsFor("scroll").map((entry) => entry.args[2]);
        expect(legs[0]).toBe(48);
        expect(legs[1]).toBeCloseTo(64 / 7, 6);
        expect(first.observation !== undefined && "screenshot" in first.observation).toBe(true);

        // A measured window is trusted in one delivery: no probe, one injection.
        const second = yield* manager.scrollCalibrated("thread-1", { x: 1_100, y: 200 }, 0, 400, {
          observe: true,
        });
        expect(second.result.scroll?.injected.deltaY).toBe(57.14);
        expect(second.result.scroll?.traveledY).toBe(400);
        expect(second.result.scroll?.gearing).toBe(7);
        expect(backend.callsFor("scroll")).toHaveLength(3);
        expect(backend.callsFor("scroll").at(-1)?.args[2]).toBeCloseTo(400 / 7, 6);
      }),
    ),
  );

  it.effect("falls back to the full request when the probe cannot be measured", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { backend, manager } = yield* calibratedScrollFixture([undefined, undefined]);

        const result = yield* manager.scrollCalibrated("thread-1", { x: 1_100, y: 200 }, 0, 400, {
          observe: true,
        });

        // The unmeasured probe deducts only its own request: 48 went out, so the
        // remaining 352 follows at gearing 1, and the client got the 400 it would
        // have gotten without the probe.
        expect(result.result.scroll?.injected).toEqual({ deltaX: 0, deltaY: 400 });
        expect(result.result.scroll?.traveledY).toBeUndefined();
        expect(result.result.scroll?.gearing).toBe(1);
        expect(backend.callsFor("scroll").map((entry) => entry.args[2])).toEqual([48, 352]);
      }),
    ),
  );

  it.effect("still identifies the window for an untargeted scroll after the clear", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // Preparing an untargeted action clears the pinned focus, and the focus
        // fallback used to be read only afterwards — so a bare delta scroll could
        // never name its window, observed an unreadable workspace downscale, and
        // calibrated nothing. The cursor the thread last drove to fills the gap.
        const { backend, manager } = yield* calibratedScrollFixture([336, 64]);

        yield* manager.click("thread-1", { x: 1_100, y: 200 });
        const result = yield* manager.scrollCalibrated("thread-1", null, 0, 400, {
          observe: true,
        });

        // The focus really was cleared; the window came from the cursor position.
        expect(backend.callsFor("clearFocusWindow").length).toBeGreaterThan(0);
        expect(result.result.scroll?.gearing).toBe(7);
        expect(result.result.scroll?.traveledY).toBe(400);
        expect(result.observation !== undefined && "screenshot" in result.observation).toBe(true);
      }),
    ),
  );

  it.effect("converts measured travel out of capture pixels before reporting or learning it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // A window wider than the observation budget is captured downscaled, so the
        // correlator's answer is in capture pixels and means less travel than it
        // says. Reporting it unconverted would teach the store a gearing that is
        // really the zoom factor.
        const backend = new FakeComputerBackend({
          windows: [
            {
              id: "fake-browser",
              title: "Browser",
              bounds: { x: 0, y: 0, width: 1_920, height: 1_080 },
              focused: true,
              minimized: false,
              visible: true,
              stackingIndex: 0,
            },
          ],
        });
        const { manager } = yield* calibratedScrollFixture([800], backend);

        // Probe-sized on purpose, so the request goes out in one measured leg.
        const result = yield* manager.scrollCalibrated("thread-1", { x: 900, y: 500 }, 0, 40, {
          observe: true,
        });

        // 1536/1920 = 0.8, so 800 capture pixels of travel are 1000 logical ones.
        expect(result.result.scroll?.traveledY).toBe(1_000);
        expect(result.result.scroll?.gearing).toBe(25);
      }),
    ),
  );

  it.effect("suppresses a wrong-way measurement instead of reporting or learning it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // The live footer-alias case: the correlator locked onto repetitive
        // content and answered with travel opposing the injection. That number
        // must reach neither the caller nor the store.
        const { backend, manager } = yield* calibratedScrollFixture([-752, undefined]);

        const result = yield* manager.scrollCalibrated("thread-1", { x: 1_100, y: 200 }, 0, 100, {
          observe: true,
        });

        expect(result.result.scroll?.traveledY).toBeUndefined();
        expect(result.result.scroll?.gearing).toBe(1);
        expect(backend.callsFor("scroll").map((entry) => entry.args[2])).toEqual([48, 52]);
      }),
    ),
  );

  it.effect("reads byte-identical captures as no movement, and learns nothing from it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = new FakeComputerBackend();
        const measurements: number[] = [];
        const manager = yield* ComputerManager.make({
          backend,
          actionSettleMs: 0,
          measureScrollTravel: () =>
            Effect.sync(() => {
              measurements.push(0);
              return undefined;
            }),
        });

        // No queued captures: the fake returns the same fixture every time, which is
        // what the end of a page looks like — pixels that did not change did not
        // move, and no correlation is needed to know it.
        const first = yield* manager.scrollCalibrated("thread-1", { x: 1_100, y: 200 }, 0, 400, {
          observe: true,
        });
        expect(first.result.scroll?.traveledY).toBe(0);
        expect(first.result.scroll?.gearing).toBe(1);
        expect(measurements).toEqual([]);

        const second = yield* manager.scrollCalibrated("thread-1", { x: 1_100, y: 200 }, 0, 400, {
          observe: true,
        });
        expect(second.result.scroll?.injected).toEqual({ deltaX: 0, deltaY: 400 });
        expect(second.result.scroll?.traveledY).toBe(0);
        // Delivery decides whether the caller can reuse its previous image.
        expect(second.observation).toHaveProperty("screenshot");
        expect(second.observation).toHaveProperty("windowId", "fake-calculator");
        expect(measurements).toEqual([]);
      }),
    ),
  );

  it.effect("keeps the correction but takes no captures when the caller wants no observation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { backend, manager } = yield* calibratedScrollFixture([336, 64]);

        yield* manager.scrollCalibrated("thread-1", { x: 1_100, y: 200 }, 0, 400, {
          observe: true,
        });
        // Three on the probing first scroll: before, after the probe, after the rest.
        expect(backend.callsFor("captureScreenshot")).toHaveLength(3);

        const unobserved = yield* manager.scrollCalibrated(
          "thread-1",
          { x: 1_100, y: 200 },
          0,
          400,
          { observe: false },
        );
        expect(backend.callsFor("captureScreenshot")).toHaveLength(3);
        expect(unobserved.observation).toBeUndefined();
        expect(unobserved.result.scroll?.traveledY).toBeUndefined();
        expect(unobserved.result.scroll?.injected.deltaY).toBe(57.14);
        expect(backend.callsFor("scroll").at(-1)?.args[2]).toBeCloseTo(400 / 7, 6);
      }),
    ),
  );

  it.effect("never re-gears the pane's own scroll, whatever the agent learned", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { backend, manager } = yield* calibratedScrollFixture([336, 64]);
        yield* manager.scrollCalibrated("thread-1", { x: 1_100, y: 200 }, 0, 400, {
          observe: true,
        });
        const capturesAfterLearning = backend.callsFor("captureScreenshot").length;

        // The human is watching the result and closing the loop themselves; a
        // correction applied under their hand would fight them.
        yield* manager.scroll(undefined, { x: 1_100, y: 200 }, 0, 400);
        expect(backend.callsFor("scroll").at(-1)?.args).toEqual([{ x: 1_100, y: 200 }, 0, 400]);
        expect(backend.callsFor("captureScreenshot")).toHaveLength(capturesAfterLearning);
      }),
    ),
  );

  it.effect("delivers the scroll unmeasured when the capture fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { backend, manager } = yield* calibratedScrollFixture([336]);
        backend.failNext("captureScreenshot");

        const result = yield* manager.scrollCalibrated("thread-1", { x: 1_100, y: 200 }, 0, 400, {
          observe: true,
        });

        expect(result.result).toMatchObject({ action: "computer_scroll" });
        expect(result.result.scroll?.traveledY).toBeUndefined();
        expect(result.observation).toBeUndefined();
        expect(backend.callsFor("scroll")).toHaveLength(1);
        // The before-capture failed, so nothing to compare an after-capture against.
        expect(backend.callsFor("captureScreenshot")).toHaveLength(1);
      }),
    ),
  );

  describe("the scroll-leg conditional settle", () => {
    it.effect("waives the leg settle when measured travel already proves arrival", () =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* withEnv("PATHWAY_CUA_CONDITIONAL_SETTLE", "1");
          const { backend, settles, scroll } = yield* settleScrollFixture([336, 64, 400]);
          // One scroll that teaches the window's gearing the settled way, after
          // which the route carries a real prediction and further legs can prove
          // arrival early.
          yield* scroll();
          const capturesBefore = backend.callsFor("captureScreenshot").length;
          const settlesBefore = settles.length;

          const result = yield* scroll();

          // The measured window is trusted in one delivery: injected 400/7, and the
          // early capture measured the predicted 400 — the pixels are the settle
          // evidence, so the 60 ms wait never ran.
          expect(settles.length - settlesBefore).toBe(0);
          expect(result.result.scroll?.traveledY).toBe(400);
          expect(result.result.scroll?.gearing).toBe(7);
          expect(backend.callsFor("captureScreenshot")).toHaveLength(capturesBefore + 2);
          expect(result.observation !== undefined && "screenshot" in result.observation).toBe(true);
        }),
      ),
    );

    it.effect("keeps the settle when the correlation refuses the early capture", () =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* withEnv("PATHWAY_CUA_CONDITIONAL_SETTLE", "1");
          const { backend, settles, scroll } = yield* settleScrollFixture([
            336,
            64,
            undefined,
            undefined,
          ]);
          yield* scroll();
          const capturesBefore = backend.callsFor("captureScreenshot").length;
          const settlesBefore = settles.length;

          const result = yield* scroll();

          // A refused measurement is not arrival: the leg pays the settle and
          // re-measures on a settled frame, which also refuses — delivered and
          // unmeasured, exactly the outcome the fixed wait exists for.
          expect(settles.length - settlesBefore).toBe(1);
          expect(result.result.scroll?.traveledY).toBeUndefined();
          expect(result.result.scroll?.gearing).toBe(7);
          expect(backend.callsFor("captureScreenshot")).toHaveLength(capturesBefore + 3);
        }),
      ),
    );

    it.effect("keeps the settle when early travel misses the prediction, and never learns it", () =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* withEnv("PATHWAY_CUA_CONDITIONAL_SETTLE", "1");
          const { backend, settles, scroll } = yield* settleScrollFixture([336, 64, 250, 400]);
          yield* scroll();
          const capturesBefore = backend.callsFor("captureScreenshot").length;
          const settlesBefore = settles.length;

          const result = yield* scroll();

          // 250 against a predicted 400 is a mid-animation frame, not arrival: the
          // leg settles and measures the settled 400. Had the early sample been
          // learned it would have dragged the smoothed gearing toward ~5.7; the
          // reported 7 proves it was dropped.
          expect(settles.length - settlesBefore).toBe(1);
          expect(result.result.scroll?.traveledY).toBe(400);
          expect(result.result.scroll?.gearing).toBe(7);
          expect(backend.callsFor("captureScreenshot")).toHaveLength(capturesBefore + 3);
        }),
      ),
    );

    it.effect("keeps the probe leg's settle — an unmeasured route has no prediction to prove", () =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* withEnv("PATHWAY_CUA_CONDITIONAL_SETTLE", "1");
          const { backend, settles, scroll } = yield* settleScrollFixture([336, 64]);

          const result = yield* scroll();

          // The probe's own measurement is what establishes the gearing, so its
          // settle is exactly the wait that must not be waived. The remainder it
          // just taught — predicted travel 64 — is the leg that skips.
          expect(settles).toHaveLength(1);
          expect(result.result.scroll?.traveledY).toBe(400);
          expect(result.result.scroll?.gearing).toBe(7);
          expect(result.result.scroll?.routes).toEqual(["wheel", "wheel"]);
          expect(backend.callsFor("captureScreenshot")).toHaveLength(3);
        }),
      ),
    );

    it.effect("keeps every settle and takes no early capture under the kill switch", () =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* withEnv("PATHWAY_CUA_CONDITIONAL_SETTLE", "0");
          const { backend, settles, scroll } = yield* settleScrollFixture([336, 64, 400]);
          yield* scroll();
          const capturesBefore = backend.callsFor("captureScreenshot").length;
          const settlesBefore = settles.length;

          const result = yield* scroll();

          // Bit-identical to the pre-flag path: settle, then one capture to
          // measure and observe with — never the speculative early capture.
          expect(settles.length - settlesBefore).toBe(1);
          expect(result.result.scroll?.traveledY).toBe(400);
          expect(backend.callsFor("captureScreenshot")).toHaveLength(capturesBefore + 2);
        }),
      ),
    );

    it.effect("keeps the settle on an unchanged scroll and still reports traveledY 0", () =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* withEnv("PATHWAY_CUA_CONDITIONAL_SETTLE", "1");
          // Exactly three queued screenshots cover the teaching scroll's captures;
          // everything after returns the one fixture image, which is what the end
          // of a page looks like — byte-identical, so measurement answers 0.
          const { backend, settles, scroll } = yield* settleScrollFixture(
            [336, 64],
            new FakeComputerBackend(),
            3,
          );
          yield* scroll();
          const capturesBefore = backend.callsFor("captureScreenshot").length;
          const settlesBefore = settles.length;

          const result = yield* scroll();

          // Zero measured travel is the edge-of-page signal, not arrival: the leg
          // settles, re-measures the same zero, and reports it — the signal the
          // tool layer's fourth-unchanged refusal feeds on must survive the flag.
          expect(settles.length - settlesBefore).toBe(1);
          expect(result.result.scroll?.traveledY).toBe(0);
          expect(backend.callsFor("captureScreenshot")).toHaveLength(capturesBefore + 3);
        }),
      ),
    );

    it.effect("does not let a waived settle upgrade a dispatched-unknown verdict", () =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* withEnv("PATHWAY_CUA_CONDITIONAL_SETTLE", "1");
          class UnknownScrollBackend extends FakeComputerBackend {
            override scroll(...args: Parameters<FakeComputerBackend["scroll"]>) {
              return Effect.as(super.scroll(...args), {
                deliveryPath: "fake-scroll",
                verified: "unconfirmed" as const,
                effect: "dispatched-unknown" as const,
              });
            }
          }
          const { settles, scroll } = yield* settleScrollFixture(
            [336, 64, 400],
            new UnknownScrollBackend(),
          );
          yield* scroll();
          const settlesBefore = settles.length;

          const result = yield* scroll();

          // The measured arrival waives the wait, but the backend's own verdict
          // stands: the observation proving travel is not the driver reporting
          // the delivery verified.
          expect(settles.length - settlesBefore).toBe(0);
          expect(result.result.scroll?.traveledY).toBe(400);
          expect(result.result.delivery).toEqual({
            path: "fake-scroll",
            verified: "unconfirmed",
            effect: "dispatched-unknown",
          });
        }),
      ),
    );
  });
});
