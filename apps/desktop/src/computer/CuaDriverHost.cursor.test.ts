import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import { expect } from "vite-plus/test";

import type { CuaReply } from "@spiritdevs/shared/cuaDriverProtocol";

import type { CuaCursorStyle } from "./CuaDriverHost.ts";
import { type DriverEvent, type Fixture, makeFixture } from "./testing/CuaDriverFixture.ts";

const decodeStyle = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

/** The `set_agent_cursor_style` arguments the fake driver received, in order. */
const stylePayloads = (events: ReadonlyArray<DriverEvent>) =>
  events
    .filter((row) => row.event.startsWith("style:"))
    .map((row) => decodeStyle(row.event.slice("style:".length)));

const sortedKeys = (payload: Record<string, unknown> | undefined) =>
  Object.keys(payload ?? {}).toSorted();

describe("agent cursor style", () => {
  const pressKey = (f: Fixture) =>
    f.send<CuaReply>({
      method: "call",
      name: "press_key",
      args: { key: "enter", _pathway_foreground_observation_ms: 0 },
    });

  it.live("pushes the custom colors once per generation, on the session open", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture({
        cursorStyle: () => ({ fill: "#101010", rim: "#F0F0F0", shadow: "#000000" }),
      });
      expect(yield* pressKey(f)).toMatchObject({ ok: true });
      // A second action reuses the same generation and session: the style is
      // setup, not per-action traffic.
      expect(yield* pressKey(f)).toMatchObject({ ok: true });

      const events = yield* f.events;
      assert.lengthOf(
        events.filter((row) => row.event === "motion-100-0"),
        1,
      );
      const payloads = stylePayloads(events);
      assert.lengthOf(payloads, 1);
      assert.deepStrictEqual(sortedKeys(payloads[0]), ["fill", "rim", "session", "shadow"]);
      assert.match(String(payloads[0]!.session), /^pathway-/);
      // Colors are normalized to lowercase before they reach the driver.
      assert.strictEqual(payloads[0]!.fill, "#101010");
      assert.strictEqual(payloads[0]!.rim, "#f0f0f0");
      assert.strictEqual(payloads[0]!.shadow, "#000000");
    }),
  );

  it.live("sends only the channels that carry a usable color", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture({
        cursorStyle: () => ({ fill: "#ABCDEF", rim: "not-a-color" }),
      });
      expect(yield* pressKey(f)).toMatchObject({ ok: true });
      const payloads = stylePayloads(yield* f.events);
      assert.lengthOf(payloads, 1);
      assert.deepStrictEqual(sortedKeys(payloads[0]), ["fill", "session"]);
      assert.strictEqual(payloads[0]!.fill, "#abcdef");
    }),
  );

  it.live("makes no style call for the stock default", () =>
    Effect.gen(function* () {
      // No cursorStyle option at all is the packaged default: the driver keeps
      // its stock monochrome cursor and hears nothing from the host.
      const f = yield* makeFixture();
      expect(yield* pressKey(f)).toMatchObject({ ok: true });
      const events = yield* f.events;
      assert.isTrue(events.some((row) => row.event === "motion-100-0"));
      assert.lengthOf(stylePayloads(events), 0);
    }),
  );

  it.live("makes no style call for a stock-resolving option", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture({ cursorStyle: () => null });
      expect(yield* pressKey(f)).toMatchObject({ ok: true });
      assert.lengthOf(stylePayloads(yield* f.events), 0);
    }),
  );

  it.live("keeps an unpatched upstream driver on its stock cursor", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture({
        unpatched: true,
        nativeRevision: null,
        cursorStyle: () => ({ fill: "#101010" }),
      });
      expect(yield* f.send({ method: "call", name: "list_windows", args: {} })).toMatchObject({
        ok: true,
        driverNativeRevision: 0,
      });
      const events = yield* f.events;
      assert.isTrue(events.some((row) => row.event === "motion-100-0"));
      assert.lengthOf(stylePayloads(events), 0);
    }),
  );

  it.live("live-pushes a preference change to the warm session, once", () =>
    Effect.gen(function* () {
      let style: CuaCursorStyle | null = { fill: "#101010" };
      const f = yield* makeFixture({ cursorStyle: () => style });
      expect(yield* pressKey(f)).toMatchObject({ ok: true });

      style = { fill: "#101010", rim: "#f0f0f0" };
      yield* f.host.setCursorStyle(style);
      // An unchanged value is already applied: the second push is skipped.
      yield* f.host.setCursorStyle(style);

      const payloads = stylePayloads(yield* f.events);
      assert.lengthOf(payloads, 2);
      expect(payloads[1]).toMatchObject({ fill: "#101010", rim: "#f0f0f0" });
      assert.strictEqual(payloads[1]!.session, payloads[0]!.session);
    }),
  );

  it.live("resets a warm session to stock when the preference clears", () =>
    Effect.gen(function* () {
      let style: CuaCursorStyle | null = { fill: "#101010" };
      const f = yield* makeFixture({ cursorStyle: () => style });
      expect(yield* pressKey(f)).toMatchObject({ ok: true });

      style = null;
      yield* f.host.setCursorStyle(null);

      const payloads = stylePayloads(yield* f.events);
      assert.lengthOf(payloads, 2);
      // A stock change carries the session and no colors, so the driver's
      // omitted-channel stock treatment is what repaints the cursor.
      assert.deepStrictEqual(sortedKeys(payloads[1]), ["session"]);
    }),
  );

  it.live("never spawns a driver just to apply a settings change", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture({ cursorStyle: () => ({ fill: "#101010" }) });
      yield* f.host.setCursorStyle({ fill: "#101010" });
      // No generation was ever spawned or warmed by the settings change; the
      // next real call opens its session with the preference from the getter.
      assert.lengthOf(yield* f.events, 0);
      expect(yield* pressKey(f)).toMatchObject({ ok: true });
      assert.lengthOf(stylePayloads(yield* f.events), 1);
    }),
  );

  it.live("styles a task's own cursor session before its first action, once", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture({ cursorStyle: () => ({ fill: "#101010" }) });
      const task = { threadId: "thread", turnId: "turn" };
      const press = f.send<CuaReply>({
        method: "call",
        name: "press_key",
        args: { key: "enter", _pathway_foreground_observation_ms: 0 },
        task,
      });
      for (let i = 0; i < 2; i++) expect(yield* press).toMatchObject({ ok: true });

      const payloads = stylePayloads(yield* f.events);
      // Two calls: the shared session at open, then the task cursor session the
      // action actually paints under. The second action reuses both.
      assert.lengthOf(payloads, 2);
      assert.strictEqual(payloads[1]!.session, "agent·thread");
      assert.strictEqual(payloads[1]!.fill, "#101010");
    }),
  );

  it.live("resets a task cursor session to stock on its next action", () =>
    Effect.gen(function* () {
      let style: CuaCursorStyle | null = { fill: "#101010" };
      const f = yield* makeFixture({ cursorStyle: () => style });
      const task = { threadId: "thread", turnId: "turn" };
      const press = f.send<CuaReply>({
        method: "call",
        name: "press_key",
        args: { key: "enter", _pathway_foreground_observation_ms: 0 },
        task,
      });
      expect(yield* press).toMatchObject({ ok: true });

      style = null;
      yield* f.host.setCursorStyle(null);
      // The live change resets the shared session and forgets what each task
      // session had, so the task's next action repaints it stock.
      expect(yield* press).toMatchObject({ ok: true });
      // A third action has nothing left to reset.
      expect(yield* press).toMatchObject({ ok: true });

      const payloads = stylePayloads(yield* f.events);
      assert.lengthOf(payloads, 4);
      assert.deepStrictEqual(sortedKeys(payloads[2]), ["session"]); // shared session reset
      assert.strictEqual(payloads[3]!.session, "agent·thread");
      assert.deepStrictEqual(sortedKeys(payloads[3]), ["session"]);
    }),
  );

  it.live("sends no style call for a stock task session", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture();
      expect(
        yield* f.send<CuaReply>({
          method: "call",
          name: "press_key",
          args: { key: "enter", _pathway_foreground_observation_ms: 0 },
          task: { threadId: "thread", turnId: "turn" },
        }),
      ).toMatchObject({ ok: true });
      assert.lengthOf(stylePayloads(yield* f.events), 0);
    }),
  );
});

describe("per-agent cursor identity", () => {
  const press = (f: Fixture, task?: Record<string, unknown>) =>
    f.send<CuaReply>({
      method: "call",
      name: "press_key",
      args: { key: "enter" },
      ...(task ? { task } : {}),
    });

  it.live("parks between actions, hides only the completed turn and preserves its session", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture({ logSessions: true, logCursorState: true });
      const first = { threadId: "cursor-thread", turnId: "turn-1" };
      const next = { threadId: "cursor-thread", turnId: "turn-2" };
      yield* press(f, first);
      yield* press(f, next);
      yield* f.send({ method: "end_task", task: first });
      assert.notInclude(yield* f.eventNames, "cursor-enabled:false:agent·cursor-thread");
      yield* f.send({ method: "end_task", task: next });
      let events = yield* f.eventNames;
      assert.include(events, "cursor-enabled:false:agent·cursor-thread");
      assert.isFalse(events.some((e) => e.includes("end_session")));
      yield* press(f, { ...next, turnId: "turn-3" });
      events = yield* f.eventNames;
      assert.lengthOf(
        events.filter((e) => e === "cursor-enabled:true:agent·cursor-thread"),
        2,
      );
      assert.lengthOf(
        events.filter((e) => e === "start"),
        1,
      );
    }),
  );

  it.live("reads cursor state only on mint/first action and logs no labels or content", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture({ logCursorState: true });
      const task = { threadId: "cursor-thread", turnId: "turn-1", label: "PRIVATE LABEL" };
      yield* f.send({ method: "call", name: "get_window_state", args: {}, task });
      yield* press(f, task);
      yield* press(f, task);
      assert.lengthOf(
        (yield* f.events).filter((e) => e.event.startsWith("cursor-state:")),
        2,
      );
      const logs = f.logs.join("\n");
      assert.include(logs, '"stage":"session-created"');
      assert.include(logs, '"stage":"first-action"');
      assert.include(logs, '"overlay_scope":"main_display"');
      assert.notInclude(logs, "PRIVATE LABEL");
      assert.notInclude(logs, '"x":10');
    }),
  );

  it.live("retries unacknowledged cursor visibility without retrying input", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture({
        logCursorState: true,
        cursorEnableFailures: 1,
        cursorHideFailures: 1,
      });
      const task = { threadId: "cursor-retry", turnId: "turn-1" };
      yield* press(f, task);
      yield* press(f, task);
      yield* f.send({ method: "end_task", task });
      yield* f.send({ method: "end_task", task });
      yield* f.send({ method: "end_task", task });
      const events = yield* f.eventNames;
      assert.lengthOf(
        events.filter((e) => e === "cursor-enabled:true:agent·cursor-retry"),
        2,
      );
      assert.lengthOf(
        events.filter((e) => e === "cursor-enabled:false:agent·cursor-retry"),
        2,
      );
      assert.lengthOf(
        events.filter((e) => e === "key"),
        2,
      );
    }),
  );

  it.live("starts preview and shield cleanup before waiting for the cursor queue", () =>
    Effect.gen(function* () {
      const frameEnded = yield* Deferred.make<void>();
      const shieldEnded = yield* Deferred.make<void>();
      const task = { threadId: "queued-cleanup", turnId: "turn-1" };
      const f = yield* makeFixture({
        inputDelayMs: 300,
        frameTap: {
          update: () => Effect.void,
          endTask: () => Deferred.succeed(frameEnded, undefined).pipe(Effect.asVoid),
          stop: Effect.void,
          dispose: Effect.void,
        },
        shield: {
          engage: () => Effect.void,
          release: () => Effect.void,
          releaseAll: Effect.succeed(0),
          endTask: () => Deferred.succeed(shieldEnded, undefined).pipe(Effect.asVoid),
          stop: Effect.void,
          dispose: Effect.void,
        },
      });
      const action = yield* f
        .send({ method: "call", name: "type_text", args: { text: "fixture" }, task })
        .pipe(Effect.forkChild);
      yield* f.waitForEvent("dispatch");
      const end = yield* f.send({ method: "end_task", task }).pipe(Effect.forkChild);
      yield* Deferred.await(frameEnded);
      yield* Deferred.await(shieldEnded);
      assert.isFalse((yield* f.events).some((e) => e.event === "effect"));
      yield* Fiber.join(action);
      yield* Fiber.join(end);
    }),
  );

  it.live("reports a failed cursor query without replaying input or retiring the driver", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture({ cursorUnavailable: true });
      expect(yield* press(f, { threadId: "cursor-thread" })).toMatchObject({ ok: true });
      expect(yield* press(f, { threadId: "cursor-thread" })).toMatchObject({ ok: true });
      const events = yield* f.eventNames;
      assert.lengthOf(
        events.filter((e) => e === "key"),
        2,
      );
      assert.lengthOf(
        events.filter((e) => e === "start"),
        1,
      );
      const logs = f.logs.join("\n");
      assert.include(logs, '"status":"unavailable"');
      assert.notInclude(logs, "private overlay error");
    }),
  );

  it.live("logs structured actuator failures with attribution but no raw native message", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture({
        actionResult: {
          isError: true,
          content: [{ type: "text", text: "PRIVATE FIELD VALUE" }],
          structuredContent: {
            effect: "dispatched-unknown",
            diagnostics: {
              delivery_path: "ax",
              actuator: "ax_press",
              error_code: "ax_dispatch_failed",
              ax_error: -25204,
              message: "PRIVATE FIELD VALUE",
              title: "PRIVATE WINDOW",
            },
          },
        },
      });
      yield* press(f, { threadId: "failure-thread", turnId: "failure-turn" });
      const logs = f.logs.join("\n");
      assert.include(logs, '"event":"computer_action"');
      assert.include(logs, '"turn":"failure-turn"');
      assert.include(logs, '"ax_error":-25204');
      assert.include(logs, "The accessibility actuator reported a native error.");
      assert.notInclude(logs, "PRIVATE FIELD VALUE");
      assert.notInclude(logs, "PRIVATE WINDOW");
    }),
  );

  it.live("dispatches each task's calls under its own cursor session label", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture({ logSessions: true });
      expect(yield* press(f, { threadId: "t-1", label: "Research run" })).toMatchObject({
        ok: true,
      });
      expect(yield* press(f, { threadId: "t-2", label: "Docs pass" })).toMatchObject({
        ok: true,
      });
      expect(yield* press(f, { threadId: "t-1", label: "Research run" })).toMatchObject({
        ok: true,
      });
      expect(yield* press(f)).toMatchObject({ ok: true });
      const names = yield* f.eventNames;
      // Each thread's actions ride — and badge — its own session cursor.
      assert.include(names, "session:agent·Research run·t-1:press_key");
      assert.include(names, "session:agent·Docs pass·t-2:press_key");
      // The shared generation session still backs unattributed calls.
      assert.isTrue(
        names.some((event) => event.startsWith("session:pathway-") && event.endsWith(":press_key")),
      );
      // Task sessions mint lazily on dispatch: the only explicit start_session
      // is the generation's own bootstrap one — no extra round trip per label.
      expect(names.filter((event) => event.startsWith("open_session:start_session:"))).toEqual([
        expect.stringMatching(/^open_session:start_session:pathway-[0-9a-f-]+$/),
      ]);
    }),
  );

  it.live("keeps cursors distinct when two threads share one display label", () =>
    Effect.gen(function* () {
      // The badge text is the session string itself, so the label alone cannot
      // key the cursor — two agents named "Research run" must still get their
      // own cursors and badge tints via the embedded thread id.
      const f = yield* makeFixture({ logSessions: true });
      expect(yield* press(f, { threadId: "t-1", label: "Research run" })).toMatchObject({
        ok: true,
      });
      expect(yield* press(f, { threadId: "t-2", label: "Research run" })).toMatchObject({
        ok: true,
      });
      const names = yield* f.eventNames;
      assert.include(names, "session:agent·Research run·t-1:press_key");
      assert.include(names, "session:agent·Research run·t-2:press_key");
    }),
  );

  it.live("falls back to the thread id when a task carries no display label", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture({ logSessions: true });
      expect(yield* press(f, { threadId: "t-9" })).toMatchObject({ ok: true });
      assert.include(yield* f.eventNames, "session:agent·t-9:press_key");
    }),
  );

  it.live("sanitizes badge-breaking characters out of the minted label", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture({ logSessions: true });
      expect(
        yield* press(f, {
          threadId: "t-1",
          label: "Res\u0000earch\nrun​",
        }),
      ).toMatchObject({ ok: true });
      assert.include(yield* f.eventNames, "session:agent·Researchrun·t-1:press_key");
    }),
  );

  it.live("a caller session arg can never override the minted agent label", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture({ logSessions: true });
      expect(
        yield* f.send<CuaReply>({
          method: "call",
          name: "press_key",
          task: { threadId: "t-1", label: "Research run" },
          args: { key: "enter", session: "forged" },
        }),
      ).toMatchObject({ ok: true });
      const names = yield* f.eventNames;
      assert.isFalse(names.some((event) => event.startsWith("session:forged")));
      assert.include(names, "session:agent·Research run·t-1:press_key");
    }),
  );

  it.live("revives an ended task session in place instead of retiring the generation", () =>
    Effect.gen(function* () {
      // A task-scoped label can die on driver idle expiry while the generation
      // stays healthy: the heal is a start_session revival on the same label,
      // not a new driver process the way a shared-session death forces.
      const f = yield* makeFixture({
        sessionDeathOnce: true,
        logSessions: true,
      });
      const task = { threadId: "t-1", label: "Research run" };
      const reply = yield* press(f, task);
      assert.isTrue(reply.ok);
      assert.notStrictEqual(reply.result?.isError, true);
      const events = yield* f.eventNames;
      assert.lengthOf(
        events.filter((event) => event === "start"),
        1,
      );
      assert.include(events, "open_session:start_session:agent·Research run·t-1");
      assert.lengthOf(
        events.filter((event) => event === "key"),
        1,
      );
      assert.include(events, "session:agent·Research run·t-1:press_key");
    }),
  );
});
