import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { expect } from "vite-plus/test";

import type { CuaReply } from "@spiritdevs/shared/cuaDriverProtocol";

import type { CuaHostPermissions } from "./CuaDriverHost.ts";
import { type Fixture, makeFixture } from "./testing/CuaDriverFixture.ts";

/** Starts a request now, as a Promise-returning call would, so arrival order follows call order. */
const sendNow = (f: Fixture, body: Record<string, unknown>) =>
  f.send<CuaReply>(body).pipe(Effect.forkChild({ startImmediately: true }));

describe("task-owned user stop", () => {
  const task = { threadId: "thread", turnId: "turn" };

  it.live("end_task succeeds without a native preview", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture();
      expect(yield* f.send({ method: "end_task", task })).toMatchObject({ ok: true });
      assert.lengthOf(yield* f.events, 0);
    }),
  );

  it.live("user Stop refuses subsequent calls from the same turn", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture();
      yield* f.host.stopTaskByUser(task);
      const blocked = yield* f.send({
        method: "call",
        name: "press_key",
        task,
        args: { key: "enter", pid: 42, window_id: 10 },
      });
      expect(blocked).toMatchObject({ ok: false, effect: "not-dispatched" });
      assert.include(blocked.error, "user stopped");
      assert.lengthOf(yield* f.events, 0);
      const next = yield* f.send({
        method: "call",
        name: "get_window_state",
        task: { ...task, turnId: "next" },
        modelObservation: true,
        args: { pid: 42, window_id: 10 },
      });
      assert.isTrue(next.ok);
    }),
  );

  for (const activeTask of [
    { threadId: "other-thread", turnId: "turn" },
    { threadId: "thread", turnId: "new-turn" },
  ]) {
    it.live(
      `stopping queued ${activeTask.threadId}/${activeTask.turnId}'s sibling preserves its native input`,
      () =>
        Effect.gen(function* () {
          const f = yield* makeFixture({ inputDelayMs: 300, logSessions: true });
          const active = yield* sendNow(f, {
            method: "call",
            name: "type_text",
            task: activeTask,
            args: { text: "fixture" },
          });
          yield* f.waitForEvent("dispatch");
          const queued = yield* sendNow(f, {
            method: "call",
            name: "press_key",
            task,
            args: { key: "enter" },
          });
          expect(yield* f.send({ method: "stop", task })).toMatchObject({
            ok: true,
            result: { stop_scope: "task" },
          });
          expect(yield* Fiber.join(queued)).toMatchObject({ ok: false, effect: "not-dispatched" });
          expect(yield* Fiber.join(active)).toMatchObject({ ok: true });
          expect(
            yield* f.send({
              method: "call",
              name: "press_key",
              task: activeTask,
              args: { key: "enter" },
            }),
          ).toMatchObject({ ok: true });
          const events = yield* f.eventNames;
          assert.lengthOf(
            events.filter((event) => event === "start"),
            1,
          );
          assert.lengthOf(
            events.filter((event) => event === "key"),
            1,
          );
          assert.include(events, "effect");
          assert.notInclude(events, "interrupt");
          assert.notInclude(events, "retiring");
        }),
    );
  }

  it.live(
    "drains matching native input and reports that queued siblings share the generation fence",
    () =>
      Effect.gen(function* () {
        const f = yield* makeFixture();
        const active = yield* sendNow(f, {
          method: "call",
          name: "type_text",
          task,
          args: { text: "fixture" },
        });
        yield* f.waitForEvent("dispatch");
        const sibling = { threadId: "other-thread", turnId: "turn" };
        const queued = yield* sendNow(f, {
          method: "call",
          name: "press_key",
          task: sibling,
          args: { key: "enter" },
        });
        expect(yield* f.send({ method: "stop", task })).toMatchObject({
          ok: true,
          result: { stop_scope: "generation" },
        });
        expect(yield* Fiber.join(active)).toMatchObject({
          ok: false,
          effect: "dispatched-unknown",
        });
        expect(yield* Fiber.join(queued)).toMatchObject({ ok: false, effect: "not-dispatched" });
        expect(
          yield* f.send({
            method: "call",
            name: "press_key",
            task: sibling,
            args: { key: "enter" },
          }),
        ).toMatchObject({ ok: true });
        const events = yield* f.eventNames;
        assert.isBelow(events.indexOf("interrupt-ack"), events.indexOf("key"));
        assert.lengthOf(
          events.filter((event) => event === "start"),
          1,
        );
        assert.notInclude(events, "effect");
        assert.notInclude(events, "cancel");
        assert.notInclude(events, "retiring");
      }),
  );

  it.live("cancels only the matching observation without interrupting queued sibling input", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture({ delayObservation: true });
      const observation = yield* sendNow(f, {
        method: "call",
        name: "get_window_state",
        task,
        modelObservation: true,
        args: { pid: 42, window_id: 10 },
      });
      yield* f.waitForEvent("observe");
      const sibling = yield* sendNow(f, {
        method: "call",
        name: "press_key",
        task: { threadId: "other-thread", turnId: "turn" },
        args: { key: "enter" },
      });
      expect(yield* f.send({ method: "stop", task })).toMatchObject({
        ok: true,
        result: { stop_scope: "task" },
      });
      expect(yield* Fiber.join(observation)).toMatchObject({
        ok: false,
        effect: "not-dispatched",
      });
      expect(yield* Fiber.join(sibling)).toMatchObject({ ok: true });
      assert.notInclude(yield* f.eventNames, "interrupt");
    }),
  );

  it.live(
    "releases a matching permission wait without cancelling pathway-helper's shared check",
    () =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const pending = yield* Deferred.make<CuaHostPermissions>();
        const f = yield* makeFixture({
          checkPermissions: () =>
            Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(pending))),
        });
        const check = yield* sendNow(f, { method: "call", name: "check_permissions", task });
        yield* Deferred.await(entered);
        yield* f.host.stopTaskByUser(task);
        expect(yield* Fiber.join(check)).toMatchObject({ ok: false, effect: "not-dispatched" });
        expect(
          yield* f.send({ method: "call", name: "press_key", args: { key: "enter" } }),
        ).toMatchObject({ ok: true });
        yield* Deferred.succeed(pending, { accessibility: true, screenRecording: true });
        assert.notInclude(yield* f.eventNames, "interrupt");
      }),
  );

  it.live(
    "revokes a task during native startup without retiring the sibling's shared generation",
    () =>
      Effect.gen(function* () {
        const f = yield* makeFixture({ metadataDelayMs: 100 });
        const starting = yield* sendNow(f, {
          method: "call",
          name: "press_key",
          task,
          args: { key: "enter" },
        });
        yield* f.waitForEvent("start");
        expect(yield* f.send({ method: "stop", task })).toMatchObject({
          ok: true,
          result: { stop_scope: "task" },
        });
        expect(yield* Fiber.join(starting)).toMatchObject({
          ok: false,
          effect: "not-dispatched",
        });
        expect(
          yield* f.send({ method: "call", name: "press_key", args: { key: "enter" } }),
        ).toMatchObject({ ok: true });
        const events = yield* f.eventNames;
        assert.lengthOf(
          events.filter((event) => event === "key"),
          1,
        );
        assert.lengthOf(
          events.filter((event) => event === "start"),
          1,
        );
        assert.notInclude(events, "interrupt");
        assert.notInclude(events, "retiring");
      }),
  );

  it.live("keeps native input ownership when a detached launch-preview read finishes", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture({
        delayListWindowsMs: 100,
        frameTap: {
          update: () => Effect.void,
          endTask: () => Effect.void,
          stop: Effect.void,
          dispose: Effect.void,
        },
      });
      yield* f.send({
        method: "call",
        name: "launch_app",
        task: { threadId: "launching-thread", turnId: "turn" },
        args: { name: "Calculator" },
      });
      yield* f.waitForEvent("list-windows");
      const active = yield* sendNow(f, {
        method: "call",
        name: "type_text",
        task,
        args: { text: "fixture" },
      });
      yield* f.waitForEvent("dispatch");
      yield* f.waitForEvent("list-windows-replied");
      expect(yield* f.send({ method: "stop", task })).toMatchObject({
        ok: true,
        result: { stop_scope: "generation" },
      });
      expect(yield* Fiber.join(active)).toMatchObject({
        ok: false,
        effect: "dispatched-unknown",
      });
      const events = yield* f.eventNames;
      assert.include(events, "interrupt-ack");
      assert.notInclude(events, "effect");
      assert.notInclude(events, "retiring");
    }),
  );

  it.live("drains its thread's active native input when Stop omits a turn identity", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture();
      const active = yield* sendNow(f, {
        method: "call",
        name: "type_text",
        task,
        args: { text: "fixture" },
      });
      yield* f.waitForEvent("dispatch");
      expect(yield* f.send({ method: "stop", task: { threadId: task.threadId } })).toMatchObject({
        ok: true,
        result: { stop_scope: "generation" },
      });
      expect(yield* Fiber.join(active)).toMatchObject({
        ok: false,
        effect: "dispatched-unknown",
      });
      const events = yield* f.eventNames;
      assert.include(events, "interrupt-ack");
      assert.notInclude(events, "effect");
      assert.notInclude(events, "retiring");
    }),
  );

  for (const state of ["idle", "queued"] as const) {
    it.live(`thread-wide Stop preserves a sibling when its own work is ${state}`, () =>
      Effect.gen(function* () {
        let activations = 0;
        // The sibling's input plus both queued turns each activate the monitor once.
        const allActivated = yield* Deferred.make<void>();
        const f = yield* makeFixture({
          inputDelayMs: 500,
          activateInputMonitor: Effect.suspend(() => {
            activations += 1;
            return activations === 3
              ? Effect.asVoid(Deferred.succeed(allActivated, undefined))
              : Effect.void;
          }),
        });
        yield* f.send({
          method: "call",
          name: "get_window_state",
          task,
          args: { pid: 42, window_id: 10 },
        });
        const sibling = yield* sendNow(f, {
          method: "call",
          name: "type_text",
          task: { threadId: "other-thread", turnId: "turn" },
          args: { text: "fixture" },
        });
        yield* f.waitForEvent("dispatch");
        const queued =
          state === "queued"
            ? yield* Effect.forEach(["queued-turn", "other-queued-turn"], (turnId) =>
                sendNow(f, {
                  method: "call",
                  name: "press_key",
                  task: { threadId: task.threadId, turnId },
                  args: { key: "enter" },
                }),
              )
            : [];
        if (state === "queued") yield* Deferred.await(allActivated);
        expect(yield* f.send({ method: "stop", task: { threadId: task.threadId } })).toMatchObject({
          ok: true,
          result: { stop_scope: "task" },
        });
        for (const call of queued)
          expect(yield* Fiber.join(call)).toMatchObject({ ok: false, effect: "not-dispatched" });
        expect(yield* Fiber.join(sibling)).toMatchObject({ ok: true });
        expect(
          yield* f.send({
            method: "call",
            name: "press_key",
            task,
            args: { key: "enter" },
          }),
        ).toMatchObject({ ok: false, effect: "not-dispatched" });
        expect(
          yield* f.send({
            method: "call",
            name: "press_key",
            task: { threadId: task.threadId, turnId: "new-turn-after-stop" },
            args: { key: "enter" },
          }),
        ).toMatchObject({ ok: true });
        const events = yield* f.eventNames;
        assert.lengthOf(
          events.filter((event) => event === "key"),
          1,
        );
        assert.include(events, "effect");
        assert.notInclude(events, "interrupt");
        assert.notInclude(events, "retiring");
      }),
    );
  }
});
