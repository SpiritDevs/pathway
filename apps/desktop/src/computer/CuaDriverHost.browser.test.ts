import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { expect } from "vite-plus/test";

import { makeFixture } from "./testing/CuaDriverFixture.ts";

describe("browser surface", () => {
  const task = { threadId: "thread", turnId: "turn" };

  it.live(
    "attributes browser calls to a per-thread lifecycle session under the control transport",
    () =>
      Effect.gen(function* () {
        const f = yield* makeFixture();
        const reply = yield* f.send({
          method: "call",
          name: "browser_navigate",
          task,
          args: { url: "https://example.com" },
        });
        assert.isTrue(reply.ok);
        const events = yield* f.eventNames;
        // The first browser call opened the persistent control connection; the
        // dispatch then rode the thread's lifecycle label under that transport id.
        assert.isTrue(events.some((event) => event.startsWith("session-begin:pathway-transport-")));
        assert.isTrue(
          events.some((event) =>
            event.startsWith("browser:browser_navigate:pathway-browser-thread:pathway-transport-"),
          ),
        );
        // A caller-supplied session can never override the minted label.
        const forged = yield* f.send({
          method: "call",
          name: "browser_click",
          task,
          args: { target_id: "t", tab_id: "tab", ref: "p1:0", session: "forged" },
        });
        assert.isTrue(forged.ok);
        const after = yield* f.eventNames;
        assert.isFalse(after.some((event) => event.startsWith("browser:browser_click:forged")));
        assert.isTrue(
          after.some((event) =>
            event.startsWith("browser:browser_click:pathway-browser-thread:pathway-transport-"),
          ),
        );
      }),
  );

  it.live("refuses browser calls without task attribution before starting a daemon", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture();
      const reply = yield* f.send({
        method: "call",
        name: "browser_navigate",
        args: { url: "https://example.com" },
      });
      assert.isFalse(reply.ok);
      assert.include(reply.error, "task attribution");
      assert.lengthOf(yield* f.events, 0);
    }),
  );

  it.live(
    "ends the thread's browser session on end_browser_thread and revives it on the next call",
    () =>
      Effect.gen(function* () {
        const f = yield* makeFixture();
        const click = f.send({
          method: "call",
          name: "browser_click",
          task,
          args: { target_id: "t", tab_id: "tab", ref: "p1:0" },
        });
        expect(yield* click).toMatchObject({ ok: true });
        expect(yield* f.send({ method: "end_browser_thread", task })).toMatchObject({ ok: true });
        expect(yield* click).toMatchObject({ ok: true });
        const lifecycle = (yield* f.eventNames).filter(
          (event) =>
            event.startsWith("browser:") ||
            event.startsWith("start_session:") ||
            event.startsWith("end_session:"),
        );
        expect(lifecycle).toEqual([
          expect.stringMatching(/^browser:browser_click:pathway-browser-thread:/),
          expect.stringMatching(/^end_session:pathway-browser-thread:pathway-transport-/),
          expect.stringMatching(/^start_session:pathway-browser-thread:pathway-transport-/),
          expect.stringMatching(/^browser:browser_click:pathway-browser-thread:/),
        ]);
      }),
  );

  it.live("keeps end_browser_thread a no-op for a thread that never used the browser", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture();
      expect(yield* f.send({ method: "end_browser_thread", task })).toMatchObject({ ok: true });
      assert.lengthOf(yield* f.events, 0);
    }),
  );

  it.live("refuses a browser bind that names one of this app's own pids", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture({ ownPids: () => new Set([424242]) });
      const reply = yield* f.send({
        method: "call",
        name: "get_browser_state",
        task,
        args: { pid: 424242, window_id: 20 },
      });
      assert.isTrue(reply.ok);
      assert.isTrue(reply.result?.isError);
      expect(reply.result?.structuredContent).toMatchObject({
        effect: "refused",
        code: "browser_self_target",
      });
      // The refusal is decided at admission: no daemon ever started.
      assert.lengthOf(yield* f.events, 0);
      // An unrelated pid still dispatches normally.
      const other = yield* f.send({
        method: "call",
        name: "get_browser_state",
        task,
        args: { pid: 777, window_id: 20 },
      });
      assert.isTrue(other.ok);
      assert.isTrue(
        (yield* f.eventNames).some((event) => event.startsWith("browser:get_browser_state:")),
      );
    }),
  );
});
