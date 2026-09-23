/**
 * Observation-side Computer tool behaviour: element diffs, app hints,
 * multi-app driving and the native parity tools, capture reuse, element refs,
 * `computer_run` observation and flow control, and `computer_help`.
 *
 * Ported from Synara's `agentGateway/computerTools.test.ts`. Cancellation is
 * fiber interruption, and spies on Effect-returning methods wrap the original
 * Effect instead of awaiting a promise.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it, vi } from "@effect/vitest";
import {
  ProviderDriverKind,
  type ComputerActionResult,
  type ComputerUiNode,
} from "@spiritdevs/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import type { ComputerApprovalOutcome } from "../../../computer/ComputerApprovalGate.ts";
import { COMPUTER_PASTE_RESTORE_MS, ComputerManager } from "../../../computer/ComputerManager.ts";
import { ComputerBackendError } from "../../../computer/computerErrors.ts";
import { FakeComputerBackend } from "../../../computer/FakeComputerBackend.ts";
import { makeComputerBrowserTools } from "./computerBrowserTools.ts";
import {
  computerToolInstructions,
  makeComputerTools,
  type ComputerToolsOptions,
} from "./computerTools.ts";
import type { McpToolCallResult, ToolContext } from "./toolRuntime.ts";

const THREAD = "thread-computer";

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

function resultJson(result: McpToolCallResult): unknown {
  const text = result.content.find((entry) => entry.type === "text");
  return text?.type === "text" ? decodeJson(text.text) : undefined;
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

const approve = () => Effect.succeed<ComputerApprovalOutcome>("approved");
const deny = () => Effect.succeed<ComputerApprovalOutcome>("denied");

const setup = Effect.fn(function* (
  backend: FakeComputerBackend = new FakeComputerBackend(),
  authorizeAction?: ComputerToolsOptions["authorizeAction"],
  /**
   * The never-raise authorization resolver. Defaults to the user having asked
   * to see the screen: these suites exercise the raise/foreground mechanics,
   * and the gate itself has dedicated tests that pass an explicit refusal.
   */
  resolveForegroundAuthorization: NonNullable<
    ComputerToolsOptions["resolveForegroundAuthorization"]
  > = () => Effect.succeed({ userRequestedVisibleUse: true }),
) {
  // A zero settle delay: these tests assert on what the post-action capture
  // does, not on how long the desktop is given to repaint.
  const manager = yield* ComputerManager.make({ backend, actionSettleMs: 0 });
  const browserTools = manager.supportsBrowser
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
   * back at 1536×864, scale 0.8, from (0, 0).
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

function textOf(result: McpToolCallResult): string {
  const text = result.content.find((entry) => entry.type === "text");
  return text?.type === "text" ? text.text : "";
}

it.layer(NodeServices.layer)("computer_get_state diff", (it) => {
  it.effect("reports the first scoped read as all-added, then only the value that moved", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { manager, call } = yield* setup();
        const baseline = resultJson(
          yield* call("computer_get_state", {
            window_id: "fake-calculator",
            diff: true,
          }),
        ) as {
          elementChanges: {
            added: { label: string }[];
            removed: unknown[];
            changed: unknown[];
          };
        };
        expect(baseline.elementChanges.added.map((item) => item.label).sort()).toEqual([
          "Calculate",
          "Display",
        ]);
        expect(baseline.elementChanges.removed).toEqual([]);
        expect(baseline.elementChanges.changed).toEqual([]);

        // Change outside the tool surface so its automatic diff does not move this baseline.
        yield* manager.setValue(THREAD, { label: "Display", windowId: "fake-calculator" }, "468");
        const diff = resultJson(
          yield* call("computer_get_state", {
            window_id: "fake-calculator",
            diff: true,
          }),
        ) as {
          elements?: unknown;
          elementWindowId?: string;
          elementChanges: {
            added: unknown[];
            removed: unknown[];
            changed: unknown[];
          };
        };
        expect(diff.elements).toBeUndefined();
        // The changed entries all belong to one window, so its id is reported
        // once instead of on every entry.
        expect(diff.elementWindowId).toBe("fake-calculator");
        expect(diff.elementChanges).toEqual({
          added: [],
          removed: [],
          changed: [
            {
              ref: 1,
              role: "text-field",
              label: "Display",
              was: "0",
              value: "468",
            },
          ],
        });
        // And a steady third read reports nothing at all.
        const steady = resultJson(
          yield* call("computer_get_state", {
            window_id: "fake-calculator",
            diff: true,
          }),
        ) as {
          elementChanges: {
            added: unknown[];
            removed: unknown[];
            changed: unknown[];
          };
        };
        expect(steady.elementChanges).toEqual({
          added: [],
          removed: [],
          changed: [],
        });
      }),
    ),
  );

  it.effect("keeps scopes apart so a windowed read does not diff the desktop digest", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { call } = yield* setup();
        yield* call("computer_get_state", { window_id: "fake-calculator" });
        // A different scope has its own baseline: this is a first read, not a diff.
        const other = resultJson(yield* call("computer_get_state", { diff: true })) as {
          elementChanges: { added: unknown[] };
        };
        expect(other.elementChanges.added.length).toBeGreaterThan(0);
      }),
    ),
  );
});

it.layer(NodeServices.layer)("computer action element diffs", (it) => {
  const windowId = "fake-calculator";
  const tree = (
    labels: readonly string[],
    value = "before",
    truncated = false,
  ): ComputerUiNode => ({
    role: "window",
    label: null,
    value: null,
    description: null,
    frame: { x: 100, y: 100, width: 900, height: 700 },
    activationPoint: null,
    onScreen: true,
    windowId,
    truncated,
    children: labels.map((label) => ({
      role: "text-field",
      label,
      value,
      description: null,
      frame: { x: 120, y: 120, width: 100, height: 30 },
      activationPoint: null,
      onScreen: true,
      windowId,
      children: [],
    })),
  });

  it.effect(
    "attaches a click diff, preserves delivery, and advances the baseline without a screenshot",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { backend, manager, call } = yield* setup(
            new FakeComputerBackend({ root: tree(["Field"]) }),
          );
          yield* call("computer_get_state", { window_id: windowId });
          const read = vi.spyOn(backend, "getState");
          // A call-through spy on the manager that keeps what each click returned.
          const clickResults: ComputerActionResult[] = [];
          const managerClick = manager.click.bind(manager);
          vi.spyOn(manager, "click").mockImplementation((...args) =>
            managerClick(...args).pipe(
              Effect.tap((result) => Effect.sync(() => clickResults.push(result))),
            ),
          );
          const originalClick = backend.click.bind(backend);
          vi.spyOn(backend, "click").mockImplementation((...args) =>
            Effect.gen(function* () {
              const result = yield* originalClick(...args);
              const state = yield* backend.getState({ includeTree: true });
              read.mockReturnValue(Effect.succeed({ ...state, root: tree(["Field"], "after") }));
              return {
                ...result,
                deliveryPath: "ax",
                verified: "unverifiable" as const,
                effect: "dispatched-unknown" as const,
              };
            }),
          );
          const response = yield* call("computer_click", {
            window_id: windowId,
            label: "Field",
            include_screenshot: false,
          });
          const result = resultJson(response);
          expect(result).toMatchObject({
            elementWindowId: windowId,
            elementChanges: {
              added: [],
              removed: [],
              changed: [{ label: "Field", was: "before", value: "after", ref: 0 }],
            },
            delivery: clickResults[0]!.delivery,
          });
          expect(response.content.every((part) => part.type === "text")).toBe(true);
          expect(read).toHaveBeenLastCalledWith(
            expect.objectContaining({ includeTree: true, includeScreenshot: false, windowId }),
          );
          expect(
            backend.calls.filter((entry) => entry.method === "captureScreenshot"),
          ).toHaveLength(0);
          expect(
            resultJson(yield* call("computer_get_state", { window_id: windowId, diff: true })),
          ).toMatchObject({
            elementChanges: { added: [], removed: [], changed: [] },
          });
        }),
      ),
  );

  for (const scope of ["none", "filtered", "other-window", "other-thread"]) {
    it.effect(`attaches nothing with a ${scope} baseline`, () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { manager, call } = yield* setup();
          if (scope !== "none")
            yield* call(
              "computer_get_state",
              {
                window_id: scope === "other-window" ? "fake-editor" : windowId,
                ...(scope === "filtered" ? { label_contains: "Display" } : {}),
              },
              undefined,
              scope === "other-thread" ? "other-thread" : THREAD,
            );
          const read = vi.spyOn(manager, "getState");
          const result = resultJson(
            yield* call("computer_set_value", {
              window_id: windowId,
              label: "Display",
              value: "123",
              include_screenshot: false,
            }),
          );
          expect(result).not.toHaveProperty("elementChanges");
          expect(read).not.toHaveBeenCalled();
        }),
      ),
    );
  }

  for (const [tool, args] of [
    ["computer_type_text", { text: "hello there" }],
    ["computer_paste", { text: "hello there" }],
    ["computer_set_value", { label: "Display", value: "123" }],
    ["computer_perform_action", { label: "Calculate", action: "activate" }],
    ["computer_invoke_menu", { path: ["File", "Save"] }],
  ] as const) {
    it.effect(`attaches a scoped diff for ${tool}`, () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { call } = yield* setup(new FakeComputerBackend(), approve);
          yield* call("computer_get_state", { window_id: windowId });
          // A paste restores the clipboard after a delay, which runs on the test clock.
          const fiber = yield* Effect.forkChild(
            call(tool, { ...args, window_id: windowId, include_screenshot: false }),
          );
          while (fiber.pollUnsafe() === undefined)
            yield* TestClock.adjust(COMPUTER_PASTE_RESTORE_MS);
          const result = yield* Fiber.join(fiber);
          expect(result.isError).not.toBe(true);
          expect(resultJson(result)).toHaveProperty("elementChanges");
        }),
      ),
    );
  }

  it.effect("propagates cancellation during the action tree read", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { manager, call, byName } = yield* setup();
        yield* call("computer_get_state", { window_id: windowId });
        const state = yield* manager.getState({ windowId, includeTree: true });
        // Synara aborted the call's signal from inside the read; here the read
        // parks until the handler's fiber is interrupted around it.
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        vi.spyOn(manager, "getState").mockImplementation(() =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as(state),
          ),
        );
        const fiber = yield* Effect.forkChild(
          byName.get("computer_click")!.handler(
            {
              window_id: windowId,
              label: "Calculate",
              include_screenshot: false,
            },
            makeContext(),
          ),
        );
        yield* Deferred.await(entered);
        yield* Fiber.interrupt(fiber);
        yield* Deferred.succeed(release, undefined);
        const exit = yield* Fiber.await(fiber);
        expect(Exit.isFailure(exit)).toBe(true);
        expect(Exit.hasInterrupts(exit)).toBe(true);
      }),
    ),
  );

  it.effect("caps added, removed and changed entries together and counts omissions", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const labels = Array.from({ length: 40 }, (_, i) => `Field ${i}`);
        const { backend, call } = yield* setup(new FakeComputerBackend({ root: tree(labels) }));
        yield* call("computer_get_state", { window_id: windowId });
        const original = backend.getState.bind(backend);
        vi.spyOn(backend, "getState").mockImplementation((args) =>
          original(args).pipe(
            Effect.map((state) => ({
              ...state,
              root: tree(
                [...labels.slice(0, 20), ...Array.from({ length: 25 }, (_, i) => `New ${i}`)],
                "after",
              ),
            })),
          ),
        );
        const result = resultJson(
          yield* call("computer_press_key", {
            window_id: windowId,
            key: "tab",
            include_screenshot: false,
          }),
        ) as {
          elementChanges: { added: unknown[]; removed: { ref?: number }[]; changed: unknown[] };
          elementChangesOmitted: number;
        };
        expect(Object.values(result.elementChanges).flat()).toHaveLength(40);
        expect(result.elementChangesOmitted).toBe(25);
        expect(result.elementChanges.removed.every((entry) => entry.ref === undefined)).toBe(true);
      }),
    ),
  );

  for (const side of ["before", "after"]) {
    it.effect(`marks a truncated ${side} tree as incomplete`, () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { backend, call } = yield* setup(
            new FakeComputerBackend({ root: tree(["Field"], "before", side === "before") }),
          );
          yield* call("computer_get_state", { window_id: windowId });
          const state = yield* backend.getState({});
          vi.spyOn(backend, "getState").mockReturnValue(
            Effect.succeed({
              ...state,
              root: tree(["Field"], "after", side === "after"),
            }),
          );
          expect(
            resultJson(
              yield* call("computer_press_key", {
                window_id: windowId,
                key: "tab",
                include_screenshot: false,
              }),
            ),
          ).toHaveProperty("elementChangesIncomplete", true);
        }),
      ),
    );
  }

  it.effect("returns the unchanged action result if the tree read fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { manager, call } = yield* setup();
        yield* call("computer_get_state", { window_id: windowId });
        const actionResults: ComputerActionResult[] = [];
        const managerClick = manager.click.bind(manager);
        vi.spyOn(manager, "click").mockImplementation((...args) =>
          managerClick(...args).pipe(
            Effect.tap((result) => Effect.sync(() => actionResults.push(result))),
          ),
        );
        vi.spyOn(manager, "getState").mockReturnValue(
          Effect.fail(new ComputerBackendError({ message: "tree unavailable" })),
        );
        const result = resultJson(
          yield* call("computer_click", {
            window_id: windowId,
            label: "Calculate",
            include_screenshot: false,
          }),
        ) as Record<string, unknown>;
        const { disclosure: _disclosure, ...payload } = result;
        expect(payload).toEqual(actionResults[0]);
      }),
    ),
  );

  it.effect("attaches one final batch diff without per-step observations", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { manager, call } = yield* setup();
        yield* call("computer_get_state", { window_id: windowId });
        const read = vi.spyOn(manager, "getState");
        const result = resultJson(
          yield* call("computer_run", {
            steps: [
              { type: "set_value", window_id: windowId, label: "Display", value: "1" },
              { type: "set_value", window_id: windowId, label: "Display", value: "12" },
            ],
          }),
        ) as { steps: { result: unknown }[] };
        expect(result).toMatchObject({
          elementChanges: {
            added: [],
            removed: [],
            changed: [{ label: "Display", was: "0", value: "12" }],
          },
        });
        expect(result.steps).toHaveLength(2);
        for (const step of result.steps) expect(step.result).not.toHaveProperty("elementChanges");
        expect(read).toHaveBeenCalledTimes(1);
      }),
    ),
  );
});

it.layer(NodeServices.layer)("computer_get_state app hint", (it) => {
  it.effect("attaches a verified note once per thread for a scoped app read", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = new FakeComputerBackend({
          windows: [
            {
              id: "slack-window",
              title: "general - Slack",
              appName: "Slack",
              bounds: { x: 10, y: 10, width: 900, height: 700 },
              focused: true,
              minimized: false,
              visible: true,
            },
          ],
        });
        const { call } = yield* setup(backend);
        const first = resultJson(
          yield* call("computer_get_state", { window_id: "slack-window" }),
        ) as {
          appHint?: string;
        };
        expect(first.appHint).toContain("set_value");
        const second = resultJson(
          yield* call("computer_get_state", { window_id: "slack-window" }),
        ) as { appHint?: string };
        expect(second.appHint).toBeUndefined();
        // A second thread has not seen it.
        const other = resultJson(
          yield* call(
            "computer_get_state",
            { window_id: "slack-window" },
            undefined,
            "other-thread",
          ),
        ) as { appHint?: string };
        expect(other.appHint).toContain("set_value");
      }),
    ),
  );
});

it.layer(NodeServices.layer)("multi-app driving", (it) => {
  it.effect("drives a second ordinary app without a further prompt", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // The second-app boundary is gone: only the denylist can refuse a drive.
        const { call } = yield* setup();
        expect((yield* call("computer_launch_app", { app: "kcalc" })).isError).not.toBe(true);
        expect((yield* call("computer_launch_app", { app: "firefox" })).isError).not.toBe(true);
      }),
    ),
  );

  describe("native driver parity tools", () => {
    it.effect("lists apps, verifies state, and zooms without approval or dispatch", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { backend, call } = yield* setup();
          const apps = yield* call("computer_list_apps", {});
          expect(apps.isError).not.toBe(true);
          const appList = resultJson(apps) as { apps: { pid: number; name: string }[] };
          expect(appList.apps.map((app) => app.pid)).toContain(1002);

          const verified = yield* call("computer_verify_state", {
            window_id: "fake-calculator",
            expect: [{ window: { bounds: { x: 1050, y: 120, tolerance_px: 4 } } }],
          });
          expect(verified.isError).not.toBe(true);
          expect(resultJson(verified)).toMatchObject({ status: "satisfied" });
          expect(backend.callsFor("verifyState").map((entry) => entry.args[0])).toEqual([
            "fake-calculator",
          ]);

          backend.setVerifySatisfied(false);
          const unsatisfied = yield* call("computer_verify_state", {
            window_id: "fake-calculator",
            expect: [{ element: { selector: { role: "AXButton" }, exists: true } }],
          });
          expect(resultJson(unsatisfied)).toMatchObject({ status: "unsatisfied" });

          const zoomed = yield* call("computer_zoom", {
            window_id: "fake-calculator",
            x: 10,
            y: 10,
            width: 100,
            height: 80,
          });
          expect(zoomed.isError).not.toBe(true);
          expect(zoomed.content.map((entry) => entry.type)).toEqual(["text", "image"]);
          expect(zoomed.content[1]).toMatchObject({ mimeType: "image/jpeg" });
          // The magnified frame must not become a coordinate frame: a click aimed
          // from it would land off-target.
          expect(resultJson(zoomed)).not.toHaveProperty("screenshot.screenshotId");

          const outOfBounds = yield* call("computer_zoom", {
            window_id: "fake-calculator",
            x: 400,
            y: 0,
            width: 100,
            height: 80,
          });
          expect(outOfBounds.isError).toBe(true);
        }),
      ),
    );

    it.effect("moves a window through approval and reports the read-back", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const backend = new FakeComputerBackend();
          const approval = vi.fn(approve);
          const { call } = yield* setup(backend, approval);
          const moved = yield* call("computer_set_window_frame", {
            window_id: "fake-calculator",
            x: 300,
            y: 200,
            width: 500,
            height: 400,
          });
          expect(moved.isError).not.toBe(true);
          // Pathway's gate takes no abort signal: name, args and caller context.
          expect(approval).toHaveBeenCalledWith(
            "computer_set_window_frame",
            expect.objectContaining({ window_id: "fake-calculator" }),
            expect.anything(),
          );
          expect(backend.callsFor("setWindowFrame").map((entry) => entry.args)).toEqual([
            ["fake-calculator", { x: 300, y: 200, width: 500, height: 400 }],
          ]);
          const windows = yield* backend.listWindows();
          expect(windows.find((window) => window.id === "fake-calculator")?.bounds).toEqual({
            x: 300,
            y: 200,
            width: 500,
            height: 400,
          });

          const invalid = yield* call("computer_set_window_frame", {
            window_id: "fake-calculator",
            x: 0,
            y: 0,
            width: 0,
            height: 400,
          });
          expect(invalid.isError).toBe(true);
        }),
      ),
    );

    it.effect(
      "asks approval before invoking menus and force-quitting, dispatching nothing when refused",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const backend = new FakeComputerBackend();
            const approval = vi.fn((_name: string) => deny());
            const { call } = yield* setup(backend, approval);
            for (const [name, args] of [
              ["computer_invoke_menu", { window_id: "fake-calculator", path: ["File", "Save"] }],
              ["computer_kill_app", { window_id: "fake-calculator" }],
            ] as const) {
              const refused = yield* call(name, args);
              expect(refused.isError).toBe(true);
            }
            expect(backend.callsFor("invokeMenu")).toHaveLength(0);
            expect(backend.callsFor("killApp")).toHaveLength(0);
            expect(approval.mock.calls.map((entry) => entry[0])).toEqual([
              "computer_invoke_menu",
              "computer_kill_app",
            ]);
          }),
        ),
    );

    it.effect("resolves kill_app's window to its owning pid before dispatch", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const backend = new FakeComputerBackend();
          const { call } = yield* setup(backend, vi.fn(approve));
          const killed = yield* call("computer_kill_app", { window_id: "fake-calculator" });
          expect(killed.isError).not.toBe(true);
          expect(backend.callsFor("killApp").map((entry) => entry.args[0])).toEqual([1002]);
          // The closed window leaves the list: the next call names the miss.
          const gone = yield* call("computer_kill_app", { window_id: "fake-calculator" });
          expect(gone.isError).toBe(true);
          expect(backend.callsFor("killApp")).toHaveLength(1);
        }),
      ),
    );

    it.effect("drives the app a window-targeted mutation names without asking", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const backend = new FakeComputerBackend();
          const { call } = yield* setup(backend, vi.fn(approve));
          yield* call("computer_launch_app", { app: "TextEdit" });
          const moved = yield* call("computer_set_window_frame", {
            window_id: "fake-calculator",
            x: 0,
            y: 0,
            width: 500,
            height: 400,
          });
          expect(moved.isError).not.toBe(true);
        }),
      ),
    );

    it.effect("runs the window-management steps through computer_run in order", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const backend = new FakeComputerBackend();
          const { call } = yield* setup(backend, vi.fn(approve));
          const result = yield* call("computer_run", {
            steps: [
              {
                type: "set_window_frame",
                window_id: "fake-calculator",
                x: 50,
                y: 60,
                width: 500,
                height: 400,
              },
              { type: "invoke_menu", window_id: "fake-calculator", path: ["File", "Save"] },
              { type: "kill_app", window_id: "fake-calculator" },
            ],
          });
          expect(result.isError).not.toBe(true);
          const payload = resultJson(result) as {
            steps: { step: number; type: string; ok: boolean }[];
            completed: number;
          };
          expect(payload.steps.map((entry) => [entry.step, entry.type, entry.ok])).toEqual([
            [0, "set_window_frame", true],
            [1, "invoke_menu", true],
            [2, "kill_app", true],
          ]);
          expect(payload.completed).toBe(3);
          expect(backend.callsFor("setWindowFrame").map((entry) => entry.args[0])).toEqual([
            "fake-calculator",
          ]);
          expect(backend.callsFor("invokeMenu").map((entry) => entry.args[1])).toEqual([
            ["File", "Save"],
          ]);
          expect(backend.callsFor("killApp").map((entry) => entry.args[0])).toEqual([1002]);
        }),
      ),
    );

    it.effect("invokes a windowless app's menu from its live pid, attributed to the app", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const backend = new FakeComputerBackend({
            apps: [
              {
                pid: 6_001,
                name: "Helium",
                bundleId: "net.imput.helium",
                running: true,
                active: false,
              },
              {
                pid: 1_001,
                name: "Terminal",
                bundleId: "org.kde.konsole",
                running: true,
                active: true,
              },
              {
                pid: 1_002,
                name: "Calculator",
                bundleId: "org.kde.kcalc",
                running: true,
                active: false,
              },
            ],
          });
          const approval = vi.fn(
            (_name: string, _args: Record<string, unknown>, _context: ToolContext) => approve(),
          );
          const { call } = yield* setup(backend, approval);
          const result = yield* call("computer_invoke_menu", {
            app: "Helium",
            path: ["File", "New Window"],
          });
          expect(result.isError).not.toBe(true);
          // The app name resolved to its live pid, and no window id rides the
          // dispatch — the driver's windowless contract, exactly.
          const dispatched = backend.callsFor("invokeMenu").at(-1)?.args[0] as Record<
            string,
            unknown
          >;
          expect(dispatched).toEqual({ pid: 6_001 });
          expect(dispatched).not.toHaveProperty("window_id");
          expect(resultJson(result)).not.toHaveProperty("windowId");
          expect(approval).toHaveBeenCalledOnce();
        }),
      ),
    );

    it.effect("refuses a menu call that names no target or two different routes", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const backend = new FakeComputerBackend();
          const { call } = yield* setup(backend, vi.fn(approve));
          const none = yield* call("computer_invoke_menu", { path: ["File"] });
          expect(none.isError).toBe(true);
          expect(textOf(none)).toContain("Name the target one way");
          const two = yield* call("computer_invoke_menu", {
            window_id: "fake-terminal",
            app: "Terminal",
            path: ["File"],
          });
          expect(two.isError).toBe(true);
          expect(textOf(two)).toContain("exactly one");
          expect(backend.callsFor("invokeMenu")).toHaveLength(0);
        }),
      ),
    );

    it.effect("runs a windowless app menu step through computer_run", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const backend = new FakeComputerBackend({
            apps: [
              {
                pid: 6_001,
                name: "Helium",
                bundleId: "net.imput.helium",
                running: true,
                active: false,
              },
              {
                pid: 1_001,
                name: "Terminal",
                bundleId: "org.kde.konsole",
                running: true,
                active: true,
              },
            ],
          });
          const { call } = yield* setup(backend, vi.fn(approve));
          const result = yield* call("computer_run", {
            steps: [{ type: "invoke_menu", app: "Helium", path: ["File", "New Window"] }],
          });
          expect(result.isError).not.toBe(true);
          const payload = resultJson(result) as { completed: number };
          expect(payload.completed).toBe(1);
          expect(backend.callsFor("invokeMenu").at(-1)?.args).toEqual([
            { pid: 6_001 },
            ["File", "New Window"],
          ]);
        }),
      ),
    );

    it.effect("refuses run steps with missing or oversized arguments whole", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const backend = new FakeComputerBackend();
          const { call } = yield* setup(backend, vi.fn(approve));
          for (const steps of [
            [
              {
                type: "set_window_frame",
                window_id: "fake-calculator",
                x: 0,
                y: 0,
                width: 0,
                height: 5,
              },
            ],
            [{ type: "set_window_frame", x: 0, y: 0, width: 5, height: 5 }],
            [{ type: "invoke_menu", window_id: "fake-calculator", path: [] }],
            [{ type: "invoke_menu", window_id: "fake-calculator" }],
            [{ type: "kill_app" }],
          ]) {
            const result = yield* call("computer_run", { steps });
            expect(result.isError).toBe(true);
          }
          expect(backend.callsFor("setWindowFrame")).toHaveLength(0);
          expect(backend.callsFor("invokeMenu")).toHaveLength(0);
          expect(backend.callsFor("killApp")).toHaveLength(0);
        }),
      ),
    );
  });

  describe("PATHWAY_CUA_CAPTURE_REUSE", () => {
    const FLAG = "PATHWAY_CUA_CAPTURE_REUSE";

    /** Sets the flag for the enclosing scope and restores the prior value on close. */
    const setFlag = (value: string | undefined) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const saved = process.env[FLAG];
          if (value === undefined) delete process.env[FLAG];
          else process.env[FLAG] = value;
          return saved;
        }),
        (saved) =>
          Effect.sync(() => {
            if (saved !== undefined) process.env[FLAG] = saved;
            else delete process.env[FLAG];
          }),
      );

    const imageParts = (result: McpToolCallResult) =>
      result.content.filter((entry) => entry.type === "image").length;

    it.effect(
      "ships a fresh image for every read under the kill switch, even a byte-identical one",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            yield* setFlag("0");
            const { call, see } = yield* setup();
            const first = yield* see();
            const second = yield* call("computer_get_state", { include_screenshot: true });
            const payload = resultJson(second) as { screenshot: { screenshotId: string } };
            expect(payload.screenshot.screenshotId).not.toBe(first.screenshotId);
            expect(payload).not.toHaveProperty("screenshotUnchanged");
            expect(imageParts(second)).toBe(1);
          }),
        ),
    );

    it.effect("names the earlier frame by default — reuse no longer needs the flag", () =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* setFlag(undefined);
          const backend = new FakeComputerBackend();
          const { call, see } = yield* setup(backend);
          const first = yield* see();
          const second = yield* call("computer_get_state", { include_screenshot: true });
          const payload = resultJson(second) as {
            screenshotUnchanged?: boolean;
            screenshot: { screenshotId: string };
          };
          expect(payload.screenshotUnchanged).toBe(true);
          expect(payload.screenshot.screenshotId).toBe(first.screenshotId);
          expect(imageParts(second)).toBe(0);
        }),
      ),
    );

    it.effect("names the earlier frame when the fresh capture is byte-identical", () =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* setFlag("1");
          const backend = new FakeComputerBackend();
          const { call, see } = yield* setup(backend);
          const first = yield* see();
          const second = yield* call("computer_get_state", { include_screenshot: true });
          const payload = resultJson(second) as {
            screenshotUnchanged?: boolean;
            screenshot: { screenshotId: string; windowId?: string };
          };
          // The pixels still cost a capture — only their delivery is deduplicated.
          expect(backend.callsFor("getState")).toHaveLength(2);
          expect(payload.screenshotUnchanged).toBe(true);
          expect(payload.screenshot.screenshotId).toBe(first.screenshotId);
          expect(imageParts(second)).toBe(0);
        }),
      ),
    );

    it.effect("delivers normally when the bytes differ or the coordinate frame moved", () =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* setFlag("1");
          const backend = new FakeComputerBackend();
          const { call, see } = yield* setup(backend);
          yield* see();
          // Same window, new pixels: byte identity is the only proof nothing
          // changed, so a different capture ships as a new frame.
          backend.queueScreenshots([
            Buffer.from("a-different-desktop").toString("base64"),
            Buffer.from("a-different-desktop").toString("base64"),
          ]);
          const changed = yield* call("computer_screenshot", { window_id: "fake-calculator" });
          const changedPayload = resultJson(changed) as {
            screenshotUnchanged?: boolean;
            screenshot: { screenshotId: string; windowId: string };
          };
          expect(changedPayload.screenshotUnchanged).toBeUndefined();
          expect(imageParts(changed)).toBe(1);

          // Identical bytes on the same window dedupe from then on — and the
          // capture itself still ran.
          const captures = backend.callsFor("captureScreenshot").length;
          const again = yield* call("computer_screenshot", { window_id: "fake-calculator" });
          const againPayload = resultJson(again) as {
            screenshotUnchanged?: boolean;
            screenshot: { screenshotId: string };
          };
          expect(backend.callsFor("captureScreenshot")).toHaveLength(captures + 1);
          expect(againPayload.screenshotUnchanged).toBe(true);
          expect(againPayload.screenshot.screenshotId).toBe(changedPayload.screenshot.screenshotId);
          expect(imageParts(again)).toBe(0);

          // Another window is a different coordinate frame even with identical
          // bytes: pointing into shot-N must never read pixels it was not shown.
          const other = yield* call("computer_screenshot", { window_id: "fake-terminal" });
          const otherPayload = resultJson(other) as {
            screenshotUnchanged?: boolean;
            screenshot: { screenshotId: string; windowId: string };
          };
          expect(otherPayload.screenshotUnchanged).toBeUndefined();
          expect(otherPayload.screenshot.screenshotId).not.toBe(
            changedPayload.screenshot.screenshotId,
          );
          expect(otherPayload.screenshot.windowId).toBe("fake-terminal");
          expect(imageParts(other)).toBe(1);
        }),
      ),
    );

    it.effect("never lets one thread's picture stand in for another's", () =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* setFlag("1");
          const { call } = yield* setup();
          const first = resultJson(
            yield* call("computer_screenshot", { window_id: "fake-calculator" }),
          ) as { screenshot: { screenshotId: string } };
          const second = resultJson(
            yield* call(
              "computer_screenshot",
              { window_id: "fake-calculator" },
              undefined,
              "other-thread",
            ),
          ) as { screenshot: { screenshotId: string }; screenshotUnchanged?: boolean };
          expect(second.screenshot.screenshotId).not.toBe(first.screenshot.screenshotId);
          expect(second.screenshotUnchanged).toBeUndefined();
        }),
      ),
    );
  });
});

it.layer(NodeServices.layer)("element refs", (it) => {
  type ListedElement = {
    ref: number;
    role: string;
    label: string;
    windowId: string | null;
    value?: string;
  };
  const elementsOf = (result: McpToolCallResult): ListedElement[] =>
    (resultJson(result) as { elements?: ListedElement[] }).elements ?? [];

  /** A desktop with one window holding two identically labelled Save buttons. */
  const duplicateSaves = (): ComputerUiNode => {
    const button = (x: number): ComputerUiNode => ({
      role: "button",
      label: "Save",
      value: null,
      description: null,
      frame: { x, y: 100, width: 60, height: 30 },
      activationPoint: null,
      onScreen: true,
      windowId: "w1",
      children: [],
    });
    return {
      role: "desktop",
      label: null,
      value: null,
      description: null,
      frame: { x: 0, y: 0, width: 1920, height: 1080 },
      activationPoint: null,
      onScreen: true,
      windowId: null,
      children: [
        {
          role: "window",
          label: "Editor",
          value: null,
          description: null,
          frame: { x: 0, y: 0, width: 800, height: 600 },
          activationPoint: null,
          onScreen: true,
          windowId: "w1",
          children: [button(20), button(200)],
        },
      ],
    };
  };

  it.effect("lists a stable ref per element and clicks it without a label", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { backend, call } = yield* setup();
        const elements = elementsOf(yield* call("computer_get_state", {}));
        const calculate = elements.find((element) => element.label === "Calculate");
        expect(calculate).toBeDefined();

        const result = yield* call("computer_click", { ref: calculate!.ref });
        expect(result.isError).not.toBe(true);
        // The button's frame centre — the same point label targeting resolves.
        expect(backend.callsFor("click").at(-1)?.args[0]).toEqual({ x: 1180, y: 228 });
      }),
    ),
  );

  it.effect("keeps a ref bound to the same element across listings", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { backend, call } = yield* setup();
        const first = elementsOf(yield* call("computer_get_state", {}));
        const calculate = first.find((element) => element.label === "Calculate")!;

        // A scoped second listing still shows the same number for it — refs do
        // not re-seat when the model narrows or widens its view.
        const second = elementsOf(
          yield* call("computer_get_state", { window_id: "fake-calculator" }),
        );
        expect(second.find((element) => element.label === "Calculate")?.ref).toBe(calculate.ref);

        const result = yield* call("computer_click", { ref: calculate.ref });
        expect(result.isError).not.toBe(true);
        expect(backend.callsFor("click").at(-1)?.args[0]).toEqual({ x: 1180, y: 228 });
      }),
    ),
  );

  it.effect("mints different refs for duplicate labels and clicks the right one", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { backend, call } = yield* setup(new FakeComputerBackend({ root: duplicateSaves() }));
        const saves = elementsOf(yield* call("computer_get_state", {})).filter(
          (element) => element.label === "Save",
        );
        expect(saves).toHaveLength(2);
        expect(saves[0]!.ref).not.toBe(saves[1]!.ref);

        const result = yield* call("computer_click", { ref: saves[1]!.ref });
        expect(result.isError).not.toBe(true);
        // The second Save's centre: ordinal 1, not the first match a label search finds.
        expect(backend.callsFor("click").at(-1)?.args[0]).toEqual({ x: 230, y: 115 });
      }),
    ),
  );

  it.effect("targets a duplicate by ref_ordinal without a ref", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { backend, call } = yield* setup(new FakeComputerBackend({ root: duplicateSaves() }));
        yield* call("computer_get_state", {});
        const result = yield* call("computer_click", { label: "Save", ref_ordinal: 1 });
        expect(result.isError).not.toBe(true);
        expect(backend.callsFor("click").at(-1)?.args[0]).toEqual({ x: 230, y: 115 });
      }),
    ),
  );

  it.effect("refuses a ref no listing ever minted, and a ref mixed with coordinates", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { call } = yield* setup();
        const before = yield* call("computer_click", { ref: 0 });
        expect(before.isError).toBe(true);
        expect(textOf(before)).toContain("computer_get_state");

        yield* call("computer_get_state", {});
        const outOfRange = yield* call("computer_click", { ref: 999 });
        expect(outOfRange.isError).toBe(true);
        expect(textOf(outOfRange)).toContain("999");

        const mixed = yield* call("computer_click", { ref: 0, x: 10, y: 10 });
        expect(mixed.isError).toBe(true);
        expect(textOf(mixed)).toContain("x/y");
      }),
    ),
  );

  it.effect("refuses when a claim beside the ref names a different element", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { call } = yield* setup();
        const elements = elementsOf(yield* call("computer_get_state", {}));
        const calculate = elements.find((element) => element.label === "Calculate")!;

        const wrongLabel = yield* call("computer_click", {
          ref: calculate.ref,
          label: "Definitely not this",
        });
        expect(wrongLabel.isError).toBe(true);
        expect(textOf(wrongLabel)).toContain("Calculate");

        const wrongRole = yield* call("computer_click", {
          ref: calculate.ref,
          role: "text-field",
        });
        expect(wrongRole.isError).toBe(true);

        // A claim that agrees with the listing is accepted.
        const right = yield* call("computer_click", {
          ref: calculate.ref,
          label: "Calculate",
        });
        expect(right.isError).not.toBe(true);
      }),
    ),
  );

  it.effect("keeps refs thread-scoped", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { call } = yield* setup();
        const elements = elementsOf(yield* call("computer_get_state", {}));
        const ref = elements[0]!.ref;
        const other = yield* call("computer_click", { ref }, undefined, "other-thread");
        expect(other.isError).toBe(true);
        expect(textOf(other)).toContain("computer_get_state");
      }),
    ),
  );

  it.effect("targets text and run steps by ref", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { backend, call } = yield* setup();
        const elements = elementsOf(yield* call("computer_get_state", {}));
        const display = elements.find((element) => element.label === "Display")!;

        const selected = yield* call("computer_select_text", {
          ref: display.ref,
          start: 0,
          length: 1,
        });
        expect(selected.isError).not.toBe(true);
        expect(backend.callsFor("selectText").at(-1)?.args[1]).toEqual({ start: 0, length: 1 });

        const calculate = elements.find((element) => element.label === "Calculate")!;
        const run = yield* call("computer_run", {
          steps: [{ type: "click", ref: calculate.ref }],
        });
        expect(run.isError).not.toBe(true);
        expect(backend.callsFor("click").at(-1)?.args[0]).toEqual({ x: 1180, y: 228 });
      }),
    ),
  );
});

it.layer(NodeServices.layer)("computer_run observation steps", (it) => {
  it.effect("lists elements mid-run with get_state and mints refs the model can use after", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { backend, call } = yield* setup();
        const run = resultJson(
          yield* call("computer_run", {
            steps: [
              { type: "get_state", window_id: "fake-calculator" },
              { type: "click", label: "Calculate", window_id: "fake-calculator" },
            ],
          }),
        ) as {
          steps: {
            type: string;
            result?: { elements?: { ref: number; label: string }[]; elementWindowId?: string };
          }[];
        };
        const listed = run.steps[0]!.result?.elements ?? [];
        expect(listed.map((element) => element.label)).toContain("Calculate");
        expect(run.steps[0]!.result?.elementWindowId).toBe("fake-calculator");
        // The listing's refs are real bindings: citing one right after the run resolves it.
        const calculate = listed.find((element) => element.label === "Calculate")!;
        const followup = yield* call("computer_click", { ref: calculate.ref });
        expect(followup.isError).not.toBe(true);
        expect(backend.callsFor("click").at(-1)?.args[0]).toEqual({ x: 1180, y: 228 });
      }),
    ),
  );

  it.effect("runs verify_state predicates mid-run", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { backend, call } = yield* setup();
        yield* call("computer_get_state", {});
        const run = resultJson(
          yield* call("computer_run", {
            steps: [
              {
                type: "verify_state",
                window_id: "fake-calculator",
                expect: [{ label: "Display", value: "0" }],
              },
            ],
          }),
        ) as { steps: { ok: boolean }[] };
        expect(run.steps[0]!.ok).toBe(true);
        expect(backend.callsFor("verifyState").at(-1)?.args).toEqual([
          "fake-calculator",
          [{ label: "Display", value: "0" }],
        ]);
      }),
    ),
  );
});

it.layer(NodeServices.layer)("computer_run flow control", (it) => {
  it.effect("skips a step whose if_element is absent and runs it when present", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { backend, call } = yield* setup();
        yield* call("computer_get_state", {});
        const run = resultJson(
          yield* call("computer_run", {
            steps: [
              {
                type: "click",
                label: "Calculate",
                window_id: "fake-calculator",
                if_element: { label: "Does not exist" },
              },
              {
                type: "click",
                label: "Calculate",
                window_id: "fake-calculator",
                if_element: { label: "Calculate", window_id: "fake-calculator" },
              },
            ],
          }),
        ) as {
          steps: { ok: boolean; skipped?: boolean; skippedReason?: string }[];
          skipped: number;
          completed: number;
        };
        expect(run.steps[0]).toMatchObject({
          ok: true,
          skipped: true,
          skippedReason: "if_element_absent",
        });
        expect(run.steps[1]).toMatchObject({ ok: true });
        expect(run.steps[1]!.skipped).toBeUndefined();
        expect(run.skipped).toBe(1);
        // Only the second click dispatched — a skipped step touches nothing.
        expect(backend.callsFor("click")).toHaveLength(1);
      }),
    ),
  );

  it.effect("skips a step whose unless_element is present", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { backend, call } = yield* setup();
        yield* call("computer_get_state", {});
        const run = resultJson(
          yield* call("computer_run", {
            steps: [
              {
                type: "click",
                label: "Calculate",
                window_id: "fake-calculator",
                unless_element: { label: "Calculate", window_id: "fake-calculator" },
              },
              {
                type: "click",
                label: "Calculate",
                window_id: "fake-calculator",
                unless_element: { label: "Not there" },
              },
            ],
          }),
        ) as { steps: { skipped?: boolean; skippedReason?: string }[] };
        expect(run.steps[0]!.skippedReason).toBe("unless_element_present");
        expect(run.steps[1]!.skipped).toBeUndefined();
        expect(backend.callsFor("click")).toHaveLength(1);
      }),
    ),
  );

  it.effect("evaluates an if_element ref against the element it was minted for", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { backend, call } = yield* setup();
        const elements = (
          resultJson(yield* call("computer_get_state", {})) as {
            elements: { ref: number; label: string }[];
          }
        ).elements;
        const calculate = elements.find((element) => element.label === "Calculate")!;
        const run = resultJson(
          yield* call("computer_run", {
            steps: [
              {
                type: "click",
                label: "Calculate",
                window_id: "fake-calculator",
                if_element: { ref: calculate.ref },
              },
            ],
          }),
        ) as { steps: { ok: boolean; skipped?: boolean }[] };
        expect(run.steps[0]!.skipped).toBeUndefined();
        expect(run.steps[0]!.ok).toBe(true);
        expect(backend.callsFor("click")).toHaveLength(1);
      }),
    ),
  );

  it.effect("continues past a failed step with continue_on_error", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { backend, call } = yield* setup();
        yield* call("computer_get_state", {});
        const run = resultJson(
          yield* call("computer_run", {
            steps: [
              {
                type: "click",
                label: "Missing control",
                window_id: "fake-calculator",
                continue_on_error: true,
              },
              { type: "click", label: "Calculate", window_id: "fake-calculator" },
            ],
          }),
        ) as {
          steps: { ok: boolean }[];
          stopped: boolean;
          completed: number;
        };
        expect(run.steps[0]!.ok).toBe(false);
        expect(run.steps[1]!.ok).toBe(true);
        expect(run.stopped).toBe(false);
        expect(run.completed).toBe(1);
        expect(backend.callsFor("click")).toHaveLength(1);
      }),
    ),
  );

  it.effect("still stops the run on a failure without continue_on_error", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { backend, call } = yield* setup();
        yield* call("computer_get_state", {});
        const run = resultJson(
          yield* call("computer_run", {
            steps: [
              { type: "click", label: "Missing control", window_id: "fake-calculator" },
              { type: "click", label: "Calculate", window_id: "fake-calculator" },
            ],
          }),
        ) as { steps: { ok: boolean }[]; stopped: boolean };
        expect(run.steps).toHaveLength(1);
        expect(run.stopped).toBe(true);
        expect(backend.callsFor("click")).toHaveLength(0);
      }),
    ),
  );

  it.effect("waits for an element to be absent with absent:true", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { call } = yield* setup();
        yield* call("computer_get_state", {});
        const run = resultJson(
          yield* call("computer_run", {
            steps: [
              {
                type: "wait",
                duration_ms: 500,
                absent: true,
                label: "Never present",
                window_id: "fake-calculator",
              },
            ],
          }),
        ) as { steps: { ok: boolean; result?: { status?: string } }[] };
        expect(run.steps[0]!.ok).toBe(true);
        expect(run.steps[0]!.result?.status).toBe("ready");
      }),
    ),
  );

  it.effect("refuses a condition with no label-carrying target", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { call } = yield* setup();
        const run = yield* call("computer_run", {
          steps: [
            {
              type: "click",
              label: "Calculate",
              window_id: "fake-calculator",
              if_element: { window_id: "fake-calculator" },
            },
          ],
        });
        expect(run.isError).toBe(true);
        expect(textOf(run)).toContain("if_element");
      }),
    ),
  );
});

it.layer(NodeServices.layer)("computer_help", (it) => {
  it.effect(
    "looks up the registered browser catalog and the returned prepare tool is callable",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const backend = new FakeComputerBackend({ browser: true });
          const { call, byName } = yield* setup(backend, approve);
          const help = resultJson(
            yield* call("computer_help", { tool: "computer_browser_prepare" }),
          );
          expect(help).toMatchObject({
            definition: byName.get("computer_browser_prepare")!.definition,
            advertised: true,
          });
          const index = resultJson(yield* call("computer_help", { topic: "tools" })) as {
            text: string;
          };
          expect(index.text).toContain("computer_browser_prepare");
          expect(index.text).toContain("computer_browser_navigate");
          const prepared = yield* call("computer_browser_prepare", {
            allow_launch: true,
            profile: { mode: "isolated_new" },
          });
          expect(prepared.isError).not.toBe(true);
          expect(backend.callsFor("browser.browser_prepare")).toHaveLength(1);
        }),
      ),
  );

  it.effect("does not invent browser entries for a desktop-only backend", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { call } = yield* setup();
        const help = yield* call("computer_help", { tool: "computer_browser_prepare" });
        expect(help.isError).toBe(true);
        const index = resultJson(yield* call("computer_help", { topic: "tools" })) as {
          text: string;
        };
        expect(index.text).not.toContain("computer_browser_prepare");
      }),
    ),
  );

  it.effect("indexes the chapters when called bare", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { call } = yield* setup();
        const result = yield* call("computer_help", {});
        expect(result.isError).not.toBe(true);
        const json = resultJson(result) as { topics: string };
        for (const topic of ["browser", "menus", "hidden", "foreground", "forms", "tools"]) {
          expect(json.topics).toContain(topic);
        }
        expect(json.topics).not.toContain("recording");
      }),
    ),
  );

  it.effect(
    "prefers element refs, gates menus on visible-use consent, and teaches whole-string insertion",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { call } = yield* setup(new FakeComputerBackend({ agentDialect: "macos" }));
          const menus = resultJson(yield* call("computer_help", { topic: "menus" })) as {
            text: string;
          };
          expect(menus.text).toContain("On macOS");
          expect(menus.text).toContain("act on an element ref first");
          // Menus activate the app, so background tasks must not be sent there first.
          expect(menus.text).toContain("only when the user asked to see the screen");
          expect(menus.text.indexOf("element ref")).toBeLessThan(
            menus.text.indexOf("computer_invoke_menu"),
          );
          expect(menus.text.indexOf("computer_invoke_menu")).toBeLessThan(
            menus.text.indexOf("coordinate click"),
          );
          const editors = resultJson(yield* call("computer_help", { topic: "editors" })) as {
            text: string;
          };
          expect(editors.text).toContain(
            "computer_type_text with window_id alone inserts the whole string",
          );
          expect(editors.text).toContain("never spell text out through computer_press_key");
        }),
      ),
  );

  it.effect("serves one chapter verbatim on its topic", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { call } = yield* setup();
        const result = yield* call("computer_help", { topic: "browser" });
        expect(result.isError).not.toBe(true);
        const json = resultJson(result) as { topic: string; text: string };
        expect(json.topic).toBe("browser");
        expect(json.text).toContain("computer_browser_prepare");
        expect(json.text).toContain("never pass one for the other");
        expect(json.text).not.toContain("computer_recording_start");
      }),
    ),
  );

  it.effect(
    "returns one canonical schema and routes hidden actions through the advertised batch tool",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { byName, tools, call, backend } = yield* setup();
          expect(
            tools.filter((tool) => tool.discoveryOnly !== true).map((tool) => tool.definition.name),
          ).toContain("computer_run");
          const help = resultJson(
            yield* call("computer_help", { tool: "computer_select_text" }),
          ) as {
            definition: { name: string; inputSchema: unknown };
            advertised: boolean;
            batchStep: { type: string; fields: string[] };
          };
          expect(help.definition).toEqual(byName.get("computer_select_text")!.definition);
          expect(help.advertised).toBe(false);
          expect(help.batchStep).toMatchObject({ type: "select_text" });
          expect(help.batchStep.fields).toEqual(
            expect.arrayContaining(["label", "start", "length", "if_element", "continue_on_error"]),
          );
          expect(help.batchStep.fields).not.toContain("include_screenshot");
          expect(encodeJson(help)).not.toContain("computer_drag");
          // Form a supported hidden step from the returned route; no direct call
          // to an unadvertised tool is needed at the provider boundary.
          const run = yield* call("computer_run", {
            steps: [
              { type: "set_value", window_id: "fake-calculator", label: "Display", value: "12345" },
              {
                type: help.batchStep.type,
                window_id: "fake-calculator",
                label: "Display",
                start: 1,
                length: 2,
              },
            ],
          });
          expect(run.isError).not.toBe(true);
          expect(resultJson(run)).toMatchObject({ completed: 2, stopped: false });
          expect(backend.callsFor("selectText")).toHaveLength(1);
        }),
      ),
  );

  it.effect("exposes an image-preserving inspection route for hidden specialists", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { call } = yield* setup();
        const help = resultJson(yield* call("computer_help", { tool: "computer_zoom" }));
        expect(help).toMatchObject({
          advertised: false,
          inspection: { name: "computer_inspect", tool: "computer_zoom" },
        });
        expect(help).not.toHaveProperty("batchStep");
        for (const args of [
          { tool: "computer_future" },
          { tool: "computer_select_text", topic: "tools" },
        ]) {
          expect((yield* call("computer_help", args)).isError).toBe(true);
        }
      }),
    ),
  );

  it.effect("gives every hidden desktop tool a currently advertised canonical route", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { call, tools } = yield* setup();
        const advertised = new Set(
          tools.filter((tool) => tool.discoveryOnly !== true).map((tool) => tool.definition.name),
        );
        const inspectionNames = schemaEnum(
          new Map(tools.map((tool) => [tool.definition.name, tool])),
          "computer_inspect",
          "tool",
        );
        for (const tool of tools.filter((entry) => entry.discoveryOnly === true)) {
          const name = tool.definition.name;
          const help = resultJson(yield* call("computer_help", { tool: name })) as {
            advertised: boolean;
            batchStep?: { type: string };
            inspection?: { name: string; tool: string };
          };
          expect(help.advertised, name).toBe(false);
          if (help.batchStep) {
            expect(advertised.has("computer_run"), name).toBe(true);
            expect(name).toBe(`computer_${help.batchStep.type}`);
          } else {
            expect(help.inspection, name).toEqual({
              name: "computer_inspect",
              tool: name,
              instruction: "Pass this schema's arguments in the arguments object.",
            });
            expect(advertised.has(help.inspection!.name), name).toBe(true);
            expect(inspectionNames, name).toContain(name);
          }
        }
      }),
    ),
  );

  it.effect("serves every chapter under all", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { call } = yield* setup();
        const result = yield* call("computer_help", { topic: "all" });
        expect(result.isError).not.toBe(true);
        const json = resultJson(result) as { chapters: string };
        expect(json.chapters).toContain("computer_browser_prepare");
        expect(json.chapters).toContain("computer_invoke_menu");
        expect(json.chapters).toContain("set_window_minimized");
        // The generated index is part of the "all" read: a discovery-only name
        // that no chapter's prose names proves the catalog joined the chapters.
        expect(json.chapters).toContain("computer_write_clipboard");
        expect(json.chapters).toContain("Available as computer_run steps");
        expect(json.chapters).not.toContain("computer_recording");
        expect(json.chapters).not.toContain("computer_replay");
      }),
    ),
  );

  it.effect("refuses an unknown topic and names the valid ones", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { call } = yield* setup();
        const result = yield* call("computer_help", { topic: "unknown_chapter" });
        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain("browser");
      }),
    ),
  );

  it.effect("keeps the injected block to the every-turn core and points at the tool", () =>
    Effect.sync(() => {
      // What moved behind computer_help was chosen for being situational: the
      // injected block still carries consent, the observe-act loop, verdicts,
      // refusals and the browser CDP spine — everything a first action needs —
      // but not the chapters or the full catalog.
      const notes = computerToolInstructions();
      expect(notes).toContain("computer_help");
      expect(notes).toContain('computer_help({tool:"computer_invoke_menu"})');
      expect(notes).not.toContain("computer_recording_start");
      expect(notes).not.toContain("set_window_minimized");
      expect(notes).toContain("never replay it");
      expect(notes).toContain("delivery.effect");
    }),
  );
});
