import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { HostProcessPlatform } from "@spiritdevs/shared/hostProcess";
import * as Effect from "effect/Effect";

import { makeCuaComputerBackend, type CuaRequest } from "./CuaComputerBackend.ts";
import { withDesktopDeliveryMode } from "./DesktopOperationQueue.ts";

const PNG_400x200 = (() => {
  const header = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(header);
  header.write("IHDR", 12);
  header.writeUInt32BE(400, 16);
  header.writeUInt32BE(200, 20);
  return header.toString("base64");
})();
const BOUNDS = { x: 0, y: 0, width: 200, height: 100 };

/** Scripted Cua stub: no Fake — Fake enforces no Space or grounding. */
const spaceFixture = Effect.fn(function* () {
  const calls: Array<{ name?: string }> = [];
  let onSpace = true;
  const respond = (req: Record<string, unknown>) => {
    calls.push(typeof req.name === "string" ? { name: req.name } : {});
    const method = req.method;
    if (method === "probe" || method === "stop") return { ok: true };
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
                is_on_screen: onSpace,
                on_current_space: onSpace,
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
          content: [{ type: "image", mimeType: "image/png", data: PNG_400x200 }],
        },
      };
    return { ok: true, result: { structuredContent: {} } };
  };
  // Captures may begin with permission/window reads, without a separate probe.
  // Identify the macOS native host on every reply, just like the real transport.
  const request: CuaRequest = async (_endpoint, req) => ({
    ...respond(req as Record<string, unknown>),
    hostPlatform: "darwin",
  });
  // Exercise a Linux backend connected to this fixture's macOS native host.
  const backend = yield* makeCuaComputerBackend({ endpoint: "/space-churn", request }).pipe(
    Effect.provideService(HostProcessPlatform, "linux"),
  );
  return {
    backend,
    calls,
    moveOffSpace: () => {
      onSpace = false;
    },
  };
});

it.layer(NodeServices.layer)("computer Space churn", (it) => {
  it.effect(
    "a Space change between prepare and dispatch refuses once, sends no drag, stays observable",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { backend, calls, moveOffSpace } = yield* spaceFixture();
          // Prepared on its Space: the observation grounds the drag.
          yield* backend.captureScreenshot({ kind: "window", windowId: "cua:10:20" });
          // The window leaves the Space before dispatch.
          moveOffSpace();
          // A single refusal naming the pause — never a dispatch, never a retry.
          const refused = yield* Effect.flip(
            withDesktopDeliveryMode(
              "foreground",
              backend.drag({ x: 50, y: 50 }, { x: 100, y: 60 }, 500, "cua:10:20"),
            ),
          );
          expect(refused).toMatchObject({
            effect: "not-dispatched",
            code: "target_not_on_active_space",
            inputPause: { windowId: "cua:10:20" },
          });
          expect(calls.filter((call) => call.name === "drag")).toHaveLength(0);
          // Read-only observation stays available on the next call.
          expect(yield* backend.getState({ windowId: "cua:10:20" })).toMatchObject({
            computerId: "desktop",
          });
          expect(calls.filter((call) => call.name === "drag")).toHaveLength(0);
        }),
      ),
  );

  it.effect("refuses a background drag the same way when the window leaves the Space", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { backend, calls, moveOffSpace } = yield* spaceFixture();
        yield* backend.captureScreenshot({ kind: "window", windowId: "cua:10:20" });
        moveOffSpace();
        // Default delivery mode is background: no explicit mode wrapper needed.
        const refused = yield* Effect.flip(
          backend.drag({ x: 50, y: 50 }, { x: 100, y: 60 }, 500, "cua:10:20"),
        );
        expect(refused).toMatchObject({
          effect: "not-dispatched",
          code: "target_not_on_active_space",
          inputPause: { windowId: "cua:10:20" },
        });
        expect(calls.filter((call) => call.name === "drag")).toHaveLength(0);
      }),
    ),
  );
});
