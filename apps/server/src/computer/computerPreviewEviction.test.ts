import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import { makeCuaComputerBackend } from "./CuaComputerBackend.ts";
import { withComputerTask } from "./computerTaskContext.ts";
import { fakeCuaRequest } from "./testing/FakeCuaRequest.ts";

const BOUNDS = { x: 0, y: 0, width: 200, height: 100 };

const PNG_HEADER = (() => {
  const header = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(header);
  header.write("IHDR", 12);
  header.writeUInt32BE(400, 16);
  header.writeUInt32BE(200, 20);
  return header.toString("base64");
})();

const evictionFixture = Effect.fn(function* () {
  const calls: Array<{ method?: string }> = [];
  const request = async (_endpoint: string, raw: unknown) => {
    const req = raw as Record<string, unknown>;
    calls.push(typeof req.method === "string" ? { method: req.method } : {});
    if (req.name === "check_permissions")
      return {
        ok: true,
        result: { structuredContent: { accessibility: true, screen_recording: true } },
      };
    if (req.name === "list_windows")
      return {
        ok: true,
        result: {
          structuredContent: {
            windows: [
              {
                pid: 10,
                window_id: 20,
                title: "Owned fixture",
                bounds: BOUNDS,
                is_on_screen: true,
                on_current_space: true,
                z_index: 1,
              },
            ],
          },
        },
      };
    if (req.name === "get_screen_size")
      return {
        ok: true,
        result: { structuredContent: { width: 1000, height: 800, scale_factor: 2 } },
      };
    if (req.name === "get_window_state")
      return {
        ok: true,
        result: {
          structuredContent: {
            pid: 10,
            window_id: 20,
            window_bounds: BOUNDS,
            screenshot_frame_valid: true,
            elements: [],
          },
          content: [{ type: "image", mimeType: "image/png", data: PNG_HEADER }],
        },
      };
    return { ok: true, result: { structuredContent: {} } };
  };
  const backend = yield* makeCuaComputerBackend({
    endpoint: "/evict",
    request: fakeCuaRequest(request),
  });
  return {
    backend,
    endTaskCalls: () => calls.filter((call) => call.method === "end_task").length,
  };
});

it.layer(NodeServices.layer)("computer preview task eviction", (it) => {
  it.effect("a dispatching task survives flooding while idle tasks are evicted", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // A wall-clock start like Synara's Date.now(): the backend's never-taken
        // snapshot is stamped 0, which only reads as fresh on a clock at 0.
        yield* TestClock.setTime(Date.UTC(2026, 0, 1));
        const { backend, endTaskCalls } = yield* evictionFixture();
        const observe = (threadId: string, turnId: string) =>
          withComputerTask(
            { threadId, turnId },
            backend.getState({ windowId: "cua:10:20", includeTree: true }),
          );
        // Live task attaches first.
        yield* observe("evict-live", "turn-live");
        // A live task re-dispatches often: flood the table with other tasks
        // while it keeps working. Recency refresh must keep it young; only
        // tasks that stopped dispatching may be evicted.
        for (let i = 0; i < 600; i++) {
          yield* observe(`flood-${i}`, `turn-${i}`);
          if (i % 50 === 0) yield* observe("evict-live", "turn-live");
        }
        // The live task still ends its preview: it was never evicted.
        yield* backend.endTask("evict-live", "turn-live");
        expect(endTaskCalls()).toBe(1);
        // A task that stopped dispatching early was evicted: ending it is silent.
        yield* backend.endTask("flood-0", "turn-0");
        expect(endTaskCalls()).toBe(1);
      }),
    ),
  );
});
