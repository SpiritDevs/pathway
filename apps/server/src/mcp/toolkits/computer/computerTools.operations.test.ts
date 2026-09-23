/**
 * Ported from Synara's `agentGateway/computerTools.test.ts`: setup prompts,
 * screenshot delivery, operation ordering, the wait/scroll/observation cases,
 * the never-raise gate, activate restore, `computer_inspect`, `computer_run`
 * and `computer_paste`.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it, vi } from "@effect/vitest";
import {
  ProviderDriverKind,
  type ComputerAvailability,
  type ComputerPermission,
} from "@spiritdevs/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import type { ComputerApprovalOutcome } from "../../../computer/ComputerApprovalGate.ts";
import { ComputerManager } from "../../../computer/ComputerManager.ts";
import {
  ComputerBackendError,
  ComputerTargetError,
  type ComputerOperationError,
} from "../../../computer/computerErrors.ts";
import { desktopDeliveryMode } from "../../../computer/DesktopOperationQueue.ts";
import { FakeComputerBackend } from "../../../computer/FakeComputerBackend.ts";
import { isModelDesktopObservationActive } from "../../../computer/modelDesktopObservation.ts";
import { makeComputerBrowserTools } from "./computerBrowserTools.ts";
import {
  computerToolInstructions,
  makeComputerTools,
  type ComputerToolsOptions,
} from "./computerTools.ts";
import {
  ComputerToolError,
  type ComputerAuthorizeAction,
  type McpToolCallResult,
  type ToolContext,
  type ToolEntry,
} from "./toolRuntime.ts";

const THREAD = "thread-computer";

const PATHWAY_PROVIDERS = ["codex", "claudeAgent", "cursor", "grok", "opencode"] as const;
type PathwayProvider = (typeof PATHWAY_PROVIDERS)[number];

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

function resultJson(result: McpToolCallResult): unknown {
  const text = result.content.find((entry) => entry.type === "text");
  return text?.type === "text" ? decodeJson(text.text) : undefined;
}

function makeContext(
  provider: PathwayProvider = "claudeAgent",
  threadId = THREAD,
  label: string | null = null,
): ToolContext {
  return {
    callerThreadId: threadId,
    callerThreadLabel: label,
    callerSessionKey: "mcp-session:computer",
    callerProvider: ProviderDriverKind.make(provider),
    callerCapabilities: new Set(["computer"]),
    callerTurnId: "turn-computer",
    assertCallerTurnActive: () => Effect.void,
    jsonRpcRequestId: 1,
  };
}

const turnEnded = () =>
  Effect.fail(
    new ComputerToolError({
      code: "caller_turn_inactive",
      message: "The requesting turn ended.",
    }),
  );

const approved = (outcome: ComputerApprovalOutcome = "approved") => Effect.succeed(outcome);

/**
 * The never-raise authorization resolver. Defaults to the user having asked to
 * see the screen: these suites exercise the raise/foreground mechanics, and
 * the gate itself has dedicated tests that pass an explicit refusal.
 */
const visibleUseRequested: NonNullable<
  ComputerToolsOptions["resolveForegroundAuthorization"]
> = () => Effect.succeed({ userRequestedVisibleUse: true });

/**
 * Runs a call whose manager path sleeps (the paste restore, a wait poll) by
 * advancing the test clock until it completes, where Synara slept for real.
 */
const drive = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(effect, { startImmediately: true });
    while (fiber.pollUnsafe() === undefined) yield* TestClock.adjust(50);
    return yield* Fiber.join(fiber);
  });

/** Lets forked calls run up to their next real suspension. */
const yieldTurns = Effect.yieldNow.pipe(Effect.repeat({ times: 20 }));

const setup = Effect.fn(function* (
  backend: FakeComputerBackend = new FakeComputerBackend(),
  authorizeAction?: ComputerAuthorizeAction,
  resolveForegroundAuthorization: NonNullable<
    ComputerToolsOptions["resolveForegroundAuthorization"]
  > = visibleUseRequested,
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
    provider?: PathwayProvider,
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
  const see = Effect.fn(function* (threadId = THREAD, label: string | null = null) {
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

it.layer(NodeServices.layer)("Pathway computer setup prompts", (it) => {
  /** One tool call against a backend whose window read fails the given way. */
  const readFailingWith = Effect.fn(function* (error: unknown) {
    const backend = Object.assign(new FakeComputerBackend(), {
      // Deliberately untyped failures ride the backend's error channel, the
      // way a rejected promise did in Synara.
      listWindows: () => Effect.fail(error as ComputerOperationError),
    });
    const manager = yield* ComputerManager.make({ backend, actionSettleMs: 0 });
    const setupPrompts: string[] = [];
    const tools = makeComputerTools({
      manager,
      onSetupRequired: ({ toolName }) => Effect.sync(() => void setupPrompts.push(toolName)),
    });
    const tool = tools.find((entry) => entry.definition.name === "computer_list_windows")!;
    const result = yield* tool.handler({}, makeContext());
    return { result, setupPrompts };
  });

  it.effect("prompts for setup when the desktop withheld an OS permission", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { result, setupPrompts } = yield* readFailingWith(
          new ComputerBackendError({
            message: "Screen Recording is not granted.",
            setupRequired: true,
          }),
        );
        expect(result.isError).toBe(true);
        expect(setupPrompts).toEqual(["computer_list_windows"]);
      }),
    ),
  );

  it.effect("prompts for setup when the permission failure arrived wrapped", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const wrapped = new Error("the desktop refused", {
          cause: new ComputerBackendError({
            message: "Accessibility is not granted.",
            setupRequired: true,
          }),
        });
        const { setupPrompts } = yield* readFailingWith(wrapped);
        expect(setupPrompts).toEqual(["computer_list_windows"]);
      }),
    ),
  );

  it.effect.each([
    [
      "a target that is no longer there",
      new ComputerTargetError({
        code: "computer_target_not_found",
        message: "No control matches that label.",
      }),
    ],
    [
      "an ordinary backend fault",
      new ComputerBackendError({ message: "The click was not delivered." }),
    ],
    ["an unrelated failure", new Error("boom")],
  ] as const)("does not prompt for setup after %s", ([_name, error]) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { result, setupPrompts } = yield* readFailingWith(error);
        expect(result.isError).toBe(true);
        expect(setupPrompts).toEqual([]);
      }),
    ),
  );

  /** One `computer_list_windows` against a backend that succeeds but is blocked. */
  const readWith = Effect.fn(function* (overrides: Partial<FakeComputerBackend>) {
    const backend = Object.assign(new FakeComputerBackend(), overrides);
    const manager = yield* ComputerManager.make({ backend, actionSettleMs: 0 });
    const prompts: {
      toolName: string;
      missing: readonly string[];
      buildSignature?: string;
    }[] = [];
    const tools = makeComputerTools({
      manager,
      onSetupRequired: ({ toolName, missing, buildSignature }) =>
        Effect.sync(
          () =>
            void prompts.push({
              toolName,
              missing,
              ...(buildSignature ? { buildSignature } : {}),
            }),
        ),
    });
    const tool = tools.find((entry) => entry.definition.name === "computer_list_windows")!;
    const result = yield* tool.handler({}, makeContext());
    const part = result.content.find((entry) => entry.type === "text");
    const text = part?.type === "text" ? part.text : "";
    return { result, prompts, text };
  });

  it.effect("prompts for setup when a successful result reports a permission state", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // The shape that slipped through before this funnel: the call succeeded, the
        // payload said "Pathway needs Accessibility", and nothing put a card on
        // screen — so the model explained macOS privacy in prose instead.
        const { result, prompts, text } = yield* readWith({
          availability: () =>
            Effect.succeed<ComputerAvailability>({
              kind: "permission-required",
              missing: ["accessibility"],
              message: "Pathway needs Accessibility to control this Mac. Turn Pathway on in…",
              buildSignature: "signed",
            }),
          missingPermissions: () =>
            Effect.succeed<readonly ComputerPermission[]>(["accessibility"]),
        });

        expect(result.isError).not.toBe(true);
        expect(prompts).toEqual([
          {
            toolName: "computer_list_windows",
            missing: ["accessibility"],
            buildSignature: "signed",
          },
        ]);
        // The model is told a setup card is in front of the user — not how macOS
        // privacy works, and not to walk them through System Settings over the top
        // of a card that is already on screen.
        expect(text).toContain("Pathway needs Accessibility and has shown the user a setup card");
        expect(text).toContain("waiting for the user to grant it");
        expect(text).not.toContain("Turn Pathway on in");
      }),
    ),
  );

  it.effect("prompts for setup for a grant that only blinds the desktop", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // Screen Recording alone leaves availability `available` on purpose, so the
        // only thing that can raise the card is the backend saying what it lacks.
        const { result, prompts } = yield* readWith({
          missingPermissions: () =>
            Effect.succeed<readonly ComputerPermission[]>(["screenRecording"]),
        });

        expect(result.isError).not.toBe(true);
        expect(prompts).toEqual([
          { toolName: "computer_list_windows", missing: ["screenRecording"] },
        ]);
      }),
    ),
  );

  it.effect("reads the missing grants fresh on every call, never from the previous answer", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // The live failure this signature exists to prevent: the user granted Screen
        // Recording between two tool calls, the second call re-read a cached
        // "missing", and the card and the model's refusal stayed on screen over a
        // desktop that already worked.
        let granted = false;
        const { prompts } = yield* readWith({
          missingPermissions: () =>
            Effect.sync(() => {
              const answer: readonly ComputerPermission[] = granted ? [] : ["screenRecording"];
              granted = true;
              return answer;
            }),
        });
        expect(prompts).toEqual([
          { toolName: "computer_list_windows", missing: ["screenRecording"] },
        ]);

        const second = yield* readWith({
          missingPermissions: () => Effect.succeed<readonly ComputerPermission[]>([]),
        });
        expect(second.prompts).toEqual([]);
      }),
    ),
  );

  it.effect("carries an ad-hoc build signature to the card, so it can explain a stale grant", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // On a locally built copy System Settings can show Pathway switched on while
        // the grant is pinned to a binary a rebuild replaced; without this the card
        // tells the user to flip a switch that is already flipped.
        const { prompts } = yield* readWith({
          missingPermissions: () =>
            Effect.succeed<readonly ComputerPermission[]>(["screenRecording"]),
          buildSignature: () => "adhoc",
        });

        expect(prompts).toEqual([
          {
            toolName: "computer_list_windows",
            missing: ["screenRecording"],
            buildSignature: "adhoc",
          },
        ]);
      }),
    ),
  );

  it.effect("carries the named grants through a thrown refusal", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = Object.assign(new FakeComputerBackend(), {
          listWindows: () =>
            Effect.fail(
              new ComputerBackendError({
                message: "The helper refused: -32000.",
                setupRequired: true,
              }),
            ),
          missingPermissions: () =>
            Effect.succeed<readonly ComputerPermission[]>(["screenRecording"]),
        });
        const manager = yield* ComputerManager.make({ backend, actionSettleMs: 0 });
        const prompts: { toolName: string; missing: readonly string[] }[] = [];
        const tools = makeComputerTools({
          manager,
          onSetupRequired: ({ toolName, missing }) =>
            Effect.sync(() => void prompts.push({ toolName, missing })),
        });
        const tool = tools.find((entry) => entry.definition.name === "computer_list_windows")!;
        yield* tool.handler({}, makeContext());

        expect(prompts).toEqual([
          { toolName: "computer_list_windows", missing: ["screenRecording"] },
        ]);
      }),
    ),
  );

  it.effect("says nothing about setup when every grant is in place", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { prompts, text } = yield* readWith({});
        expect(prompts).toEqual([]);
        expect(text).not.toContain("setup card");
        expect(text).not.toContain("macOS is asking");
      }),
    ),
  );

  it.effect(
    "tells the model to stop for a blocking grant and to carry on for a degrading one",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          // Screen Recording declined leaves the desktop perfectly driveable and only
          // unseeable, and the note used to say "Stop desktop automation… do not
          // retry" on every successful call for the rest of the session.
          const degrading = yield* readWith({
            missingPermissions: () =>
              Effect.succeed<readonly ComputerPermission[]>(["screenRecording"]),
          });
          expect(degrading.text).toContain("does not block desktop control");
          expect(degrading.text).toContain("Do not stop");
          expect(degrading.text).not.toContain("Stop desktop automation");

          const blocking = yield* readWith({
            missingPermissions: () =>
              Effect.succeed<readonly ComputerPermission[]>(["accessibility"]),
          });
          expect(blocking.text).toContain("Nothing on the desktop can be driven without it");
          expect(blocking.text).toContain("Stop desktop automation");
        }),
      ),
  );

  it.effect("puts the setup note on the error path and on a screenshot-bearing result", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // Both were unreachable: the catch branch returned the backend's raw
        // message, and every screenshot-bearing result is already a built tool
        // result, which the note only knew how to add to a plain object.
        const backend = Object.assign(new FakeComputerBackend(), {
          missingPermissions: () =>
            Effect.succeed<readonly ComputerPermission[]>(["accessibility"]),
        });
        const manager = yield* ComputerManager.make({ backend, actionSettleMs: 0 });
        const tools = makeComputerTools({ manager });
        const byName = new Map(tools.map((tool) => [tool.definition.name, tool]));
        const run = (name: string, args: Record<string, unknown>) =>
          byName.get(name)!.handler(args, makeContext());

        // A perception read with an image: the note lands in the JSON text part
        // beside the picture.
        const state = yield* run("computer_get_state", { include_screenshot: true });
        expect(state.content.map((entry) => entry.type)).toEqual(["text", "image"]);
        expect((resultJson(state) as { setupRequired?: string }).setupRequired).toContain(
          "Pathway needs Accessibility and has shown the user a setup card",
        );

        // And a failure, which used to hand back the backend's sentence alone.
        backend.failNext("captureScreenshot");
        const failed = yield* run("computer_screenshot", {
          window_id: "fake-terminal",
        });
        expect(failed.isError).toBe(true);
        const text = failed.content.find((entry) => entry.type === "text");
        expect(text?.type === "text" ? text.text : "").toContain("setup card");
      }),
    ),
  );

  it.effect("raises the card from a state read that reports a blocking permission", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // The primary perception tool carried no availability at all, so the
        // permission-required branch could not fire for the call an agent makes
        // first.
        const backend = Object.assign(new FakeComputerBackend(), {
          availability: () =>
            Effect.succeed<ComputerAvailability>({
              kind: "permission-required",
              missing: ["accessibility"],
              message: "Pathway needs Accessibility to control this Mac.",
              buildSignature: "signed",
            }),
        });
        const manager = yield* ComputerManager.make({ backend, actionSettleMs: 0 });
        const prompts: string[] = [];
        const tools = makeComputerTools({
          manager,
          onSetupRequired: ({ toolName }) => Effect.sync(() => void prompts.push(toolName)),
        });
        const tool = tools.find((entry) => entry.definition.name === "computer_get_state")!;
        const result = yield* tool.handler({}, makeContext());

        expect(prompts).toEqual(["computer_get_state"]);
        expect(resultJson(result)).toMatchObject({
          availability: { kind: "permission-required", missing: ["accessibility"] },
        });
      }),
    ),
  );
});

it.layer(NodeServices.layer)("screenshot delivery consistency", (it) => {
  it.effect("refreshes screenshot coordinates when an unchanged window moves", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { backend, call } = yield* setup();
        yield* call("computer_press_key", {
          key: "enter",
          window_id: "fake-calculator",
        });
        const windows = yield* backend.listWindows();
        backend.emitWindowsChanged(
          windows.map((w) =>
            w.id === "fake-calculator" ? { ...w, bounds: { ...w.bounds!, x: 600 } } : w,
          ),
        );
        yield* call("computer_press_key", {
          key: "enter",
          window_id: "fake-calculator",
        });
        yield* call("computer_click", { x: 5, y: 5, include_screenshot: false });
        expect(backend.callsFor("click").at(-1)?.args[0]).toEqual({
          x: 605,
          y: 125,
        });
      }),
    ),
  );

  it.effect("returns the action window after an intervening workspace screenshot", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { call, see } = yield* setup();
        yield* call("computer_press_key", {
          key: "enter",
          window_id: "fake-calculator",
        });
        yield* see();
        const repeat = yield* call("computer_press_key", {
          key: "enter",
          window_id: "fake-calculator",
        });
        expect(repeat.content.some((c) => c.type === "image")).toBe(true);
      }),
    ),
  );
});

it.layer(NodeServices.layer)("computer operation ordering", (it) => {
  it.effect(
    "keeps pane input after the action observation and refuses a queued call from an ended turn",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const backend = new FakeComputerBackend();
          const held = yield* Deferred.make<void>();
          const started = yield* Deferred.make<void>();
          const pressKey = backend.pressKey.bind(backend);
          backend.pressKey = (...args: Parameters<typeof pressKey>) =>
            Effect.gen(function* () {
              const result = yield* pressKey(...args);
              yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(held);
              return result;
            });
          const events: string[] = [];
          const capture = backend.captureScreenshot.bind(backend);
          backend.captureScreenshot = (...args: Parameters<typeof capture>) =>
            Effect.suspend(() => {
              events.push("capture");
              return capture(...args);
            });
          const type = backend.typeText.bind(backend);
          backend.typeText = (...args: Parameters<typeof type>) =>
            Effect.suspend(() => {
              events.push("pane input");
              return type(...args);
            });
          const { manager, byName, call } = yield* setup(backend);
          let active = true;
          const first = yield* Effect.forkChild(call("computer_press_key", { key: "enter" }), {
            startImmediately: true,
          });
          yield* Deferred.await(started);
          const paneInput = yield* Effect.forkChild(manager.typeText(undefined, "human"), {
            startImmediately: true,
          });
          const context: ToolContext = {
            ...makeContext(),
            assertCallerTurnActive: () => (active ? Effect.void : turnEnded()),
          };
          const next = yield* Effect.forkChild(
            byName.get("computer_press_key")!.handler({ key: "escape" }, context),
            { startImmediately: true },
          );
          active = false;
          expect(events).toEqual([]);
          yield* Deferred.succeed(held, undefined);
          yield* Fiber.join(first);
          yield* Fiber.join(paneInput);
          expect((yield* Fiber.join(next)).isError).toBe(true);
          expect(events).toEqual(["capture", "pane input"]);
          expect(backend.callsFor("pressKey")).toHaveLength(1);
        }),
      ),
  );

  it.effect("refuses a queued mutation flipped off mid-queue without new backend calls", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = new FakeComputerBackend();
        const held = yield* Deferred.make<void>();
        const started = yield* Deferred.make<void>();
        const pressKey = backend.pressKey.bind(backend);
        backend.pressKey = (...args: Parameters<typeof pressKey>) =>
          Effect.gen(function* () {
            const result = yield* pressKey(...args);
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(held);
            return result;
          });
        const { manager, call } = yield* setup(backend);
        const first = yield* Effect.forkChild(call("computer_press_key", { key: "enter" }), {
          startImmediately: true,
        });
        yield* Deferred.await(started);
        const queued = yield* Effect.forkChild(call("computer_press_key", { key: "escape" }), {
          startImmediately: true,
        });
        yield* yieldTurns;
        const disabling = yield* Effect.forkChild(manager.setControlEnabled(THREAD, false), {
          startImmediately: true,
        });
        yield* Deferred.succeed(held, undefined);
        yield* Fiber.join(disabling);
        yield* Fiber.join(first);
        const queuedResult = yield* Fiber.join(queued);
        expect(queuedResult.isError).toBe(true);
        expect(backend.callsFor("pressKey")).toHaveLength(1);
        yield* manager.setControlEnabled(THREAD, true);
      }),
    ),
  );
});

// Synara declares these cases at the top level of the file, between the
// ordering and never-raise describes; the layer block only provides services.
it.layer(NodeServices.layer)("computer wait, scroll and observation", (it) => {
  it.effect("waits for a live label and returns its window screenshot in the same call", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { backend, call } = yield* setup();
        const result = yield* call("computer_wait", {
          duration_ms: 5_000,
          label: "Display",
          window_id: "fake-calculator",
        });
        expect(result.isError).not.toBe(true);
        expect(resultJson(result)).toMatchObject({
          status: "ready",
          screenshot: { windowId: "fake-calculator" },
        });
        expect(backend.callsFor("getState")).toHaveLength(1);
        expect(backend.callsFor("click")).toHaveLength(0);
        expect(backend.callsFor("raiseWindow")).toHaveLength(0);
        const invalid = yield* call("computer_wait", {
          duration_ms: 0,
          label: "Display",
        });
        expect(invalid.isError).toBe(true);
      }),
    ),
  );

  it.effect("waits for a window's surface to go quiet when settle is requested", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { backend, call } = yield* setup(new FakeComputerBackend({ waitForSettle: true }));
        const result = yield* call("computer_wait", {
          duration_ms: 5_000,
          window_id: "fake-terminal",
          settle: true,
        });
        expect(result.isError).not.toBe(true);
        expect(resultJson(result)).toMatchObject({
          settled: true,
          mode: "observer",
        });
        expect(backend.callsFor("waitForSettle")).toHaveLength(1);
        expect(backend.callsFor("waitForSettle")[0]?.args[0]).toMatchObject({
          windowId: "fake-terminal",
        });
        // Watching is not touching: no input, no raise, no capture rode along.
        expect(backend.callsFor("click")).toHaveLength(0);
        expect(backend.callsFor("raiseWindow")).toHaveLength(0);
        expect(backend.callsFor("captureScreenshot")).toHaveLength(0);
      }),
    ),
  );

  it.effect("reports the fixed fallback when the backend cannot observe a settle", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { backend, call } = yield* setup();
        const result = yield* call("computer_wait", {
          duration_ms: 5_000,
          window_id: "fake-terminal",
          settle: true,
        });
        expect(result.isError).not.toBe(true);
        // No observer exists on this backend, so the honest answer is a fixed
        // pause — mode reports which kind of wait actually happened.
        expect(resultJson(result)).toMatchObject({ settled: true, mode: "fixed", waitedMs: 0 });
        expect(backend.callsFor("waitForSettle")).toHaveLength(0);
      }),
    ),
  );

  it.effect("requires a window for a settle wait and refuses an unknown one", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { call } = yield* setup(new FakeComputerBackend({ waitForSettle: true }));
        const missing = yield* call("computer_wait", { duration_ms: 5_000, settle: true });
        expect(missing.isError).toBe(true);
        const unknown = yield* call("computer_wait", {
          duration_ms: 5_000,
          window_id: "no-such-window",
          settle: true,
        });
        expect(unknown.isError).toBe(true);
        // settle and label are different observation modes; combining them is
        // refused rather than silently preferring one.
        const combined = yield* call("computer_wait", {
          duration_ms: 5_000,
          window_id: "fake-terminal",
          label: "OK",
          settle: true,
        });
        expect(combined.isError).toBe(true);
      }),
    ),
  );

  it.effect("can wait for the next label on an action without replaying input", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { backend, call } = yield* setup();
        const result = yield* call("computer_click", {
          label: "Display",
          window_id: "fake-calculator",
          wait_for_label: "Display",
        });
        expect(result.isError).not.toBe(true);
        expect(resultJson(result)).toMatchObject({ readiness: { status: "ready" } });
        expect(backend.callsFor("click")).toHaveLength(1);
        const invalid = yield* call("computer_click", {
          label: "Display",
          wait_for_label: "",
        });
        expect(invalid.isError).toBe(true);
        expect(backend.callsFor("click")).toHaveLength(1);
      }),
    ),
  );

  it.effect("does not substitute a new window from another process for the target screenshot", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = new FakeComputerBackend();
        const before = (yield* backend.listWindows()).map((window) => ({
          ...window,
          pid: 10,
        }));
        backend.emitWindowsChanged(before);
        const { call } = yield* setup(backend);
        backend.pressKey = () =>
          Effect.sync(() => {
            backend.emitWindowsChanged([
              ...before,
              { ...before[0]!, id: "unrelated-popup", pid: 20, stackingIndex: 0 },
            ]);
            return {};
          });
        const result = yield* call("computer_press_key", {
          key: "enter",
          window_id: "fake-terminal",
        });
        expect(resultJson(result)).toMatchObject({
          screenshot: { windowId: "fake-terminal" },
        });
      }),
    ),
  );

  it.effect("limits large scrolls to overlapping views across screenshot scale changes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { backend, call } = yield* setup();
        const first = resultJson(
          yield* call("computer_screenshot", { window_id: "fake-terminal" }),
        ) as {
          screenshot: {
            region: { width: number; height: number };
            width: number;
            height: number;
          };
        };
        for (const distance of [1500, 700, -1400]) {
          const result = resultJson(
            yield* call("computer_scroll", {
              window_id: "fake-terminal",
              delta_x: 0,
              delta_y: distance,
            }),
          ) as {
            scroll: { requested: { deltaY: number }; limitedTo: { deltaY: number } };
          };
          expect(result.scroll.limitedTo.deltaY).toBe(
            (Math.sign(distance) * first.screenshot.region.height) / 2,
          );
          expect(Math.abs(result.scroll.requested.deltaY)).toBeGreaterThan(
            Math.abs(result.scroll.limitedTo.deltaY),
          );
          expect(
            Math.abs(backend.callsFor("scroll").at(-1)!.args[2] as number),
          ).toBeLessThanOrEqual(first.screenshot.region.height / 2);
        }
      }),
    ),
  );

  it.effect("keeps a completed input successful when conditional observation fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = new FakeComputerBackend();
        const click = backend.click.bind(backend);
        backend.click = (...args: Parameters<typeof click>) =>
          Effect.tap(click(...args), () => Effect.sync(() => backend.failNext("getState")));
        const { call } = yield* setup(backend);
        const result = yield* call("computer_click", {
          label: "Calculate",
          window_id: "fake-calculator",
          wait_for_label: "Display",
        });
        expect(result.isError).not.toBe(true);
        expect(resultJson(result)).toMatchObject({
          action: "computer_click",
          readiness: { status: "unavailable" },
        });
        expect(backend.callsFor("click")).toHaveLength(1);
      }),
    ),
  );

  it.effect(
    "inherits an omitted scroll target from the screenshot rather than the old keyboard target",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { backend, manager, call } = yield* setup();
          yield* manager.typeText(undefined, "human", "fake-terminal");
          const shot = yield* call("computer_screenshot", {
            window_id: "fake-calculator",
          });
          expect(shot.isError).not.toBe(true);
          const result = yield* call("computer_scroll", {
            delta_x: 0,
            delta_y: 30,
            include_screenshot: false,
          });
          expect(result.isError).not.toBe(true);
          expect(resultJson(result)).toMatchObject({ windowId: "fake-calculator" });
          expect(backend.callsFor("focusWindow").at(-1)?.args).toEqual(["fake-calculator"]);
        }),
      ),
  );

  it.effect(
    "allows human input between conditional wait observations and stops polling when control is revoked",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const backend = new FakeComputerBackend();
          const reading = yield* Deferred.make<void>();
          const getState = backend.getState.bind(backend);
          backend.getState = (...args: Parameters<typeof getState>) =>
            Effect.tap(getState(...args), () => Deferred.succeed(reading, undefined));
          const { manager, call } = yield* setup(backend);
          const waiting = yield* Effect.forkChild(
            call("computer_wait", {
              duration_ms: 1000,
              label: "Never exists",
              window_id: "fake-calculator",
              include_screenshot: false,
            }),
            { startImmediately: true },
          );
          yield* Deferred.await(reading);
          yield* manager.typeText(undefined, "human input");
          expect(backend.callsFor("typeText")).toHaveLength(1);
          yield* manager.setControlEnabled(THREAD, false);
          const reads = backend.callsFor("getState").length;
          expect((yield* drive(Fiber.join(waiting))).isError).toBe(true);
          expect(backend.callsFor("getState")).toHaveLength(reads);
          expect(backend.callsFor("click")).toHaveLength(0);
        }),
      ),
  );
});

it.layer(NodeServices.layer)("computer never-raise gate", (it) => {
  const refusing: NonNullable<ComputerToolsOptions["resolveForegroundAuthorization"]> = () =>
    Effect.succeed({ userRequestedVisibleUse: false });

  it.effect("gates exact-window and app menu calls and batched menu steps as foreground", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = new FakeComputerBackend();
        const approval = vi.fn((_name: string, _args: Record<string, unknown>) => approved());
        const { call } = yield* setup(backend, approval, refusing);
        for (const target of [{ window_id: "fake-calculator" }, { pid: 1_002 }]) {
          expect(
            resultJson(yield* call("computer_invoke_menu", { ...target, path: ["File"] })),
          ).toMatchObject({
            error: "foreground_not_requested",
            effect: "not-dispatched",
          });
        }
        expect(approval).toHaveBeenCalledWith(
          "computer_invoke_menu",
          expect.objectContaining({ delivery_mode: "foreground" }),
          expect.anything(),
        );
        const batch = resultJson(
          yield* call("computer_run", {
            steps: [{ type: "invoke_menu", app: "Calculator", path: ["File"] }],
          }),
        );
        expect(batch).toMatchObject({
          completed: 0,
          stopped: true,
          steps: [
            { ok: false, error: { code: "foreground_not_requested", effect: "not-dispatched" } },
          ],
        });
        expect(backend.callsFor("invokeMenu")).toHaveLength(0);
        expect(backend.callsFor("raiseWindow")).toHaveLength(0);
        expect(backend.callsFor("focusWindow")).toHaveLength(0);
      }),
    ),
  );

  it.effect("refuses activate without the user's task-text authorization, and raises nothing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = new FakeComputerBackend();
        const approval = vi.fn(() => approved());
        const { call } = yield* setup(backend, approval, refusing);
        const refused = yield* call("computer_activate_window", { window_id: "fake-calculator" });
        expect(refused.isError).toBe(true);
        const payload = resultJson(refused) as { error: string; effect: string; message: string };
        expect(payload.error).toBe("foreground_not_requested");
        expect(payload.effect).toBe("not-dispatched");
        expect(payload.message).toContain("did not ask");
        expect(backend.callsFor("raiseWindow")).toEqual([]);
        expect(backend.callsFor("focusWindow")).toEqual([]);
      }),
    ),
  );

  it.effect("refuses an absent resolver too — never-raise is the default", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = new FakeComputerBackend();
        const manager = yield* ComputerManager.make({ backend, actionSettleMs: 0 });
        const tools = makeComputerTools({
          manager,
          authorizeAction: () => approved(),
        });
        const tool = tools.find((entry) => entry.definition.name === "computer_activate_window")!;
        const refused = yield* tool.handler({ window_id: "fake-calculator" }, makeContext());
        expect(refused.isError).toBe(true);
        expect(encodeJson(resultJson(refused))).toContain("foreground_not_requested");
        expect(backend.callsFor("raiseWindow")).toEqual([]);
      }),
    ),
  );

  it.effect("refuses foreground delivery without authorization and dispatches nothing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = new FakeComputerBackend();
        const approval = vi.fn(() => approved());
        const { call } = yield* setup(backend, approval, refusing);
        const refused = yield* call("computer_press_key", {
          key: "enter",
          window_id: "fake-calculator",
          delivery_mode: "foreground",
        });
        expect(refused.isError).toBe(true);
        expect(encodeJson(resultJson(refused))).toContain("foreground_not_requested");
        expect(backend.callsFor("pressKey")).toEqual([]);
      }),
    ),
  );

  it.effect("refuses a run's activate step without authorization, and the run reports it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = new FakeComputerBackend();
        const approval = vi.fn(() => approved());
        const { call } = yield* setup(backend, approval, refusing);
        const result = yield* call("computer_run", {
          steps: [{ type: "activate_window", window_id: "fake-calculator" }],
        });
        const payload = resultJson(result) as {
          completed: number;
          stopped: boolean;
          steps: { ok: boolean; error?: { code?: string } }[];
        };
        expect(payload.stopped).toBe(true);
        expect(payload.steps[0]).toMatchObject({
          ok: false,
          error: { code: "foreground_not_requested", effect: "not-dispatched" },
        });
        expect(backend.callsFor("raiseWindow")).toEqual([]);
      }),
    ),
  );

  it.effect("launches macOS apps in the background without hiding or raising them", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = new FakeComputerBackend({ agentDialect: "macos" });
        const { call } = yield* setup(
          backend,
          vi.fn(() => approved()),
          refusing,
        );
        const result = yield* call("computer_launch_app", {
          app: "TextEdit",
          hidden: false,
          wait_for_window: false,
        });
        expect(result.isError).not.toBe(true);
        const batched = yield* call("computer_run", {
          steps: [{ type: "launch_app", app: "TextEdit", wait_for_window: false }],
        });
        expect(resultJson(batched)).toMatchObject({ steps: [{ ok: true }] });
        expect(backend.callsFor("launchApp").map((entry) => entry.args)).toEqual([
          ["TextEdit", [], { hidden: false }],
          ["TextEdit", []],
        ]);
        expect(backend.callsFor("raiseWindow")).toEqual([]);
      }),
    ),
  );

  it.effect("allows the authorized raise, and the resolver is read per call", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = new FakeComputerBackend();
        const approval = vi.fn(() => approved());
        let authorized = false;
        const { call } = yield* setup(backend, approval, () =>
          Effect.sync(() => ({ userRequestedVisibleUse: authorized })),
        );
        expect(
          (yield* call("computer_activate_window", { window_id: "fake-calculator" })).isError,
        ).toBe(true);
        expect(backend.callsFor("raiseWindow")).toEqual([]);
        // The user replies "yes, show me": the next read authorizes.
        authorized = true;
        const allowed = yield* call("computer_activate_window", { window_id: "fake-calculator" });
        expect(allowed.isError).not.toBe(true);
        expect(backend.callsFor("raiseWindow").map((entry) => entry.args[0])).toEqual([
          "fake-calculator",
          "fake-terminal",
        ]);
      }),
    ),
  );

  it.effect("keeps the refusal-map guidance and the foreground chapter", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const notes = computerToolInstructions();
        expect(notes).toContain("foreground_not_requested");
        expect(notes).toContain("foreground_user_interaction");
        const { call } = yield* setup();
        const chapter = yield* call("computer_help", { topic: "foreground" });
        expect(chapter.isError).not.toBe(true);
        const json = resultJson(chapter) as { text: string };
        expect(json.text).toContain("foreground_not_requested");
        expect(json.text).toContain("foreground_user_interaction");
        const index = yield* call("computer_help", {});
        expect((resultJson(index) as { topics: string }).topics).toContain("foreground");
      }),
    ),
  );
});

it.layer(NodeServices.layer)("computer_activate_window foreground restore", (it) => {
  it.effect(
    "runs a default-background activate in foreground scope and restores when approved",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const backend = new FakeComputerBackend();
          const deliveryModes: string[] = [];
          const raise = backend.raiseWindow.bind(backend);
          backend.raiseWindow = (windowId: string) =>
            Effect.flatMap(desktopDeliveryMode, (mode) => {
              deliveryModes.push(mode);
              return raise(windowId);
            });
          const approval = vi.fn((_name: string, _args: Record<string, unknown>) => approved());
          const { call } = yield* setup(backend, approval);
          // No delivery_mode arg: the call defaults to background, yet activation
          // is a foreground excursion within the task's approval.
          const result = yield* call("computer_activate_window", {
            window_id: "fake-calculator",
          });
          expect(result.isError).not.toBe(true);
          expect(approval).toHaveBeenCalledWith(
            "computer_activate_window",
            expect.objectContaining({ delivery_mode: "foreground" }),
            expect.anything(),
          );
          // The whole excursion — raise plus restore — runs in foreground scope.
          expect(deliveryModes).toEqual(["foreground", "foreground"]);
          expect(backend.callsFor("raiseWindow").map((entry) => entry.args[0])).toEqual([
            "fake-calculator",
            "fake-terminal",
          ]);
          expect(resultJson(result)).toMatchObject({
            action: "computer_activate_window",
            windowId: "fake-calculator",
          });
        }),
      ),
  );

  it.effect("touches nothing when approval refuses the activate", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = new FakeComputerBackend();
        const approval = vi.fn(() => approved("denied"));
        const { call } = yield* setup(backend, approval);
        const refused = yield* call("computer_activate_window", {
          window_id: "fake-calculator",
        });
        expect(refused.isError).toBe(true);
        expect(backend.callsFor("raiseWindow")).toHaveLength(0);
        expect(backend.callsFor("focusWindow")).toHaveLength(0);
      }),
    ),
  );
});

it.layer(NodeServices.layer)("computer_inspect", (it) => {
  it.effect.each(PATHWAY_PROVIDERS)(
    "preserves specialist reads and image results for %s",
    (provider) =>
      Effect.scoped(
        Effect.gen(function* () {
          const authorize = vi.fn((_name: string, _args: Record<string, unknown>) => approved());
          const { backend, byName, call } = yield* setup(new FakeComputerBackend(), authorize);
          const inspector = byName.get("computer_inspect")!;
          expect(inspector.discoveryOnly).not.toBe(true);
          expect(inspector.requiredCapability).toBe("computer");
          expect(inspector.requiresActiveTurn).toBe(true);
          expect(inspector.definition.annotations?.readOnlyHint).toBe(false);
          for (const [tool, args] of [
            ["computer_read_clipboard", {}],
            ["computer_get_accessibility_tree", { window_id: "fake-calculator" }],
            ["computer_get_cursor_position", { window_id: "fake-calculator" }],
            ["computer_zoom", { window_id: "fake-calculator", x: 0, y: 0, width: 40, height: 40 }],
          ] as const) {
            const help = resultJson(yield* call("computer_help", { tool }, provider)) as {
              inspection: { name: string; tool: string };
            };
            const result = yield* call(
              help.inspection.name,
              { tool: help.inspection.tool, arguments: args },
              provider,
            );
            expect(result.isError, tool).not.toBe(true);
            if (tool === "computer_zoom") {
              expect(
                result.content.some(
                  (item) => item.type === "image" && item.mimeType === "image/jpeg",
                ),
              ).toBe(true);
              const payload = resultJson(result) as { zoom: unknown };
              expect(payload.zoom).toMatchObject({ windowId: "fake-calculator" });
              expect(encodeJson(payload)).not.toContain("bytesBase64");
              expect(encodeJson(payload)).not.toContain("screenshotId");
            }
          }
          expect(authorize).toHaveBeenCalledTimes(1);
          expect(authorize.mock.calls[0]?.[0]).toBe("computer_read_clipboard");
          for (const method of [
            "readClipboard",
            "getAccessibilityTree",
            "getCursorPosition",
            "zoomWindow",
          ]) {
            expect(backend.callsFor(method), method).toHaveLength(1);
          }
          expect(backend.callsFor("captureScreenshot")).toHaveLength(0);
        }),
      ),
  );

  it.effect(
    "refuses unknown routes, invalid schemas and extra fields before any backend call",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const authorize = vi.fn(() => approved());
          const { backend, call } = yield* setup(new FakeComputerBackend(), authorize);
          for (const args of [
            { tool: "computer_click", arguments: { x: 2, y: 3 } },
            { tool: "computer_inspect", arguments: { tool: "computer_read_clipboard" } },
            { tool: "computer_future" },
            { tool: "mcp__pathway__computer_read_clipboard" },
            { tool: "computer_read_clipboard", arguments: { text: "private" } },
            { tool: "computer_read_clipboard", arguments: [] },
            { tool: "computer_read_clipboard", arguments: null },
            { tool: "computer_get_cursor_position", arguments: { window_id: 42 } },
            { tool: "computer_zoom", arguments: { window_id: "fake-calculator" } },
            {
              tool: "computer_zoom",
              arguments: { window_id: "fake-calculator", x: "1", y: 0, width: 4, height: 4 },
            },
            {
              tool: "computer_zoom",
              arguments: { window_id: "fake-calculator", x: 1, y: 0, width: Infinity, height: 4 },
            },
            { tool: "computer_get_accessibility_tree", delivery_mode: "foreground" },
          ]) {
            expect((yield* call("computer_inspect", args)).isError).toBe(true);
          }
          expect(backend.calls).toHaveLength(0);
          expect(authorize).not.toHaveBeenCalled();
        }),
      ),
  );

  it.effect("retains clipboard refusal and dead-turn checks before dispatch", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const authorize = vi.fn(() => approved("denied"));
        const { backend, byName, call } = yield* setup(new FakeComputerBackend(), authorize);
        expect((yield* call("computer_inspect", { tool: "computer_read_clipboard" })).isError).toBe(
          true,
        );
        expect(authorize).toHaveBeenCalledTimes(1);
        const inactive: ToolContext = {
          ...makeContext(),
          assertCallerTurnActive: turnEnded,
        };
        const result = yield* byName
          .get("computer_inspect")!
          .handler({ tool: "computer_get_cursor_position" }, inactive);
        expect(result.isError).toBe(true);
        expect(backend.callsFor("readClipboard")).toHaveLength(0);
        expect(backend.callsFor("getCursorPosition")).toHaveLength(0);
      }),
    ),
  );

  it.effect("passes cancellation to a pending canonical clipboard approval", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        let approvalInterrupted = false;
        // Cancellation is fiber interruption: the pending approval is the
        // interrupted child, where Synara aborted its signal.
        const authorize: ComputerAuthorizeAction = () =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                approvalInterrupted = true;
              }),
            ),
          );
        const { backend, byName } = yield* setup(new FakeComputerBackend(), authorize);
        const pending = yield* Effect.forkChild(
          byName
            .get("computer_inspect")!
            .handler({ tool: "computer_read_clipboard" }, makeContext()),
          { startImmediately: true },
        );
        yield* Deferred.await(entered);
        yield* Fiber.interrupt(pending);
        const outcome = yield* Fiber.await(pending);
        expect(Exit.hasInterrupts(outcome)).toBe(true);
        expect(approvalInterrupted).toBe(true);
        expect(backend.callsFor("readClipboard")).toHaveLength(0);
      }),
    ),
  );
});

it.layer(NodeServices.layer)("computer_run", (it) => {
  it.effect("reports the active step instead of one generic batch label", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { manager, call } = yield* setup();
        const activity = vi.spyOn(manager.cursorActivity, "during");
        const result = yield* call("computer_run", {
          steps: [
            { type: "click", label: "Display", window_id: "fake-calculator" },
            { type: "type_text", text: "468", window_id: "fake-calculator" },
            { type: "write_clipboard", text: "copied value" },
          ],
        });
        expect(result.isError).not.toBe(true);
        expect(activity.mock.calls.map((entry) => entry[1])).toEqual([
          "Running sequence",
          "Clicking",
          "Typing",
          "Writing clipboard",
        ]);
      }),
    ),
  );

  it.effect("runs steps in order through the same manager calls and closes with fresh state", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { backend, call } = yield* setup();
        const result = yield* call("computer_run", {
          steps: [
            { type: "click", label: "Display", window_id: "fake-calculator" },
            { type: "type_text", text: "468", window_id: "fake-calculator" },
            { type: "select_text", label: "Display", start: 0, length: 2 },
            { type: "press_key", key: "enter", window_id: "fake-calculator" },
          ],
        });
        expect(result.isError).not.toBe(true);
        const payload = resultJson(result) as {
          steps: {
            step: number;
            type: string;
            ok: boolean;
            result?: Record<string, unknown>;
          }[];
          completed: number;
          stopped: boolean;
          state: { elements: { label: string }[]; elementWindowId?: string };
        };
        expect(payload.completed).toBe(4);
        expect(payload.stopped).toBe(false);
        expect(payload.steps.map((entry) => [entry.step, entry.type, entry.ok])).toEqual([
          [0, "click", true],
          [1, "type_text", true],
          [2, "select_text", true],
          [3, "press_key", true],
        ]);
        // computerId rides once on the envelope, not on every step.
        for (const entry of payload.steps) expect(entry.result).not.toHaveProperty("computerId");
        expect(payload.state.elements.map((element) => element.label)).toContain("Display");
        // The closing state's listing is one window: id hoisted, as in get_state.
        expect(payload.state.elementWindowId).toBe("fake-calculator");
        expect(backend.callsFor("click")).toHaveLength(1);
        expect(backend.callsFor("typeText").map((entry) => entry.args[0])).toEqual(["468"]);
        expect(backend.callsFor("selectText").map((entry) => entry.args[1])).toEqual([
          { start: 0, length: 2 },
        ]);
        expect(backend.callsFor("pressKey")).toHaveLength(1);
      }),
    ),
  );

  it.effect("stops at the first failure and reports which step and why", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { backend, call } = yield* setup();
        backend.failNext("typeText", new ComputerBackendError({ message: "seat unavailable" }));
        const result = yield* call("computer_run", {
          steps: [
            { type: "click", label: "Display", window_id: "fake-calculator" },
            { type: "type_text", text: "1" },
            { type: "press_key", key: "enter" },
          ],
        });
        expect(result.isError).not.toBe(true);
        const payload = resultJson(result) as {
          steps: { step: number; ok: boolean; error?: { message?: string } }[];
          completed: number;
          stopped: boolean;
        };
        expect(payload.stopped).toBe(true);
        expect(payload.completed).toBe(1);
        expect(payload.steps).toHaveLength(2);
        expect(payload.steps[1]).toMatchObject({
          step: 1,
          type: "type_text",
          ok: false,
          error: { message: "seat unavailable" },
        });
        // The third step never dispatched.
        expect(backend.callsFor("pressKey")).toHaveLength(0);
      }),
    ),
  );

  it.effect("refuses a malformed batch whole, before anything dispatches", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { backend, call } = yield* setup();
        for (const steps of [
          [{ type: "click", label: "Display" }, { type: "levitate" }],
          [{ type: "type_text", text: "hi", bogus: true }],
          [{ type: "type_text" }],
          [{ type: "click", label: "Display" }, 42],
        ]) {
          const result = yield* call("computer_run", { steps });
          expect(result.isError).toBe(true);
        }
        expect(backend.callsFor("click")).toHaveLength(0);
        expect(backend.callsFor("typeText")).toHaveLength(0);
      }),
    ),
  );

  it.effect("caps the step count", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { backend, call } = yield* setup();
        const result = yield* call("computer_run", {
          steps: Array.from({ length: 26 }, () => ({
            type: "press_key",
            key: "enter",
          })),
        });
        expect(result.isError).toBe(true);
        expect(backend.callsFor("pressKey")).toHaveLength(0);
      }),
    ),
  );

  it.effect("asks approval once for the declared list and dispatches nothing when refused", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = new FakeComputerBackend();
        const approval = vi.fn((_name: string) => approved("denied"));
        const { call } = yield* setup(backend, approval);
        const refused = yield* call("computer_run", {
          steps: [{ type: "click", label: "Display", window_id: "fake-calculator" }],
        });
        expect(refused.isError).toBe(true);
        expect(approval).toHaveBeenCalledTimes(1);
        expect(approval.mock.calls[0]?.[0]).toBe("computer_run");
        expect(backend.callsFor("click")).toHaveLength(0);
      }),
    ),
  );

  it.effect("scopes only the activate_window step to foreground delivery", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = new FakeComputerBackend();
        const modes: string[] = [];
        const raise = backend.raiseWindow.bind(backend);
        backend.raiseWindow = (windowId: string) =>
          Effect.flatMap(desktopDeliveryMode, (mode) => {
            modes.push(mode);
            return raise(windowId);
          });
        const click = backend.click.bind(backend);
        backend.click = (...args: Parameters<typeof click>) =>
          Effect.flatMap(desktopDeliveryMode, (mode) => {
            modes.push(mode);
            return click(...args);
          });
        const { call } = yield* setup(backend);
        const result = yield* call("computer_run", {
          steps: [
            { type: "activate_window", window_id: "fake-calculator" },
            { type: "click", label: "Display", window_id: "fake-calculator" },
          ],
        });
        expect(result.isError).not.toBe(true);
        // raise + restore are foreground; everything the click path touches —
        // its own window aim included — stays in the batch's background mode.
        expect(modes.slice(0, 2)).toEqual(["foreground", "foreground"]);
        expect(modes.slice(2).every((mode) => mode === "background")).toBe(true);
        expect(modes.length).toBeGreaterThan(2);
        // The restore re-covered the calculator, so the click restacks its own
        // target — required on a compositing backend for the point to route.
        expect(backend.callsFor("raiseWindow").map((entry) => entry.args[0])).toEqual([
          "fake-calculator",
          "fake-terminal",
          "fake-calculator",
        ]);
      }),
    ),
  );

  it.effect("waits for a label mid-run and resolves fresh targets per step", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { backend, call } = yield* setup();
        const result = yield* call("computer_run", {
          steps: [
            {
              type: "wait",
              duration_ms: 5_000,
              label: "Display",
              window_id: "fake-calculator",
            },
            {
              type: "set_value",
              label: "Display",
              window_id: "fake-calculator",
              value: "42",
            },
          ],
        });
        expect(result.isError).not.toBe(true);
        const payload = resultJson(result) as {
          steps: { ok: boolean; result?: unknown }[];
        };
        expect(payload.steps[0]).toMatchObject({
          ok: true,
          result: { status: "ready" },
        });
        expect(payload.steps[1]).toMatchObject({ ok: true });
        expect(backend.callsFor("setValue")).toHaveLength(1);
      }),
    ),
  );

  it.effect("carries model-observation authority on its internal reads", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = new FakeComputerBackend();
        const observed: boolean[] = [];
        const getState = backend.getState.bind(backend);
        backend.getState = (...args: Parameters<typeof getState>) =>
          Effect.flatMap(isModelDesktopObservationActive, (active) => {
            observed.push(active);
            return getState(...args);
          });
        const { call } = yield* setup(backend);
        const result = yield* call("computer_run", {
          steps: [
            {
              type: "wait",
              duration_ms: 2_000,
              label: "Display",
              window_id: "fake-calculator",
            },
          ],
        });
        expect(result.isError).not.toBe(true);
        // The wait-step poll and the closing state read both ran as model
        // observations — they satisfy a pending post-resume observation gate.
        expect(observed.length).toBeGreaterThanOrEqual(2);
        expect(observed.every(Boolean)).toBe(true);
      }),
    ),
  );

  it.effect("propagates a dead turn instead of reporting a half-run as data", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { backend, byName } = yield* setup();
        let checks = 0;
        const context: ToolContext = {
          ...makeContext(),
          assertCallerTurnActive: () => {
            checks += 1;
            return checks <= 2 ? Effect.void : turnEnded();
          },
        };
        const result = yield* byName.get("computer_run")!.handler(
          {
            steps: [
              { type: "click", label: "Display", window_id: "fake-calculator" },
              { type: "type_text", text: "1" },
            ],
          },
          context,
        );
        expect(result.isError).toBe(true);
        // The turn died before step two: one click dispatched, nothing typed.
        expect(backend.callsFor("click")).toHaveLength(1);
        expect(backend.callsFor("typeText")).toHaveLength(0);
      }),
    ),
  );

  it.effect("attaches a final screenshot of the affected window when asked", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { call } = yield* setup();
        const result = yield* call("computer_run", {
          steps: [{ type: "click", label: "Display", window_id: "fake-calculator" }],
          include_screenshot: true,
        });
        expect(result.isError).not.toBe(true);
        expect(result.content.some((entry) => entry.type === "image")).toBe(true);
        expect(resultJson(result)).toMatchObject({
          screenshot: { windowId: "fake-calculator" },
        });
      }),
    ),
  );

  it.effect("pastes through the clipboard and restores the user's contents", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { backend, call } = yield* setup();
        yield* call("computer_write_clipboard", { text: "the user's copy" });
        const result = yield* drive(
          call("computer_run", {
            steps: [
              { type: "click", label: "Display", window_id: "fake-calculator" },
              {
                type: "paste",
                text: "long agent payload",
                window_id: "fake-calculator",
              },
            ],
          }),
        );
        expect(result.isError).not.toBe(true);
        const payload = resultJson(result) as {
          steps: { result?: Record<string, unknown> }[];
        };
        expect(payload.steps[1]?.result).toMatchObject({
          action: "computer_paste",
          clipboardRestored: true,
        });
        // write payload, send chord, write the user's contents back.
        expect(backend.callsFor("writeClipboard").map((entry) => entry.args[0])).toEqual([
          "the user's copy",
          "long agent payload",
          "the user's copy",
        ]);
        expect(backend.callsFor("hotkey").map((entry) => entry.args[0])).toEqual([["ctrl", "v"]]);
      }),
    ),
  );
});

it.layer(NodeServices.layer)("computer_paste", (it) => {
  it.effect("saves, pastes, and restores the shared clipboard", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { backend, call } = yield* setup();
        yield* call("computer_write_clipboard", { text: "keep me" });
        const result = yield* drive(
          call("computer_paste", {
            text: "pasted text",
            window_id: "fake-calculator",
          }),
        );
        expect(result.isError).not.toBe(true);
        expect(resultJson(result)).toMatchObject({
          action: "computer_paste",
          clipboardRestored: true,
        });
        expect(backend.callsFor("hotkey").map((entry) => entry.args[0])).toEqual([["ctrl", "v"]]);
        const clipboard = resultJson(yield* call("computer_read_clipboard", {})) as {
          value: string;
        };
        expect(clipboard.value).toBe("keep me");
      }),
    ),
  );

  it.effect("uses the Command chord on a macOS backend", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = Object.assign(new FakeComputerBackend(), {
          agentDialect: "macos" as const,
        });
        const { call } = yield* setup(backend);
        const result = yield* drive(
          call("computer_paste", {
            text: "payload",
            window_id: "fake-calculator",
          }),
        );
        expect(result.isError).not.toBe(true);
        expect(backend.callsFor("hotkey").map((entry) => entry.args[0])).toEqual([["meta", "v"]]);
      }),
    ),
  );

  it.effect("still restores the clipboard when the paste dispatch fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { backend, call } = yield* setup();
        yield* call("computer_write_clipboard", { text: "user text" });
        backend.failNext("hotkey");
        const result = yield* drive(
          call("computer_paste", {
            text: "agent text",
            window_id: "fake-calculator",
          }),
        );
        expect(result.isError).toBe(true);
        expect(backend.callsFor("writeClipboard").map((entry) => entry.args[0])).toEqual([
          "user text",
          "agent text",
          "user text",
        ]);
      }),
    ),
  );
});
