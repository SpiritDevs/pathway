import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it, vi } from "@effect/vitest";
import { ProviderDriverKind } from "@spiritdevs/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { ComputerApprovalOutcome } from "../../../computer/ComputerApprovalGate.ts";
import { ComputerManager } from "../../../computer/ComputerManager.ts";
import { FakeComputerBackend } from "../../../computer/FakeComputerBackend.ts";
import { UnavailableComputerBackend } from "../../../computer/UnavailableComputerBackend.ts";
import { ComputerBackendError } from "../../../computer/computerErrors.ts";
import {
  COMPUTER_APPROVAL_REQUIRED_TOOLS,
  makeComputerTools,
  type ComputerToolsOptions,
} from "./computerTools.ts";
import {
  canonicalPathwayComputerToolName,
  isPathwayComputerToolFamilyName,
  PATHWAY_COMPUTER_TOOL_NAMES,
} from "./computerToolPermission.ts";
import type { McpToolCallResult, ToolContext } from "./toolRuntime.ts";

const THREAD = "thread-gap4";

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

function resultJson(result: McpToolCallResult): unknown {
  const text = result.content.find((entry) => entry.type === "text");
  return text?.type === "text" ? decodeJson(text.text) : undefined;
}

function resultText(result: McpToolCallResult): string {
  return result.content.map((entry) => (entry.type === "text" ? entry.text : "")).join("\n");
}

function makeContext(provider = "claudeAgent", threadId = THREAD): ToolContext {
  return {
    callerThreadId: threadId,
    callerThreadLabel: null,
    callerSessionKey: "mcp-session:gap4",
    callerProvider: ProviderDriverKind.make(provider),
    callerCapabilities: new Set(["computer"]),
    callerTurnId: "turn-gap4",
    assertCallerTurnActive: () => Effect.void,
    jsonRpcRequestId: 1,
  };
}

const approving = () => vi.fn(() => Effect.succeed<ComputerApprovalOutcome>("approved"));
const denying = () => vi.fn(() => Effect.succeed<ComputerApprovalOutcome>("denied"));

const setup = Effect.fn(function* (
  backend: FakeComputerBackend | UnavailableComputerBackend = new FakeComputerBackend(),
  authorizeAction?: ComputerToolsOptions["authorizeAction"],
) {
  const manager = yield* ComputerManager.make({ backend, actionSettleMs: 0 });
  const tools = makeComputerTools({
    manager,
    // These tests exercise menu execution; the never-raise gate has explicit
    // refusal coverage in computerTools.test.ts.
    resolveForegroundAuthorization: () => Effect.succeed({ userRequestedVisibleUse: true }),
    ...(authorizeAction ? { authorizeAction } : {}),
  });
  const byName = new Map(tools.map((tool) => [tool.definition.name, tool]));
  const call = (
    name: string,
    args: Record<string, unknown>,
    provider?: string,
    threadId?: string,
  ): Effect.Effect<McpToolCallResult> => {
    const tool = byName.get(name);
    if (!tool) return Effect.die(new Error(`no such tool: ${name}`));
    return tool.handler(args, makeContext(provider, threadId));
  };
  return { backend, manager, tools, byName, call };
});

/** A backend that never implemented the optional app/frame/menu methods. */
function withoutGapFour(backend: FakeComputerBackend): FakeComputerBackend {
  return new Proxy(backend, {
    get: (target, property, receiver) =>
      property === "listApps" || property === "setWindowFrame" || property === "invokeMenu"
        ? undefined
        : Reflect.get(target, property, receiver),
  });
}

it.layer(NodeServices.layer)("Pathway computer tools: menus and frames", (it) => {
  describe("computer_list_apps", () => {
    it.effect("lists apps with the metadata the driver reports, without an approval gate", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const approval = approving();
          const { call, byName } = yield* setup(
            new FakeComputerBackend({
              apps: [
                {
                  pid: 42,
                  name: "TextEdit",
                  bundleId: "com.apple.TextEdit",
                  running: true,
                  active: true,
                  launchPath: "/System/Applications/TextEdit.app",
                  windowCount: 1,
                },
                {
                  pid: 0,
                  name: "Chess",
                  bundleId: "com.apple.Chess",
                  running: false,
                  active: false,
                  launchPath: "/System/Applications/Chess.app",
                },
              ],
            }),
            approval,
          );
          const definition = byName.get("computer_list_apps")?.definition;
          expect(definition?.annotations).toMatchObject({ readOnlyHint: true });
          expect(COMPUTER_APPROVAL_REQUIRED_TOOLS.has("computer_list_apps")).toBe(false);

          const result = yield* call("computer_list_apps", {});
          expect(result.isError).not.toBe(true);
          const payload = resultJson(result) as {
            apps: Array<Record<string, unknown>>;
            availability: { kind: string };
            computerId: string;
          };
          expect(payload.computerId).toBe("desktop");
          expect(payload.availability.kind).toBe("available");
          expect(payload.apps).toEqual([
            expect.objectContaining({
              pid: 42,
              name: "TextEdit",
              bundleId: "com.apple.TextEdit",
              running: true,
              active: true,
              launchPath: "/System/Applications/TextEdit.app",
              windowCount: 1,
            }),
            // Installed-but-not-running rows survive: "is X installed?" is the tool's
            // other half, and the driver reports those with pid 0.
            expect.objectContaining({ pid: 0, name: "Chess", running: false, active: false }),
          ]);
          expect(approval).not.toHaveBeenCalled();
        }),
      ),
    );

    it.effect("refuses cleanly on a backend that cannot enumerate applications", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { call } = yield* setup(withoutGapFour(new FakeComputerBackend()));
          const result = yield* call("computer_list_apps", {});
          expect(result.isError).toBe(true);
          expect(resultText(result)).toContain("cannot enumerate applications");
        }),
      ),
    );

    it.effect("surfaces the unavailable backend's own message", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { call } = yield* setup(
            new UnavailableComputerBackend("the display link is gone", 0),
          );
          const result = yield* call("computer_list_apps", {});
          expect(result.isError).toBe(true);
          expect(resultText(result)).toContain("the display link is gone");
        }),
      ),
    );
  });

  describe("computer_set_window_frame", () => {
    it.effect("is approval-gated and moves the exact window, reporting a verified result", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const approval = approving();
          const backend = new FakeComputerBackend();
          const { call } = yield* setup(backend, approval);
          expect(COMPUTER_APPROVAL_REQUIRED_TOOLS.has("computer_set_window_frame")).toBe(true);

          const result = yield* call("computer_set_window_frame", {
            window_id: "fake-calculator",
            x: 200,
            y: 300,
            width: 800,
            height: 600,
          });
          expect(approval).toHaveBeenCalledWith(
            "computer_set_window_frame",
            expect.objectContaining({ window_id: "fake-calculator" }),
            expect.anything(),
          );
          expect(result.isError).not.toBe(true);
          const payload = resultJson(result) as {
            action: string;
            windowId: string;
            delivery?: { verified: string; effect?: string };
          };
          expect(payload.action).toBe("computer_set_window_frame");
          expect(payload.windowId).toBe("fake-calculator");
          expect(payload.delivery).toMatchObject({ verified: "confirmed", effect: "verified" });
          // The fake's own window list is the readback the result stands on.
          const windows = yield* backend.listWindows();
          expect(windows.find((window) => window.id === "fake-calculator")?.bounds).toEqual({
            x: 200,
            y: 300,
            width: 800,
            height: 600,
          });
        }),
      ),
    );

    it.effect("reports dispatched-unknown when the readback does not show the frame", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const backend = new FakeComputerBackend();
          backend.setFrameApplies(false);
          const { call } = yield* setup(backend);
          const result = yield* call("computer_set_window_frame", {
            window_id: "fake-calculator",
            x: 0,
            y: 0,
            width: 640,
            height: 480,
          });
          expect(result.isError).not.toBe(true);
          const payload = resultJson(result) as {
            delivery?: { verified: string; effect?: string };
          };
          expect(payload.delivery).toMatchObject({
            verified: "unconfirmed",
            effect: "dispatched-unknown",
          });
        }),
      ),
    );

    it.effect("refuses a nonpositive frame and an unknown window before dispatch", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const approval = approving();
          const backend = new FakeComputerBackend();
          const { call } = yield* setup(backend, approval);

          const badSize = yield* call("computer_set_window_frame", {
            window_id: "fake-calculator",
            x: 0,
            y: 0,
            width: 0,
            height: 480,
          });
          expect(badSize.isError).toBe(true);
          const missingWindow = yield* call("computer_set_window_frame", {
            window_id: "no-such-window",
            x: 0,
            y: 0,
            width: 100,
            height: 100,
          });
          expect(missingWindow.isError).toBe(true);
          const missingId = yield* call("computer_set_window_frame", {
            x: 0,
            y: 0,
            width: 100,
            height: 100,
          });
          expect(missingId.isError).toBe(true);
          expect(backend.callsFor("setWindowFrame")).toEqual([]);
        }),
      ),
    );

    it.effect("dispatches nothing when approval is refused", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const backend = new FakeComputerBackend();
          const { call } = yield* setup(backend, denying());
          const result = yield* call("computer_set_window_frame", {
            window_id: "fake-calculator",
            x: 0,
            y: 0,
            width: 100,
            height: 100,
          });
          expect(result.isError).toBe(true);
          expect(backend.callsFor("setWindowFrame")).toEqual([]);
          expect(
            (yield* backend.listWindows()).find((window) => window.id === "fake-calculator")
              ?.bounds,
          ).toEqual({ x: 1_050, y: 120, width: 420, height: 620 });
        }),
      ),
    );
  });

  describe("computer_invoke_menu", () => {
    it.effect(
      "does not promise background menu execution even when visible use is authorized",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const approval = approving();
            const backend = new FakeComputerBackend();
            const { call, byName } = yield* setup(backend, approval);
            const schema = byName.get("computer_invoke_menu")?.definition.inputSchema as {
              properties: { delivery_mode: { enum: string[] } };
            };
            expect(schema.properties.delivery_mode.enum).toEqual(["foreground"]);
            const result = yield* call("computer_invoke_menu", {
              window_id: "fake-calculator",
              path: ["File"],
              delivery_mode: "background",
            });
            expect(result.isError).toBe(true);
            expect(resultText(result)).toContain("cannot preserve background focus");
            expect(approval).not.toHaveBeenCalled();
            expect(backend.callsFor("invokeMenu")).toHaveLength(0);
          }),
        ),
    );

    it.effect("is approval-gated and invokes the exact path on the window's app", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const backend = new FakeComputerBackend();
          const { call } = yield* setup(backend, approving());
          expect(COMPUTER_APPROVAL_REQUIRED_TOOLS.has("computer_invoke_menu")).toBe(true);

          const result = yield* call("computer_invoke_menu", {
            window_id: "fake-terminal",
            path: ["File", "Save"],
          });
          expect(result.isError).not.toBe(true);
          const payload = resultJson(result) as {
            action: string;
            windowId: string;
            delivery?: { verified: string };
          };
          expect(payload.action).toBe("computer_invoke_menu");
          expect(payload.windowId).toBe("fake-terminal");
          expect(backend.callsFor("invokeMenu").at(-1)?.args).toEqual([
            { windowId: "fake-terminal" },
            ["File", "Save"],
          ]);
        }),
      ),
    );

    it.effect("bounds the path the same way the schema advertises", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const backend = new FakeComputerBackend();
          const { call } = yield* setup(backend, approving());

          const empty = yield* call("computer_invoke_menu", {
            window_id: "fake-terminal",
            path: [],
          });
          expect(empty.isError).toBe(true);
          const tooDeep = yield* call("computer_invoke_menu", {
            window_id: "fake-terminal",
            path: ["1", "2", "3", "4", "5", "6", "7"],
          });
          expect(tooDeep.isError).toBe(true);
          const blank = yield* call("computer_invoke_menu", {
            window_id: "fake-terminal",
            path: ["File", "   "],
          });
          expect(blank.isError).toBe(true);
          expect(backend.callsFor("invokeMenu")).toEqual([]);
        }),
      ),
    );

    it.effect("preserves a disabled-item refusal instead of falling back to pixels", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const backend = new FakeComputerBackend();
          backend.refuseMenuPath(
            ["Edit", "Undo"],
            new ComputerBackendError({
              message: "The menu item is disabled.",
              rejectedOperation: "invokeMenu",
            }),
          );
          const { call } = yield* setup(backend, approving());
          const result = yield* call("computer_invoke_menu", {
            window_id: "fake-terminal",
            path: ["Edit", "Undo"],
          });
          expect(result.isError).toBe(true);
          expect(resultText(result)).toContain("disabled");
          // The refusal is persistent state, not a one-off: a replay is refused too.
          const replay = yield* call("computer_invoke_menu", {
            window_id: "fake-terminal",
            path: ["Edit", "Undo"],
          });
          expect(replay.isError).toBe(true);
        }),
      ),
    );

    it.effect("drives another app's menus without asking", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const backend = new FakeComputerBackend();
          const { call } = yield* setup(backend, approving());
          // Both menus dispatch: only the denylist can refuse a drive.
          const first = yield* call("computer_invoke_menu", {
            window_id: "fake-terminal",
            path: ["File"],
          });
          expect(first.isError).not.toBe(true);
          const second = yield* call("computer_invoke_menu", {
            window_id: "fake-calculator",
            path: ["File"],
          });
          expect(second.isError).not.toBe(true);
          expect(backend.callsFor("invokeMenu").length).toBe(2);
        }),
      ),
    );

    it.effect("dispatches nothing when approval is refused", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const backend = new FakeComputerBackend();
          const { call } = yield* setup(backend, denying());
          const result = yield* call("computer_invoke_menu", {
            window_id: "fake-terminal",
            path: ["File", "Quit"],
          });
          expect(result.isError).toBe(true);
          expect(backend.callsFor("invokeMenu")).toEqual([]);
        }),
      ),
    );
  });

  describe("computer_get_accessibility_tree", () => {
    it.effect("returns the desktop inventory without an approval gate", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const approval = approving();
          const backend = new FakeComputerBackend();
          const { call, byName } = yield* setup(backend, approval);
          const definition = byName.get("computer_get_accessibility_tree")?.definition;
          expect(definition?.annotations).toMatchObject({ readOnlyHint: true });
          expect(COMPUTER_APPROVAL_REQUIRED_TOOLS.has("computer_get_accessibility_tree")).toBe(
            false,
          );

          const result = yield* call("computer_get_accessibility_tree", {});
          expect(result.isError).not.toBe(true);
          const payload = resultJson(result) as {
            apps: Array<Record<string, unknown>>;
            windows: Array<Record<string, unknown>>;
            truncated: boolean;
            availability: { kind: string };
            computerId: string;
          };
          expect(payload.computerId).toBe("desktop");
          expect(payload.truncated).toBe(false);
          // The default fake desktop: two running apps and their on-screen windows.
          expect(payload.apps.map((app) => app.pid)).toEqual([1_001, 1_002]);
          expect(payload.windows.map((window) => window.id)).toEqual([
            "fake-terminal",
            "fake-calculator",
          ]);
          expect(approval).not.toHaveBeenCalled();
          expect(backend.callsFor("getAccessibilityTree")).toHaveLength(1);
          expect(backend.callsFor("getAccessibilityTree")[0]?.args).toEqual([]);
        }),
      ),
    );

    it.effect("scopes the snapshot to the app owning the exact window", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const backend = new FakeComputerBackend();
          const { call } = yield* setup(backend);
          const scoped = yield* call("computer_get_accessibility_tree", {
            window_id: "fake-calculator",
          });
          expect(scoped.isError).not.toBe(true);
          const payload = resultJson(scoped) as {
            windowId?: string;
            apps: Array<{ pid: number }>;
            windows: Array<{ id: string }>;
          };
          expect(payload.windowId).toBe("fake-calculator");
          expect(payload.apps).toEqual([expect.objectContaining({ pid: 1_002 })]);
          expect(payload.windows.map((window) => window.id)).toEqual(["fake-calculator"]);
          expect(backend.callsFor("getAccessibilityTree")[0]?.args).toEqual(["fake-calculator"]);

          const missing = yield* call("computer_get_accessibility_tree", {
            window_id: "no-such-window",
          });
          expect(missing.isError).toBe(true);
          // The existence check fails before the backend is asked again.
          expect(backend.callsFor("getAccessibilityTree")).toHaveLength(1);
        }),
      ),
    );

    it.effect(
      "refuses cleanly on a backend without the read and carries the unavailable message",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const stripped = new Proxy(new FakeComputerBackend(), {
              get: (target, property, receiver) =>
                property === "getAccessibilityTree"
                  ? undefined
                  : Reflect.get(target, property, receiver),
            });
            const { call } = yield* setup(stripped);
            const result = yield* call("computer_get_accessibility_tree", {});
            expect(result.isError).toBe(true);
            expect(resultText(result)).toContain("cannot read the desktop inventory");

            const unavailable = yield* setup(
              new UnavailableComputerBackend("the display link is gone", 0),
            );
            const refused = yield* unavailable.call("computer_get_accessibility_tree", {});
            expect(refused.isError).toBe(true);
            expect(resultText(refused)).toContain("the display link is gone");
          }),
        ),
    );
  });

  describe("computer_get_cursor_position", () => {
    it.effect("reads the pointer without an approval gate or a control lease", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const approval = approving();
          const backend = new FakeComputerBackend();
          backend.setCursorPosition({ x: 410, y: 240 });
          const { call, byName } = yield* setup(backend, approval);
          const definition = byName.get("computer_get_cursor_position")?.definition;
          expect(definition?.annotations).toMatchObject({ readOnlyHint: true });
          expect(COMPUTER_APPROVAL_REQUIRED_TOOLS.has("computer_get_cursor_position")).toBe(false);

          const result = yield* call("computer_get_cursor_position", {});
          expect(result.isError).not.toBe(true);
          expect(resultJson(result)).toMatchObject({
            computerId: "desktop",
            x: 410,
            y: 240,
          });
          expect(approval).not.toHaveBeenCalled();
          // A read takes no lease: the desktop control path was never entered.
          expect(backend.callsFor("getCursorPosition")).toHaveLength(1);
        }),
      ),
    );

    it.effect("reports containment when scoped to a window, and refuses a dead one", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const backend = new FakeComputerBackend();
          // fake-calculator spans x 1050..1470, y 120..740.
          backend.setCursorPosition({ x: 1_100, y: 200 });
          const { call } = yield* setup(backend);
          const inside = yield* call("computer_get_cursor_position", {
            window_id: "fake-calculator",
          });
          expect(inside.isError).not.toBe(true);
          expect(resultJson(inside)).toMatchObject({
            windowId: "fake-calculator",
            insideWindow: true,
          });
          backend.setCursorPosition({ x: 10, y: 10 });
          const outside = yield* call("computer_get_cursor_position", {
            window_id: "fake-calculator",
          });
          expect(resultJson(outside)).toMatchObject({ insideWindow: false });

          const missing = yield* call("computer_get_cursor_position", {
            window_id: "no-such-window",
          });
          expect(missing.isError).toBe(true);
        }),
      ),
    );

    it.effect(
      "refuses cleanly on a backend without the read and carries the unavailable message",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const stripped = new Proxy(new FakeComputerBackend(), {
              get: (target, property, receiver) =>
                property === "getCursorPosition"
                  ? undefined
                  : Reflect.get(target, property, receiver),
            });
            const { call } = yield* setup(stripped);
            const result = yield* call("computer_get_cursor_position", {});
            expect(result.isError).toBe(true);
            expect(resultText(result)).toContain("cannot read the cursor position");

            const unavailable = yield* setup(
              new UnavailableComputerBackend("the display link is gone", 0),
            );
            const refused = yield* unavailable.call("computer_get_cursor_position", {});
            expect(refused.isError).toBe(true);
            expect(resultText(refused)).toContain("the display link is gone");
          }),
        ),
    );
  });

  describe("tool-name registry", () => {
    it.effect("owns every served tool name in all three provider spellings", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { byName } = yield* setup();
          for (const name of [
            "computer_list_apps",
            "computer_set_window_frame",
            "computer_invoke_menu",
            "computer_verify_state",
            "computer_zoom",
            "computer_get_accessibility_tree",
            "computer_get_cursor_position",
            "computer_kill_app",
          ]) {
            // A served tool that the registry does not own dies two ways: the
            // denial card cannot route it and the provider permission path treats
            // it as foreign.
            expect(byName.has(name), `Pathway serves ${name}`).toBe(true);
            expect(PATHWAY_COMPUTER_TOOL_NAMES).toContain(name);
            expect(canonicalPathwayComputerToolName(`pathway_${name}`)).toBe(name);
            expect(canonicalPathwayComputerToolName(`mcp__pathway__${name}`)).toBe(name);
            expect(isPathwayComputerToolFamilyName(name)).toBe(true);
          }
        }),
      ),
    );
  });

  describe("computer_run step coverage", () => {
    it.effect("runs frame and menu steps in order inside one approved sequence", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const backend = new FakeComputerBackend();
          const { call } = yield* setup(backend, approving());
          const result = yield* call("computer_run", {
            steps: [
              {
                type: "set_window_frame",
                window_id: "fake-calculator",
                x: 10,
                y: 10,
                width: 500,
                height: 400,
              },
              { type: "invoke_menu", window_id: "fake-terminal", path: ["File"] },
            ],
          });
          expect(result.isError).not.toBe(true);
          expect(backend.callsFor("setWindowFrame").at(-1)?.args).toEqual([
            "fake-calculator",
            { x: 10, y: 10, width: 500, height: 400 },
          ]);
          expect(backend.callsFor("invokeMenu").at(-1)?.args).toEqual([
            { windowId: "fake-terminal" },
            ["File"],
          ]);
        }),
      ),
    );

    it.effect("refuses a run step missing its window or a menu path that is too deep", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const backend = new FakeComputerBackend();
          const { call } = yield* setup(backend, approving());
          const missingWindow = yield* call("computer_run", {
            steps: [{ type: "set_window_frame", x: 0, y: 0, width: 10, height: 10 }],
          });
          expect(missingWindow.isError).toBe(true);
          const deepMenu = yield* call("computer_run", {
            steps: [
              {
                type: "invoke_menu",
                window_id: "fake-terminal",
                path: ["1", "2", "3", "4", "5", "6", "7"],
              },
            ],
          });
          expect(deepMenu.isError).toBe(true);
          expect(backend.callsFor("invokeMenu")).toEqual([]);
        }),
      ),
    );
  });
});
