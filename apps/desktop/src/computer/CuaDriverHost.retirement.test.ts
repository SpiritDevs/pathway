import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { expect } from "vite-plus/test";

import type { CuaReply } from "@spiritdevs/shared/cuaDriverProtocol";

import type { CuaHostPermissions } from "./CuaDriverHost.ts";
import { makeFixture } from "./testing/CuaDriverFixture.ts";

describe("Cua macOS host retirement", () => {
  it.live("starts the compact cursor once per generation and owns the observation budget", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture();
      for (let i = 0; i < 2; i++) {
        const reply = yield* f.send({
          method: "call",
          name: "press_key",
          args: { key: "enter", _pathway_foreground_observation_ms: 0 },
        });
        assert.isTrue(reply.ok);
        assert.strictEqual(reply.hostPlatform, "darwin");
      }
      const events = yield* f.eventNames;
      assert.lengthOf(
        events.filter((event) => event === "motion-100-0"),
        1,
      );
      assert.lengthOf(
        events.filter((event) => event === "observation-budget-100"),
        2,
      );
    }),
  );

  for (const method of ["stop", "suspend", "pauseDesktop"] as const) {
    it.live(`${method} does not wait for another feature's permission dialog`, () =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const pending = yield* Deferred.make<CuaHostPermissions>();
        const f = yield* makeFixture({
          checkPermissions: () =>
            Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(pending))),
        });
        const check = yield* f
          .send({ method: "call", name: "check_permissions" })
          .pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        yield* method === "pauseDesktop" ? f.host.pauseDesktop("screen-lock") : f.host[method];
        expect(yield* Fiber.join(check)).toMatchObject({ ok: false, effect: "not-dispatched" });
        // Releasing this Computer wait does not cancel the shared request.
        yield* Deferred.succeed(pending, { accessibility: true, screenRecording: true });
        assert.lengthOf(yield* f.events, 0);
      }),
    );
  }

  it.live("releases a disconnected permission check without retiring a later native session", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const pending = yield* Deferred.make<CuaHostPermissions>();
      const f = yield* makeFixture({
        checkPermissions: () =>
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(pending))),
      });
      const check = yield* f
        .send({ method: "call", name: "check_permissions" })
        .pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      yield* Fiber.interrupt(check);
      expect(
        yield* f.send({ method: "call", name: "get_screen_size" }, { timeoutMs: 2_000 }),
      ).toMatchObject({ ok: true });
      yield* Deferred.succeed(pending, { accessibility: true, screenRecording: true });
      expect(yield* f.send({ method: "call", name: "press_key" })).toMatchObject({ ok: true });
      assert.strictEqual(yield* f.count("start"), 1);
    }),
  );

  it.live("unlock does not bypass an unacknowledged cleanup barrier", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture({ cleanup: "incomplete" });
      yield* f.send({ method: "call", name: "check_permissions" });
      yield* f.send({ method: "call", name: "press_key", args: { key: "enter" } });
      const paused = yield* Effect.flip(f.host.pauseDesktop("screen-lock"));
      assert.include(paused.message, "did not confirm native input cleanup");
      yield* f.host.resumeDesktop("screen-lock");
      expect(yield* f.send({ method: "call", name: "get_window_state" })).toMatchObject({
        ok: false,
      });
      assert.strictEqual(yield* f.count("start"), 1);
    }),
  );

  it.live("locking cancels active native input and rejects waiting input before dispatch", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture();
      const active = yield* f
        .send({ method: "call", name: "type_text", args: { text: "fixture" } })
        .pipe(Effect.forkChild);
      yield* f.waitForEvent("dispatch");
      const queued = yield* f
        .send<CuaReply>({ method: "call", name: "press_key" })
        .pipe(Effect.forkChild);
      yield* f.host.pauseDesktop("screen-lock");
      expect(yield* Fiber.join(active)).toMatchObject({ ok: false });
      const queuedReply = yield* Fiber.join(queued);
      assert.isTrue(queuedReply.ok === false || queuedReply.result?.isError === true);
      const events = yield* f.eventNames;
      assert.include(events, "cleanup-ack");
      assert.notInclude(events, "effect");
      assert.notInclude(events, "key");
    }),
  );
});
