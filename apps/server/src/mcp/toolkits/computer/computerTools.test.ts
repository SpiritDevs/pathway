import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it, vi } from "@effect/vitest";
import { ProviderDriverKind, type ComputerLaunchAppResult } from "@spiritdevs/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { COMPUTER_ACTION_OBSERVATION_MAX_DIMENSION } from "../../../computer/ComputerBackend.ts";
import { ComputerManager } from "../../../computer/ComputerManager.ts";
import { FakeComputerBackend } from "../../../computer/FakeComputerBackend.ts";
import { ComputerBackendError } from "../../../computer/computerErrors.ts";
import { isModelDesktopObservationActive } from "../../../computer/modelDesktopObservation.ts";
import { makeComputerBrowserTools } from "./computerBrowserTools.ts";
import {
  COMPUTER_APPROVAL_REQUIRED_TOOLS,
  COMPUTER_CONTROL_CAPABILITY,
  computerToolInstructions,
  computerToolRequiresApproval,
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

function textJson(result: McpToolCallResult): unknown {
  const text = result.content.find((entry) => entry.type === "text");
  return decodeJson(text?.type === "text" ? text.text : "{}");
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
    callerCapabilities: new Set([COMPUTER_CONTROL_CAPABILITY]),
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

/** One property's description, for the schemas whose vocabulary is backend-dependent. */
function schemaPropertyDescription(byName: ToolsByName, tool: string, property: string): string {
  const schema = byName.get(tool)?.definition.inputSchema as
    | { properties?: Record<string, { description?: string }> }
    | undefined;
  return schema?.properties?.[property]?.description ?? "";
}

/** The `window_id` blurb one tool advertises, which is backend-dependent prose. */
function windowIdDescription(byName: ToolsByName, tool: string): string {
  const schema = byName.get(tool)?.definition.inputSchema as
    | { properties?: { window_id?: { description?: string } } }
    | undefined;
  return schema?.properties?.window_id?.description ?? "";
}

const byteLength = (value: unknown) => Buffer.byteLength(encodeJson(value), "utf8");

it.layer(NodeServices.layer)("Pathway computer tools", (it) => {
  it.effect("bounds active tool context and directs deferred discovery to the next small set", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { tools } = yield* setup(new FakeComputerBackend({ agentDialect: "macos" }));
        const definitions = tools
          .filter((tool) => tool.discoveryOnly !== true)
          .map((tool) => tool.definition);
        const descriptorBytes = byteLength(definitions);
        // The macOS desktop catalog was 29,792 bytes before advertising run; it is
        // now 29,326 with the compact run and inspector routes. Keep both below
        // that baseline without serializing every step or specialist schema.
        // Browser tools, provider framing and images are separate costs.
        expect(descriptorBytes).toBeLessThanOrEqual(29_400);
        expect(
          byteLength(definitions.find((tool) => tool.name === "computer_run")),
        ).toBeLessThanOrEqual(2_000);
        expect(
          byteLength(definitions.find((tool) => tool.name === "computer_inspect")),
        ).toBeLessThanOrEqual(750);
        const notes = computerToolInstructions();
        // The injected block was 8,404 chars before the surface cut shrank it to
        // the every-turn core (~3.5k); the ceiling keeps the block from growing
        // back silently.
        expect(notes.length).toBeLessThanOrEqual(3_800);
        expect(descriptorBytes + Buffer.byteLength(notes, "utf8")).toBeLessThanOrEqual(33_200);
        expect(notes).toContain("never list the whole catalog");
        expect(notes).toContain("look them up by exact name");
        expect(notes).toContain("computer_launch_app");
        expect(notes).toContain("foreground_not_requested");
        // Unit-2/6 gate: the driver refusals real tasks hit must stay mapped to
        // their next step, or the agent retries blindly.
        expect(notes).toContain("same_pid_keyboard_ambiguity");
        expect(notes).toContain("element_outside_target_window");
        expect(notes).toContain("input_target_unavailable");
        expect(notes).toContain("repeated_unverified_action");
        // The hidden-launch choreography is deleted from the shared block.
        expect(notes).not.toContain("relaunch visible");
        expect(notes).not.toContain("unhide with computer_set_app_visibility");
        // Retired surface: the recording/replay names are gone from everywhere.
        expect(notes).not.toContain("computer_recording");
        expect(notes).not.toContain("computer_replay");
      }),
    ),
  );

  it.effect(
    "presents launch hidden as an explicit posture, not an invisible-workspace doctrine",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { byName } = yield* setup();
          const hidden = schemaPropertyDescription(byName, "computer_launch_app", "hidden");
          expect(hidden).toContain("Explicitly hide");
          expect(hidden).toContain("never authorizes foreground input");
          expect(hidden).not.toContain("Defaults to true");
          expect(hidden).not.toContain("agent launches stay invisible");
          expect(hidden).not.toContain("invisible workspace");
        }),
      ),
  );

  it.effect("attaches list-windows guidance to a null-window launch result", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // A launch that yields no window is where relaunch loops start: the
        // result itself must name the next step.
        const backend = new FakeComputerBackend();
        backend.launchApp = (app: string) =>
          Effect.succeed<ComputerLaunchAppResult>({
            computerId: backend.computerId,
            app,
            window: null,
          });
        const { call } = yield* setup(backend);
        const result = yield* call("computer_launch_app", {
          app: "Aside",
          wait_for_window: false,
        });
        expect(result.isError).not.toBe(true);
        const text = encodeJson(resultJson(result));
        expect(text).toContain("computer_list_windows");
        expect(text).toContain("never launch again");
        // The old relaunch-visible escape hatch is gone; the browser route is
        // the only alternative the result names.
        expect(text).not.toContain("relaunch visible");
        expect(text).toContain("computer_browser_prepare");
      }),
    ),
  );

  it.effect("returns the same no-relaunch guidance for batched launches", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = new FakeComputerBackend();
        backend.launchApp = (app: string) =>
          Effect.succeed<ComputerLaunchAppResult>({
            computerId: backend.computerId,
            app,
            window: null,
          });
        const { call } = yield* setup(backend);
        const result = yield* call("computer_run", {
          steps: [{ type: "launch_app", app: "Helium", wait_for_window: false }],
        });
        expect(result.isError).not.toBe(true);
        expect(encodeJson(resultJson(result))).toContain("never launch again automatically");
        expect(encodeJson(resultJson(result))).toContain("not_checked");
      }),
    ),
  );

  it.effect("stops a batch after a delivered launch with no usable window", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = new FakeComputerBackend();
        backend.launchApp = (app: string) =>
          Effect.succeed<ComputerLaunchAppResult>({
            computerId: backend.computerId,
            app,
            window: null,
            windowStatus: "no_usable_window",
            windowReason: "off_space",
          });
        const { call } = yield* setup(backend);
        const result = resultJson(
          yield* call("computer_run", {
            steps: [
              {
                type: "launch_app",
                app: "Helium",
                wait_for_window: false,
                continue_on_error: true,
              },
              { type: "press_key", key: "enter" },
            ],
          }),
        );
        expect(result).toMatchObject({
          stopped: true,
          stoppedReason: "no_usable_window",
          completed: 1,
        });
        expect(backend.callsFor("pressKey")).toHaveLength(0);
      }),
    ),
  );

  it.effect("leaves an off-screen launch result without unhide choreography", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // L23: a hidden launch is an ordinary off-screen workspace now, so the
        // result must not route the model into set_app_visibility or a visible
        // relaunch to make the app usable.
        const { call } = yield* setup();
        const result = yield* call("computer_launch_app", {
          app: "Helium",
          hidden: true,
          wait_for_window: false,
        });
        expect(result.isError).not.toBe(true);
        const text = encodeJson(resultJson(result));
        expect(text).not.toContain("unhide");
        expect(text).not.toContain("relaunch visible");
        expect(text).not.toContain("set_app_visibility");
      }),
    ),
  );

  it.effect("reserves model observation authority for explicit perception tools", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = new FakeComputerBackend();
        const observations: boolean[] = [];
        const getState = backend.getState.bind(backend);
        const capture = backend.captureScreenshot.bind(backend);
        backend.getState = (options) =>
          Effect.gen(function* () {
            observations.push(yield* isModelDesktopObservationActive);
            return yield* getState(options);
          });
        backend.captureScreenshot = (request) =>
          Effect.gen(function* () {
            observations.push(yield* isModelDesktopObservationActive);
            return yield* capture(request);
          });
        const { call } = yield* setup(backend);
        for (const [name, args] of [
          ["computer_get_state", { window_id: "fake-calculator" }],
          ["computer_screenshot", { window_id: "fake-calculator" }],
          [
            "computer_wait",
            {
              window_id: "fake-calculator",
              label: "Display",
              duration_ms: 0,
              include_screenshot: false,
            },
          ],
        ] as const) {
          observations.length = 0;
          expect((yield* call(name, args)).isError).not.toBe(true);
          expect(observations.length).toBeGreaterThan(0);
          expect(observations.every(Boolean)).toBe(true);
          expect(yield* isModelDesktopObservationActive).toBe(false);
        }
        observations.length = 0;
        expect(
          (yield* call("computer_set_value", { label: "Display", value: "468" })).isError,
        ).not.toBe(true);
        expect(observations.length).toBeGreaterThan(0);
        expect(observations.every((active) => !active)).toBe(true);
      }),
    ),
  );

  it.effect("describes exact targeting separately from foreground promotion", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { byName } = yield* setup();
        const notes = computerToolInstructions();
        expect(notes).toContain("Act by ref (or exact label plus role)");
        expect(windowIdDescription(byName, "computer_press_key")).toContain("does not activate it");
        expect(windowIdDescription(byName, "computer_click")).toContain(
          "Exact window for label or x/y targeting",
        );
      }),
    ),
  );

  it.effect("covers routine foreground delivery with the active task consent on macOS", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { byName } = yield* setup(new FakeComputerBackend({ agentDialect: "macos" }));
        const notes = computerToolInstructions();
        expect(notes).toContain("the user's visible-use request or direct confirmation");
        expect(notes).not.toContain("without bringing it to the front");
        expect(windowIdDescription(byName, "computer_click")).toContain(
          "Exact window for label or x/y targeting",
        );
        expect(windowIdDescription(byName, "computer_type_text")).toContain("does not activate it");
        // The activate tool no longer promises consent-covered foreground: the
        // user's own task text is the authorization, and the description says so.
        expect(byName.get("computer_activate_window")?.definition.description).toContain(
          "only when the user's own task text asked to see the screen",
        );
        expect(byName.get("computer_list_windows")?.definition.description).not.toContain(
          "into view automatically",
        );
        expect(byName.get("computer_get_state")?.definition.description).toContain(
          "primary display",
        );
        expect(windowIdDescription(byName, "computer_get_state")).toContain(
          "any requested screenshot",
        );
        const capture = byName.get("computer_screenshot")?.definition;
        expect(capture?.description).toContain("Rectangular region capture is unavailable");
        const captureSchema = capture?.inputSchema as {
          properties: Record<string, unknown>;
        };
        expect(Object.keys(captureSchema.properties).sort()).toEqual([
          "max_dimension",
          "window_id",
        ]);
      }),
    ),
  );

  it.effect("spells out all three delivery verdicts once, in the shared notes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // The three-way verdict lives in the injected block now — it was eleven
        // identical copies across the tool schemas — and each input tool carries
        // the short form: evidence, not retry permission.
        const { byName } = yield* setup();
        const notes = computerToolInstructions();
        expect(notes).toContain('"verified"');
        expect(notes).toContain('"dispatched-unknown"');
        expect(notes).toContain('"not-dispatched"');
        expect(notes).toContain("never replay it");
        for (const name of ["computer_type_text", "computer_press_key"]) {
          const description = byName.get(name)?.definition.description ?? "";
          expect(description).toContain("delivery.verified");
          expect(description).toContain("never replay an uncertain action");
        }
      }),
    ),
  );

  it.effect("carries the caller's name to the backend that draws the agent cursor", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // The tool layer is the only place that knows what a thread is called, and
        // the badge on the human's desktop is the only reason it has to say so.
        const names: Array<string | null> = [];
        const backend = Object.assign(new FakeComputerBackend(), {
          setDrivingAgent: (name: string | null) =>
            Effect.sync(() => {
              names.push(name);
            }),
        });
        const { call, see } = yield* setup(backend);
        const claude = ProviderDriverKind.make("claudeAgent");
        yield* see(THREAD, "Luna");

        yield* call("computer_click", { x: 4, y: 4 }, claude, THREAD, "Luna");
        expect(names).toEqual(["Luna"]);

        yield* call("computer_press_key", { key: "enter" }, claude, THREAD, "Luna");
        expect(names).toEqual(["Luna"]);
      }),
    ),
  );

  it.effect(
    "exposes the native batch fast path behind the computer capability, with 15 specialist tools hidden",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { byName, tools } = yield* setup();
          // 33 registered desktop tools: 18 advertised, including the batch fast
          // path, plus 15 specialists. The 7 recording/replay tools, the three click
          // variants and computer_hotkey are gone entirely — their behavior folded
          // into computer_click's count/button and computer_press_key's chord.
          expect(tools.map((tool) => tool.definition.name)).toEqual([
            "computer_spaces",
            "computer_list_windows",
            "computer_get_state",
            "computer_screenshot",
            "computer_get_screen_size",
            "computer_wait",
            "computer_read_clipboard",
            "computer_launch_app",
            "computer_list_apps",
            "computer_verify_state",
            "computer_zoom",
            "computer_get_accessibility_tree",
            "computer_get_cursor_position",
            "computer_inspect",
            "computer_help",
            "computer_set_window_frame",
            "computer_invoke_menu",
            "computer_kill_app",
            "computer_set_window_minimized",
            "computer_set_app_visibility",
            "computer_click",
            "computer_move_cursor",
            "computer_drag",
            "computer_scroll",
            "computer_type_text",
            "computer_press_key",
            "computer_write_clipboard",
            "computer_paste",
            "computer_activate_window",
            "computer_set_value",
            "computer_perform_action",
            "computer_select_text",
            "computer_run",
          ]);
          expect(
            tools.filter((tool) => tool.discoveryOnly !== true).map((tool) => tool.definition.name),
          ).toEqual([
            "computer_list_windows",
            "computer_get_state",
            "computer_screenshot",
            "computer_get_screen_size",
            "computer_wait",
            "computer_launch_app",
            "computer_list_apps",
            "computer_verify_state",
            "computer_inspect",
            "computer_help",
            "computer_click",
            "computer_scroll",
            "computer_type_text",
            "computer_press_key",
            "computer_paste",
            "computer_activate_window",
            "computer_set_value",
            "computer_run",
          ]);
          // Hidden mutations remain reachable through the advertised batch tool;
          // computer_help returns only the specific schema a model asks for.
          expect(
            tools.filter((tool) => tool.discoveryOnly === true).map((tool) => tool.definition.name),
          ).toEqual([
            "computer_spaces",
            "computer_read_clipboard",
            "computer_zoom",
            "computer_get_accessibility_tree",
            "computer_get_cursor_position",
            "computer_set_window_frame",
            "computer_invoke_menu",
            "computer_kill_app",
            "computer_set_window_minimized",
            "computer_set_app_visibility",
            "computer_move_cursor",
            "computer_drag",
            "computer_write_clipboard",
            "computer_perform_action",
            "computer_select_text",
          ]);
          // Pathway's capability is `computer`; Synara's was `computer:control`.
          expect(
            tools.every((tool) => tool.requiredCapability === COMPUTER_CONTROL_CAPABILITY),
          ).toBe(true);
          expect(tools.every((tool) => tool.requiresActiveTurn === true)).toBe(true);
          expect(COMPUTER_APPROVAL_REQUIRED_TOOLS).toEqual(
            new Set([
              "computer_read_clipboard",
              "computer_launch_app",
              "computer_click",
              "computer_move_cursor",
              "computer_drag",
              "computer_scroll",
              "computer_type_text",
              "computer_press_key",
              "computer_write_clipboard",
              "computer_set_value",
              "computer_perform_action",
              "computer_select_text",
              "computer_paste",
              "computer_run",
              "computer_activate_window",
              "computer_set_window_frame",
              "computer_invoke_menu",
              "computer_kill_app",
              "computer_set_window_minimized",
              "computer_set_app_visibility",
            ]),
          );
          // A hover posts no event, presses nothing, and no longer aims the keyboard,
          // so there is nothing for a human to approve and nothing destructive to
          // warn about. It was gated back when `move` still re-pointed the keyboard.
          expect(computerToolRequiresApproval("computer_move_cursor")).toBe(true);
          expect(
            (
              byName.get("computer_move_cursor")?.definition.annotations as
                | { destructiveHint?: boolean }
                | undefined
            )?.destructiveHint,
          ).toBe(false);
          // Waiting touches nothing at all.
          expect(computerToolRequiresApproval("computer_wait")).toBe(false);
          for (const name of COMPUTER_APPROVAL_REQUIRED_TOOLS) {
            expect(computerToolRequiresApproval(name)).toBe(true);
            expect(tools.some((tool) => tool.definition.name === name)).toBe(true);
          }
        }),
      ),
  );

  it.effect(
    "does not force provider preloading and keeps every computer tool capability-gated",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { tools, byName } = yield* setup();
          // Capability filtering controls exposure; vendor tool-search behavior varies.
          const preloaded = tools.filter(
            (tool) => tool.definition._meta?.["anthropic/alwaysLoad"] === true,
          );
          expect(preloaded).toEqual([]);
          // No `_meta` at all: no alwaysLoad marker, and no search hint (a hint would
          // replace the description a deferred tool advertises, and the shared
          // `computer` name segment already retrieves the whole set in one search).
          for (const tool of tools) {
            expect(tool.definition._meta).toBeUndefined();
          }
          // Deferring must not disturb what a tool already declares, nor its gate: the
          // whole family stays behind the computer capability and is present.
          expect(byName.get("computer_click")?.definition.annotations).toMatchObject({
            readOnlyHint: false,
          });
          expect(
            tools.every((tool) => tool.requiredCapability === COMPUTER_CONTROL_CAPABILITY),
          ).toBe(true);
        }),
      ),
  );

  it.effect(
    "filters discovery to the requested app without losing availability or choosing a window",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const backend = new FakeComputerBackend();
          const windows = yield* backend.listWindows();
          backend.emitWindowsChanged([
            ...windows,
            { ...windows[0]!, id: "same-app-second-window" },
          ]);
          const { call } = yield* setup(backend);
          const all = resultJson(yield* call("computer_list_windows", {})) as {
            windows: unknown[];
          };
          expect(all.windows).toHaveLength(windows.length + 1);
          const filtered = resultJson(
            yield* call("computer_list_windows", {
              app: windows[0]!.appName!.toUpperCase(),
            }),
          ) as { windows: { id: string }[]; availability: unknown };
          expect(filtered.windows.map((window) => window.id)).toEqual([
            windows[0]!.id,
            "same-app-second-window",
          ]);
          expect(filtered.availability).toBeDefined();
          expect(
            resultJson(yield* call("computer_list_windows", { app: "missing-app" })),
          ).toMatchObject({ windows: [] });
        }),
      ),
  );

  it.effect("refreshes Computer routing guidance per thread without repeating every call", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { call } = yield* setup();
        const guided: boolean[] = [];
        for (let index = 0; index < 11; index += 1) {
          const result = resultJson(yield* call("computer_list_windows", {})) as {
            toolGuidance?: string;
          };
          guided.push(result.toolGuidance?.includes("Computer routing reminder") === true);
        }
        expect(guided).toEqual([
          true,
          false,
          false,
          false,
          false,
          false,
          false,
          false,
          false,
          false,
          true,
        ]);
        expect(
          resultJson(yield* call("computer_list_windows", {}, undefined, "other-thread")),
        ).toMatchObject({
          toolGuidance: expect.stringContaining("Computer routing reminder"),
        });
      }),
    ),
  );

  it.effect("returns perception payloads and preserves screenshot image content", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { call } = yield* setup();
        const list = yield* call("computer_list_windows", {});
        expect(list.isError).not.toBe(true);
        const state = yield* call("computer_get_state", {
          include_screenshot: true,
          include_text: true,
        });
        expect(state.content.map((entry) => entry.type)).toEqual(["text", "image"]);
        expect(state.content.find((entry) => entry.type === "image")).toMatchObject({
          mimeType: "image/png",
        });
        // The id is how the model names this picture later; the size is the space
        // its coordinates are in. Region and scale still travel for the pane and
        // for debugging, but the model is never asked to do arithmetic with them.
        const text = state.content.find((entry) => entry.type === "text");
        if (text?.type === "text") expect(text.text).toBe(encodeJson(decodeJson(text.text)));
        expect(textJson(state)).toMatchObject({
          screenshot: {
            screenshotId: "shot-1",
            // The 1920x1080 workspace comes back downscaled: no image handed to a
            // model may exceed the vision-API resize threshold, or the model reads
            // coordinates off a picture the server never produced.
            width: 1_536,
            height: 864,
            region: { x: 0, y: 0, width: 1_920, height: 1_080 },
            scale: 0.8,
          },
        });
      }),
    ),
  );

  /**
   * The elements digest is the parity lever with macOS visual understanding:
   * without it the model's only grounding is pixel estimation from a
   * downscaled screenshot, which is how forms turned into scroll-hunting.
   */
  it.effect("lists actionable elements on every get_state without needing include_text", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { call } = yield* setup();
        const state = yield* call("computer_get_state", {});
        const payload = resultJson(state) as {
          elements: { role: string; label: string; windowId?: string | null }[];
          elementWindowId?: string;
          text?: string;
        };

        expect(Array.isArray(payload.elements)).toBe(true);
        const roles = payload.elements.map((element: { role: string }) => element.role);
        expect(roles).toContain("button"); // Calculate
        expect(roles).toContain("text-field"); // Display
        for (const element of payload.elements) {
          expect(typeof element.label).toBe("string");
          expect(element.label.length).toBeGreaterThan(0);
          // The fixture's elements are all in one window, so the id is hoisted
          // onto the listing instead of repeating on every entry.
          expect(element.windowId).toBeUndefined();
        }
        expect(payload.elementWindowId).toBe("fake-calculator");
        // The full text rendering stays opt-in; the digest always rides.
        expect(payload.text).toBeUndefined();

        const withText = yield* call("computer_get_state", { include_text: true });
        const textPayload = resultJson(withText) as { text?: string };
        expect(textPayload.text).toEqual(expect.stringContaining("button"));
      }),
    ),
  );

  it.effect("reports an elements digest that omits nothing silently when truncated", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const bigTree = {
          role: "desktop" as const,
          label: null,
          value: null,
          description: null,
          frame: { x: 0, y: 0, width: 1_920, height: 1_080 },
          activationPoint: null,
          onScreen: true,
          windowId: null,
          children: Array.from({ length: 90 }, (_unused, index) => ({
            role: "push button" as const,
            label: `Button ${index}`,
            value: null,
            description: null,
            frame: { x: 0, y: 0, width: 80, height: 30 },
            activationPoint: null,
            onScreen: true,
            windowId: "w1",
            children: [],
          })),
        };
        const { call } = yield* setup(new FakeComputerBackend({ root: bigTree }));

        const payload = resultJson(yield* call("computer_get_state", {})) as {
          elements: { windowId?: string }[];
          elementWindowId?: string;
          elementsTruncated?: boolean;
        };
        expect(payload.elements).toHaveLength(60);
        expect(payload.elementsTruncated).toBe(true);
        // One window: its id is hoisted once instead of riding all 60 entries.
        expect(payload.elementWindowId).toBe("w1");
        expect(payload.elements.every((element) => element.windowId === undefined)).toBe(true);
      }),
    ),
  );

  it.effect("names label_contains when a truncated tree misses the label", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const base = new FakeComputerBackend();
        const state = yield* base.getState({ includeTree: true });
        const truncatedRoot = { ...state.root!, truncated: true as const };
        const { call } = yield* setup(new FakeComputerBackend({ root: truncatedRoot }));
        const result = yield* call("computer_click", { label: "Missing control" });
        expect(result.isError).toBe(true);
        const text = result.content.find((entry) => entry.type === "text");
        expect(text?.type === "text" ? text.text : "").toContain("label_contains");
      }),
    ),
  );

  it.effect("tells the model to point in screenshot pixels and never to convert them", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { byName } = yield* setup();
        // Both perception tools spell the same contract out, so the model carries
        // one skill from the workspace shot to the zoomed one.
        for (const name of ["computer_get_state", "computer_screenshot"]) {
          const description = byName.get(name)?.definition.description ?? "";
          expect(description).toContain("screenshotId");
          expect(description).toContain("pass x/y as pixel coordinates in that image");
          expect(description).not.toContain("region.x");
        }
        // Each pointer tool carries the coordinate rule self-contained now — the
        // compact injected block no longer spends a paragraph on it.
        for (const name of [
          "computer_click",
          "computer_move_cursor",
          "computer_drag",
          "computer_scroll",
        ]) {
          const description = byName.get(name)?.definition.description ?? "";
          expect(description).toContain("never desktop coordinates");
          expect(description).not.toContain("global desktop coordinates");
          // The optional id lives beside x/y on every pointer tool.
          expect(encodeJson(byName.get(name)?.definition.inputSchema)).toContain("screenshot_id");
        }
        expect(byName.get("computer_get_screen_size")?.definition.description).toContain(
          "Informational only",
        );
      }),
    ),
  );

  it.effect("tells the model the cursor is overlay-only and no background hover exists", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { byName } = yield* setup();
        // Probing showed pid-routed synthetic mouseMoved posts only reach an AppKit
        // window while the user's real cursor is inside it, so move_cursor cannot
        // become a hover delivery path. The description must keep denying that
        // effect plainly.
        const description = byName.get("computer_move_cursor")?.definition.description ?? "";
        expect(description).toContain("does not deliver hover events");
        expect(description).toContain("a real background hover is not available on this backend");
        expect(description).toContain("real system pointer never moves");
      }),
    ),
  );

  it.effect("tells the model how to click a window another window covers", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { byName } = yield* setup();
        const list = byName.get("computer_list_windows")?.definition.description ?? "";
        expect(list).toContain("stackingIndex");
        expect(list).toContain("occludedBy");
        expect(list).toContain("window_id");

        // Every pointer tool takes the same target shape, so the escape hatch has
        // to be described on the shared property rather than in one tool.
        for (const name of ["computer_click", "computer_move_cursor", "computer_drag"]) {
          const schema = encodeJson(byName.get(name)?.definition.inputSchema ?? {});
          expect(schema).toContain("Exact window for label or x/y targeting");
        }
      }),
    ),
  );

  it.effect("keeps a window-scoped state capture bound to its native target", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = new FakeComputerBackend();
        const originalState = backend.getState.bind(backend);
        backend.getState = (options) =>
          Effect.gen(function* () {
            const state = yield* originalState(options);
            const screenshot = yield* backend.captureScreenshot({
              kind: "window",
              windowId: "fake-calculator",
            });
            return { ...state, screenshot: { ...screenshot, windowId: "fake-calculator" } };
          });
        const { call } = yield* setup(backend);
        const observed = yield* call("computer_get_state", {
          window_id: "fake-calculator",
          include_screenshot: true,
        });
        expect(resultJson(observed)).toMatchObject({
          screenshot: { windowId: "fake-calculator" },
        });
        const mismatched = yield* call("computer_click", {
          window_id: "fake-editor",
          x: 5,
          y: 5,
          include_screenshot: false,
        });
        expect(mismatched.isError).toBe(true);
        expect(backend.callsFor("click")).toHaveLength(0);
        const clicked = yield* call("computer_click", {
          x: 5,
          y: 5,
          include_screenshot: false,
        });
        expect(clicked.isError).not.toBe(true);
        expect(backend.callsFor("click").at(-1)?.args[0]).toEqual({
          x: 1_055,
          y: 125,
        });
      }),
    ),
  );

  it.effect("zooms into a window and reads the next coordinates in that window's pixels", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { backend, call, see } = yield* setup();
        const result = yield* call("computer_screenshot", {
          window_id: "fake-calculator",
        });

        expect(result.isError).not.toBe(true);
        expect(result.content.map((entry) => entry.type)).toEqual(["text", "image"]);
        expect(result.content.find((entry) => entry.type === "image")).toMatchObject({
          mimeType: "image/png",
        });
        // The calculator window sits at (1050, 120) and is 420x620 logical pixels,
        // which fits the default budget, so the capture is not downscaled.
        expect(textJson(result)).toMatchObject({
          screenshot: {
            screenshotId: "shot-1",
            windowId: "fake-calculator",
            mimeType: "image/png",
            width: 420,
            height: 620,
            region: { x: 1_050, y: 120, width: 420, height: 620 },
            scale: 1,
          },
        });
        expect(backend.callsFor("captureScreenshot").at(-1)?.args[0]).toEqual({
          kind: "window",
          windowId: "fake-calculator",
        });

        // Pixel (5, 5) of that picture is the calculator's top-left corner plus
        // five: the server adds the window offset, the model never does. (The
        // clicks here skip their observation so the zoom stays the frame; an
        // observation would become the next frame, as the observation test pins.)
        yield* call("computer_click", { x: 5, y: 5, include_screenshot: false });
        expect(backend.callsFor("click").at(-1)?.args[0]).toEqual({
          x: 1_055,
          y: 125,
        });

        // A point past the picture's edge is refused rather than landing on
        // whatever the desktop has next to the window.
        const outside = yield* call("computer_click", {
          x: 500,
          y: 10,
          include_screenshot: false,
        });
        expect(outside.isError).toBe(true);
        expect(resultJson(outside)).toMatchObject({
          error: {
            code: "computer_target_offscreen",
            message: expect.stringContaining("420x620 screenshot shot-1"),
          },
        });
        expect(backend.callsFor("click")).toHaveLength(1);

        // Naming an earlier screenshot reads the coordinates in that one instead.
        const workspace = yield* see();
        expect(workspace.screenshotId).toBe("shot-2");
        yield* call("computer_click", {
          x: 5,
          y: 5,
          screenshot_id: "shot-1",
          include_screenshot: false,
        });
        expect(backend.callsFor("click").at(-1)?.args[0]).toEqual({
          x: 1_055,
          y: 125,
        });
        // Use a different point so the generic uncertain-action loop guard does
        // not preempt this coordinate-frame assertion.
        yield* call("computer_click", { x: 8, y: 8, include_screenshot: false });
        // Back in the workspace frame: eight screenshot pixels cover ten desktop points.
        expect(backend.callsFor("click").at(-1)?.args[0]).toEqual({ x: 10, y: 10 });

        // An id this conversation was never given is refused, naming the ones it
        // has. Fresh coordinates keep the repeat guard — which strips
        // screenshot_id from its key — from preempting the frame lookup.
        const unknown = yield* call("computer_click", {
          x: 7,
          y: 9,
          screenshot_id: "shot-9",
        });
        expect(resultJson(unknown)).toMatchObject({
          error: {
            code: "computer_target_not_found",
            message: expect.stringContaining("shot-1, shot-2"),
          },
        });
      }),
    ),
  );

  it.effect("refuses to point before the conversation has seen a screenshot", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { backend, call } = yield* setup();

        const blind = yield* call("computer_click", { x: 4, y: 4 });
        expect(blind.isError).toBe(true);
        expect(resultJson(blind)).toMatchObject({
          error: {
            code: "computer_target_invalid",
            message: expect.stringContaining("computer_screenshot"),
          },
        });
        // A scroll distance is in screenshot pixels too, so it needs a frame even
        // without a point.
        const scroll = yield* call("computer_scroll", { delta_x: 0, delta_y: 100 });
        expect(scroll.isError).toBe(true);
        expect(backend.callsFor("click")).toHaveLength(0);
        expect(backend.callsFor("scroll")).toHaveLength(0);

        // A label needs no picture: it is resolved from the accessibility tree.
        const byLabel = yield* call("computer_click", {
          label: "Calculate",
          role: "button",
        });
        expect(byLabel.isError).not.toBe(true);
        expect(backend.callsFor("click")).toHaveLength(1);
      }),
    ),
  );

  it.effect("keeps each conversation's screenshots apart", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { call, see } = yield* setup();
        yield* see("thread-a");

        // Thread B never looked, so thread A's picture is not its frame.
        const blind = yield* call("computer_click", { x: 1, y: 1 }, undefined, "thread-b");
        expect(resultJson(blind)).toMatchObject({
          error: { code: "computer_target_invalid" },
        });
      }),
    ),
  );

  it.effect("zooms into a region and maps points and scroll distances through its scale", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { backend, call, see } = yield* setup();
        yield* see();
        // The rect is in the workspace screenshot's pixels, and that picture is the
        // 1920-wide desktop downscaled to 1536, so each of its pixels is 1.25
        // desktop points: this asks for the desktop rect (1050, 120) 400x800.
        const result = yield* call("computer_screenshot", {
          x: 840,
          y: 96,
          width: 320,
          height: 640,
          max_dimension: 400,
        });

        expect(result.isError).not.toBe(true);
        const payload = textJson(result) as Record<string, unknown>;
        // 800 logical pixels squeezed into 400 screenshot pixels halves the scale,
        // so screenshot pixel (100, 100) is desktop point (1250, 320).
        expect(payload).toMatchObject({
          screenshot: {
            width: 200,
            height: 400,
            region: { x: 1_050, y: 120, width: 400, height: 800 },
            scale: 0.5,
          },
        });
        expect(payload.windowId).toBeUndefined();
        expect(backend.callsFor("captureScreenshot").at(-1)?.args[0]).toEqual({
          kind: "region",
          region: { x: 1_050, y: 120, width: 400, height: 800 },
          maxDimension: 400,
        });

        // The server owns the arithmetic the model used to be asked for. (Each
        // action skips its observation so the zoom stays the frame under test.)
        const skip = { include_screenshot: false };
        yield* call("computer_click", { x: 100, y: 100, ...skip });
        expect(backend.callsFor("click").at(-1)?.args[0]).toEqual({
          x: 1_250,
          y: 320,
        });
        // A scroll distance is in the same pixels as the point, so 40 pixels of a
        // half-scale picture is 80 pixels of content.
        yield* call("computer_scroll", {
          x: 100,
          y: 100,
          delta_x: 0,
          delta_y: 40,
          ...skip,
        });
        expect(backend.callsFor("scroll").at(-1)?.args).toEqual([{ x: 1_250, y: 320 }, 0, 80]);
        yield* call("computer_drag", {
          from: { x: 0, y: 0 },
          to: { x: 100, y: 100 },
          ...skip,
        });
        expect(backend.callsFor("drag").at(-1)?.args.slice(0, 2)).toEqual([
          { x: 1_050, y: 120 },
          { x: 1_250, y: 320 },
        ]);
        // Zooming again is measured in the zoomed picture, and clipped to it.
        yield* call("computer_screenshot", {
          x: 100,
          y: 300,
          width: 200,
          height: 200,
        });
        expect(backend.callsFor("captureScreenshot").at(-1)?.args[0]).toEqual({
          kind: "region",
          region: { x: 1_250, y: 720, width: 200, height: 200 },
        });
      }),
    ),
  );

  it.effect("refuses an ambiguous or incomplete screenshot request without capturing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { backend, call } = yield* setup();

        const both = yield* call("computer_screenshot", {
          window_id: "fake-calculator",
          x: 0,
        });
        expect(both.isError).toBe(true);
        expect(both.content[0]).toMatchObject({
          text: expect.stringContaining("never both"),
        });

        const partial = yield* call("computer_screenshot", {
          x: 10,
          y: 20,
          width: 30,
        });
        expect(partial.isError).toBe(true);
        expect(partial.content[0]).toMatchObject({
          text: expect.stringContaining("height"),
        });

        const empty = yield* call("computer_screenshot", {
          x: 10,
          y: 20,
          width: 0,
          height: 30,
        });
        expect(empty.isError).toBe(true);
        expect(empty.content[0]).toMatchObject({
          text: expect.stringContaining("greater than zero"),
        });

        expect(backend.callsFor("captureScreenshot")).toHaveLength(0);
      }),
    ),
  );

  it.effect("captures the focused window when called without a target", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { backend, call } = yield* setup();
        const result = yield* call("computer_screenshot", {});

        expect(result.isError).not.toBe(true);
        expect(result.content.map((entry) => entry.type)).toEqual(["text", "image"]);
        // The fake terminal is the focused window, so an untargeted zoom lands on
        // it and says so, mapping the same way an explicit window capture does.
        expect(textJson(result)).toMatchObject({
          screenshot: {
            screenshotId: "shot-1",
            windowId: "fake-terminal",
            region: { x: 40, y: 40, width: 960, height: 720 },
          },
        });
        expect(backend.callsFor("captureScreenshot").at(-1)?.args[0]).toEqual({
          kind: "window",
          windowId: "fake-terminal",
        });
      }),
    ),
  );

  it.effect("surfaces a compositor capture failure as a readable error result", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { backend, call } = yield* setup();
        backend.failNext(
          "captureScreenshot",
          new ComputerBackendError({
            message: "org.pathway.ComputerUse.Error.CaptureFailed: window not visible",
          }),
        );

        const result = yield* call("computer_screenshot", {
          window_id: "fake-calculator",
        });
        expect(result.isError).toBe(true);
        expect(result.content[0]).toMatchObject({
          text: expect.stringContaining("window not visible"),
        });
      }),
    ),
  );

  it.effect("keeps the zoom tool read-only and free of an approval gate", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // No `authorizeAction`: nobody can answer an approval, so this caller has
        // no approval gate at all, and a read-only tool must still run.
        const { backend, byName, call } = yield* setup();
        expect(computerToolRequiresApproval("computer_screenshot")).toBe(false);
        expect(byName.get("computer_screenshot")?.definition.annotations).toMatchObject({
          readOnlyHint: true,
        });
        const result = yield* call(
          "computer_screenshot",
          { window_id: "fake-calculator" },
          ProviderDriverKind.make("opencode"),
        );
        expect(result.isError).not.toBe(true);
        expect(backend.callsFor("captureScreenshot")).toHaveLength(1);
      }),
    ),
  );

  it.effect("passes a clamped pointer landing point back to the caller", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = new FakeComputerBackend();
        backend.click = (point) =>
          Effect.succeed({
            point,
            clampedTo: { x: point.x, y: 1_080 },
          });
        const { call, see } = yield* setup(backend);
        yield* see();

        // Screenshot pixel 44 of the downscaled workspace frame is desktop point 55.
        const result = yield* call("computer_click", { x: 44, y: 44 });
        expect(result.isError).not.toBe(true);
        expect(textJson(result)).toMatchObject({
          point: { x: 55, y: 55 },
          clampedTo: { x: 55, y: 1_080 },
        });
      }),
    ),
  );

  it.effect("attaches a post-action screenshot of the focused window to action results", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { backend, call, see } = yield* setup();
        yield* see();
        const result = yield* call("computer_click", { x: 100, y: 100 });

        expect(result.isError).not.toBe(true);
        expect(result.content.map((entry) => entry.type)).toEqual(["text", "image"]);
        // A bare coordinate names no window, so the capture goes to the window the
        // compositor routed the click to — the topmost one at the point — and the
        // metadata says which window the pixels cover. (An untargeted action also
        // clears the pinned focus, so the focused-window fallback cannot answer
        // here; the action point is what identifies the window.)
        expect(textJson(result)).toMatchObject({
          action: "computer_click",
          point: { x: 125, y: 125 },
          screenshot: {
            screenshotId: "shot-2",
            windowId: "fake-terminal",
            region: { x: 40, y: 40, width: 960, height: 720 },
            scale: 1,
          },
        });
        expect(backend.callsFor("captureScreenshot").at(-1)?.args[0]).toEqual({
          kind: "window",
          windowId: "fake-terminal",
          // Action observations spend a smaller pixel budget than perception ones.
          maxDimension: COMPUTER_ACTION_OBSERVATION_MAX_DIMENSION,
        });

        // The observation is the picture the model reads next, so it is also the
        // one its next coordinates are in: (5, 5) of the terminal is desktop (45, 45).
        yield* call("computer_click", { x: 5, y: 5 });
        expect(backend.callsFor("click").at(-1)?.args[0]).toEqual({ x: 45, y: 45 });
        // The identical capture comes back as screenshotUnchanged, and the model is
        // told to keep reading the previous picture — so that stays the frame.
        const repeat = yield* call("computer_click", { x: 5, y: 5 });
        expect(resultJson(repeat)).toMatchObject({ screenshotUnchanged: true });
        yield* call("computer_click", { x: 6, y: 6 });
        expect(backend.callsFor("click").at(-1)?.args[0]).toEqual({ x: 46, y: 46 });
      }),
    ),
  );

  it.effect("captures the window a scoped action named rather than the focused one", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { backend, call, see } = yield* setup();
        yield* see();
        const result = yield* call("computer_click", {
          x: 1_100,
          y: 200,
          window_id: "fake-calculator",
        });

        expect(result.isError).not.toBe(true);
        expect(backend.callsFor("captureScreenshot").at(-1)?.args[0]).toEqual({
          kind: "window",
          windowId: "fake-calculator",
          // Action observations spend a smaller pixel budget than perception ones.
          maxDimension: COMPUTER_ACTION_OBSERVATION_MAX_DIMENSION,
        });
      }),
    ),
  );

  it.effect("reports a closed target instead of photographing another window", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = new FakeComputerBackend();
        const originalClick = backend.click.bind(backend);
        backend.click = (target, windowId, modifiers) =>
          Effect.gen(function* () {
            const result = yield* originalClick(target, windowId, modifiers);
            // The click closed every window: by observation time the target is gone,
            // and the one thing the result must not contain is a screenshot of
            // whatever window remains focused — on a live desktop, the human's.
            backend.emitWindowsChanged([]);
            return result;
          });
        const { call, see } = yield* setup(backend);
        yield* see();

        const result = yield* call("computer_click", {
          x: 1_100,
          y: 200,
          window_id: "fake-calculator",
        });
        expect(result.isError).not.toBe(true);
        expect(result.content.map((entry) => entry.type)).toEqual(["text"]);
        expect(textJson(result)).toMatchObject({
          action: "computer_click",
          targetWindowClosed: true,
        });
      }),
    ),
  );

  it.effect("skips the post-action screenshot when the model opts out", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { backend, call } = yield* setup();
        const result = yield* call("computer_type_text", {
          text: "hi",
          include_screenshot: false,
        });

        expect(result.isError).not.toBe(true);
        expect(result.content.map((entry) => entry.type)).toEqual(["text"]);
        expect(backend.callsFor("captureScreenshot")).toHaveLength(0);
      }),
    ),
  );

  it.effect("focuses a named window before keyboard input and zooms the result to it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { backend, call } = yield* setup();

        const hotkey = yield* call("computer_press_key", {
          key: "ctrl+t",
          window_id: "fake-calculator",
        });
        expect(hotkey.isError).not.toBe(true);
        expect(backend.callsFor("raiseWindow").at(-1)?.args).toEqual(["fake-calculator"]);
        expect(backend.callsFor("focusWindow").at(-1)?.args).toEqual(["fake-calculator"]);
        expect(resultJson(hotkey)).toMatchObject({ windowId: "fake-calculator" });
        // The screenshot follows the keys, so the model sees the window it typed
        // into rather than whatever happened to be focused.
        expect(backend.callsFor("captureScreenshot").at(-1)?.args[0]).toEqual({
          kind: "window",
          windowId: "fake-calculator",
          // Action observations spend a smaller pixel budget than perception ones.
          maxDimension: COMPUTER_ACTION_OBSERVATION_MAX_DIMENSION,
        });

        // The camel-case spelling works here for the same reason it does on targets.
        const typed = yield* call("computer_type_text", {
          text: "hi",
          windowId: "fake-terminal",
        });
        expect(typed.isError).not.toBe(true);
        expect(backend.callsFor("focusWindow").at(-1)?.args).toEqual(["fake-terminal"]);
        expect(backend.callsFor("typeText").at(-1)?.args).toEqual(["hi"]);

        const pressed = yield* call("computer_press_key", {
          key: "enter",
          window_id: "gone",
        });
        expect(pressed.isError).toBe(true);
        expect(resultJson(pressed)).toMatchObject({
          error: { code: "computer_target_not_found" },
        });
        expect(backend.callsFor("pressKey")).toHaveLength(0);
      }),
    ),
  );

  it.effect("uses exact semantic text input without focusing the target window", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = Object.assign(new FakeComputerBackend(), {
          focusNeutralSemanticText: true,
        });
        const { call, manager } = yield* setup(backend);
        const semanticText = vi.spyOn(manager, "typeTextAt");
        const typed = yield* call("computer_type_text", {
          text: "42",
          label: "Display",
          role: "text-field",
          window_id: "fake-calculator",
          include_screenshot: false,
        });

        expect(typed.isError).not.toBe(true);
        expect(semanticText).toHaveBeenCalledWith(
          THREAD,
          "42",
          expect.objectContaining({
            label: "Display",
            role: "text-field",
            windowId: "fake-calculator",
          }),
        );
        expect(backend.callsFor("focusWindow")).toHaveLength(0);
        expect(backend.callsFor("raiseWindow")).toHaveLength(0);
        expect(backend.callsFor("typeText").at(-1)?.args[0]).toBe("42");
      }),
    ),
  );

  it.effect("uses the sole writable control for exact-window text without a label", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = Object.assign(new FakeComputerBackend(), {
          focusNeutralSemanticText: true,
        });
        const { call, manager } = yield* setup(backend);
        const semanticText = vi.spyOn(manager, "typeTextAt");
        const typed = yield* call("computer_type_text", {
          text: "42",
          window_id: "fake-calculator",
          include_screenshot: false,
        });

        expect(typed.isError).not.toBe(true);
        expect(semanticText).toHaveBeenCalledWith(THREAD, "42", {
          windowId: "fake-calculator",
        });
        expect(backend.callsFor("focusWindow")).toHaveLength(0);
        expect(backend.callsFor("raiseWindow")).toHaveLength(0);
      }),
    ),
  );

  it.effect(
    "zooms the post-action screenshot to the window under an untargeted action's point",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { backend, call, see } = yield* setup();
          yield* see();

          // The regression this pins: an untargeted scroll used to come back with a
          // workspace-wide downscale too small to read, and the model scroll-hunted
          // blind. The window under the scroll's own coordinates is the picture.
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
            screenshot: { windowId: "fake-calculator" },
          });
          expect(backend.callsFor("captureScreenshot").at(-1)?.args[0]).toEqual({
            kind: "window",
            windowId: "fake-calculator",
            maxDimension: COMPUTER_ACTION_OBSERVATION_MAX_DIMENSION,
          });
        }),
      ),
  );

  it.effect("tells the model where keyboard input lands and when not to skip a screenshot", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { byName } = yield* setup();
        for (const name of ["computer_type_text", "computer_press_key", "computer_paste"]) {
          const tool = byName.get(name);
          expect(tool?.definition.description).toContain(
            "Pass window_id or use the last aimed window",
          );
          expect(encodeJson(tool?.definition.inputSchema)).toContain("window_id");
        }
        // A final text observation can replace an image when it verifies the result.
        const schema = encodeJson(byName.get("computer_click")?.definition.inputSchema);
        expect(schema).toContain("verify with fresh state or a final screenshot");
      }),
    ),
  );
});
