import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import { ComputerApprovalRequester, make as makeApprovalGate } from "./ComputerApprovalGate.ts";
import { makeCuaComputerBackend } from "./CuaComputerBackend.ts";
import { fakeCuaRequest } from "./testing/FakeCuaRequest.ts";

const PNG_400x200 = (() => {
  const header = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(header);
  header.write("IHDR", 12);
  header.writeUInt32BE(400, 16);
  header.writeUInt32BE(200, 20);
  return header.toString("base64");
})();
const BOUNDS = { x: 0, y: 0, width: 200, height: 100 };

interface GuardControls {
  /** Answer readiness with a native auth-sheet refusal. */
  readonly refuseReadinessAsAuthSheet: () => void;
  /** Answer keyboard input with a native refusal under `code`. */
  readonly refuseInput: (code: string) => void;
}

/** Scripted Cua stub: no Fake — Fake enforces no delivery mode or sheet state. */
const guardFixture = Effect.fn(function* () {
  const calls: Array<{ name?: string }> = [];
  let readinessRefusal: Record<string, unknown> | undefined;
  let inputRefusal: { code: string } | undefined;
  const respond = (req: Record<string, unknown>) => {
    calls.push(typeof req.name === "string" ? { name: req.name } : {});
    const method = req.method as string | undefined;
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
    if (req.name === "check_input_ready") {
      if (readinessRefusal)
        return {
          ok: true,
          result: { isError: true, structuredContent: readinessRefusal },
        };
      return {
        ok: true,
        result: { structuredContent: { ready: true, pid: 10, window_id: 20 } },
      };
    }
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
    if (req.name === "type_text" && inputRefusal)
      return {
        ok: true,
        result: {
          isError: true,
          structuredContent: {
            effect: "refused",
            code: inputRefusal.code,
            message: "The native operation could not complete.",
          },
          content: [{ type: "text", text: "No actuator ran." }],
        },
      };
    return { ok: true, result: { structuredContent: {} } };
  };
  // The real host identifies its platform on every reply. Direct input starts
  // with list_windows, so probe-only metadata does not describe this host yet.
  const request = async (_endpoint: string, req: unknown) => ({
    ...respond(req as Record<string, unknown>),
    hostPlatform: "darwin",
  });
  const backend = yield* makeCuaComputerBackend({
    endpoint: "/foreground-guard",
    request: fakeCuaRequest(request),
  });
  const controls: GuardControls = {
    refuseReadinessAsAuthSheet: () => {
      readinessRefusal = {
        effect: "refused",
        code: "auth_sheet_focused",
        message: "An authentication sheet has focus.",
        pid: 10,
        window_id: 20,
      };
    },
    refuseInput: (code) => {
      inputRefusal = { code };
    },
  };
  return { backend, calls, controls };
});

/** The backend may run on Linux while its authenticated native host is macOS. */
const runOnLinux = Effect.acquireRelease(
  Effect.sync(() => {
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { ...descriptor, value: "linux" });
    return descriptor;
  }),
  (descriptor) => Effect.sync(() => Object.defineProperty(process, "platform", descriptor)),
);

it.layer(NodeServices.layer)("computer foreground guard", (it) => {
  it.effect("background never activates: raise is refused before any native call", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* runOnLinux;
        const { backend, calls } = yield* guardFixture();
        // Default delivery is background: activation is refused, not queued.
        expect(yield* Effect.flip(backend.raiseWindow("cua:10:20"))).toMatchObject({
          effect: "not-dispatched",
          code: "foreground_required",
        });
        expect(calls.filter((call) => call.name === "bring_to_front")).toHaveLength(0);
        expect(calls).toHaveLength(0);
      }),
    ),
  );

  it.effect(
    "auth sheets never approve: input and readiness refuse without settling approvals",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* runOnLinux;
          const { backend, calls, controls } = yield* guardFixture();
          const opened = yield* Deferred.make<string>();
          const gate = yield* makeApprovalGate().pipe(
            Effect.provideService(ComputerApprovalRequester, {
              open: (prompt) => Deferred.succeed(opened, prompt.requestId).pipe(Effect.asVoid),
              resolve: () => Effect.void,
            }),
          );
          const threadId = "foreground-guard-thread";
          const prompt = yield* Effect.forkChild(
            gate.request({ threadId, callKey: "foreground-guard", toolName: "computer_type_text" }),
          );
          const promptId = yield* Deferred.await(opened);

          controls.refuseInput("auth_sheet_focused");
          expect(yield* Effect.flip(backend.typeText("abc", "cua:10:20"))).toMatchObject({
            effect: "not-dispatched",
            code: "auth_sheet_focused",
            inputPause: { windowId: "cua:10:20" },
          });
          // Observation stays available past the sheet; the pause is input-only.
          expect(yield* backend.getState({ windowId: "cua:10:20" })).toMatchObject({
            computerId: "desktop",
          });
          // Readiness surfaces the same code through the read-only path.
          controls.refuseReadinessAsAuthSheet();
          expect(yield* Effect.flip(backend.checkInputReady("cua:10:20"))).toMatchObject({
            effect: "not-dispatched",
            code: "auth_sheet_focused",
          });
          // Neither refusal approved, denied, or otherwise touched the live prompt.
          expect(promptId).not.toBe("");
          expect(yield* gate.respond(threadId, promptId, "accept")).toBe(true);
          expect(yield* Fiber.join(prompt)).toBe("approved");
          expect(calls.filter((call) => call.name === "bring_to_front")).toHaveLength(0);
        }),
      ),
  );

  it.effect("secure input refuses keyboard delivery as not-dispatched without an input pause", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* runOnLinux;
        const { backend, calls, controls } = yield* guardFixture();
        controls.refuseInput("secure_input_active");
        expect(yield* Effect.flip(backend.typeText("abc", "cua:10:20"))).toMatchObject({
          effect: "not-dispatched",
          code: "secure_input_active",
        });
        const error = yield* Effect.flip(backend.typeText("abc", "cua:10:20"));
        expect("inputPause" in error ? error.inputPause : undefined).toBeUndefined();
        expect(calls.filter((call) => call.name === "click")).toHaveLength(0);
      }),
    ),
  );
});
