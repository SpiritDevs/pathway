import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  type ComputerInputMonitorState,
  type EscapeKillSwitchMonitor,
  make,
  type PhysicalComputerInput,
} from "./EscapeKillSwitchMonitor.ts";
import { type FakeHelperSpawner, makeFakeHelperSpawner } from "./testing/FakeHelperSpawner.ts";

interface Harness {
  readonly monitor: EscapeKillSwitchMonitor;
  readonly fake: FakeHelperSpawner;
  readonly escapes: Queue.Queue<void>;
  readonly inputs: Array<PhysicalComputerInput>;
  readonly nextInput: Effect.Effect<PhysicalComputerInput>;
  readonly errors: Queue.Queue<string>;
  readonly states: Array<ComputerInputMonitorState>;
  /** Resolves once the monitor has published `expected` (or already holds it). */
  readonly awaitState: (expected: ComputerInputMonitorState) => Effect.Effect<void>;
}

const sameState = (a: ComputerInputMonitorState, b: ComputerInputMonitorState) =>
  a.ready === b.ready && a.error === b.error;

const withMonitor = <A, E>(body: (harness: Harness) => Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const fake = yield* makeFakeHelperSpawner;
    const scope = yield* Scope.make();
    const escapes = yield* Queue.unbounded<void>();
    const inputQueue = yield* Queue.unbounded<PhysicalComputerInput>();
    const errors = yield* Queue.unbounded<string>();
    const inputs: Array<PhysicalComputerInput> = [];
    const states: Array<ComputerInputMonitorState> = [];
    const waiters: Array<{
      expected: ComputerInputMonitorState;
      deferred: Deferred.Deferred<void>;
    }> = [];
    let latest: ComputerInputMonitorState = { ready: false, error: "input_monitor_starting" };

    const monitor = yield* make({
      helperPath: "/fixture/pathway-helper",
      onEscape: () => Queue.offer(escapes, undefined).pipe(Effect.asVoid),
      onPhysicalInput: (event) =>
        Effect.sync(() => inputs.push(event)).pipe(
          Effect.andThen(Queue.offer(inputQueue, event)),
          Effect.asVoid,
        ),
      onError: (message) => Queue.offer(errors, message).pipe(Effect.asVoid),
      onStateChange: (state) =>
        Effect.sync(() => {
          latest = state;
          states.push(state);
          for (const waiter of waiters.splice(0)) {
            if (sameState(waiter.expected, state)) Deferred.doneUnsafe(waiter.deferred, Exit.void);
            else waiters.push(waiter);
          }
        }),
    }).pipe(
      Scope.provide(scope),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fake.layer),
    );

    const awaitState = (expected: ComputerInputMonitorState) =>
      Effect.suspend(() => {
        if (sameState(latest, expected)) return Effect.void;
        const deferred = Deferred.makeUnsafe<void>();
        waiters.push({ expected, deferred });
        return Deferred.await(deferred);
      });

    return yield* body({
      monitor,
      fake,
      escapes,
      inputs,
      nextInput: Queue.take(inputQueue),
      errors,
      states,
      awaitState,
    }).pipe(Effect.ensuring(Scope.close(scope, Exit.void)));
  });

describe("EscapeKillSwitchMonitor", () => {
  it.effect("forwards arm and disarm commands to the helper", () =>
    withMonitor(({ monitor, fake }) =>
      Effect.gen(function* () {
        yield* monitor.start;
        const helper = yield* fake.next;
        yield* monitor.setArmed(true);
        yield* monitor.setArmed(false);
        yield* helper.awaitStdin("disarm");
        assert.deepStrictEqual(helper.stdinLines, ["arm", "disarm"]);
      }),
    ),
  );

  it.effect("reports an escape line from the helper exactly once per line", () =>
    withMonitor(({ monitor, fake, escapes }) =>
      Effect.gen(function* () {
        yield* monitor.start;
        const helper = yield* fake.next;
        yield* monitor.setArmed(true);
        yield* helper.emit('{"type":"ready"}');
        yield* helper.emit('{"type":"escape","capturedAt":"2026-09-18T00:00:00Z"}');
        yield* Queue.take(escapes);
        assert.strictEqual(yield* Queue.size(escapes), 0);
        // A second physical press is a second event: repeated presses are not
        // coalesced, because each one re-confirms the kill.
        yield* helper.emit('{"type":"escape"}');
        yield* Queue.take(escapes);
        assert.strictEqual(yield* Queue.size(escapes), 0);
      }),
    ),
  );

  it.effect("ignores ready and state messages but forwards helper errors", () =>
    withMonitor(({ monitor, fake, escapes, errors }) =>
      Effect.gen(function* () {
        yield* monitor.start;
        const helper = yield* fake.next;
        yield* helper.emit('{"type":"ready"}');
        yield* helper.emit('{"type":"escape-monitor-state","armed":true}');
        yield* helper.emit(
          '{"type":"error","code":"input-monitoring-required","message":"input monitoring denied"}',
        );
        yield* helper.emit("not json at all");
        assert.strictEqual(yield* Queue.take(errors), "input monitoring denied");
        assert.strictEqual(yield* Queue.size(escapes), 0);
        assert.deepStrictEqual(yield* monitor.state, {
          ready: false,
          error: "input-monitoring-required",
        });
      }),
    ),
  );

  it.effect("respawns after an unexpected exit and replays the armed state", () =>
    withMonitor(({ monitor, fake, awaitState }) =>
      Effect.gen(function* () {
        yield* monitor.start;
        const first = yield* fake.next;
        yield* monitor.setArmed(true);
        yield* first.exit(1);
        yield* awaitState({ ready: false, error: "input_monitor_unavailable" });
        // The first respawn waits the base backoff, not forever.
        yield* TestClock.adjust(1_100);
        const second = yield* fake.next;
        // The armed side of the gate is replayed so a restarted helper does not
        // silently widen the window where Escape is inert.
        yield* second.awaitStdin("arm");
        assert.deepStrictEqual(second.stdinLines, ["arm"]);
      }),
    ),
  );

  it.effect(
    "publishes missing listener access and recovers when the existing helper becomes ready",
    () =>
      withMonitor(({ monitor, fake, escapes, inputs, nextInput, states, awaitState }) =>
        Effect.gen(function* () {
          yield* monitor.start;
          const helper = yield* fake.next;
          yield* monitor.setArmed(true);
          yield* helper.emit(
            '{"type":"error","code":"input-monitoring-required","message":"Permission required"}',
          );
          yield* helper.emit(
            '{"type":"physical-input","kind":"keyboard","pid":50,"text":"never forwarded"}',
          );
          yield* helper.emit('{"type":"escape"}');
          yield* awaitState({ ready: false, error: "input-monitoring-required" });
          yield* helper.emit('{"type":"ready"}');
          yield* helper.emit(
            '{"type":"physical-input","kind":"pointer","pid":50,"windowId":70,"text":"never forwarded"}',
          );
          // Lines are handled in order, so the pointer event arriving proves the
          // keyboard event and Escape before readiness were dropped.
          assert.deepStrictEqual(yield* nextInput, {
            type: "physical-input",
            kind: "pointer",
            pid: 50,
            windowId: 70,
          });
          assert.strictEqual(inputs.length, 1);
          assert.strictEqual(yield* Queue.size(escapes), 0);
          assert.deepStrictEqual(yield* monitor.state, { ready: true });
          assert.strictEqual(fake.spawned.length, 1);
          assert.deepStrictEqual(states.at(-1), { ready: true });

          yield* monitor.setArmed(false);
          yield* helper.emit('{"type":"physical-input","kind":"keyboard","pid":50}');
          yield* helper.emit('{"type":"escape"}');
          // The exit is reported only after stdout drains, so it orders the
          // assertions after both disarmed lines.
          yield* helper.exit(0);
          yield* awaitState({ ready: false, error: "input_monitor_unavailable" });
          assert.strictEqual(inputs.length, 1);
          assert.strictEqual(yield* Queue.size(escapes), 0);
        }),
      ),
  );

  it.effect(
    "replaces a denied listener only after a fresh permission probe confirms the grant",
    () =>
      withMonitor(({ monitor, fake }) =>
        Effect.gen(function* () {
          const denied = yield* Effect.forkChild(monitor.activate());
          const first = yield* fake.next;
          yield* first.emit(
            '{"type":"error","code":"input-monitoring-required","message":"Denied"}',
          );
          yield* Fiber.join(denied);
          yield* monitor.activate();
          assert.strictEqual(fake.spawned.length, 1);

          const recovered = yield* Effect.forkChild(monitor.activate(true));
          const second = yield* fake.next;
          assert.strictEqual(fake.spawned.length, 2);
          // Whatever the replaced listener still says is not trusted.
          yield* first.emit('{"type":"ready"}');
          assert.isFalse((yield* monitor.state).ready);
          yield* second.emit('{"type":"ready"}');
          yield* Fiber.join(recovered);
          assert.isTrue((yield* monitor.state).ready);
          assert.deepStrictEqual(first.signals, ["SIGTERM"]);
        }),
      ),
  );

  it.effect("closes readiness on helper exit and ignores late messages from that process", () =>
    withMonitor(({ monitor, fake, inputs, awaitState }) =>
      Effect.gen(function* () {
        yield* monitor.start;
        const helper = yield* fake.next;
        yield* monitor.setArmed(true);
        yield* helper.emit('{"type":"ready"}');
        yield* awaitState({ ready: true });
        yield* helper.exit(1);
        yield* awaitState({ ready: false, error: "input_monitor_unavailable" });
        // The exited process has no stdout left; anything it "says" now is dropped.
        yield* helper.emit('{"type":"ready"}');
        yield* helper.emit('{"type":"physical-input","kind":"keyboard","pid":50}');
        assert.deepStrictEqual(yield* monitor.state, {
          ready: false,
          error: "input_monitor_unavailable",
        });
        assert.strictEqual(inputs.length, 0);
      }),
    ),
  );

  it.effect("waits for first activation readiness without spawning or polling while unused", () =>
    withMonitor(({ monitor, fake, awaitState }) =>
      Effect.gen(function* () {
        assert.strictEqual(fake.spawned.length, 0);
        let completed = false;
        const activation = yield* Effect.forkChild(
          monitor.activate().pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                completed = true;
              }),
            ),
          ),
        );
        const helper = yield* fake.next;
        yield* helper.awaitStdin("arm");
        assert.deepStrictEqual(helper.stdinLines, ["arm"]);
        assert.isFalse(completed);
        yield* helper.emit('{"type":"ready"}');
        yield* Fiber.join(activation);
        assert.isTrue((yield* monitor.state).ready);

        yield* monitor.setArmed(false);
        assert.deepStrictEqual(yield* monitor.state, { ready: false, error: "input_monitor_idle" });
        const reactivated = yield* Effect.forkChild(monitor.activate());
        yield* awaitState({ ready: false, error: "input_monitor_starting" });
        yield* helper.emit('{"type":"ready"}');
        yield* Fiber.join(reactivated);
        assert.strictEqual(fake.spawned.length, 1);
      }),
    ),
  );

  it.effect("bounds readiness waits and does not restart a helper after disarm", () =>
    withMonitor(({ monitor, fake, awaitState }) =>
      Effect.gen(function* () {
        const activation = yield* Effect.forkChild(monitor.activate());
        const helper = yield* fake.next;
        yield* TestClock.adjust(1_000);
        yield* Fiber.join(activation);
        assert.isFalse((yield* monitor.state).ready);
        yield* helper.exit(1);
        yield* awaitState({ ready: false, error: "input_monitor_unavailable" });
        yield* monitor.setArmed(false);
        yield* TestClock.adjust(60_000);
        assert.strictEqual(fake.spawned.length, 1);
      }),
    ),
  );

  it.effect("does not spawn twice when activation overtakes the restart timer", () =>
    withMonitor(({ monitor, fake, awaitState }) =>
      Effect.gen(function* () {
        const firstActivation = yield* Effect.forkChild(monitor.activate());
        const first = yield* fake.next;
        yield* first.emit('{"type":"ready"}');
        yield* Fiber.join(firstActivation);
        yield* first.exit(1);
        yield* awaitState({ ready: false, error: "input_monitor_unavailable" });
        const secondActivation = yield* Effect.forkChild(monitor.activate());
        const second = yield* fake.next;
        yield* second.emit('{"type":"ready"}');
        yield* Fiber.join(secondActivation);
        yield* TestClock.adjust(30_000);
        assert.strictEqual(fake.spawned.length, 2);
      }),
    ),
  );

  it.effect("does not respawn once disposed", () =>
    withMonitor(({ monitor, fake }) =>
      Effect.gen(function* () {
        yield* monitor.start;
        const first = yield* fake.next;
        yield* monitor.dispose;
        // The signal is delivered on its own, already scheduled, fiber.
        yield* Effect.yieldNow;
        assert.deepStrictEqual(first.signals, ["SIGTERM"]);
        yield* first.exit(0);
        yield* TestClock.adjust(60_000);
        assert.strictEqual(fake.spawned.length, 1);
        assert.deepStrictEqual(yield* monitor.state, {
          ready: false,
          error: "input_monitor_stopped",
        });
      }),
    ),
  );
});
