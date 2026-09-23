import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { expect } from "vite-plus/test";

import { cuaRequest } from "@spiritdevs/shared/cuaDriverProtocol";

import { type CuaInputMonitorState, ESCAPE_INPUT_COOLDOWN_MS } from "./CuaDriverHost.ts";
import { CAPABILITY, type Fixture, makeFixture } from "./testing/CuaDriverFixture.ts";

/**
 * Physical input while the agent drives the real cursor and keyboard: the one
 * collision that still interrupts, and so the way into native takeover.
 */
const foregroundCollision = (
  f: Fixture,
  task: { threadId: string; turnId: string },
  target: { pid: number; window_id: number },
) =>
  Effect.gen(function* () {
    const typing = yield* f
      .send(
        {
          method: "call",
          name: "type_text",
          args: { ...target, delivery_mode: "foreground", text: "fixture" },
          task,
        },
        { mutation: true },
      )
      .pipe(Effect.forkChild);
    yield* f.waitForEvent("dispatch");
    assert.isTrue(
      yield* f.host.physicalInput({
        kind: "pointer",
        pid: target.pid,
        windowId: target.window_id,
      }),
    );
    expect(yield* Fiber.join(typing)).toMatchObject({ ok: false, effect: "dispatched-unknown" });
    yield* f.waitForEvent("interrupt-ack");
  });

describe("physical Escape interrupt", () => {
  const pressKey = (f: Fixture) =>
    f.send({ method: "call", name: "press_key", args: { key: "enter" } });

  it.live("ignores the press when nothing is driving, so Escape stays an ordinary key", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture();
      // No live or spawning generation and no held latch: the host reports the
      // press did not engage, and mutating admission still works afterwards.
      assert.isFalse(yield* f.host.emergencyStopInput);
      expect(yield* pressKey(f)).toMatchObject({ ok: true });
    }),
  );

  it.live(
    "drains native input, keeps the generation, and requires fresh observation after Escape",
    () =>
      Effect.gen(function* () {
        let releaseCalls = 0;
        const f = yield* makeFixture({
          releaseHeldInput: Effect.sync(() => {
            releaseCalls += 1;
          }),
        });
        // Prime a live generation.
        expect(yield* pressKey(f)).toMatchObject({ ok: true });

        // The fake driver holds a type_text reply for 10s — the wedged-provider
        // shape the interrupt exists for. The press must not wait on it.
        const hung = yield* f
          .send(
            { method: "call", name: "type_text", args: { text: "fixture" } },
            { timeoutMs: 5_000, mutation: true },
          )
          .pipe(Effect.forkChild);
        yield* f.waitForEvent("dispatch");
        assert.isTrue(yield* f.host.emergencyStopInput);
        // A socket abort returns promptly, while the separate native interrupt
        // drains the old operation and releases its own held input.
        expect(yield* Fiber.join(hung)).toMatchObject({ ok: false });
        yield* f.waitForEvent("interrupt-ack");
        assert.strictEqual(releaseCalls, 0);
        const mid = yield* f.eventNames;
        assert.include(mid, "interrupt");
        assert.lengthOf(
          mid.filter((event) => event === "release"),
          1,
        );
        assert.notInclude(mid, "effect");
        assert.notInclude(mid, "cancel");
        assert.notInclude(mid, "retiring");
        assert.lengthOf(
          mid.filter((event) => event === "start"),
          1,
        );

        // Inside the cooldown a mutating call is refused with the paused
        // dialect, while reads keep dispatching on the same generation.
        expect(yield* pressKey(f)).toMatchObject({
          ok: true,
          result: {
            isError: true,
            structuredContent: { effect: "refused", code: "computer_input_paused" },
          },
        });
        expect(yield* f.send({ method: "call", name: "list_windows" })).toMatchObject({
          ok: true,
        });

        // Time alone cannot make the model's old target state fresh. A preview
        // or target-readiness probe cannot clear the model-observation gate.
        f.advanceClock(ESCAPE_INPUT_COOLDOWN_MS + 50);
        expect(yield* pressKey(f)).toMatchObject({
          result: { structuredContent: { code: "computer_input_paused" } },
          desktopInterruptions: 0,
        });
        yield* f.send({ method: "call", name: "get_window_state" });
        expect(yield* f.send({ method: "call", name: "check_input_ready" })).toMatchObject({
          result: { isError: true },
        });
        yield* f.send({ method: "call", name: "get_window_state", modelObservation: true });
        expect(yield* pressKey(f)).toMatchObject({ ok: true, result: {} });
        const after = yield* f.eventNames;
        assert.lengthOf(
          after.filter((event) => event === "start"),
          1,
        );
        assert.lengthOf(
          after.filter((event) => event === "key"),
          2,
        );
        assert.notInclude(after, "retiring");
      }),
  );

  it.live("interrupts the in-flight action on the backend stop verb without retiring", () =>
    Effect.gen(function* () {
      let releaseCalls = 0;
      const f = yield* makeFixture({
        releaseHeldInput: Effect.sync(() => {
          releaseCalls += 1;
        }),
      });
      expect(yield* pressKey(f)).toMatchObject({ ok: true });
      const hung = yield* f
        .send(
          { method: "call", name: "type_text", args: { text: "fixture" } },
          { timeoutMs: 5_000, mutation: true },
        )
        .pipe(Effect.forkChild);
      yield* f.waitForEvent("dispatch");
      // The same socket verb the backend's stopInput sends on turn Stop,
      // control revoke, and the relayed physical-Escape notice.
      expect(yield* f.send({ method: "stop" })).toMatchObject({ ok: true });
      expect(yield* Fiber.join(hung)).toMatchObject({ ok: false });
      assert.strictEqual(releaseCalls, 0);
      // Native interrupt is reusable; cancel_input still belongs to retirement.
      const mid = yield* f.eventNames;
      assert.include(mid, "interrupt-ack");
      assert.notInclude(mid, "effect");
      assert.notInclude(mid, "cancel");
      assert.notInclude(mid, "retiring");
      assert.lengthOf(
        mid.filter((event) => event === "start"),
        1,
      );
      // A bare stop arms no cooldown — the cooldown belongs to the physical
      // press — so the next action dispatches immediately on the live driver.
      expect(yield* pressKey(f)).toMatchObject({ ok: true });
      const after = yield* f.eventNames;
      assert.lengthOf(
        after.filter((event) => event === "key"),
        2,
      );
      assert.lengthOf(
        after.filter((event) => event === "start"),
        1,
      );
    }),
  );

  it.live(
    "keeps admission closed after a driver crash until the held-input release is confirmed",
    () =>
      Effect.gen(function* () {
        const release = yield* Deferred.make<void>();
        const f = yield* makeFixture({ crash: true, releaseHeldInput: Deferred.await(release) });
        // The fake driver exits on dispatch. The call's own retirement stays
        // pending on the release gate (or the interrupt's abort lands first —
        // either way the crashed generation is still the host's live reference
        // when Escape lands) — and the request's reply is legitimately blocked
        // on that cleanup, which is why it is not joined yet.
        const crashing = yield* f
          .send(
            { method: "call", name: "type_text", args: { text: "fixture" } },
            { timeoutMs: 5_000, mutation: true },
          )
          .pipe(Effect.forkChild);
        yield* f.waitForEvent("crash");
        assert.isTrue(yield* f.host.emergencyStopInput);
        // Let the crash retirement finish: with the release confirmed the dead
        // generation clears, and nothing else holds admission.
        yield* Deferred.succeed(release, undefined);
        expect(yield* Fiber.join(crashing)).toMatchObject({ ok: false });
        // stop joins the pending retirement chain, so its return proves the
        // generation cleared rather than merely having had time to.
        yield* f.host.stop;
        // The replacement generation still needs a fresh model observation;
        // successful crash cleanup does not validate the interrupted model state.
        f.advanceClock(ESCAPE_INPUT_COOLDOWN_MS + 50);
        yield* f.send({ method: "call", name: "get_window_state", modelObservation: true });
        expect(yield* pressKey(f)).toMatchObject({ ok: true, result: {} });
      }),
  );

  it.live(
    "stays fail-closed when the crash cleanup is unconfirmed, with no Escape latch involved",
    () =>
      Effect.gen(function* () {
        const f = yield* makeFixture({
          crash: true,
          releaseHeldInput: Effect.fail({ message: "helper gone" }),
        });
        expect(
          yield* f.send(
            { method: "call", name: "type_text", args: { text: "fixture" } },
            { timeoutMs: 5_000, mutation: true },
          ),
        ).toMatchObject({ ok: false });
        // The driver died mid-input and nothing confirmed the OS-level release:
        // the generation stays referenced, and the interrupt cannot reopen what
        // the unprovable held-input state is closing.
        assert.isTrue(yield* f.host.emergencyStopInput);
        expect(yield* f.send({ method: "call", name: "check_permissions" })).toMatchObject({
          ok: false,
          effect: "not-dispatched",
        });
        assert.strictEqual(yield* f.count("start"), 1);
      }),
  );

  it.live(
    "keeps input closed after an incomplete native interrupt and rechecks the drain before dispatch",
    () =>
      Effect.gen(function* () {
        let releaseCalls = 0;
        const f = yield* makeFixture({
          interruptCleanup: "once-incomplete",
          releaseHeldInput: Effect.sync(() => {
            releaseCalls += 1;
          }),
        });
        yield* pressKey(f);
        expect(yield* f.send({ method: "stop" })).toMatchObject({ ok: false });
        assert.strictEqual(releaseCalls, 1);
        assert.strictEqual(yield* f.count("key"), 1);
        expect(yield* pressKey(f)).toMatchObject({ ok: true, result: {} });
        const events = yield* f.eventNames;
        assert.lengthOf(
          events.filter((event) => event === "interrupt"),
          2,
        );
        assert.lengthOf(
          events.filter((event) => event === "key"),
          2,
        );
        assert.isBelow(events.lastIndexOf("interrupt-ack"), events.lastIndexOf("key"));
        assert.lengthOf(
          events.filter((event) => event === "start"),
          1,
        );
      }),
  );

  for (const interruptCleanup of ["wrong-pid", "missing-admission", "incomplete"] as const) {
    it.live(`never resumes input on a ${interruptCleanup} interruption acknowledgement`, () =>
      Effect.gen(function* () {
        const f = yield* makeFixture({ interruptCleanup });
        yield* pressKey(f);
        expect(yield* f.send({ method: "stop" })).toMatchObject({ ok: false });
        expect(yield* pressKey(f)).toMatchObject({ ok: false, effect: "not-dispatched" });
        assert.strictEqual(yield* f.count("key"), 1);
      }),
    );
  }

  it.live(
    "keeps background control running through the human's typing, clicks and app switches",
    () =>
      Effect.gen(function* () {
        const f = yield* makeFixture();
        const task = { threadId: "background", turnId: "turn" };
        const args = { pid: 700, window_id: 900, key: "enter" };
        yield* f.send({ method: "call", name: "press_key", args, task });
        // Keys in the controlled app (⌘-Tab included), clicks on its window, and
        // input anywhere else: none of it touches background work.
        assert.isFalse(yield* f.host.physicalInput({ kind: "keyboard", pid: 700 }));
        assert.isFalse(yield* f.host.physicalInput({ kind: "pointer", pid: 700, windowId: 900 }));
        assert.isFalse(yield* f.host.physicalInput({ kind: "keyboard", pid: 701 }));
        expect(yield* f.send({ method: "call", name: "press_key", args, task })).toMatchObject({
          ok: true,
          result: {},
        });
        assert.strictEqual(yield* f.count("interrupt"), 0);
        assert.strictEqual(yield* f.count("key"), 2);
      }),
  );

  it.live(
    "interrupts foreground input even when the physical event belongs to a different app",
    () =>
      Effect.gen(function* () {
        const f = yield* makeFixture();
        const hung = yield* f
          .send(
            {
              method: "call",
              name: "type_text",
              args: { pid: 700, window_id: 900, delivery_mode: "foreground", text: "fixture" },
            },
            { mutation: true },
          )
          .pipe(Effect.forkChild);
        yield* f.waitForEvent("dispatch");
        assert.isTrue(yield* f.host.physicalInput({ kind: "keyboard", pid: 701 }));
        expect(yield* Fiber.join(hung)).toMatchObject({ ok: false, effect: "dispatched-unknown" });
        yield* f.waitForEvent("interrupt-ack");
        assert.strictEqual(yield* f.count("release"), 1);
      }),
  );

  for (const scoped of [true, false]) {
    it.live(
      `keeps foreground recovery paused through continued typing (scoped target: ${scoped})`,
      () =>
        Effect.gen(function* () {
          const f = yield* makeFixture({ delayObservation: true });
          const task = { threadId: "foreground-recovery", turnId: "turn" };
          const target = scoped ? { pid: 700, window_id: 900 } : {};
          const typing = yield* f
            .send(
              {
                method: "call",
                name: "type_text",
                args: { ...target, delivery_mode: "foreground", text: "fixture" },
                task,
              },
              { mutation: true },
            )
            .pipe(Effect.forkChild);
          yield* f.waitForEvent("dispatch");
          const physicalInput = f.host.physicalInput({ kind: "keyboard", pid: 700 });
          assert.isTrue(yield* physicalInput);
          expect(yield* Fiber.join(typing)).toMatchObject({
            ok: false,
            effect: "dispatched-unknown",
          });
          yield* f.waitForEvent("interrupt-ack");
          f.advanceClock(ESCAPE_INPUT_COOLDOWN_MS + 50);

          const observe = f.send({
            method: "call",
            name: "get_window_state",
            args: target,
            modelObservation: true,
            task,
          });
          const act = f.send({
            method: "call",
            name: "press_key",
            args: { ...target, delivery_mode: "foreground", key: "enter" },
            task,
          });
          const reading = yield* Effect.forkChild(observe);
          yield* f.waitForEvent("observe");
          // The interrupted action already returned; input must still invalidate this read.
          assert.isTrue(yield* physicalInput);
          expect(yield* Fiber.join(reading)).toMatchObject({
            result: { structuredContent: { code: "computer_input_paused" } },
          });
          expect(yield* act).toMatchObject({
            result: { structuredContent: { code: "computer_input_paused" } },
          });
          // An early read must not disarm recovery tracking during the new cooldown.
          yield* observe;
          assert.isTrue(yield* physicalInput);
          assert.strictEqual(yield* f.count("interrupt"), 1);
          f.advanceClock(ESCAPE_INPUT_COOLDOWN_MS + 50);
          expect(yield* act).toMatchObject({
            result: { structuredContent: { code: "computer_input_paused" } },
          });
          yield* observe;
          expect(yield* act).toMatchObject({ ok: true, result: {} });
          assert.isFalse(yield* physicalInput);
          assert.strictEqual(yield* f.count("key"), 1);
        }),
    );
  }

  it.live("starts listener activation only on use and disarms it when the last task ends", () =>
    Effect.gen(function* () {
      let state: CuaInputMonitorState = { ready: false, error: "input_monitor_idle" };
      let activations = 0;
      const armedChanges: boolean[] = [];
      const f = yield* makeFixture({
        activateInputMonitor: Effect.sync(() => {
          activations += 1;
          state = { ready: true };
        }),
        onInputMonitorArmedChange: (armed) => {
          armedChanges.push(armed);
          if (!armed) state = { ready: false, error: "input_monitor_idle" };
        },
        inputMonitorState: Effect.sync(() => state),
      });
      assert.strictEqual(activations, 0);
      const task = { threadId: "activation", turnId: "turn" };
      yield* f.send({ method: "call", name: "press_key", args: { key: "enter" }, task });
      assert.strictEqual(activations, 1);
      yield* f.send({ method: "end_task", task });
      assert.strictEqual(armedChanges.at(-1), false);
      yield* f.send({
        method: "call",
        name: "press_key",
        args: { key: "enter" },
        task: { ...task, turnId: "next" },
      });
      assert.strictEqual(activations, 2);
      assert.strictEqual(yield* f.count("key"), 2);
    }),
  );

  it.live(
    "keeps passive status checks and previews idle until actual model Computer work starts",
    () =>
      Effect.gen(function* () {
        let state: CuaInputMonitorState = { ready: false, error: "input_monitor_idle" };
        let activations = 0;
        const armedChanges: boolean[] = [];
        const f = yield* makeFixture({
          activateInputMonitor: Effect.sync(() => {
            activations += 1;
            state = { ready: true };
          }),
          onInputMonitorArmedChange: (armed) => {
            armedChanges.push(armed);
            if (!armed) state = { ready: false, error: "input_monitor_idle" };
          },
          inputMonitorState: Effect.sync(() => state),
          checkPermissions: () =>
            Effect.succeed({ accessibility: true, screenRecording: true, inputMonitoring: true }),
        });
        for (let i = 0; i < 3; i += 1) {
          yield* f.send({ method: "probe" });
          const status = yield* f.send({ method: "call", name: "check_permissions" });
          expect(status.result?.structuredContent).not.toHaveProperty("input_monitor_ready");
          expect(status.result?.structuredContent).not.toHaveProperty("input_monitor_error");
        }
        const task = { threadId: "passive-preview", turnId: "turn" };
        yield* f.send({
          method: "call",
          name: "get_window_state",
          args: { pid: 700, window_id: 900 },
          task,
          modelObservation: false,
        });
        assert.strictEqual(activations, 0);
        assert.lengthOf(armedChanges, 0);
        assert.isFalse(yield* f.host.isInputMonitorRequested);
        yield* f.send({
          method: "call",
          name: "get_window_state",
          args: { pid: 700, window_id: 900 },
          task,
          modelObservation: true,
        });
        assert.strictEqual(activations, 1);
        assert.isTrue(yield* f.host.isInputMonitorRequested);
        yield* f.send({ method: "end_task", task });
        yield* f.send({ method: "call", name: "check_permissions" });
        assert.strictEqual(activations, 1);
        assert.isFalse(yield* f.host.isInputMonitorRequested);
        assert.strictEqual(armedChanges.at(-1), false);
      }),
  );

  it.live("exposes granted-but-unavailable monitoring and requires recovery before input", () =>
    Effect.gen(function* () {
      let state: CuaInputMonitorState = { ready: false, error: "event_tap_unavailable" };
      const f = yield* makeFixture({
        inputMonitorState: Effect.sync(() => state),
        checkPermissions: () =>
          Effect.succeed({ accessibility: true, screenRecording: true, inputMonitoring: true }),
      });
      expect(yield* pressKey(f)).toMatchObject({
        result: { structuredContent: { effect: "refused", code: "input_monitor_unavailable" } },
      });
      expect(yield* f.send({ method: "call", name: "check_permissions" })).toMatchObject({
        result: {
          structuredContent: {
            input_monitoring: true,
            input_monitor_ready: false,
            input_monitor_error: "event_tap_unavailable",
          },
        },
      });
      state = { ready: true };
      expect(yield* pressKey(f)).toMatchObject({ ok: true, result: {} });
      state = { ready: false, error: "input_monitor_unavailable" };
      yield* f.host.inputMonitorStateChanged(state);
      yield* f.waitForEvent("interrupt-ack");
      expect(yield* pressKey(f)).toMatchObject({
        result: { structuredContent: { code: "input_monitor_unavailable" } },
        desktopInterruptions: 0,
      });
      state = { ready: true };
      expect(yield* pressKey(f)).toMatchObject({
        result: { structuredContent: { code: "computer_input_paused" } },
      });
      yield* f.send({ method: "call", name: "get_window_state", modelObservation: true });
      expect(yield* pressKey(f)).toMatchObject({ ok: true, result: {} });
    }),
  );

  it.live(
    "drains an interrupted browser mutation and uses the new epoch without retiring its binding",
    () =>
      Effect.gen(function* () {
        const f = yield* makeFixture({ browserHang: true });
        const task = { threadId: "browser-stop", turnId: "turn" };
        const hung = yield* f
          .send(
            { method: "call", name: "browser_type", args: { text: "fixture" }, task },
            { mutation: true },
          )
          .pipe(Effect.forkChild);
        yield* f.waitForEvent("browser-dispatch");
        expect(yield* f.send({ method: "stop" })).toMatchObject({ ok: true });
        expect(yield* Fiber.join(hung)).toMatchObject({ ok: false, effect: "dispatched-unknown" });
        expect(
          yield* f.send({ method: "call", name: "browser_navigate", args: {}, task }),
        ).toMatchObject({ ok: true, result: {} });
        const events = yield* f.eventNames;
        assert.lengthOf(
          events.filter((event) => event === "release"),
          1,
        );
        assert.lengthOf(
          events.filter((event) => event === "start"),
          1,
        );
        assert.notInclude(events, "browser-effect");
      }),
  );

  for (const name of ["type_text", "browser_type"]) {
    it.live(
      `drains already-dispatched ${name} when its caller disconnects, without replay or replacement`,
      () =>
        Effect.gen(function* () {
          const f = yield* makeFixture({ browserHang: true, inputDelayMs: 150 });
          const controller = new AbortController();
          // The raw client, not f.send: the caller-side rejection carries the
          // `effect` verdict this case asserts.
          const call = yield* Effect.promise(() =>
            cuaRequest(
              f.endpoint,
              {
                capability: CAPABILITY,
                method: "call",
                name,
                args: { text: "fixture" },
                task: { threadId: "disconnect", turnId: "turn" },
              },
              { mutation: true, signal: controller.signal },
            ).catch((error: unknown) => error),
          ).pipe(Effect.forkChild);
          yield* f.waitForEvent(name === "browser_type" ? "browser-dispatch" : "dispatch");
          controller.abort();
          expect(yield* Fiber.join(call)).toMatchObject({ effect: "dispatched-unknown" });
          yield* f.waitForEvent("interrupt");
          // The next call is admitted behind the matching native cleanup ACK.
          expect(yield* pressKey(f)).toMatchObject({ ok: true, result: {} });
          // The driver clears the held action's effect timer in the same tick
          // it logs `interrupt`, so a late effect can no longer land.
          const events = yield* f.eventNames;
          assert.lengthOf(
            events.filter((event) => event === "release"),
            1,
          );
          assert.lengthOf(
            events.filter((event) => event === "start"),
            1,
          );
          assert.isAbove(events.indexOf("key"), events.indexOf("interrupt-ack"));
          assert.notInclude(events, "effect");
          assert.notInclude(events, "browser-effect");
        }),
    );
  }

  it.live(
    "requires a live Escape listener for browser mutations but keeps browser reads available",
    () =>
      Effect.gen(function* () {
        let state: CuaInputMonitorState = { ready: false, error: "event_tap_unavailable" };
        const f = yield* makeFixture({ inputMonitorState: Effect.sync(() => state) });
        const task = { threadId: "listener-browser", turnId: "turn" };
        const action = f.send({ method: "call", name: "browser_navigate", args: {}, task });
        expect(yield* action).toMatchObject({
          result: { structuredContent: { code: "input_monitor_unavailable" } },
        });
        expect(
          yield* f.send({ method: "call", name: "get_browser_state", args: {}, task }),
        ).toMatchObject({ ok: true, result: {} });
        state = { ready: true };
        expect(yield* action).toMatchObject({ ok: true, result: {} });
        assert.lengthOf(
          (yield* f.eventNames).filter((event) => event.startsWith("browser:browser_navigate:")),
          1,
        );
      }),
  );

  it.live("rechecks browser listener readiness after asynchronous session setup", () =>
    Effect.gen(function* () {
      let checks = 0;
      const f = yield* makeFixture({
        inputMonitorState: Effect.sync(
          (): CuaInputMonitorState =>
            ++checks === 1 ? { ready: true } : { ready: false, error: "event_tap_unavailable" },
        ),
      });
      expect(
        yield* f.send({
          method: "call",
          name: "browser_navigate",
          args: {},
          task: { threadId: "late-listener-failure", turnId: "turn" },
        }),
      ).toMatchObject({
        result: { structuredContent: { code: "input_monitor_unavailable" } },
      });
      assert.isFalse(
        (yield* f.eventNames).some((event) => event.startsWith("browser:browser_navigate:")),
      );
    }),
  );

  it.live("does not mistake OS releases or later reads for an unconfirmed browser release", () =>
    Effect.gen(function* () {
      let releaseCalls = 0;
      const f = yield* makeFixture({
        browserCleanupUnconfirmed: true,
        releaseHeldInput: Effect.sync(() => {
          releaseCalls += 1;
        }),
      });
      const task = { threadId: "browser-cleanup", turnId: "turn" };
      expect(yield* f.send({ method: "call", name: "browser_type", args: {}, task })).toMatchObject(
        {
          result: { isError: true, structuredContent: { input_cleanup_unconfirmed: true } },
        },
      );
      yield* f.send({ method: "call", name: "get_browser_state", args: {}, task });
      expect(yield* f.send({ method: "stop" })).toMatchObject({ ok: false });
      expect(yield* pressKey(f)).toMatchObject({ ok: false, effect: "not-dispatched" });
      assert.strictEqual(releaseCalls, 0);
      assert.notInclude(yield* f.eventNames, "key");
    }),
  );

  it.live(
    "does not let another task, window, preview, or mismatched read clear native takeover",
    () =>
      Effect.gen(function* () {
        const f = yield* makeFixture();
        const taskA = { threadId: "task-a", turnId: "turn" };
        const taskB = { threadId: "task-b", turnId: "turn" };
        const windowA = { pid: 701, window_id: 901 };
        const windowB = { pid: 700, window_id: 900 };
        const observe = (
          task: typeof taskA,
          args: Record<string, unknown>,
          modelObservation = true,
        ) => f.send({ method: "call", name: "get_window_state", args, modelObservation, task });
        const click = (task: typeof taskA, args: Record<string, unknown>) =>
          f.send({ method: "call", name: "press_key", args: { ...args, key: "enter" }, task });
        yield* observe(taskA, windowA);
        yield* observe(taskB, windowB);
        yield* foregroundCollision(f, taskB, windowB);
        yield* observe(taskA, windowB);
        yield* observe(taskB, windowA);
        yield* observe(taskB, windowB, false);
        yield* observe(taskB, { ...windowB, fixture_wrong_window: true });
        yield* f.send({
          method: "call",
          name: "get_desktop_state",
          modelObservation: true,
          task: taskB,
        });
        f.advanceClock(ESCAPE_INPUT_COOLDOWN_MS + 50);
        expect(yield* click(taskA, windowA)).toMatchObject({ ok: true, result: {} });
        expect(yield* click(taskB, windowB)).toMatchObject({
          result: { structuredContent: { code: "computer_input_paused" } },
          desktopInterruptions: 0,
        });
        yield* observe(taskB, windowB);
        expect(yield* click(taskB, windowB)).toMatchObject({ ok: true, result: {} });
      }),
  );

  it.live("fences input after uncertain focus restoration until a fresh model observation", () =>
    Effect.gen(function* () {
      const result = {
        isError: true,
        structuredContent: { effect: "unverifiable", code: "focus_restore_failed" },
      };
      const f = yield* makeFixture({ actionResult: result });
      const task = { threadId: "restore-failure", turnId: "turn" };
      const target = { pid: 700, window_id: 900 };
      const act = f.send({
        method: "call",
        name: "press_key",
        args: { ...target, key: "enter" },
        task,
      });
      const read = (modelObservation: boolean) =>
        f.send({ method: "call", name: "get_window_state", args: target, modelObservation, task });
      assert.deepStrictEqual((yield* act).result, result);
      yield* read(false);
      assert.strictEqual((yield* act).result?.structuredContent?.code, "computer_input_paused");
      assert.strictEqual(yield* f.count("key"), 1);
      yield* read(true);
      // The fixture fails again, but exactly one new explicitly observed action ran.
      assert.deepStrictEqual((yield* act).result, result);
      assert.strictEqual(yield* f.count("key"), 2);
    }),
  );

  it.live(
    "recovers native takeover through a fresh usable sibling, never an empty or stale read",
    () =>
      Effect.gen(function* () {
        const f = yield* makeFixture();
        const task = { threadId: "sibling-recovery", turnId: "turn" };
        const observe = (args: Record<string, unknown>) =>
          f.send({ method: "call", name: "get_window_state", args, modelObservation: true, task });
        const act = f.send({
          method: "call",
          name: "press_key",
          args: { pid: 700, window_id: 901, key: "enter" },
          task,
        });
        yield* observe({ pid: 700, window_id: 900 });
        yield* foregroundCollision(f, task, { pid: 700, window_id: 900 });
        const cooldown = yield* act;
        const waitSeconds = cooldown.result?.structuredContent?.wait_seconds;
        assert.isNumber(waitSeconds);
        assert.isAbove(waitSeconds as number, 0);
        assert.isString(cooldown.result?.structuredContent?.requery_hint);
        f.advanceClock(ESCAPE_INPUT_COOLDOWN_MS + 50);
        for (const extra of [
          {},
          { fixture_usable: true, fixture_degraded: "ax_window_unresolved" },
          { fixture_usable: true, fixture_stale: true },
        ]) {
          yield* observe({ pid: 700, window_id: 901, ...extra });
          assert.strictEqual((yield* act).result?.structuredContent?.code, "computer_input_paused");
        }
        yield* observe({ pid: 700, window_id: 901, fixture_usable: true });
        expect(yield* act).toMatchObject({ ok: true, result: {} });
      }),
  );

  for (const snapshot_format of ["dom_refs_v1", "semantic_v2"]) {
    it.live(
      `requires the affected task's exact ${snapshot_format} browser snapshot after an interrupt`,
      () =>
        Effect.gen(function* () {
          const f = yield* makeFixture({ browserObservations: true });
          const task = { threadId: "browser-takeover", turnId: "turn" };
          const otherTask = { threadId: "other-browser-task", turnId: "turn" };
          const window = { pid: 700, window_id: 900 };
          const browser = { target_id: "target-700-900", tab_id: "tab-a", snapshot_format };
          const observe = (args: Record<string, unknown>, modelObservation = true, owner = task) =>
            f.send({
              method: "call",
              name: "get_browser_state",
              args,
              modelObservation,
              task: owner,
            });
          const action = f.send({ method: "call", name: "browser_click", args: browser, task });
          yield* observe(window);
          yield* observe(browser);
          assert.isTrue(yield* f.host.emergencyStopInput);
          yield* f.waitForEvent("interrupt-ack");
          yield* observe(browser, true, otherTask);
          yield* observe(window);
          yield* observe(browser, false);
          yield* observe({ ...browser, fixture_wrong_target: true });
          yield* observe({ ...browser, tab_id: "other-tab" });
          // Rebinding the same native window mints new tab IDs. Seeing that new
          // tab must not unlock input through the still-valid old capability.
          yield* observe({ ...window, fixture_target_id: "target-rebound" });
          yield* observe({ target_id: "target-rebound", tab_id: "new-tab", snapshot_format });
          yield* f.send({
            method: "call",
            name: "get_window_state",
            args: window,
            modelObservation: true,
            task,
          });
          f.advanceClock(ESCAPE_INPUT_COOLDOWN_MS + 50);
          expect(yield* action).toMatchObject({
            result: { structuredContent: { code: "computer_input_paused" } },
            desktopInterruptions: 0,
          });
          yield* observe(browser);
          assert.deepStrictEqual((yield* action).result, {});
        }),
    );
  }

  it.live(
    "keeps Escape browser recovery separate from native reads and rejects an interrupted browser snapshot",
    () =>
      Effect.gen(function* () {
        const f = yield* makeFixture({ browserObservations: true, delayBrowserObservation: true });
        const task = { threadId: "browser-escape", turnId: "turn" };
        const window = { pid: 700, window_id: 900 };
        const browser = { target_id: "target-700-900", tab_id: "tab-a" };
        yield* f.send({ method: "call", name: "get_browser_state", args: window, task });
        assert.isTrue(yield* f.host.emergencyStopInput);
        yield* f.waitForEvent("interrupt-ack");
        yield* f.send({
          method: "call",
          name: "get_desktop_state",
          modelObservation: true,
          task,
        });
        yield* f.send({
          method: "call",
          name: "get_browser_state",
          args: window,
          modelObservation: true,
          task,
        });
        const reading = yield* f
          .send({
            method: "call",
            name: "get_browser_state",
            args: browser,
            modelObservation: true,
            task,
          })
          .pipe(Effect.forkChild);
        yield* f.waitForEvent("browser-observe");
        assert.isTrue(yield* f.host.emergencyStopInput);
        expect(yield* Fiber.join(reading)).toMatchObject({
          result: { structuredContent: { code: "computer_input_paused" } },
        });
        f.advanceClock(ESCAPE_INPUT_COOLDOWN_MS + 50);
        expect(
          yield* f.send({ method: "call", name: "browser_navigate", args: browser, task }),
        ).toMatchObject({ result: { isError: true } });
        yield* f.send({
          method: "call",
          name: "get_browser_state",
          args: browser,
          modelObservation: true,
          task,
        });
        assert.deepStrictEqual(
          (yield* f.send({ method: "call", name: "browser_navigate", args: browser, task })).result,
          {},
        );
      }),
  );

  it.live(
    "permits separate isolated setup after retirement while old browser targets stay paused",
    () =>
      Effect.gen(function* () {
        const f = yield* makeFixture({ browserObservations: true });
        const task = { threadId: "browser-recovery-setup", turnId: "turn" };
        const oldTarget = { target_id: "old-browser", tab_id: "old-tab" };
        const newTarget = { target_id: "new-browser", tab_id: "new-tab" };
        const call = (name: string, args: Record<string, unknown>, modelObservation = false) =>
          f.send({ method: "call", name, args, modelObservation, task });
        yield* call("get_browser_state", oldTarget, true);
        yield* f.host.pauseDesktop("screen-lock");
        yield* f.host.resumeDesktop("screen-lock");
        expect(
          yield* call("browser_prepare", {
            pid: 700,
            allow_launch: true,
            profile: { mode: "isolated_new" },
          }),
        ).toMatchObject({ result: { structuredContent: { code: "computer_input_paused" } } });
        assert.deepStrictEqual(
          (yield* call("browser_prepare", {
            allow_launch: true,
            profile: { mode: "isolated_new" },
          })).result,
          {},
        );
        expect(yield* call("browser_navigate", newTarget)).toMatchObject({
          result: { structuredContent: { code: "computer_input_paused" } },
        });
        yield* call("get_browser_state", { pid: 701, fixture_target_id: "new-browser" }, true);
        expect(yield* call("browser_navigate", newTarget)).toMatchObject({
          result: { structuredContent: { code: "computer_input_paused" } },
        });
        yield* call("get_browser_state", newTarget, true);
        assert.deepStrictEqual((yield* call("browser_navigate", newTarget)).result, {});
        expect(yield* call("browser_navigate", oldTarget)).toMatchObject({
          result: { structuredContent: { code: "computer_input_paused" } },
        });
        yield* call("get_browser_state", oldTarget, true);
        assert.deepStrictEqual((yield* call("browser_navigate", oldTarget)).result, {});
      }),
  );

  it.live("has no rearm method left on the host protocol", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture();
      const reply = yield* f.send({ method: "rearm" });
      assert.isFalse(reply.ok);
      assert.include(reply.error, "Unsupported computer host request.");
    }),
  );
});
