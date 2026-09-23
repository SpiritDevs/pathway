import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { expect } from "vite-plus/test";

import type { CuaComputerTask } from "@spiritdevs/shared/cuaDriverProtocol";

import type { CuaShieldEngageRequest, CuaShieldHost } from "./CuaDriverHost.ts";
import { makeFixture } from "./testing/CuaDriverFixture.ts";

type ShieldCall =
  | {
      readonly method: "engage";
      readonly args: readonly [CuaShieldEngageRequest, CuaComputerTask | undefined];
    }
  | { readonly method: "release"; readonly args: readonly [string] }
  | { readonly method: "endTask"; readonly args: readonly [CuaComputerTask] }
  | { readonly method: "releaseAll" | "stop" | "dispose"; readonly args: readonly [] };

/** A shield surface that records every call in order; releaseAll reports the engages it saw. */
const recordingShield = () => {
  const calls: Array<ShieldCall> = [];
  const record = (call: ShieldCall) =>
    Effect.sync(() => {
      calls.push(call);
    });
  const shield: CuaShieldHost = {
    engage: (request, task) => record({ method: "engage", args: [request, task] }),
    release: (shieldId) => record({ method: "release", args: [shieldId] }),
    releaseAll: record({ method: "releaseAll", args: [] }).pipe(
      Effect.map(() => calls.filter((call) => call.method === "engage").length),
    ),
    endTask: (ended) => record({ method: "endTask", args: [ended] }),
    stop: record({ method: "stop", args: [] }),
    dispose: record({ method: "dispose", args: [] }),
  };
  return { calls, shield, methods: () => calls.map((call) => call.method) };
};

describe("activation shield host method", () => {
  const task = { threadId: "thread", turnId: "turn" };
  const engageArgs = {
    action: "engage",
    shield_id: "shield-abc123",
    frame: { x: 100, y: 50, width: 400, height: 300 },
    window_id: 4242,
    pid: 777,
    label: "Pathway activating Calculator",
  };

  it.live("routes engage to the shield host with parsed args and task attribution", () =>
    Effect.gen(function* () {
      const recording = recordingShield();
      const f = yield* makeFixture({ shield: recording.shield });
      const reply = yield* f.send({ method: "shield", task, args: engageArgs });
      assert.isTrue(reply.ok);
      expect(reply.result).toMatchObject({ engaged: true, shield_id: "shield-abc123" });
      assert.lengthOf(recording.calls, 1);
      const call = recording.calls[0]!;
      assert.strictEqual(call.method, "engage");
      assert.deepStrictEqual(call.args[0], {
        shieldId: "shield-abc123",
        frame: { x: 100, y: 50, width: 400, height: 300 },
        windowId: 4242,
        pid: 777,
        label: "Pathway activating Calculator",
      });
      assert.deepStrictEqual(call.args[1], task);
      // A shield engage is host-local: no driver generation was ever started.
      assert.lengthOf(yield* f.events, 0);
    }),
  );

  it.live("refuses engage when no shield surface is configured", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture();
      const reply = yield* f.send({ method: "shield", task, args: engageArgs });
      assert.isFalse(reply.ok);
      assert.include(reply.error, "not available");
      assert.strictEqual(reply.effect, "not-dispatched");
    }),
  );

  it.live("refuses engage while the desktop is paused but still accepts release", () =>
    Effect.gen(function* () {
      const recording = recordingShield();
      const f = yield* makeFixture({ shield: recording.shield });
      yield* f.host.pauseDesktop("screen-lock");
      yield* Effect.gen(function* () {
        const reply = yield* f.send({ method: "shield", task, args: engageArgs });
        assert.isFalse(reply.ok);
        assert.include(reply.error, "paused");
        // Teardown is never gated on the pause.
        expect(
          yield* f.send({
            method: "shield",
            args: { action: "release", shield_id: "shield-abc123" },
          }),
        ).toMatchObject({ ok: true });
        assert.deepStrictEqual(recording.methods(), ["stop", "release"]);
      }).pipe(Effect.ensuring(f.host.resumeDesktop("screen-lock")));
    }),
  );

  it.live("rejects malformed shield args before touching the surface", () =>
    Effect.gen(function* () {
      const recording = recordingShield();
      const f = yield* makeFixture({ shield: recording.shield });
      for (const args of [
        { action: "engage", shield_id: "bad id with spaces" },
        {
          action: "engage",
          shield_id: "shield-1",
          frame: { x: 0, y: 0, width: -4, height: 4 },
          window_id: 1,
          pid: 1,
        },
        {
          action: "engage",
          shield_id: "shield-1",
          frame: { x: 0, y: 0, width: 4, height: 4 },
          window_id: 0,
          pid: 1,
        },
        { action: "release" },
        { action: "detonate" },
        "engage",
      ]) {
        const reply = yield* f.send({ method: "shield", task, args });
        assert.isFalse(reply.ok);
        assert.strictEqual(reply.effect, "not-dispatched");
      }
      assert.lengthOf(recording.calls, 0);
    }),
  );

  it.live("release_all is the forced-release path and reports the live count", () =>
    Effect.gen(function* () {
      const recording = recordingShield();
      const f = yield* makeFixture({ shield: recording.shield });
      yield* f.send({ method: "shield", task, args: engageArgs });
      const reply = yield* f.send({ method: "shield", args: { action: "release_all" } });
      assert.isTrue(reply.ok);
      expect(reply.result).toMatchObject({ released: 1 });
      assert.deepStrictEqual(recording.methods(), ["engage", "releaseAll"]);
    }),
  );

  it.live("end_task releases the task's shields", () =>
    Effect.gen(function* () {
      const recording = recordingShield();
      const f = yield* makeFixture({ shield: recording.shield });
      yield* f.send({ method: "end_task", task });
      assert.deepStrictEqual(recording.methods(), ["endTask"]);
      assert.deepStrictEqual(recording.calls[0]!.args[0], task);
    }),
  );

  it.live("stop and dispose release the whole shield surface", () =>
    Effect.gen(function* () {
      const recording = recordingShield();
      const f = yield* makeFixture({ shield: recording.shield });
      yield* f.host.stop;
      assert.include(recording.methods(), "stop");
    }),
  );

  it.live("shield requests still require host authority", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture();
      // An undefined capability is dropped from the JSON line: the request carries no authority.
      const reply = yield* f.send({
        capability: undefined,
        method: "shield",
        args: { action: "release_all" },
      });
      assert.isFalse(reply.ok);
      assert.include(String(reply.error), "authority");
    }),
  );
});
