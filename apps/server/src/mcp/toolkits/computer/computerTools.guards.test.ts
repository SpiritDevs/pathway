import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it, vi } from "@effect/vitest";
import {
  COMPUTER_SELECT_TEXT_RANGE_MAX,
  COMPUTER_TEXT_MAX_LENGTH,
  COMPUTER_WAIT_MAX_MS,
  ProviderDriverKind,
  type ComputerUiNode,
} from "@spiritdevs/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import type { ComputerApprovalOutcome } from "../../../computer/ComputerApprovalGate.ts";
import {
  DEFAULT_COMPUTER_CAPTURE_MAX_DIMENSION,
  MAX_COMPUTER_CLIPBOARD_BYTES,
} from "../../../computer/ComputerBackend.ts";
import { CuaActionError } from "../../../computer/computerErrors.ts";
import { ComputerManager } from "../../../computer/ComputerManager.ts";
import { FakeComputerBackend } from "../../../computer/FakeComputerBackend.ts";
import { makeComputerBrowserTools } from "./computerBrowserTools.ts";
import {
  COMPUTER_CONTROL_FIRST_MUTATION_DISCLOSURE,
  computerToolInstructions,
  computerToolRequiresApproval,
  makeComputerTools,
  type ComputerToolsOptions,
} from "./computerTools.ts";
import type {
  ComputerAuthorizeAction,
  McpToolCallResult,
  ToolContext,
  ToolEntry,
} from "./toolRuntime.ts";

const THREAD = "thread-computer";

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

function resultJson(result: McpToolCallResult): unknown {
  const text = result.content.find((entry) => entry.type === "text");
  return text?.type === "text" ? decodeJson(text.text) : undefined;
}

/** The first text part of a result, or "" when it has none. */
function firstText(result: McpToolCallResult): string {
  const text = result.content.find((entry) => entry.type === "text");
  return text?.type === "text" ? text.text : "";
}

/** A backend that never implemented the optional clipboard methods. */
function withoutClipboard(backend: FakeComputerBackend): FakeComputerBackend {
  return new Proxy(backend, {
    get: (target, property, receiver) =>
      property === "readClipboard" || property === "writeClipboard"
        ? undefined
        : Reflect.get(target, property, receiver),
  });
}

function makeContext(
  provider: ProviderDriverKind = ProviderDriverKind.make("claudeAgent"),
  threadId = THREAD,
  label: string | null = null,
): ToolContext {
  return {
    callerThreadId: threadId,
    callerThreadLabel: label,
    callerSessionKey: "mcp-session:computer",
    callerProvider: provider,
    callerCapabilities: new Set(["computer"]),
    callerTurnId: "turn-computer",
    assertCallerTurnActive: () => Effect.void,
    jsonRpcRequestId: 1,
  };
}

const setup = Effect.fn(function* (
  backend: FakeComputerBackend = new FakeComputerBackend(),
  authorizeAction?: ComputerToolsOptions["authorizeAction"],
  /**
   * The never-raise authorization resolver. Defaults to the user having asked
   * to see the screen: these suites exercise the raise/foreground mechanics,
   * and the gate itself has dedicated tests that pass an explicit refusal.
   */
  resolveForegroundAuthorization: ComputerToolsOptions["resolveForegroundAuthorization"] = () =>
    Effect.succeed({ userRequestedVisibleUse: true }),
) {
  // A zero settle delay: these tests assert on what the post-action capture
  // does, not on how long the desktop is given to repaint.
  const manager = yield* ComputerManager.make({ backend, actionSettleMs: 0 });
  const browserTools: readonly ToolEntry[] = manager.supportsBrowser
    ? yield* makeComputerBrowserTools({
        manager,
        ...(authorizeAction ? { authorizeAction } : {}),
        resolveForegroundAuthorization,
      })
    : [];
  const tools = makeComputerTools({
    manager,
    ...(authorizeAction ? { authorizeAction } : {}),
    resolveForegroundAuthorization,
    relatedTools: browserTools,
  });
  const byName = new Map([...tools, ...browserTools].map((tool) => [tool.definition.name, tool]));
  const call = (
    name: string,
    args: Record<string, unknown>,
    provider?: ProviderDriverKind,
    threadId?: string,
    label?: string | null,
  ): Effect.Effect<McpToolCallResult> => {
    const tool = byName.get(name);
    if (!tool) return Effect.die(new Error(`no such tool: ${name}`));
    return tool.handler(args, makeContext(provider, threadId, label));
  };
  /**
   * Look at the desktop the way the model does before it points: a workspace
   * screenshot. The fake workspace is 1920×1080 and the perception budget caps
   * an image handed to a model at 1536 on its longest side, so this frame comes
   * back at 1536×864, scale 0.8, from (0, 0) — a screenshot pixel is 1.25
   * desktop points, and that conversion is exactly what the server does for the
   * model rather than asking it to.
   */
  const see = (threadId = THREAD, label: string | null = null) =>
    Effect.gen(function* () {
      const state = yield* call(
        "computer_get_state",
        { include_screenshot: true },
        undefined,
        threadId,
        label,
      );
      expect(state.isError).not.toBe(true);
      return (resultJson(state) as { screenshot: { screenshotId: string } }).screenshot;
    });
  return { backend, manager, tools, byName, call, see };
});

type ToolsByName = Map<string, { definition: { inputSchema: unknown } }>;

/** One property's `enum`, for the schemas whose vocabulary is backend-dependent. */
function schemaEnum(byName: ToolsByName, tool: string, property: string): readonly string[] {
  const schema = byName.get(tool)?.definition.inputSchema as
    | { properties?: Record<string, { enum?: readonly string[] }> }
    | undefined;
  return schema?.properties?.[property]?.enum ?? [];
}

/** One property's description, for the same reason. */
function schemaPropertyDescription(byName: ToolsByName, tool: string, property: string): string {
  const schema = byName.get(tool)?.definition.inputSchema as
    | { properties?: Record<string, { description?: string }> }
    | undefined;
  return schema?.properties?.[property]?.description ?? "";
}

it.layer(NodeServices.layer)("Pathway computer tools", (it) => {
  it.effect("reports an unchanged screen instead of resending the identical image", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { backend, call } = yield* setup();

        const first = yield* call("computer_press_key", { key: "enter" });
        expect(first.content.map((entry) => entry.type)).toEqual(["text", "image"]);

        // The fake returns the same PNG for the same window, which is the live case
        // this exists for: an action the desktop did not visibly react to. Sending
        // the identical picture again costs a second copy of the same image tokens
        // and tells the model nothing it is not already looking at.
        const repeat = yield* call("computer_press_key", { key: "enter" });
        expect(repeat.isError).not.toBe(true);
        expect(repeat.content.map((entry) => entry.type)).toEqual(["text"]);
        expect(resultJson(repeat)).toMatchObject({
          action: "computer_press_key",
          screenshotUnchanged: true,
          note: expect.stringContaining("byte-for-byte what your previous screenshot showed"),
        });
        expect(backend.callsFor("captureScreenshot")).toHaveLength(2);

        // A different window is a different picture, however identical its pixels.
        const other = yield* call("computer_press_key", {
          key: "enter",
          window_id: "fake-calculator",
        });
        expect(other.content.map((entry) => entry.type)).toEqual(["text", "image"]);
      }),
    ),
  );

  it.effect("refuses a fourth consecutive unchanged scroll on the same window", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { backend, call, see } = yield* setup();
        yield* see();
        // Alternating distances keep each call's loop-guard key distinct — the
        // generic repeated-action refusal fires on three identical calls, and this
        // test exercises the scroll-specific streak instead.
        const args = { window_id: "fake-calculator", delta_x: 0, delta_y: 20 };
        const otherArgs = { window_id: "fake-calculator", delta_x: 0, delta_y: 40 };

        const first = yield* call("computer_scroll", args);
        expect(first.isError).not.toBe(true);
        expect(resultJson(first)).toMatchObject({
          action: "computer_scroll",
          scroll: { traveledY: 0 },
          scrollObservation: {
            status: "no-visible-movement",
            code: "scroll_noop",
            measuredDeltaY: 0,
            message: expect.stringContaining("dropped delivery"),
          },
        });

        const second = yield* call("computer_scroll", otherArgs);
        expect(second.isError).not.toBe(true);
        expect(resultJson(second)).toMatchObject({ screenshotUnchanged: true });

        const third = yield* call("computer_scroll", args);
        expect(third.isError).not.toBe(true);
        expect(backend.callsFor("scroll")).toHaveLength(3);

        const fourth = yield* call("computer_scroll", otherArgs);
        expect(fourth.isError).toBe(true);
        expect(firstText(fourth)).toContain("computer_get_state");
        expect(firstText(fourth)).toContain("label_contains");
        expect(backend.callsFor("scroll")).toHaveLength(3);

        // The recovery the refusal names breaks the streak.
        yield* call("computer_get_state", { include_screenshot: false });
        backend.queueScreenshots(["changed-before", "changed-after"]);
        const changed = yield* call("computer_scroll", args);
        expect(changed.isError).not.toBe(true);
        expect(changed.content.map((entry) => entry.type)).toEqual(["text", "image"]);

        // Counter restarted: the next scroll is allowed, not refused.
        const after = yield* call("computer_scroll", otherArgs);
        expect(after.isError).not.toBe(true);
        expect(backend.callsFor("scroll").length).toBeGreaterThan(3);
      }),
    ),
  );

  it.effect("still refuses a fourth unchanged scroll with PATHWAY_CUA_CONDITIONAL_SETTLE set", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // The conditional-settle flag lets a scroll leg skip its wait only when
        // measured travel proves arrival; an unchanged scroll proves nothing, so
        // the zero-travel signal — and the refusal it feeds — must survive it.
        vi.stubEnv("PATHWAY_CUA_CONDITIONAL_SETTLE", "1");
        yield* Effect.addFinalizer(() => Effect.sync(() => vi.unstubAllEnvs()));
        const { backend, call, see } = yield* setup();
        yield* see();
        // Distinct distances keep the generic repeated-action guard out of the
        // way so the scroll-specific streak is what refuses.
        const args = { window_id: "fake-calculator", delta_x: 0, delta_y: 20 };
        const otherArgs = { window_id: "fake-calculator", delta_x: 0, delta_y: 40 };

        for (let attempt = 0; attempt < 3; attempt += 1) {
          const result = yield* call("computer_scroll", attempt % 2 === 0 ? args : otherArgs);
          expect(result.isError).not.toBe(true);
        }

        const fourth = yield* call("computer_scroll", args);
        expect(fourth.isError).toBe(true);
        expect(firstText(fourth)).toContain("no visible movement");
        expect(backend.callsFor("scroll")).toHaveLength(3);
      }),
    ),
  );

  it.effect("refuses the third identical mutating call that observed nothing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { backend, call } = yield* setup();
        // A keypress on the fake backend reports no delivery verdict, so its
        // effect is dispatched-unknown — the unverified repeat this guard exists
        // for. Two are ordinary retries; the third is a loop.
        const args = { key: "enter", include_screenshot: false };
        const first = yield* call("computer_press_key", args);
        expect(first.isError).not.toBe(true);
        const second = yield* call("computer_press_key", args);
        expect(second.isError).not.toBe(true);
        const third = yield* call("computer_press_key", args);
        expect(third.isError).toBe(true);
        expect(resultJson(third)).toMatchObject({
          error: { code: "repeated_unverified_action" },
        });
        expect(backend.callsFor("pressKey")).toHaveLength(2);
      }),
    ),
  );

  it.effect(
    "does not turn lease refusals into repeated input or block a later corrected call",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { backend, manager, call } = yield* setup();
          yield* manager.pressKey("owner", "tab");
          const args = { key: "enter", include_screenshot: false };
          for (let attempt = 0; attempt < 4; attempt += 1) {
            const refused = yield* call("computer_press_key", args);
            expect(resultJson(refused)).toMatchObject({
              error: { code: "computer_controlled_by_other_thread" },
            });
          }
          expect(backend.callsFor("pressKey")).toHaveLength(1);
          yield* manager.releaseDesktopControl("owner");
          expect((yield* call("computer_press_key", args)).isError).not.toBe(true);
          expect(backend.callsFor("pressKey")).toHaveLength(2);
        }),
      ),
  );

  it.effect("bounds repeated native refusals without claiming any input was dispatched", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { backend, call } = yield* setup();
        const key = vi
          .spyOn(backend, "pressKey")
          .mockReturnValue(
            Effect.fail(
              new CuaActionError(
                "No input was sent.",
                "not-dispatched",
                "same_pid_keyboard_ambiguity",
              ),
            ),
          );
        for (let attempt = 0; attempt < 3; attempt += 1) {
          expect(
            resultJson(
              yield* call("computer_press_key", { key: "enter", include_screenshot: false }),
            ),
          ).toMatchObject({
            error: "same_pid_keyboard_ambiguity",
            effect: "not-dispatched",
          });
        }
        expect(
          resultJson(
            yield* call("computer_press_key", { key: "enter", include_screenshot: false }),
          ),
        ).toMatchObject({
          error: {
            code: "repeated_computer_refusal",
            effect: "not-dispatched",
            previousInputMayHaveTakenEffect: false,
          },
        });
        expect(key).toHaveBeenCalledTimes(3);
      }),
    ),
  );

  it.effect("bounds batches that repeatedly stop at the same refused first action", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { backend, call } = yield* setup();
        const key = vi
          .spyOn(backend, "pressKey")
          .mockReturnValue(
            Effect.fail(
              new CuaActionError(
                "No input was sent.",
                "not-dispatched",
                "same_pid_keyboard_ambiguity",
              ),
            ),
          );
        const args = {
          steps: [{ type: "press_key", key: "enter", window_id: "fake-calculator" }],
          include_screenshot: false,
        };
        for (let attempt = 0; attempt < 3; attempt += 1) {
          expect(resultJson(yield* call("computer_run", args))).toMatchObject({ completed: 0 });
        }
        expect(resultJson(yield* call("computer_run", args))).toMatchObject({
          error: { code: "repeated_computer_refusal", previousInputMayHaveTakenEffect: false },
        });
        expect(key).toHaveBeenCalledTimes(3);
      }),
    ),
  );

  it.effect(
    "preserves verified delivery and window identity when the result includes an image",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { backend, manager, call } = yield* setup();
          vi.spyOn(backend, "pressKey").mockReturnValue(
            Effect.succeed({
              effect: "verified",
              verified: "confirmed",
              deliveryPath: "semantic",
              windowId: "fake-calculator",
            }),
          );
          const audit = vi.spyOn(manager, "recordComputerAudit");
          const result = yield* call("computer_press_key", {
            key: "enter",
            window_id: "fake-calculator",
          });
          expect(result.content.some((part) => part.type === "image")).toBe(true);
          expect(audit).toHaveBeenCalledWith(
            expect.objectContaining({
              effect: "verified",
              target: expect.objectContaining({ windowId: "fake-calculator" }),
              diagnostics: { observation: "fresh-frame" },
            }),
          );
        }),
      ),
  );

  it.effect("retains uncertain native errors and their diagnostics in the audit", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { backend, manager, call } = yield* setup();
        const diagnostics = {
          delivery_path: "ax" as const,
          actuator: "ax_press" as const,
          ax_error: -25202,
        };
        const key = vi
          .spyOn(backend, "pressKey")
          .mockReturnValue(
            Effect.fail(
              new CuaActionError(
                "Native action failed.",
                "dispatched-unknown",
                "cua_action_failed",
                undefined,
                diagnostics,
              ),
            ),
          );
        const audit = vi.spyOn(manager, "recordComputerAudit");
        const args = { key: "enter", include_screenshot: false };
        expect(resultJson(yield* call("computer_press_key", args))).toMatchObject({
          error: "cua_action_failed",
          effect: "dispatched-unknown",
          diagnostics,
        });
        expect(audit).toHaveBeenCalledWith(
          expect.objectContaining({
            effect: "dispatched-unknown",
            code: "cua_action_failed",
            diagnostics,
          }),
        );
        yield* call("computer_press_key", args);
        expect(resultJson(yield* call("computer_press_key", args))).toMatchObject({
          error: { code: "repeated_unverified_action" },
        });
        expect(key).toHaveBeenCalledTimes(2);
      }),
    ),
  );

  it.effect("does not mistake an uncertain first batch step for a pre-dispatch refusal", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { backend, manager, call } = yield* setup();
        const key = vi
          .spyOn(backend, "pressKey")
          .mockReturnValue(
            Effect.fail(
              new CuaActionError(
                "Input may have been sent.",
                "dispatched-unknown",
                "cua_action_failed",
              ),
            ),
          );
        const audit = vi.spyOn(manager, "recordComputerAudit");
        const args = { steps: [{ type: "press_key", key: "enter", window_id: "fake-calculator" }] };
        expect(resultJson(yield* call("computer_run", args))).toMatchObject({
          completed: 0,
          steps: [{ ok: false, error: { effect: "dispatched-unknown" } }],
        });
        expect(audit).toHaveBeenCalledWith(
          expect.objectContaining({ tool: "computer_run", effect: "dispatched-unknown" }),
        );
        yield* call("computer_run", args);
        expect(resultJson(yield* call("computer_run", args))).toMatchObject({
          error: { code: "repeated_unverified_action" },
        });
        expect(key).toHaveBeenCalledTimes(2);
      }),
    ),
  );

  it.effect("refuses the repeat before the approval prompt and before dispatch", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // The guard fires ahead of consent: a refused loop must not spend an
        // approval prompt on an action that will not run.
        let approvals = 0;
        const { backend, call } = yield* setup(new FakeComputerBackend(), () =>
          Effect.sync((): ComputerApprovalOutcome => {
            approvals += 1;
            return "approved";
          }),
        );
        const args = { key: "enter", include_screenshot: false };
        yield* call("computer_press_key", args);
        yield* call("computer_press_key", args);
        const refused = yield* call("computer_press_key", args);
        expect(refused.isError).toBe(true);
        expect(resultJson(refused)).toMatchObject({
          error: { code: "repeated_unverified_action" },
        });
        expect(approvals).toBe(2);
        expect(backend.callsFor("pressKey")).toHaveLength(2);
      }),
    ),
  );

  it.effect("treats screenshot-only argument changes as the same action", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { backend, call } = yield* setup();
        // A fresh frame must not disguise a repeat: include_screenshot and
        // screenshot_id are stripped from the key the ring compares.
        const first = yield* call("computer_press_key", {
          key: "enter",
          include_screenshot: false,
        });
        const second = yield* call("computer_press_key", {
          key: "enter",
          include_screenshot: true,
        });
        const third = yield* call("computer_press_key", {
          key: "enter",
          include_screenshot: false,
        });
        expect(first.isError).not.toBe(true);
        expect(second.isError).not.toBe(true);
        expect(third.isError).toBe(true);
        expect(resultJson(third)).toMatchObject({
          error: { code: "repeated_unverified_action" },
        });
        expect(backend.callsFor("pressKey")).toHaveLength(2);
      }),
    ),
  );

  it.effect("clears the streak when a call reports verified, so the refusal comes later", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = new FakeComputerBackend();
        const { call } = yield* setup(backend);
        // set_window_frame is the fake's read-back action: frameApplies false is
        // the dispatched-unverified shape, true the confirmed one — same key, so
        // only the verified effect explains why the refusal waits for a fresh
        // pair of unverified repeats.
        const args = { window_id: "fake-calculator", x: 10, y: 10, width: 400, height: 300 };
        backend.setFrameApplies(false);
        expect((yield* call("computer_set_window_frame", args)).isError).not.toBe(true);
        backend.setFrameApplies(true);
        // Verified on the second send: the ring empties instead of arming.
        expect((yield* call("computer_set_window_frame", args)).isError).not.toBe(true);
        backend.setFrameApplies(false);
        // Two more unverified repeats are ordinary retries again; the one after
        // them — the third in a row — is the refusal.
        expect((yield* call("computer_set_window_frame", args)).isError).not.toBe(true);
        expect((yield* call("computer_set_window_frame", args)).isError).not.toBe(true);
        const refused = yield* call("computer_set_window_frame", args);
        expect(refused.isError).toBe(true);
        expect(resultJson(refused)).toMatchObject({
          error: { code: "repeated_unverified_action" },
        });
        expect(backend.callsFor("setWindowFrame")).toHaveLength(4);
      }),
    ),
  );

  it.effect("clears the streak when a different action intervenes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { backend, call } = yield* setup();
        const args = { key: "enter", include_screenshot: false };
        yield* call("computer_press_key", args);
        yield* call("computer_press_key", args);
        // Even another press_key with a different key breaks the repeat — the
        // model changed what it was doing.
        const other = yield* call("computer_press_key", {
          key: "tab",
          include_screenshot: false,
        });
        expect(other.isError).not.toBe(true);
        const resumed = yield* call("computer_press_key", args);
        expect(resumed.isError).not.toBe(true);
        expect(backend.callsFor("pressKey")).toHaveLength(4);
      }),
    ),
  );

  it.effect("does not guard reads — repeated get_state calls still answer", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { backend, call } = yield* setup();
        for (let attempt = 0; attempt < 4; attempt += 1) {
          const result = yield* call("computer_get_state", { include_screenshot: false });
          expect(result.isError).not.toBe(true);
        }
        // computer_read_clipboard sits in the approval set for privacy, but a
        // re-read is not a mutating loop: it is deliberately out of the guard.
        for (let attempt = 0; attempt < 4; attempt += 1) {
          const result = yield* call("computer_read_clipboard", {});
          expect(result.isError).not.toBe(true);
        }
        expect(backend.callsFor("readClipboard")).toHaveLength(4);
      }),
    ),
  );

  it.effect("keeps a discovery-only tool callable by exact name", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { backend, call, tools } = yield* setup();
        expect(tools.find((tool) => tool.definition.name === "computer_drag")?.discoveryOnly).toBe(
          true,
        );
        const dragged = yield* call("computer_drag", {
          from: { label: "Calculate", role: "button" },
          to: { label: "Display", role: "text-field" },
        });
        expect(dragged.isError).not.toBe(true);
        expect(backend.callsFor("drag")).toHaveLength(1);
      }),
    ),
  );

  it.effect("tells the model the observation is downscaled and what unchanged means", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { byName } = yield* setup();
        // The compact injected block no longer carries the pixel budget; the
        // detail lives on the tools that produce the images — the screenshot
        // schema owns the cap, the action tools own the attached-observation rule.
        const screenshotSchema = encodeJson(
          byName.get("computer_screenshot")?.definition.inputSchema,
        );
        expect(screenshotSchema).toContain(`capped at ${DEFAULT_COMPUTER_CAPTURE_MAX_DIMENSION}`);
        // Each action still says a screenshot is attached, and the schema carries
        // the default.
        const description = byName.get("computer_click")?.definition.description ?? "";
        expect(description).toContain("Returns a screenshot of the affected window");
        expect(encodeJson(byName.get("computer_click")?.definition.inputSchema)).toContain(
          "Post-action screenshot, default true",
        );
      }),
    ),
  );

  it.effect("keeps a successful action result when the post-action capture fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { backend, call } = yield* setup();
        backend.failNext("captureScreenshot");
        const result = yield* call("computer_press_key", { key: "enter" });

        // The key press happened; losing the screenshot must not report failure.
        expect(result.isError).not.toBe(true);
        expect(result.content.map((entry) => entry.type)).toEqual(["text"]);
        expect(resultJson(result)).toMatchObject({ action: "computer_press_key" });
      }),
    ),
  );

  it.effect("tells the model every observed action already carries its screenshot", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { byName } = yield* setup();
        for (const name of [
          "computer_click",
          "computer_move_cursor",
          "computer_drag",
          "computer_scroll",
          "computer_type_text",
          "computer_press_key",
          "computer_set_value",
          "computer_perform_action",
          "computer_select_text",
        ]) {
          const tool = byName.get(name);
          expect(tool?.definition.description).toContain(
            "Returns a screenshot of the affected window",
          );
          const schema = encodeJson(tool?.definition.inputSchema);
          expect(schema).toContain("include_screenshot");
          expect(schema).toContain("Post-action screenshot, default true");
        }
        // Launching resolves seconds later and clipboard writes change no pixels,
        // so neither pays for a capture that would only show the previous state.
        for (const name of ["computer_launch_app", "computer_write_clipboard"]) {
          const tool = byName.get(name);
          expect(tool?.definition.description).not.toContain("screenshot taken after");
          expect(encodeJson(tool?.definition.inputSchema)).not.toContain("include_screenshot");
        }
      }),
    ),
  );

  it.effect("resolves semantic actions from a fresh snapshot and reports backend calls", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { backend, call } = yield* setup();
        const result = yield* call("computer_click", {
          label: "Calculate",
          role: "button",
        });
        expect(result.isError).not.toBe(true);
        expect(backend.callsFor("click")).toHaveLength(1);
        expect(backend.callsFor("click")[0]?.args[0]).toEqual({ x: 1_180, y: 228 });

        const setValue = yield* call("computer_set_value", {
          label: "Display",
          value: "468",
        });
        expect(setValue.isError).not.toBe(true);
        expect(backend.callsFor("setValue")).toHaveLength(1);

        const selectText = yield* call("computer_select_text", {
          label: "Display",
          start: 0,
          length: 2,
        });
        expect(selectText.isError).not.toBe(true);
        const selectCalls = backend.callsFor("selectText");
        expect(selectCalls).toHaveLength(1);
        expect(selectCalls[0]?.args[0]).toMatchObject({
          node: expect.objectContaining({ label: "Display" }),
        });
        expect(selectCalls[0]?.args[1]).toEqual({ start: 0, length: 2 });
        // The fake's read-back is the substring the range covers: "468"[0..2].
        expect(resultJson(selectText)).toMatchObject({
          action: "computer_select_text",
          value: "46",
        });
      }),
    ),
  );

  it.effect("preserves raw text values, including whitespace and an empty value", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { backend, call } = yield* setup();

        for (const text of ["  hello  ", " ", "\n"]) {
          const result = yield* call("computer_type_text", { text });
          expect(result.isError).not.toBe(true);
          expect(backend.callsFor("typeText").at(-1)?.args).toEqual([text]);
        }

        const emptyValue = yield* call("computer_set_value", {
          label: "Display",
          value: "",
        });
        expect(emptyValue.isError).not.toBe(true);
        expect(backend.callsFor("setValue").at(-1)?.args.at(-1)).toBe("");
      }),
    ),
  );

  it.effect("fills a form field whose visible label contains a non-breaking space", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = new FakeComputerBackend({
          root: {
            role: "AXTextField",
            label: "First name *",
            value: "",
            description: null,
            frame: { x: 100, y: 200, width: 300, height: 40 },
            activationPoint: null,
            onScreen: true,
            windowId: "w1",
            editable: true,
            children: [],
          },
        });
        const { call } = yield* setup(backend);
        const result = yield* call("computer_set_value", {
          window_id: "w1",
          label: "First name *",
          value: "Ada",
          include_screenshot: false,
        });
        expect(result.isError).not.toBe(true);
        expect(backend.callsFor("setValue")).toHaveLength(1);
        expect(backend.callsFor("setValue")[0]?.args.at(-1)).toBe("Ada");
        expect(backend.callsFor("typeText")).toHaveLength(0);
      }),
    ),
  );

  it.effect("treats a camel-case windowId as a scroll target", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = new FakeComputerBackend({
          root: {
            role: "window",
            label: "Calculator",
            value: null,
            description: null,
            frame: { x: 100, y: 200, width: 300, height: 400 },
            activationPoint: { x: 250, y: 400 },
            onScreen: true,
            windowId: "w1",
            children: [],
          },
        });
        const { call, see } = yield* setup(backend);
        yield* see();

        const result = yield* call("computer_scroll", {
          windowId: "w1",
          delta_x: 10,
          delta_y: -20,
        });

        expect(result.isError).not.toBe(true);
        expect(backend.callsFor("scroll").at(-1)?.args[0]).toEqual({
          x: 250,
          y: 400,
        });
      }),
    ),
  );

  it.effect("refuses invalid targets with structured candidate data", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { call } = yield* setup();
        const result = yield* call("computer_click", { label: "does not exist" });
        expect(result.isError).toBe(true);
        const structured = resultJson(result) as {
          error: { code: string; candidates: readonly unknown[] };
        };
        expect(structured.error.code).toBe("computer_target_not_found");
        expect(structured.error.candidates.length).toBeGreaterThan(0);
      }),
    ),
  );

  it.effect("round-trips the shared clipboard and starts from an empty one", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { backend, call } = yield* setup();

        const empty = yield* call("computer_read_clipboard", {});
        expect(resultJson(empty)).toMatchObject({
          action: "computer_read_clipboard",
          value: "",
        });

        const write = yield* call("computer_write_clipboard", {
          text: "  copied\ntext  ",
        });
        expect(write.isError).not.toBe(true);
        expect(backend.callsFor("writeClipboard").at(-1)?.args).toEqual(["  copied\ntext  "]);

        const read = yield* call("computer_read_clipboard", {});
        expect(resultJson(read)).toMatchObject({ value: "  copied\ntext  " });
      }),
    ),
  );

  it.effect("tells the model the clipboard belongs to the user too", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { byName } = yield* setup();
        for (const name of ["computer_read_clipboard", "computer_write_clipboard"]) {
          expect(byName.get(name)?.definition.description).toContain("shared with the human user");
        }
      }),
    ),
  );

  it.effect("refuses clipboard text past the byte limit before it reaches the backend", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { backend, call } = yield* setup();
        const result = yield* call("computer_write_clipboard", {
          text: "x".repeat(MAX_COMPUTER_CLIPBOARD_BYTES + 1),
        });
        expect(result.isError).toBe(true);
        expect(backend.callsFor("writeClipboard")).toHaveLength(0);
      }),
    ),
  );

  /**
   * MCP tool arguments are never validated against their JSON Schemas, so
   * these bounds are enforced at the tool layer: an oversized set_value that
   * fell back to typed keystrokes would hold the exclusive desktop lease and
   * the turn for hours, and thousands of hotkey keys would hold the seat
   * indefinitely as press/release pairs.
   */
  it.effect("refuses a set_value past the text bound before it reaches the backend", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { backend, call } = yield* setup();
        const result = yield* call("computer_set_value", {
          label: "Display",
          role: "text-field",
          value: "x".repeat(COMPUTER_TEXT_MAX_LENGTH + 1),
        });
        expect(result.isError).toBe(true);
        expect(backend.callsFor("setValue")).toHaveLength(0);

        const within = yield* call("computer_set_value", {
          label: "Display",
          role: "text-field",
          value: "x".repeat(COMPUTER_TEXT_MAX_LENGTH),
        });
        expect(within.isError).not.toBe(true);
        expect(backend.callsFor("setValue")).toHaveLength(1);
      }),
    ),
  );

  it.effect("refuses a press_key chord past the contract's shape before dispatch", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { backend, call } = yield* setup();

        const tooMany = yield* call("computer_press_key", {
          key: Array.from({ length: 17 }, (_, index) => `Key${index}`).join("+"),
        });
        expect(tooMany.isError).toBe(true);
        expect(backend.callsFor("hotkey")).toHaveLength(0);

        const longKey = yield* call("computer_press_key", {
          key: `ctrl+${"k".repeat(129)}`,
        });
        expect(longKey.isError).toBe(true);
        expect(backend.callsFor("hotkey")).toHaveLength(0);

        const within = yield* call("computer_press_key", { key: "Control+L" });
        expect(within.isError).not.toBe(true);
        expect(backend.callsFor("hotkey")).toHaveLength(1);
        expect(backend.callsFor("hotkey")[0]?.args[0]).toEqual(["Control", "L"]);
      }),
    ),
  );

  it.effect("passes xdotool-style key spellings through to the backend unchanged", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { backend, call } = yield* setup();

        // The tool layer validates shape only; name mapping and refusal belong to
        // the backend (cuaKey) and the driver keymap, so an xdotool spelling and a
        // not-yet-native name must arrive verbatim.
        const pressed = yield* call("computer_press_key", { key: "Page_Up" });
        expect(pressed.isError).not.toBe(true);
        expect(backend.callsFor("pressKey").map((entry) => entry.args)).toEqual([["Page_Up"]]);

        const chord = yield* call("computer_press_key", { key: "meta+KP_Enter" });
        expect(chord.isError).not.toBe(true);
        expect(backend.callsFor("hotkey").map((entry) => entry.args)).toEqual([
          [["meta", "KP_Enter"]],
        ]);
      }),
    ),
  );

  it.effect(
    "refuses control-off mutations even for a gated provider without touching the backend",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { backend, manager, call } = yield* setup();
          yield* manager.setControlEnabled(THREAD, false);
          const refused = yield* call("computer_click", { x: 10, y: 10 });
          expect(refused.isError).toBe(true);
          expect(backend.callsFor("click")).toHaveLength(0);
          yield* manager.setControlEnabled(THREAD, true);
        }),
      ),
  );

  it.effect("includes the control disclosure on the first mutation payload of a turn", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { call } = yield* setup();
        expect(COMPUTER_CONTROL_FIRST_MUTATION_DISCLOSURE).toContain("Computer control ON");
        const first = yield* call("computer_press_key", { key: "enter" });
        expect(first.isError).not.toBe(true);
        expect(firstText(first)).toContain("Computer control ON");
        const second = yield* call("computer_press_key", { key: "enter" });
        expect(second.isError).not.toBe(true);
        expect(firstText(second)).not.toContain("Computer control ON");
      }),
    ),
  );

  it.effect("refuses a semantic action name past the contract's bound", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { backend, call } = yield* setup();
        const result = yield* call("computer_perform_action", {
          label: "Display",
          action: "a".repeat(257),
        });
        expect(result.isError).toBe(true);
        expect(backend.callsFor("performAction")).toHaveLength(0);
      }),
    ),
  );

  it.effect("passes the macOS secondary action names through to the backend verbatim", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { backend, call } = yield* setup(new FakeComputerBackend({ agentDialect: "macos" }));
        for (const action of [
          "AXPress",
          "press",
          "open",
          "show_menu",
          "menu",
          "pick",
          "confirm",
          "cancel",
        ]) {
          const result = yield* call("computer_perform_action", {
            label: "Calculate",
            action,
          });
          expect(result.isError).not.toBe(true);
        }
        expect(backend.callsFor("performAction").map((entry) => entry.args[1])).toEqual([
          "AXPress",
          "press",
          "open",
          "show_menu",
          "menu",
          "pick",
          "confirm",
          "cancel",
        ]);
      }),
    ),
  );

  it.effect("refuses malformed select_text ranges and x/y targets before the backend", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { backend, call } = yield* setup();

        for (const args of [
          { label: "Display" },
          { label: "Display", start: 0 },
          { label: "Display", start: -1, length: 1 },
          { label: "Display", start: 0, length: -1 },
          { label: "Display", start: 0.5, length: 1 },
          { label: "Display", start: 0, length: COMPUTER_SELECT_TEXT_RANGE_MAX + 1 },
          // A coordinate cannot name which characters a range covers — refused
          // outright rather than resolving the window's first writable field.
          { x: 100, y: 200, start: 0, length: 1 },
        ]) {
          const result = yield* call("computer_select_text", args);
          expect(result.isError).toBe(true);
        }
        expect(backend.callsFor("selectText")).toHaveLength(0);
        expect(backend.callsFor("getState")).toHaveLength(0);

        const caret = yield* call("computer_select_text", {
          label: "Display",
          start: 1,
          length: 0,
        });
        expect(caret.isError).not.toBe(true);
        expect(backend.callsFor("selectText")).toHaveLength(1);
      }),
    ),
  );

  it.effect("reports clipboard tools as unsupported on a backend without them", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { call } = yield* setup(withoutClipboard(new FakeComputerBackend()));

        for (const [name, args] of [
          ["computer_read_clipboard", {}],
          ["computer_write_clipboard", { text: "nope" }],
        ] as const) {
          const result = yield* call(name, args);
          expect(result.isError).toBe(true);
          expect(firstText(result)).toContain("does not support clipboard access");
        }
      }),
    ),
  );

  it.effect("keeps the clipboard read behind approval instead of the perception set", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // Pathway has no gate-less provider set: the refusal comes from the
        // approval gate itself declining the read.
        const authorizeAction = vi.fn<ComputerAuthorizeAction>(() =>
          Effect.succeed<ComputerApprovalOutcome>("denied"),
        );
        const { backend, byName, call } = yield* setup(new FakeComputerBackend(), authorizeAction);

        // Approval-gated on purpose: the clipboard can hold something the human
        // copied privately, so providers must not auto-approve it as read-only.
        expect(byName.get("computer_read_clipboard")?.definition.annotations).toMatchObject({
          readOnlyHint: false,
          destructiveHint: false,
        });

        const refused = yield* call("computer_read_clipboard", {});
        expect(refused.isError).toBe(true);
        expect(authorizeAction).toHaveBeenCalledWith(
          "computer_read_clipboard",
          expect.anything(),
          expect.anything(),
        );
        expect(backend.callsFor("readClipboard")).toHaveLength(0);
      }),
    ),
  );

  it.effect(
    "refuses a second thread's actions without encouraging retry loops and keeps its perception",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { backend, call, manager, see } = yield* setup();
          yield* see("thread-a");

          // The first action to land owns the desktop; nothing asks for it explicitly.
          const owned = yield* call("computer_click", { x: 10, y: 10 }, undefined, "thread-a");
          expect(owned.isError).not.toBe(true);

          const blocked = yield* call(
            "computer_type_text",
            { text: "hello" },
            undefined,
            "thread-b",
          );
          expect(blocked.isError).toBe(true);
          expect(resultJson(blocked)).toMatchObject({
            error: {
              code: "computer_controlled_by_other_thread",
              retryable: false,
              message: expect.stringContaining("another conversation"),
            },
          });
          // The refusal happens before the backend, so the loser never moves anything.
          expect(backend.callsFor("typeText")).toHaveLength(0);

          // Reading the desktop is never arbitrated: the blocked thread can keep
          // watching, which is what makes "try again later" actionable advice. (The
          // state call gives the zoom that follows it a screenshot to point into.)
          for (const [name, args] of [
            ["computer_list_windows", {}],
            ["computer_get_state", { include_screenshot: true }],
            ["computer_get_screen_size", {}],
            ["computer_screenshot", { x: 0, y: 0, width: 100, height: 100 }],
          ] as const) {
            const perception = yield* call(name, args, undefined, "thread-b");
            expect(perception.isError).not.toBe(true);
          }

          // Turn end hands the desktop over; the roles then swap.
          yield* manager.releaseDesktopControl("thread-a");
          const handover = yield* call(
            "computer_type_text",
            { text: "hello" },
            undefined,
            "thread-b",
          );
          expect(handover.isError).not.toBe(true);
          const nowBlocked = yield* call("computer_click", { x: 1, y: 1 }, undefined, "thread-a");
          expect(resultJson(nowBlocked)).toMatchObject({
            error: { code: "computer_controlled_by_other_thread" },
          });
        }),
      ),
  );

  /**
   * Models spell an omitted optional field as an explicit `null` all the time.
   * Deciding "this scroll has a target" from which keys are present read that
   * as a target, built an empty one, and had it refused as
   * computer_target_invalid — a hard failure for a request that meant "scroll
   * wherever the pointer is".
   */
  it.effect("reads an explicitly null scroll target as no target", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { backend, call, see } = yield* setup();
        yield* see();

        const result = yield* call("computer_scroll", {
          x: null,
          y: null,
          label: null,
          window_id: null,
          delta_x: 0,
          delta_y: 120,
        });

        expect(result.isError).not.toBe(true);
        // Probe plus remainder, both untargeted: the null target survives into
        // every leg rather than becoming an empty target object.
        // 120 screenshot pixels of the downscaled workspace frame is 150 desktop
        // pixels: the probe takes 48 of them and the remainder carries 102.
        expect(backend.callsFor("scroll").map((entry) => entry.args)).toEqual([[null, 0, 150]]);
      }),
    ),
  );

  it.effect("reports scroll travel and spends no extra capture doing it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { backend, call, see } = yield* setup();
        yield* see();
        const seen = backend.callsFor("captureScreenshot").length;

        const result = yield* call("computer_scroll", {
          x: 1_100,
          y: 200,
          delta_x: 0,
          delta_y: 300,
        });

        expect(result.isError).not.toBe(true);
        expect(result.content.map((entry) => entry.type)).toEqual(["text", "image"]);
        expect(resultJson(result)).toMatchObject({
          action: "computer_scroll",
          scroll: {
            // Screenshot pixels converted to desktop pixels by the frame's 0.8
            // scale before anything is injected.
            requested: { deltaX: 0, deltaY: 375 },
            injected: { deltaX: 0, deltaY: 375 },
            gearing: 1,
          },
        });
        // Exactly three on a first, probing scroll: before, after the probe leg,
        // and after the remainder — the last of which is also the screenshot the
        // result carries. A fourth would mean the generic observation path had
        // photographed the window again.
        expect(backend.callsFor("captureScreenshot")).toHaveLength(seen + 3);
      }),
    ),
  );

  it.effect("opts out of the captures with the screenshot, keeping the request telemetry", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { backend, call, see } = yield* setup();
        yield* see();
        const seen = backend.callsFor("captureScreenshot").length;

        const result = yield* call("computer_scroll", {
          x: 1_100,
          y: 200,
          delta_x: 0,
          delta_y: 300,
          include_screenshot: false,
        });

        expect(result.content.map((entry) => entry.type)).toEqual(["text"]);
        expect(backend.callsFor("captureScreenshot")).toHaveLength(seen);
        const payload = resultJson(result) as {
          scroll?: { requested?: unknown; injected?: unknown; traveledY?: number };
        };
        expect(payload.scroll?.requested).toEqual({ deltaX: 0, deltaY: 375 });
        expect(payload.scroll?.injected).toEqual({ deltaX: 0, deltaY: 375 });
        expect(payload.scroll?.traveledY).toBeUndefined();
      }),
    ),
  );

  it.effect("tells the model that scroll distance is verified rather than assumed", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { byName } = yield* setup();
        const description = byName.get("computer_scroll")?.definition.description ?? "";

        expect(description).toContain("scroll.traveledY");
        // macOS now measures and gears like the other platforms; the description
        // must not carry the old "no corrective retries" caveat.
        expect(description).toContain("delta_x and delta_y");
        expect(description).toContain("edge or dropped input");
        // The advice that replaced scroll-hunting stays.
        expect(description).toContain("computer_get_state");
      }),
    ),
  );

  it.effect.each([
    [{ delta_y: 80 }, [0, 100]],
    [{ delta_x: -40 }, [-50, 0]],
  ] as const)(
    "defaults the omitted scroll axis to zero in direct and batch calls",
    ([axes, expected]) =>
      Effect.scoped(
        Effect.gen(function* () {
          const { backend, call, see, byName } = yield* setup();
          yield* see();
          const schema = byName.get("computer_scroll")!.definition.inputSchema as {
            required?: readonly string[];
          };
          expect(schema.required ?? []).not.toContain("delta_x");
          expect(schema.required ?? []).not.toContain("delta_y");
          const result = yield* call("computer_scroll", { ...axes, include_screenshot: false });
          expect(result.isError).not.toBe(true);
          expect(backend.callsFor("scroll").at(-1)?.args.slice(1)).toEqual(expected);
          const batch = yield* call("computer_run", { steps: [{ type: "scroll", ...axes }] });
          expect(resultJson(batch)).toMatchObject({ completed: 1, stopped: false });
          expect(backend.callsFor("scroll").at(-1)?.args.slice(1)).toEqual(expected);
        }),
      ),
  );

  it.effect("refuses an empty or zero scroll before dispatch", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { backend, call, see } = yield* setup();
        yield* see();
        for (const axes of [{}, { delta_x: 0, delta_y: 0 }]) {
          const result = yield* call("computer_scroll", axes);
          expect(result.isError).toBe(true);
          expect(encodeJson(result)).toContain("nonzero");
        }
        expect(backend.callsFor("scroll")).toHaveLength(0);
      }),
    ),
  );

  it.effect("still resolves a scroll target when one is actually given", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { backend, call, see } = yield* setup();
        yield* see();

        yield* call("computer_scroll", { x: 100, y: 100, delta_x: 0, delta_y: -50 });

        // Probe plus remainder — the resolved point rides into both legs. The
        // point sits inside a window so the probe has something to measure against;
        // a point over bare desktop would skip calibration and send one leg.
        expect(backend.callsFor("scroll").map((entry) => entry.args)).toEqual([
          [{ x: 125, y: 125 }, 0, -48],
          [{ x: 125, y: 125 }, 0, -14.5],
        ]);
      }),
    ),
  );

  it.effect("never hands the model an image larger than it will actually be shown", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // Above roughly 1568 px on the long edge a vision API downscales the picture
        // before the model sees it, so the model reads coordinates off an image the
        // server never produced and the mapping is wrong by that ratio.
        const { backend, byName, call } = yield* setup();
        const schema = byName.get("computer_screenshot")?.definition.inputSchema as {
          properties: { max_dimension: { maximum: number } };
        };
        expect(schema.properties.max_dimension.maximum).toBe(
          DEFAULT_COMPUTER_CAPTURE_MAX_DIMENSION,
        );
        expect(DEFAULT_COMPUTER_CAPTURE_MAX_DIMENSION).toBe(1_536);

        // The schema bound is advisory — nothing validates MCP arguments against it
        // — so the request is clamped here too.
        yield* call("computer_screenshot", {
          window_id: "fake-terminal",
          max_dimension: 8_000,
        });
        expect(backend.callsFor("captureScreenshot").at(-1)?.args[0]).toEqual({
          kind: "window",
          windowId: "fake-terminal",
          maxDimension: DEFAULT_COMPUTER_CAPTURE_MAX_DIMENSION,
        });
      }),
    ),
  );

  it.effect("waits without touching the desktop, and never for longer than its bound", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { backend, call } = yield* setup();
        // The wait sleeps on the Effect clock: it has not finished before its
        // duration has passed, and finishes once it has.
        const waiting = yield* Effect.forkChild(call("computer_wait", { duration_ms: 5 }));
        yield* TestClock.adjust(4);
        expect(waiting.pollUnsafe()).toBeUndefined();
        yield* TestClock.adjust(1);
        const result = yield* Fiber.join(waiting);
        expect(result.isError).not.toBe(true);
        expect(resultJson(result)).toMatchObject({ waitedMs: 5 });
        // No pointer, no keys, no capture: a wait that photographed the desktop
        // would be a screenshot with a delay, which is not what it is for.
        expect(backend.callsFor("captureScreenshot")).toHaveLength(0);
        expect(backend.callsFor("click")).toHaveLength(0);

        // Clamped rather than refused: the intent is clear and only the scale is
        // wrong, and an unclamped wait stalls the whole turn behind a sleep.
        const clampedFiber = yield* Effect.forkChild(
          call("computer_wait", { duration_ms: 60 * 60 * 1_000 }),
        );
        yield* TestClock.adjust(COMPUTER_WAIT_MAX_MS);
        const clamped = yield* Fiber.join(clampedFiber);
        expect(resultJson(clamped)).toMatchObject({
          waitedMs: COMPUTER_WAIT_MAX_MS,
        });
        const negative = yield* call("computer_wait", { duration_ms: -5 });
        expect(resultJson(negative)).toMatchObject({ waitedMs: 0 });
      }),
    ),
  );

  it.effect("holds modifiers across a click and a scroll, and refuses a name it cannot press", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // Not expressible as a press_key chord, which releases its keys before the
        // gesture happens — so shift-click and ctrl-scroll need the pointer tools'
        // own modifiers field.
        const { backend, call, see } = yield* setup();
        yield* see();

        yield* call("computer_click", {
          x: 40,
          y: 40,
          modifiers: ["shift"],
          include_screenshot: false,
        });
        expect(backend.callsFor("click").at(-1)?.args).toEqual([{ x: 50, y: 50 }, ["shift"]]);

        yield* call("computer_scroll", {
          x: 40,
          y: 40,
          delta_x: 0,
          delta_y: 8,
          modifiers: ["ctrl", "ctrl"],
          include_screenshot: false,
        });
        expect(backend.callsFor("scroll").at(-1)?.args).toEqual([
          { x: 50, y: 50 },
          0,
          10,
          ["ctrl"],
        ]);

        const refused = yield* call("computer_click", {
          x: 40,
          y: 40,
          modifiers: ["hyper"],
        });
        expect(refused.isError).toBe(true);
        expect(refused.content[0]).toMatchObject({
          text: expect.stringContaining("hyper"),
        });
      }),
    ),
  );

  it.effect("sends a triple click as one gesture, and refuses where it cannot be one", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { backend, call, see } = yield* setup();
        yield* see();
        const tripled = yield* call("computer_click", {
          x: 40,
          y: 40,
          count: 3,
          include_screenshot: false,
        });
        expect(tripled.isError).not.toBe(true);
        expect(resultJson(tripled)).toMatchObject({ action: "computer_click" });
        expect(backend.callsFor("tripleClick")).toHaveLength(1);
        expect(backend.callsFor("click")).toHaveLength(0);

        // Three separate clicks are three carets, not a line selection, so a
        // backend that cannot express the gesture says so rather than approximating.
        const without = new Proxy(new FakeComputerBackend(), {
          get: (target, property, receiver) =>
            property === "tripleClick" ? undefined : Reflect.get(target, property, receiver),
        });
        const limited = yield* setup(without);
        yield* limited.see();
        const refused = yield* limited.call("computer_click", {
          x: 40,
          y: 40,
          count: 3,
        });
        expect(refused.isError).toBe(true);
        expect(refused.content[0]).toMatchObject({
          text: expect.stringContaining("cannot send a triple click"),
        });
      }),
    ),
  );

  it.effect("photographs a window the action opened instead of reporting nothing changed", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // The observer captures exactly one window, so a key press that opens a
        // dialog photographs the old window — very often byte-identical — and the
        // model was told its action had not landed at the moment it had landed
        // hardest.
        const backend = new FakeComputerBackend();
        const { call } = yield* setup(backend);

        // Establishes the terminal's capture as what this thread has already seen.
        const first = yield* call("computer_press_key", {
          key: "enter",
          window_id: "fake-terminal",
        });
        expect(first.content.map((entry) => entry.type)).toEqual(["text", "image"]);

        const before = yield* backend.listWindows();
        // A dialog shares its owning app's pid — the same-process test the
        // observer applies once windows carry one.
        const pid = before.find((window) => window.id === "fake-terminal")?.pid;
        backend.pressKey = () =>
          Effect.sync(() => {
            backend.emitWindowsChanged([
              ...before,
              {
                id: "fake-dialog",
                title: "Save changes?",
                appName: "org.kde.konsole",
                ...(pid === undefined ? {} : { pid }),
                bounds: { x: 200, y: 200, width: 300, height: 200 },
                focused: false,
                minimized: false,
                visible: true,
              },
            ]);
            return {};
          });

        const opened = yield* call("computer_press_key", {
          key: "enter",
          window_id: "fake-terminal",
        });
        expect(opened.isError).not.toBe(true);
        expect(resultJson(opened)).toMatchObject({
          screenshot: { windowId: "fake-dialog" },
        });
        expect(opened.content.map((entry) => entry.type)).toEqual(["text", "image"]);
      }),
    ),
  );

  it.effect("says an unchanged frame is unsettled rather than asserting the action missed", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { call } = yield* setup();
        yield* call("computer_press_key", {
          key: "enter",
          window_id: "fake-terminal",
        });
        // Nothing opened, so there is no new window to photograph instead and the
        // identical picture is genuinely all there is to report.
        const quiet = yield* call("computer_press_key", {
          key: "enter",
          window_id: "fake-terminal",
        });
        expect(resultJson(quiet)).toMatchObject({
          screenshotUnchanged: true,
          note: expect.stringContaining("does not prove the action missed"),
        });
      }),
    ),
  );

  it.effect("scopes the elements digest by window and by label, and counts what it drops", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { call } = yield* setup();
        const all = resultJson(yield* call("computer_get_state", {})) as {
          elements: { label: string; windowId?: string }[];
          elementWindowId?: string;
          elementsTruncated?: boolean;
          elementsOmitted?: number;
        };
        // The default tree's elements are all in one window: the id is hoisted.
        const windowId = all.elementWindowId!;
        expect(windowId).toBe("fake-calculator");

        const scoped = resultJson(yield* call("computer_get_state", { window_id: windowId })) as {
          elements: { windowId?: string }[];
          elementWindowId?: string;
        };
        expect(scoped.elements.length).toBeGreaterThan(0);
        expect(scoped.elementWindowId).toBe(windowId);
        expect(scoped.elements.every((element) => element.windowId === undefined)).toBe(true);

        const label = all.elements[0]!.label;
        const filtered = resultJson(
          yield* call("computer_get_state", { label_contains: label.toUpperCase() }),
        ) as { elements: { label: string }[] };
        expect(filtered.elements.length).toBeGreaterThan(0);
        expect(
          filtered.elements.every((element) =>
            element.label.toLocaleLowerCase().includes(label.toLocaleLowerCase()),
          ),
        ).toBe(true);

        const none = resultJson(
          yield* call("computer_get_state", {
            label_contains: "no control is called this",
          }),
        ) as { elements: unknown[]; elementsTruncated?: boolean };
        expect(none.elements).toEqual([]);
        expect(none.elementsTruncated).toBeUndefined();
      }),
    ),
  );

  it.effect("keeps per-element window ids when one listing spans windows", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // An unscoped read over a desktop with two windows must keep each entry's
        // window id: that is what tells the model which window an action addresses,
        // so the hoist applies only to a one-window listing.
        const entry = (windowId: string, label: string): ComputerUiNode => ({
          role: "button",
          label,
          value: null,
          description: null,
          frame: { x: 0, y: 0, width: 80, height: 30 },
          activationPoint: null,
          onScreen: true,
          windowId,
          children: [],
        });
        const root: ComputerUiNode = {
          role: "desktop",
          label: null,
          value: null,
          description: null,
          frame: { x: 0, y: 0, width: 1_920, height: 1_080 },
          activationPoint: null,
          onScreen: true,
          windowId: null,
          children: [
            {
              role: "window",
              label: "Terminal",
              value: null,
              description: null,
              frame: { x: 40, y: 40, width: 960, height: 720 },
              activationPoint: null,
              onScreen: true,
              windowId: "fake-terminal",
              children: [entry("fake-terminal", "Run")],
            },
            {
              role: "window",
              label: "Calculator",
              value: null,
              description: null,
              frame: { x: 1_050, y: 120, width: 420, height: 620 },
              activationPoint: null,
              onScreen: true,
              windowId: "fake-calculator",
              children: [entry("fake-calculator", "Calculate")],
            },
          ],
        };
        const { call } = yield* setup(new FakeComputerBackend({ root }));
        const payload = resultJson(yield* call("computer_get_state", {})) as {
          elements: { label: string; windowId?: string }[];
          elementWindowId?: string;
        };
        expect(payload.elementWindowId).toBeUndefined();
        expect(payload.elements.map((element) => [element.label, element.windowId])).toEqual([
          ["Run", "fake-terminal"],
          ["Calculate", "fake-calculator"],
        ]);
      }),
    ),
  );

  it.effect(
    "brings a window forward only through the explicit tool, and refuses where it cannot",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const raised: string[] = [];
          const backend = Object.assign(new FakeComputerBackend(), {
            raiseWindow: (windowId: string) =>
              Effect.sync(() => {
                raised.push(windowId);
              }),
          });
          const approval = vi.fn<ComputerAuthorizeAction>(() =>
            Effect.succeed<ComputerApprovalOutcome>("approved"),
          );
          const { call } = yield* setup(backend, approval);

          const result = yield* call("computer_activate_window", {
            window_id: "fake-terminal",
          });
          expect(approval).toHaveBeenCalledWith(
            "computer_activate_window",
            expect.objectContaining({ delivery_mode: "foreground" }),
            expect.anything(),
          );
          expect(result.isError).not.toBe(true);
          expect(raised).toEqual(["fake-terminal"]);
          expect(resultJson(result)).toMatchObject({
            action: "computer_activate_window",
            windowId: "fake-terminal",
          });

          const missing = yield* call("computer_activate_window", {
            window_id: "no-such-window",
          });
          expect(missing.isError).toBe(true);

          // A desktop with no stacking control says so rather than reporting a move
          // that never happened.
          const without = new Proxy(new FakeComputerBackend(), {
            get: (target, property, receiver) =>
              property === "raiseWindow" ? undefined : Reflect.get(target, property, receiver),
          });
          const plain = yield* setup(without, approval);
          const refused = yield* plain.call("computer_activate_window", {
            window_id: "fake-terminal",
          });
          expect(refused.isError).toBe(true);
          expect(refused.content[0]).toMatchObject({
            text: expect.stringContaining("cannot bring a window forward"),
          });

          // And it is approval-gated, being the one tool whose whole effect is on
          // what the person at the machine sees.
          expect(computerToolRequiresApproval("computer_activate_window")).toBe(true);
        }),
      ),
  );

  it.effect(
    "describes the shortcut form and the semantic actions this desktop actually accepts",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const linux = yield* setup();
          const hotkey = linux.byName.get("computer_press_key")?.definition.description ?? "";
          expect(hotkey).toContain("A chord");
          expect(hotkey).not.toContain("ordered key sequence");
          expect(hotkey).toContain("releases in reverse");
          const linuxActions = schemaEnum(linux.byName, "computer_perform_action", "action");
          expect(linuxActions).toEqual(["activate", "click"]);
          expect(linux.byName.get("computer_launch_app")?.definition.description).toContain(
            "executable on PATH",
          );

          const mac = yield* setup(new FakeComputerBackend({ agentDialect: "macos" }));
          const macHotkey = mac.byName.get("computer_press_key")?.definition.description ?? "";
          expect(macHotkey).toContain("exactly one other key");
          expect(macHotkey).toContain("More than one non-modifier key is refused");
          const macActions = schemaEnum(mac.byName, "computer_perform_action", "action");
          expect(macActions).toEqual([
            "AXPress",
            "press",
            "open",
            "show_menu",
            "menu",
            "pick",
            "confirm",
            "cancel",
          ]);
          expect(
            schemaPropertyDescription(mac.byName, "computer_perform_action", "action"),
          ).toContain("does not advertise");
          const macLaunchAppDescription =
            mac.byName.get("computer_launch_app")?.definition.description ?? "";
          expect(macLaunchAppDescription).toContain("the way macOS does");
          // Launch posture is a request, not proof that the resulting window is usable.
          expect(macLaunchAppDescription).toContain("requests no foreground activation");
          expect(macLaunchAppDescription).toContain("may create no usable window");
          const macLaunchApp = schemaPropertyDescription(mac.byName, "computer_launch_app", "app");
          expect(macLaunchApp).toContain("com.apple.Safari");
          expect(macLaunchApp).not.toContain("/Applications/Safari.app");
        }),
      ),
  );

  it.effect("separates admission refusals from uncertain dispatched input", () =>
    Effect.sync(() => {
      const notes = computerToolInstructions();
      expect(notes).toContain('"not-dispatched"');
      expect(notes).toContain('"dispatched-unknown"');
      expect(notes).toContain("never replay it");
      expect(notes).toContain("repeated_unverified_action");
    }),
  );

  it.effect("matches a label exactly as written, spaces included", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // The desktop targeters compare labels verbatim on purpose, so trimming the
        // argument retargeted a caller that named "Save " at a control called "Save".
        const { call } = yield* setup();
        const refused = yield* call("computer_click", { label: "Calculate " });
        expect(refused.isError).toBe(true);
        expect(resultJson(refused)).toMatchObject({
          error: { code: "computer_target_not_found" },
        });
        const found = yield* call("computer_click", { label: "Calculate" });
        expect(found.isError).not.toBe(true);
      }),
    ),
  );

  it.effect("clamps a drag duration to the bound its schema advertises", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { backend, byName, call, see } = yield* setup();
        yield* see();

        yield* call("computer_drag", {
          from: { x: 1, y: 1 },
          to: { x: 2, y: 2 },
          duration_ms: 1e9,
        });
        yield* call("computer_drag", {
          from: { x: 1, y: 1 },
          to: { x: 2, y: 2 },
          duration_ms: -5,
        });

        const durations = backend.callsFor("drag").map((entry) => entry.args[2]);
        expect(durations).toEqual([30_000, 0]);
        const schema = byName.get("computer_drag")?.definition.inputSchema as {
          properties: { duration_ms: { maximum: number; minimum: number } };
        };
        // The clamp is the schema's own bound, not a second opinion about it.
        expect(schema.properties.duration_ms).toMatchObject({
          maximum: 30_000,
          minimum: 0,
        });
      }),
    ),
  );
});
