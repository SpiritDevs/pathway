import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { expect } from "vite-plus/test";

import { cuaHostProcessIsAlive } from "./CuaRuntimeOwnership.ts";
import { makeFixture } from "./testing/CuaDriverFixture.ts";

describe("driver warm-up on first touch", () => {
  for (const warmOnFirstTouch of [undefined, false]) {
    it.live(`leaves the driver cold when the option is ${String(warmOnFirstTouch)}`, () =>
      Effect.gen(function* () {
        const f = yield* makeFixture({
          ...(warmOnFirstTouch === undefined ? {} : { warmOnFirstTouch }),
          checkPermissions: () => Effect.succeed({ accessibility: true, screenRecording: true }),
        });
        expect(yield* f.send({ method: "probe" })).toMatchObject({ ok: true });
        expect(yield* f.send({ method: "call", name: "check_permissions" })).toMatchObject({
          ok: true,
        });
        // Stop joins any startup in flight, so a warm spawn would have logged its start.
        yield* f.host.stop;
        assert.lengthOf(yield* f.events, 0);
      }),
    );
  }

  it.live("warms spawn and handshake on the first probe without opening a session", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture({ warmOnFirstTouch: true });
      expect(yield* f.send({ method: "probe" })).toMatchObject({ ok: true });
      const warmed = yield* f.waitForEvent("start");
      assert.lengthOf(
        warmed.filter((event) => event.event === "start"),
        1,
      );
      // Warm stops at the validated handshake on purpose: session setup — the
      // fixture's motion event — never reaches the driver before real work.
      assert.isFalse((yield* f.events).some((event) => event.event === "motion-100-0"));
      // The first real call reuses the warmed generation: no second spawn, and
      // the once-per-generation cursor setup runs exactly once now.
      expect(
        yield* f.send({ method: "call", name: "press_key", args: { key: "enter" } }),
      ).toMatchObject({ ok: true });
      const events = yield* f.events;
      assert.lengthOf(
        events.filter((event) => event.event === "start"),
        1,
      );
      assert.lengthOf(
        events.filter((event) => event.event === "motion-100-0"),
        1,
      );
      assert.lengthOf(
        events.filter((event) => event.event === "key"),
        1,
      );
    }),
  );

  it.live("does not prewarm a macOS driver before the first real permission grants", () =>
    Effect.gen(function* () {
      let granted = false;
      const f = yield* makeFixture({
        warmOnFirstTouch: true,
        checkPermissions: () =>
          Effect.sync(() => ({ accessibility: granted, screenRecording: granted })),
      });
      yield* f.send({ method: "probe" });
      yield* f.send({ method: "call", name: "check_permissions" });
      assert.lengthOf(yield* f.events, 0);
      granted = true;
      yield* f.send({ method: "call", name: "check_permissions" });
      assert.lengthOf(
        (yield* f.waitForEvent("start")).filter((event) => event.event === "start"),
        1,
      );
    }),
  );

  it.live("warms on a permission check too, and only once per host lifetime", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture({
        warmOnFirstTouch: true,
        checkPermissions: () => Effect.succeed({ accessibility: true, screenRecording: true }),
      });
      yield* f.send({ method: "call", name: "check_permissions" });
      yield* f.waitForEvent("start");
      // Later first-touch requests do not spawn again — warm is once-only even
      // while it is still in flight.
      yield* f.send({ method: "probe" });
      yield* f.send({ method: "call", name: "check_permissions" });
      // A stop retires the warmed generation; it joins any startup in flight,
      // so a second warm spawn would have logged its start by now.
      yield* f.host.stop;
      assert.strictEqual(yield* f.count("start"), 1);
      // The next probe must not conjure a replacement — warm ran its once.
      yield* f.send({ method: "probe" });
      yield* f.host.stop;
      assert.strictEqual(yield* f.count("start"), 1);
      // Real work still starts a driver on demand, paying the cold start then.
      expect(yield* f.send({ method: "call", name: "press_key" })).toMatchObject({ ok: true });
      assert.strictEqual(yield* f.count("start"), 2);
    }),
  );

  it.live("does not treat housekeeping requests as first touches", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture({ warmOnFirstTouch: true });
      yield* f.send({ method: "end_task", task: { threadId: "thread", turnId: "turn" } });
      // Stop joins any startup in flight, so a warm spawn would have logged its start.
      yield* f.host.stop;
      assert.lengthOf(yield* f.events, 0);
    }),
  );

  it.live("logs a failed warm and leaves the first real call's own startup intact", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture({ warmOnFirstTouch: true, unpatched: true });
      expect(yield* f.send({ method: "probe" })).toMatchObject({ ok: true });
      const events = yield* f.waitForEvent("start");
      const pid = events.find((event) => event.event === "start")!.pid;
      // This deliberately incompatible fixture exits before installing its
      // graceful-exit logger. The warm fails only once the host saw the exit.
      yield* f.waitForLog("driver warm-up failed");
      assert.isFalse(cuaHostProcessIsAlive(pid));
      // The warm failure retired its generation cleanly; the real call spawns
      // again and fails on the same handshake, not on anything warm poisoned.
      expect(
        yield* f.send({ method: "call", name: "press_key", args: { key: "enter" } }),
      ).toMatchObject({ ok: false, effect: "not-dispatched" });
      assert.strictEqual(yield* f.count("start"), 2);
    }),
  );
});
