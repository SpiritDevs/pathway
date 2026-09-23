import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it, vi } from "@effect/vitest";
import { ProviderDriverKind } from "@spiritdevs/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { ComputerApprovalOutcome } from "../../../computer/ComputerApprovalGate.ts";
import { ComputerManager } from "../../../computer/ComputerManager.ts";
import { FakeComputerBackend } from "../../../computer/FakeComputerBackend.ts";
import { UnavailableComputerBackend } from "../../../computer/UnavailableComputerBackend.ts";
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

const THREAD = "thread-visibility";

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

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
    callerSessionKey: "mcp-session:visibility",
    callerProvider: ProviderDriverKind.make(provider),
    callerCapabilities: new Set(["computer"]),
    callerTurnId: "turn-visibility",
    assertCallerTurnActive: () => Effect.void,
    jsonRpcRequestId: 1,
  };
}

const approving = () => vi.fn(() => Effect.succeed<ComputerApprovalOutcome>("approved"));
const denying = () => vi.fn(() => Effect.succeed<ComputerApprovalOutcome>("denied"));

const setup = Effect.fn(function* (
  backend: FakeComputerBackend | UnavailableComputerBackend = new FakeComputerBackend(),
  authorizeAction?: ComputerToolsOptions["authorizeAction"],
  /** Defaults to the user having asked to see the screen; the gate's own tests override it. */
  resolveForegroundAuthorization: ComputerToolsOptions["resolveForegroundAuthorization"] = () =>
    Effect.succeed({ userRequestedVisibleUse: true }),
) {
  const manager = yield* ComputerManager.make({ backend, actionSettleMs: 0 });
  const tools = makeComputerTools({
    manager,
    ...(authorizeAction ? { authorizeAction } : {}),
    resolveForegroundAuthorization,
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

/** A backend that never implemented the visibility lifecycle methods. */
function withoutVisibility(backend: FakeComputerBackend): FakeComputerBackend {
  return new Proxy(backend, {
    get: (target, property, receiver) =>
      property === "setWindowMinimized" || property === "setAppVisibility"
        ? undefined
        : Reflect.get(target, property, receiver),
  });
}

it.layer(NodeServices.layer)("Pathway computer tools: visibility lifecycle", (it) => {
  describe("computer_set_window_minimized", () => {
    it.effect("is approval-gated and minimizes the exact window without activating it", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const approval = approving();
          const backend = new FakeComputerBackend();
          const { call } = yield* setup(backend, approval);
          expect(COMPUTER_APPROVAL_REQUIRED_TOOLS.has("computer_set_window_minimized")).toBe(true);

          const result = yield* call("computer_set_window_minimized", {
            window_id: "fake-calculator",
            minimized: true,
          });
          expect(approval).toHaveBeenCalledWith(
            "computer_set_window_minimized",
            expect.objectContaining({ window_id: "fake-calculator", minimized: true }),
            expect.anything(),
          );
          expect(result.isError).not.toBe(true);
          const payload = resultJson(result) as {
            action: string;
            windowId: string;
            delivery?: { verified: string; effect?: string };
          };
          expect(payload.action).toBe("computer_set_window_minimized");
          expect(payload.windowId).toBe("fake-calculator");
          expect(payload.delivery).toMatchObject({ verified: "confirmed", effect: "verified" });
          // Off screen but still listed — the semantic tools keep it addressable.
          const window = (yield* backend.listWindows()).find(
            (candidate) => candidate.id === "fake-calculator",
          );
          expect(window).toMatchObject({ minimized: true, visible: false });
          // Nothing activated and nothing was aimed: the window-level visibility
          // write never reaches the raise/focus actuators. (`focused` on the fake is
          // the agent's input aim, which the lease claim itself clears — it is not
          // frontmost state.)
          expect(
            (yield* backend.listWindows()).find((candidate) => candidate.id === "fake-terminal"),
          ).toMatchObject({ visible: true });
          expect(backend.callsFor("raiseWindow")).toEqual([]);
          expect(backend.callsFor("focusWindow")).toEqual([]);
        }),
      ),
    );

    it.effect("restores the same window in place", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const backend = new FakeComputerBackend();
          const { call } = yield* setup(backend, approving());
          yield* call("computer_set_window_minimized", {
            window_id: "fake-calculator",
            minimized: true,
          });
          const restored = yield* call("computer_set_window_minimized", {
            window_id: "fake-calculator",
            minimized: false,
          });
          expect(restored.isError).not.toBe(true);
          const window = (yield* backend.listWindows()).find(
            (candidate) => candidate.id === "fake-calculator",
          );
          expect(window).toMatchObject({ minimized: false, visible: true });
        }),
      ),
    );

    it.effect("refuses bad arguments and a foreground mode it cannot honor before dispatch", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const backend = new FakeComputerBackend();
          const { call } = yield* setup(backend, approving());

          const foreground = yield* call("computer_set_window_minimized", {
            window_id: "fake-calculator",
            minimized: true,
            delivery_mode: "foreground",
          });
          expect(foreground.isError).toBe(true);
          expect(resultText(foreground)).toContain("never activates");
          const missingWindow = yield* call("computer_set_window_minimized", {
            window_id: "no-such-window",
            minimized: true,
          });
          expect(missingWindow.isError).toBe(true);
          const missingFlag = yield* call("computer_set_window_minimized", {
            window_id: "fake-calculator",
          });
          expect(missingFlag.isError).toBe(true);
          const wrongType = yield* call("computer_set_window_minimized", {
            window_id: "fake-calculator",
            minimized: "yes",
          });
          expect(wrongType.isError).toBe(true);
          const missingId = yield* call("computer_set_window_minimized", { minimized: true });
          expect(missingId.isError).toBe(true);
          expect(backend.callsFor("setWindowMinimized")).toEqual([]);
        }),
      ),
    );

    it.effect("hides another app's window without asking", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const backend = new FakeComputerBackend();
          const { call } = yield* setup(backend, approving());
          // Both windows minimize: only the denylist can refuse a drive.
          const first = yield* call("computer_set_window_minimized", {
            window_id: "fake-terminal",
            minimized: true,
          });
          expect(first.isError).not.toBe(true);
          const second = yield* call("computer_set_window_minimized", {
            window_id: "fake-calculator",
            minimized: true,
          });
          expect(second.isError).not.toBe(true);
          expect(backend.callsFor("setWindowMinimized").length).toBe(2);
        }),
      ),
    );

    it.effect("dispatches nothing when approval is refused", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const backend = new FakeComputerBackend();
          const { call } = yield* setup(backend, denying());
          const result = yield* call("computer_set_window_minimized", {
            window_id: "fake-calculator",
            minimized: true,
          });
          expect(result.isError).toBe(true);
          expect(backend.callsFor("setWindowMinimized")).toEqual([]);
          expect(
            (yield* backend.listWindows()).find((window) => window.id === "fake-calculator"),
          ).toMatchObject({ minimized: false, visible: true });
        }),
      ),
    );

    it.effect(
      "refuses cleanly on a backend without the write and carries the unavailable message",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const approval = approving();
            const { call } = yield* setup(withoutVisibility(new FakeComputerBackend()), approval);
            const result = yield* call("computer_set_window_minimized", {
              window_id: "fake-calculator",
              minimized: true,
            });
            expect(result.isError).toBe(true);
            expect(resultText(result)).toContain("cannot minimize or restore windows");

            const unavailable = yield* setup(
              new UnavailableComputerBackend("the display link is gone", 0),
              approval,
            );
            const refused = yield* unavailable.call("computer_set_window_minimized", {
              window_id: "fake-calculator",
              minimized: true,
            });
            expect(refused.isError).toBe(true);
            expect(resultText(refused)).toContain("the display link is gone");
          }),
        ),
    );
  });

  describe("computer_set_app_visibility", () => {
    it.effect("is approval-gated and hides a running app by pid without activating it", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const approval = approving();
          const backend = new FakeComputerBackend();
          const { call } = yield* setup(backend, approval);
          expect(COMPUTER_APPROVAL_REQUIRED_TOOLS.has("computer_set_app_visibility")).toBe(true);

          const result = yield* call("computer_set_app_visibility", { pid: 1_002, hidden: true });
          expect(approval).toHaveBeenCalledWith(
            "computer_set_app_visibility",
            expect.objectContaining({ pid: 1_002, hidden: true }),
            expect.anything(),
          );
          expect(result.isError).not.toBe(true);
          const payload = resultJson(result) as {
            action: string;
            delivery?: { verified: string; effect?: string };
          };
          expect(payload.action).toBe("computer_set_app_visibility");
          expect(payload.delivery).toMatchObject({ verified: "confirmed", effect: "verified" });
          // Every window of that pid leaves the screen; the other app's stays.
          const windows = yield* backend.listWindows();
          expect(windows.find((window) => window.id === "fake-calculator")).toMatchObject({
            visible: false,
          });
          expect(windows.find((window) => window.id === "fake-terminal")).toMatchObject({
            visible: true,
          });
          expect(backend.callsFor("raiseWindow")).toEqual([]);
          expect(backend.callsFor("focusWindow")).toEqual([]);
        }),
      ),
    );

    it.effect("unhides the app's windows in place", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const backend = new FakeComputerBackend();
          const { call } = yield* setup(backend, approving());
          yield* call("computer_set_app_visibility", { pid: 1_002, hidden: true });
          const restored = yield* call("computer_set_app_visibility", {
            pid: 1_002,
            hidden: false,
          });
          expect(restored.isError).not.toBe(true);
          expect(
            (yield* backend.listWindows()).find((window) => window.id === "fake-calculator"),
          ).toMatchObject({ visible: true });
        }),
      ),
    );

    it.effect("refuses a bad pid, a missing flag, and foreground delivery before dispatch", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const backend = new FakeComputerBackend();
          const { call } = yield* setup(backend, approving());

          for (const args of [
            { pid: 0, hidden: true },
            { pid: -3, hidden: true },
            { pid: 1.5, hidden: true },
            { pid: "1002", hidden: true },
            { pid: 1_002 },
            { pid: 1_002, hidden: "yes" },
            { hidden: true },
            { pid: 1_002, hidden: true, delivery_mode: "foreground" },
          ]) {
            const result = yield* call("computer_set_app_visibility", args);
            expect(result.isError, encodeJson(args)).toBe(true);
          }
          expect(backend.callsFor("setAppVisibility")).toEqual([]);
        }),
      ),
    );

    it.effect("hides the app a pid resolves to without asking", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const backend = new FakeComputerBackend();
          const { call } = yield* setup(backend, approving());
          const first = yield* call("computer_set_window_minimized", {
            window_id: "fake-terminal",
            minimized: true,
          });
          expect(first.isError).not.toBe(true);
          // pid 1002 resolves to the calculator: an ordinary drive, so it hides.
          const second = yield* call("computer_set_app_visibility", {
            pid: 1_002,
            hidden: true,
          });
          expect(second.isError).not.toBe(true);
          expect(backend.callsFor("setAppVisibility")).toHaveLength(1);
        }),
      ),
    );

    it.effect("reaches the backend refusal for a pid that names no running app", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const backend = new FakeComputerBackend();
          const { call } = yield* setup(backend, approving());
          // A pid nothing resolves to still admits under the stable pid key — the
          // boundary is never skipped for want of a name — then the backend's own
          // "no such app" refusal is what surfaces.
          const result = yield* call("computer_set_app_visibility", { pid: 9_999, hidden: true });
          expect(result.isError).toBe(true);
          expect(resultText(result)).toContain("No running application has pid 9999");
          expect(backend.callsFor("setAppVisibility")).toHaveLength(1);
        }),
      ),
    );

    it.effect("dispatches nothing when approval is refused", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const backend = new FakeComputerBackend();
          const { call } = yield* setup(backend, denying());
          const result = yield* call("computer_set_app_visibility", { pid: 1_002, hidden: true });
          expect(result.isError).toBe(true);
          expect(backend.callsFor("setAppVisibility")).toEqual([]);
        }),
      ),
    );

    it.effect(
      "refuses cleanly on a backend without the write and carries the unavailable message",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const approval = approving();
            const { call } = yield* setup(withoutVisibility(new FakeComputerBackend()), approval);
            const result = yield* call("computer_set_app_visibility", {
              pid: 1_002,
              hidden: true,
            });
            expect(result.isError).toBe(true);
            expect(resultText(result)).toContain("cannot hide or unhide applications");

            const unavailable = yield* setup(
              new UnavailableComputerBackend("the display link is gone", 0),
              approval,
            );
            const refused = yield* unavailable.call("computer_set_app_visibility", {
              pid: 1_002,
              hidden: true,
            });
            expect(refused.isError).toBe(true);
            expect(resultText(refused)).toContain("the display link is gone");
          }),
        ),
    );
  });

  describe("computer_launch_app hidden", () => {
    it.effect("launches the app off-screen — created but never rendered, never focused", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const backend = new FakeComputerBackend();
          const { call } = yield* setup(backend, approving());
          const result = yield* call("computer_launch_app", {
            app: "TextEdit",
            hidden: true,
            wait_for_window: false,
          });
          expect(result.isError).not.toBe(true);
          // The option arrives as the third argument only when asked for.
          expect(backend.callsFor("launchApp").at(-1)?.args).toEqual([
            "TextEdit",
            [],
            { hidden: true },
          ]);
          const windows = yield* backend.listWindows();
          const launched = windows.find((window) => window.appName === "TextEdit");
          expect(launched).toMatchObject({ focused: false, visible: false });
          // The other windows' flags are untouched: a hidden launch takes no focus
          // and renders nothing over them.
          expect(windows.find((window) => window.id === "fake-terminal")).toMatchObject({
            visible: true,
          });
          expect(backend.callsFor("raiseWindow")).toEqual([]);
        }),
      ),
    );

    it.effect("creates an available background window without foreground authorization", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const backend = new FakeComputerBackend({ agentDialect: "macos" });
          const { call } = yield* setup(backend, approving(), () =>
            Effect.succeed({ userRequestedVisibleUse: false }),
          );
          const before = yield* backend.listWindows();
          for (const options of [{}, { hidden: false }]) {
            const result = yield* call("computer_launch_app", {
              app: "TextEdit",
              wait_for_window: false,
              ...options,
            });
            expect(result.isError).not.toBe(true);
          }
          expect(backend.callsFor("launchApp").map((entry) => entry.args)).toEqual([
            ["TextEdit", []],
            ["TextEdit", [], { hidden: false }],
          ]);
          const after = yield* backend.listWindows();
          expect(after.filter((window) => window.appName === "TextEdit")).toEqual([
            expect.objectContaining({ focused: false, visible: true }),
            expect.objectContaining({ focused: false, visible: true }),
          ]);
          for (const existing of before) {
            expect(after.find((window) => window.id === existing.id)?.visible).toBe(
              existing.visible,
            );
          }
          expect(backend.callsFor("raiseWindow")).toEqual([]);
          expect(backend.callsFor("focusWindow")).toEqual([]);
        }),
      ),
    );
  });

  describe("hidden-workspace run steps", () => {
    it.effect("runs the visibility lifecycle steps in order inside one approved sequence", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const backend = new FakeComputerBackend();
          const { call } = yield* setup(backend, approving());
          const result = yield* call("computer_run", {
            steps: [
              { type: "launch_app", app: "org.kde.konsole", hidden: true, wait_for_window: false },
              { type: "set_window_minimized", window_id: "fake-terminal", minimized: true },
              { type: "set_app_visibility", pid: 1_002, hidden: true },
            ],
          });
          expect(result.isError).not.toBe(true);
          expect(backend.callsFor("launchApp").at(-1)?.args).toEqual([
            "org.kde.konsole",
            [],
            { hidden: true },
          ]);
          expect(backend.callsFor("setWindowMinimized").at(-1)?.args).toEqual([
            "fake-terminal",
            true,
          ]);
          expect(backend.callsFor("setAppVisibility").at(-1)?.args).toEqual([1_002, true]);
        }),
      ),
    );

    it.effect("refuses a malformed visibility step before anything dispatches", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const backend = new FakeComputerBackend();
          const { call } = yield* setup(backend, approving());
          for (const steps of [
            [{ type: "set_window_minimized", minimized: true }],
            [{ type: "set_window_minimized", window_id: "fake-terminal" }],
            [{ type: "set_app_visibility", hidden: true }],
            [{ type: "set_app_visibility", pid: 1_002 }],
            [{ type: "set_app_visibility", pid: -1, hidden: true }],
          ]) {
            const result = yield* call("computer_run", { steps });
            expect(result.isError, encodeJson(steps)).toBe(true);
          }
          expect(backend.callsFor("setWindowMinimized")).toEqual([]);
          expect(backend.callsFor("setAppVisibility")).toEqual([]);
        }),
      ),
    );
  });

  describe("tool-name registry", () => {
    it.effect("owns the visibility lifecycle names in all three provider spellings", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { byName } = yield* setup();
          for (const name of ["computer_set_window_minimized", "computer_set_app_visibility"]) {
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
});
