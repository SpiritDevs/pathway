import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { expect } from "vite-plus/test";

import type { CuaPreviewTarget } from "@spiritdevs/shared/cuaDriverProtocol";

import type { CuaFrameTapHost } from "./CuaDriverHost.ts";
import { makeFixture } from "./testing/CuaDriverFixture.ts";

/** A frame tap that records each target it is pointed at; `updated` resolves on the first. */
const tapDouble = Effect.gen(function* () {
  const updates: Array<CuaPreviewTarget> = [];
  const updated = yield* Deferred.make<void>();
  const host: CuaFrameTapHost = {
    update: (target) =>
      Effect.sync(() => updates.push(target)).pipe(
        Effect.andThen(Deferred.succeed(updated, undefined)),
        Effect.asVoid,
      ),
    endTask: () => Effect.void,
    stop: Effect.void,
    dispose: Effect.void,
  };
  return { updates, updated, host };
});

/**
 * Resolves once the host logs a line containing `text`. The fixture keeps
 * logs in a plain array, so this hooks its `push` for the wait.
 */
describe("frame tap launch prime", () => {
  const task = { threadId: "thread", turnId: "turn" };
  const calculator = {
    pid: 101,
    window_id: 202,
    app_name: "Calculator",
    title: "Calculator",
    bounds: { x: 0, y: 0, width: 400, height: 600 },
    is_on_screen: true,
  };

  it.live("points the tap at the launched app's main window", () =>
    Effect.gen(function* () {
      const tap = yield* tapDouble;
      const f = yield* makeFixture({ frameTap: tap.host, listWindows: [calculator] });
      const launched = yield* f.send({
        method: "call",
        name: "launch_app",
        task,
        args: { name: "Calculator" },
      });
      assert.isTrue(launched.ok);
      yield* Deferred.await(tap.updated);
      assert.lengthOf(tap.updates, 1);
      expect(tap.updates[0]).toMatchObject({ pid: 101, windowId: 202 });
    }),
  );

  it.live("matches bundle ids by their tail component", () =>
    Effect.gen(function* () {
      const tap = yield* tapDouble;
      const f = yield* makeFixture({ frameTap: tap.host, listWindows: [calculator] });
      yield* f.send({
        method: "call",
        name: "launch_app",
        task,
        args: { bundle_id: "com.apple.Calculator" },
      });
      yield* Deferred.await(tap.updated);
      assert.lengthOf(tap.updates, 1);
      expect(tap.updates[0]).toMatchObject({ pid: 101, windowId: 202 });
    }),
  );

  it.live("stays quiet when no on-screen window matches", () =>
    Effect.gen(function* () {
      const tap = yield* tapDouble;
      const f = yield* makeFixture({ frameTap: tap.host, listWindows: [calculator] });
      // The detached prime ends here when nothing matches: a later update is impossible.
      const primed = yield* f
        .waitForLog("no on-screen window matched")
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* f.send({
        method: "call",
        name: "launch_app",
        task,
        args: { name: "TextEdit" },
      });
      yield* Fiber.join(primed);
      assert.deepStrictEqual(tap.updates, []);
    }),
  );

  it.live("skips the prime for ended tasks", () =>
    Effect.gen(function* () {
      const tap = yield* tapDouble;
      const f = yield* makeFixture({ frameTap: tap.host, listWindows: [calculator] });
      yield* f.send({ method: "end_task", task });
      // The host decides whether to start the detached prime before it replies.
      yield* f.send({
        method: "call",
        name: "launch_app",
        task,
        args: { name: "Calculator" },
      });
      assert.strictEqual(yield* f.count("list-windows"), 0);
      assert.deepStrictEqual(tap.updates, []);
    }),
  );
});

describe("frame tap browser targeting", () => {
  const task = { threadId: "thread", turnId: "turn" };

  it.live("points the tap at the window a browser bind call names", () =>
    Effect.gen(function* () {
      const tap = yield* tapDouble;
      const f = yield* makeFixture({ frameTap: tap.host });
      const bound = yield* f.send({
        method: "call",
        name: "get_browser_state",
        task,
        args: { pid: 101, window_id: 202 },
      });
      assert.isTrue(bound.ok);
      yield* Deferred.await(tap.updated);
      assert.lengthOf(tap.updates, 1);
      expect(tap.updates[0]).toMatchObject({ pid: 101, windowId: 202 });
    }),
  );

  // The tap update for a call runs before its reply, so the reply is the barrier.
  it.live("keeps the tap parked on target-id-only browser calls", () =>
    Effect.gen(function* () {
      const tap = yield* tapDouble;
      const f = yield* makeFixture({ frameTap: tap.host });
      const navigated = yield* f.send({
        method: "call",
        name: "browser_navigate",
        task,
        args: { target_id: "cua:1:2", tab_id: "tab-1", url: "https://example.test" },
      });
      assert.isTrue(navigated.ok);
      assert.deepStrictEqual(tap.updates, []);
    }),
  );

  it.live("a refused bind call proves nothing and leaves the tap parked", () =>
    Effect.gen(function* () {
      const tap = yield* tapDouble;
      const f = yield* makeFixture({ frameTap: tap.host, browserRefusal: true });
      const refused = yield* f.send({
        method: "call",
        name: "get_browser_state",
        task,
        args: { pid: 101, window_id: 202 },
      });
      assert.isTrue(refused.ok);
      assert.deepStrictEqual(tap.updates, []);
    }),
  );
});
