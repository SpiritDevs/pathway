import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it, vi } from "@effect/vitest";
import {
  COMPUTER_BROWSER_DRIVER_NAMES,
  COMPUTER_BROWSER_TOOL_NAMES,
  ProviderDriverKind,
} from "@spiritdevs/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  ComputerApprovalPublishError,
  ComputerApprovalQueueFullError,
  type ComputerApprovalOutcome,
} from "../../../computer/ComputerApprovalGate.ts";
import type { ComputerBrowserCall } from "../../../computer/ComputerBackend.ts";
import { ComputerManager } from "../../../computer/ComputerManager.ts";
import {
  abortDesktop,
  desktopDeliveryMode,
  desktopSignal,
  makeDesktopAbort,
} from "../../../computer/DesktopOperationQueue.ts";
import { FakeComputerBackend } from "../../../computer/FakeComputerBackend.ts";
import { ComputerBackendError } from "../../../computer/computerErrors.ts";
import { isModelDesktopObservationActive } from "../../../computer/modelDesktopObservation.ts";
import {
  computerBrowserToolRequiresApproval,
  makeComputerBrowserTools,
  type ComputerBrowserToolsOptions,
} from "./computerBrowserTools.ts";
import type { McpToolCallResult, ToolContext } from "./toolRuntime.ts";

const THREAD = "thread-browser";

function makeContext(threadId = THREAD, turnId: string | null = "turn-browser"): ToolContext {
  return {
    callerThreadId: threadId,
    callerThreadLabel: null,
    callerSessionKey: "mcp-session:browser",
    callerProvider: ProviderDriverKind.make("claudeAgent"),
    callerCapabilities: new Set(["computer"]),
    callerTurnId: turnId,
    assertCallerTurnActive: () => Effect.void,
    jsonRpcRequestId: 1,
  };
}

const approve: ComputerBrowserToolsOptions["authorizeAction"] = () => Effect.succeed("approved");

const setup = Effect.fn(function* (options?: {
  backend?: FakeComputerBackend;
  authorizeAction?: ComputerBrowserToolsOptions["authorizeAction"];
  resolveForegroundAuthorization?: ComputerBrowserToolsOptions["resolveForegroundAuthorization"];
  resolveWorkspaceRoot?: ComputerBrowserToolsOptions["resolveWorkspaceRoot"];
}) {
  const backend = options?.backend ?? new FakeComputerBackend({ browser: true });
  const manager = yield* ComputerManager.make({ backend, actionSettleMs: 0 });
  const tools = yield* makeComputerBrowserTools({
    manager,
    ...(options?.authorizeAction ? { authorizeAction: options.authorizeAction } : {}),
    ...(options?.resolveForegroundAuthorization
      ? { resolveForegroundAuthorization: options.resolveForegroundAuthorization }
      : {}),
    ...(options?.resolveWorkspaceRoot
      ? { resolveWorkspaceRoot: options.resolveWorkspaceRoot }
      : {}),
  });
  const byName = new Map(tools.map((tool) => [tool.definition.name, tool]));
  const call = (
    name: string,
    args: Record<string, unknown>,
    threadId = THREAD,
  ): Effect.Effect<McpToolCallResult> => {
    const tool = byName.get(name);
    if (!tool) return Effect.die(new Error(`no such tool: ${name}`));
    return tool.handler(args, makeContext(threadId));
  };
  return { backend, manager, tools, byName, call };
});

function textOf(result: McpToolCallResult): string {
  return result.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

function jsonOf(result: McpToolCallResult): unknown {
  return decodeJson(textOf(result));
}

/** A driver reply that binds target bt-1 with the given tabs. */
function bindingResult(tabs: ReadonlyArray<Record<string, unknown>>) {
  return {
    content: [
      {
        type: "text",
        text: `bound target bt-1 (exact) with ${tabs.length} tab(s)`,
      },
    ],
    structuredContent: {
      status: "ok",
      mode: "bind",
      binding_quality: "exact",
      native_title: "about:blank",
      target_id: "bt-1",
      tabs,
    },
  };
}

it.layer(NodeServices.layer)("computer_browser_* gateway tools", (it) => {
  it.effect("authorizes fresh browser observations only while the model state call runs", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { backend, call } = yield* setup({ authorizeAction: approve });
        const scopes: boolean[] = [];
        const originalCall = backend.browser!.call;
        vi.spyOn(backend.browser!, "call").mockImplementation((request) =>
          Effect.flatMap(isModelDesktopObservationActive, (active) => {
            scopes.push(active);
            return originalCall(request);
          }),
        );
        yield* call("computer_browser_state", { pid: 123 });
        yield* call("computer_browser_prepare", { allow_launch: true });
        expect(scopes).toEqual([true, false]);
        expect(yield* isModelDesktopObservationActive).toBe(false);
      }),
    ),
  );

  it.effect("registers the whole family on the computer capability with active-turn dispatch", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { tools } = yield* setup();
        expect(tools.map((tool) => tool.definition.name)).toEqual([...COMPUTER_BROWSER_TOOL_NAMES]);
        for (const tool of tools) {
          expect(tool.requiredCapability).toBe("computer");
          expect(tool.requiresActiveTurn).toBe(true);
        }
        const state = tools.find((tool) => tool.definition.name === "computer_browser_state");
        expect(state?.definition.annotations?.readOnlyHint).toBe(true);
        for (const tool of tools) {
          if (tool === state) continue;
          expect(tool.definition.annotations?.readOnlyHint).toBe(false);
        }
      }),
    ),
  );

  it.effect(
    "states the rev-30/31 browser contract: headless default, pid-only bind, isolated_named",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { byName } = yield* setup();
          const prepare = byName.get("computer_browser_prepare");
          expect(prepare?.definition.description).toContain("headless by default");
          expect(prepare?.definition.description).toContain("windowed:true");
          expect(prepare?.definition.description).toContain("isolated_named");
          // No platform may treat visible or personal-profile input as a Linux fallback.
          expect(prepare?.definition.description).toContain("confirmed direct-X11 Escape listener");
          expect(prepare?.definition.description).toContain(
            "only owned isolated headless targets support mutation",
          );
          expect(prepare?.definition.description).toContain(
            "Wayland/XWayland and standalone hosts permit reads/passive prepare only",
          );
          expect(prepare?.definition.description).toContain(
            "Linux refuses visible launch and personal-profile control",
          );
          expect(prepare?.definition.description).not.toContain("Linux cannot launch headlessly");
          expect(prepare?.definition.description).toContain("browser_consent_required");
          const prepareSchema = prepare?.definition.inputSchema as {
            properties?: Record<string, unknown>;
          };
          expect(prepareSchema.properties?.windowed).toBeDefined();
          expect(prepareSchema.properties?.windowed).toMatchObject({
            description: expect.stringContaining(
              "confirmed direct-X11 Escape listener, and refuses true",
            ),
          });
          const state = byName.get("computer_browser_state");
          expect(state?.definition.description).toContain("driver_owned_headless");
          const stateSchema = state?.definition.inputSchema as {
            properties?: { window_id?: { description?: string } };
          };
          expect(stateSchema.properties?.window_id?.description).toContain(
            "Omit it for a driver-owned headless browser",
          );
          expect(stateSchema.properties?.window_id?.description).not.toContain("required with pid");
          const type = byName.get("computer_browser_type");
          const typeSchema = type?.definition.inputSchema as {
            properties?: { input_route?: { enum?: readonly string[] } };
          };
          expect(typeSchema.properties?.input_route?.enum).toEqual(["trusted", "dom_event"]);
        }),
      ),
  );

  it("covers every gateway name with a driver name", () => {
    expect(Object.keys(COMPUTER_BROWSER_DRIVER_NAMES).toSorted()).toEqual(
      [...COMPUTER_BROWSER_TOOL_NAMES].toSorted(),
    );
  });

  it("requires approval for everything except state and dialog inspect", () => {
    expect(computerBrowserToolRequiresApproval("computer_browser_state", {})).toBe(false);
    expect(
      computerBrowserToolRequiresApproval("computer_browser_dialog", { action: "inspect" }),
    ).toBe(false);
    expect(
      computerBrowserToolRequiresApproval("computer_browser_dialog", { action: "accept" }),
    ).toBe(true);
    for (const name of COMPUTER_BROWSER_TOOL_NAMES) {
      if (name === "computer_browser_state" || name === "computer_browser_dialog") continue;
      expect(computerBrowserToolRequiresApproval(name, {})).toBe(true);
    }
  });

  it.effect("binds and snapshots without an approval gate, passing the driver reply through", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { backend, call } = yield* setup();
        const result = yield* call("computer_browser_state", {
          target_id: "t-1",
          tab_id: "tab-1",
        });
        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({ target_id: `fake-browser-${THREAD}` });
        expect(backend.callsFor("browser.get_browser_state")).toHaveLength(1);
      }),
    ),
  );

  it.effect("refuses mutating calls before dispatch when the session has no approval gate", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { backend, call } = yield* setup();
        const result = yield* call("computer_browser_click", {
          target_id: "t",
          tab_id: "tab",
          ref: "p1:0",
        });
        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain("ComputerApprovalRequired");
        expect(backend.calls.filter((entry) => entry.method.startsWith("browser."))).toHaveLength(
          0,
        );
      }),
    ),
  );

  it.effect("surfaces a denial without dispatching", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { backend, call } = yield* setup({
          authorizeAction: () => Effect.succeed("denied"),
        });
        const result = yield* call("computer_browser_type", {
          target_id: "t",
          tab_id: "tab",
          ref: "p1:0",
          text: "hello",
        });
        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain("denied");
        expect(backend.callsFor("browser.browser_type")).toHaveLength(0);
      }),
    ),
  );

  it.effect(
    "returns a non-error pending result without dispatching or auditing while approval waits",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { backend, manager, call } = yield* setup({
            authorizeAction: () => Effect.succeed("pending"),
          });
          const audit = vi.spyOn(manager, "recordComputerAudit");
          const result = yield* call("computer_browser_click", {
            target_id: "t",
            tab_id: "tab",
            ref: "p1:0",
          });
          expect(result.isError).not.toBe(true);
          expect(jsonOf(result)).toMatchObject({
            status: "approval_pending",
            tool: "computer_browser_click",
            message: expect.stringContaining("Pathway"),
          });
          expect(backend.callsFor("browser.browser_click")).toHaveLength(0);
          expect(audit).not.toHaveBeenCalled();
        }),
      ),
  );

  it.effect("reports a full approval queue as approval_queue_full without dispatching", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { backend, manager, call } = yield* setup({
          authorizeAction: () =>
            Effect.fail(new ComputerApprovalQueueFullError({ scope: "thread" })),
        });
        const audit = vi.spyOn(manager, "recordComputerAudit");
        const result = yield* call("computer_browser_click", {
          target_id: "t",
          tab_id: "tab",
          ref: "p1:0",
        });
        expect(result.isError).toBe(true);
        expect(jsonOf(result)).toMatchObject({
          error: { code: "approval_queue_full", retryable: true },
        });
        expect(backend.callsFor("browser.browser_click")).toHaveLength(0);
        expect(audit).toHaveBeenCalledWith(
          expect.objectContaining({ effect: "refused", code: "approval_queue_full" }),
        );
      }),
    ),
  );

  it.effect("refuses as approval-unavailable when the approval card cannot be posted", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { backend, call } = yield* setup({
          authorizeAction: () =>
            Effect.fail(new ComputerApprovalPublishError({ message: "thread gone" })),
        });
        const result = yield* call("computer_browser_click", {
          target_id: "t",
          tab_id: "tab",
          ref: "p1:0",
        });
        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain("ComputerApprovalRequired");
        expect(backend.callsFor("browser.browser_click")).toHaveLength(0);
      }),
    ),
  );

  it.effect.each(["missing", "not requested", "failed"] as const)(
    "refuses a visible browser launch despite full action access when visibility is %s",
    (state) =>
      Effect.scoped(
        Effect.gen(function* () {
          const authorizeAction = vi.fn(approve);
          const { backend, manager, call } = yield* setup({
            authorizeAction,
            ...(state !== "missing"
              ? {
                  resolveForegroundAuthorization: () =>
                    state === "failed"
                      ? Effect.die(new Error("Thread state unavailable"))
                      : Effect.succeed({ userRequestedVisibleUse: false }),
                }
              : {}),
          });
          const audit = vi.spyOn(manager, "recordComputerAudit");
          const result = yield* call("computer_browser_prepare", {
            allow_launch: true,
            windowed: true,
            profile: { mode: "isolated_new" },
          });
          expect(result.isError).toBe(true);
          expect(textOf(result)).toContain("foreground_not_requested");
          expect(authorizeAction).not.toHaveBeenCalled();
          expect(backend.callsFor("browser.browser_prepare")).toHaveLength(0);
          expect(audit).toHaveBeenCalledWith(
            expect.objectContaining({
              effect: "not-dispatched",
              code: "foreground_not_requested",
            }),
          );
        }),
      ),
  );

  it.effect("allows an explicitly requested visible browser and checks the next call again", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let userRequestedVisibleUse = true;
        const visibility = vi.fn((_context: ToolContext) =>
          Effect.sync(() => ({ userRequestedVisibleUse })),
        );
        const { backend, call } = yield* setup({
          authorizeAction: approve,
          resolveForegroundAuthorization: visibility,
        });
        const modes: string[] = [];
        const originalCall = backend.browser!.call;
        vi.spyOn(backend.browser!, "call").mockImplementation((request) =>
          Effect.flatMap(desktopDeliveryMode, (mode) => {
            modes.push(mode);
            return originalCall(request);
          }),
        );
        const args = { allow_launch: true, windowed: true, profile: { mode: "isolated_new" } };
        const allowed = yield* call("computer_browser_prepare", args);
        expect(allowed.isError).not.toBe(true);
        expect(backend.callsFor("browser.browser_prepare")).toHaveLength(1);
        expect(visibility).toHaveBeenCalledWith(
          expect.objectContaining({ callerThreadId: THREAD, callerTurnId: "turn-browser" }),
        );

        userRequestedVisibleUse = false;
        const revoked = yield* call("computer_browser_prepare", args);
        expect(textOf(revoked)).toContain("foreground_not_requested");
        expect(backend.callsFor("browser.browser_prepare")).toHaveLength(1);
        expect(visibility).toHaveBeenCalledTimes(3);
        expect(modes).toEqual(["foreground"]);
        yield* call("computer_browser_prepare", { ...args, windowed: false });
        expect(modes).toEqual(["foreground", "background"]);
      }),
    ),
  );

  it.effect(
    "refuses when visible-use authorization changes while ordinary approval is pending",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          let userRequestedVisibleUse = true;
          const approval = yield* Deferred.make<ComputerApprovalOutcome>();
          const approvalStarted = yield* Deferred.make<void>();
          const visibility = vi.fn((_context: ToolContext) =>
            Effect.sync(() => ({ userRequestedVisibleUse })),
          );
          const { backend, call } = yield* setup({
            authorizeAction: () =>
              Deferred.succeed(approvalStarted, undefined).pipe(
                Effect.andThen(Deferred.await(approval)),
              ),
            resolveForegroundAuthorization: visibility,
          });
          const pending = yield* Effect.forkChild(
            call("computer_browser_prepare", {
              allow_launch: true,
              windowed: true,
              profile: { mode: "isolated_new" },
            }),
          );
          yield* Deferred.await(approvalStarted);
          userRequestedVisibleUse = false;
          yield* Deferred.succeed(approval, "approved");

          const result = yield* Fiber.join(pending);
          expect(textOf(result)).toContain("foreground_not_requested");
          expect(backend.callsFor("browser.browser_prepare")).toHaveLength(0);
          expect(visibility).toHaveBeenCalledTimes(2);
        }),
      ),
  );

  it.effect.each([undefined, false])(
    "keeps a headless launch with windowed:%s independent of visibility",
    (windowed) =>
      Effect.scoped(
        Effect.gen(function* () {
          const visibility = vi.fn((_context: ToolContext) =>
            Effect.succeed({ userRequestedVisibleUse: false }),
          );
          const { backend, call } = yield* setup({
            authorizeAction: approve,
            resolveForegroundAuthorization: visibility,
          });
          const result = yield* call("computer_browser_prepare", {
            allow_launch: true,
            ...(windowed === undefined ? {} : { windowed }),
            profile: { mode: "isolated_new" },
          });
          expect(result.isError).not.toBe(true);
          expect(backend.callsFor("browser.browser_prepare")).toHaveLength(1);
          expect(visibility).not.toHaveBeenCalled();
        }),
      ),
  );

  it.effect("refuses a visible launch when its authorization changes in the browser queue", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let userRequestedVisibleUse = true;
        const visibility = vi.fn((_context: ToolContext) =>
          Effect.sync(() => ({ userRequestedVisibleUse })),
        );
        const firstEntered = yield* Deferred.make<void>();
        const firstRelease = yield* Deferred.make<void>();
        const browserNames: string[] = [];
        const browser = (request: ComputerBrowserCall) =>
          Effect.gen(function* () {
            browserNames.push(request.name);
            if (request.name === "get_browser_state") {
              yield* Deferred.succeed(firstEntered, undefined);
              yield* Deferred.await(firstRelease);
            }
            return { structuredContent: { status: "ok" } };
          });
        const { manager, call } = yield* setup({
          backend: new FakeComputerBackend({ browser }),
          authorizeAction: approve,
          resolveForegroundAuthorization: visibility,
        });
        // Signals once the second call reaches the browser queue.
        const secondQueued = yield* Deferred.make<void>();
        const originalBrowserCall = manager.browserCall.bind(manager);
        let queued = 0;
        vi.spyOn(manager, "browserCall").mockImplementation((...args) => {
          queued += 1;
          const invoke = originalBrowserCall(...args);
          return queued === 2
            ? Effect.andThen(Deferred.succeed(secondQueued, undefined), invoke)
            : invoke;
        });
        const first = yield* Effect.forkChild(
          call("computer_browser_state", { target_id: "t", tab_id: "tab" }),
        );
        yield* Deferred.await(firstEntered);
        const visible = yield* Effect.forkChild(
          call("computer_browser_prepare", {
            allow_launch: true,
            windowed: true,
            profile: { mode: "isolated_new" },
          }),
        );
        yield* Deferred.await(secondQueued);
        expect(visibility).toHaveBeenCalledTimes(1);
        userRequestedVisibleUse = false;
        yield* Deferred.succeed(firstRelease, undefined);

        yield* Fiber.join(first);
        const result = yield* Fiber.join(visible);
        expect(textOf(result)).toContain("foreground_not_requested");
        expect(visibility).toHaveBeenCalledTimes(2);
        expect(browserNames).toEqual(["get_browser_state"]);
      }),
    ),
  );

  it.effect("does not dispatch after cancellation during the admitted browser check", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const checkEntered = yield* Deferred.make<void>();
        const checkRelease = yield* Deferred.make<void>();
        const browser = vi.fn((_call: ComputerBrowserCall) =>
          Effect.succeed({ structuredContent: { status: "ok" } }),
        );
        const { manager } = yield* setup({ backend: new FakeComputerBackend({ browser }) });
        const abort = makeDesktopAbort();
        const pending = yield* Effect.forkChild(
          manager.browserCall(
            THREAD,
            "turn-browser",
            "browser_prepare",
            { windowed: true },
            desktopSignal(abort),
            Deferred.succeed(checkEntered, undefined).pipe(
              Effect.andThen(Deferred.await(checkRelease)),
            ),
          ),
        );
        yield* Deferred.await(checkEntered);
        yield* abortDesktop(abort, new ComputerBackendError({ message: "Caller cancelled" }));
        yield* Deferred.succeed(checkRelease, undefined);
        const exit = yield* Fiber.await(pending);
        expect(Exit.isFailure(exit)).toBe(true);
        expect(String(Exit.isFailure(exit) ? exit.cause : "")).toContain("Caller cancelled");
        expect(browser).not.toHaveBeenCalled();
      }),
    ),
  );

  it.effect.each([
    {
      label: "nested refusal code",
      reply: { structuredContent: { status: "refused", refusal: { code: "browser_ref_stale" } } },
      expected: { effect: "refused", code: "browser_ref_stale" },
    },
    {
      label: "legacy top-level refusal code",
      reply: { structuredContent: { status: "refused", code: "browser_requires_setup" } },
      expected: { effect: "refused", code: "browser_requires_setup" },
    },
    {
      label: "typed refusal carrying isError",
      reply: {
        isError: true,
        structuredContent: { status: "refused", refusal: { code: "browser_consent_required" } },
      },
      expected: { effect: "refused", code: "browser_consent_required" },
    },
    {
      label: "successful dispatch without effect proof",
      reply: { structuredContent: { status: "ok" } },
      expected: { effect: "dispatched-unknown" },
    },
    {
      label: "closed native action refusal",
      reply: { structuredContent: { effect: "refused", route: "dom" } },
      expected: { effect: "refused", code: "browser_refused" },
    },
    {
      label: "DOM readback without application effect proof",
      reply: {
        structuredContent: {
          status: "ok",
          effect: "unverifiable",
          route: "dom_event",
          dispatched: true,
          readback: "matched",
        },
      },
      expected: { effect: "dispatched-unknown" },
    },
  ])("audits $label without upgrading its effect", ({ reply, expected }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = new FakeComputerBackend({ browser: () => Effect.succeed(reply) });
        const { manager, call } = yield* setup({ backend, authorizeAction: approve });
        const audit = vi.spyOn(manager, "recordComputerAudit");
        const result = yield* call("computer_browser_type", {
          target_id: "t",
          tab_id: "tab",
          ref: "p1:0",
          text: "private text",
        });
        expect(result.structuredContent).toEqual(reply.structuredContent);
        expect(audit).toHaveBeenCalledWith(
          expect.objectContaining({ tool: "computer_browser_type", ...expected }),
        );
        expect(encodeJson(audit.mock.calls)).not.toContain("private text");
      }),
    ),
  );

  it.effect("records a proven navigation without issuing another browser call", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const args = { target_id: "bt-1", tab_id: "tab-1", url: "https://example.test/" };
        const backend = new FakeComputerBackend({
          browser: () =>
            Effect.succeed({
              structuredContent: {
                status: "ok",
                ...args,
                verification: {
                  scope: "navigation",
                  method: "page_frame_tree",
                  status: "confirmed",
                },
              },
            }),
        });
        const { manager, call } = yield* setup({ backend, authorizeAction: approve });
        const audit = vi.spyOn(manager, "recordComputerAudit");
        yield* call("computer_browser_navigate", args);
        expect(audit).toHaveBeenCalledWith(
          expect.objectContaining({
            tool: "computer_browser_navigate",
            effect: "verified",
          }),
        );
        expect(backend.calls.filter((entry) => entry.method.startsWith("browser."))).toHaveLength(
          1,
        );
      }),
    ),
  );

  it.effect("reports field readback without claiming submission succeeded", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const structuredContent = {
          effect: "unverifiable",
          route: "dom",
          evidence: [{ kind: "value_readback" }],
        };
        const backend = new FakeComputerBackend({
          browser: () =>
            Effect.succeed({
              structuredContent,
              content: [{ type: "text", text: "legacy dispatch summary" }],
            }),
        });
        const { manager, call } = yield* setup({ backend, authorizeAction: approve });
        const audit = vi.spyOn(manager, "recordComputerAudit");
        const result = yield* call("computer_browser_type", {
          target_id: "bt-1",
          tab_id: "tab-1",
          ref: "p1:2",
          text: "private value",
          input_route: "dom_event",
          replace: true,
        });
        expect(result.structuredContent).toEqual(structuredContent);
        expect(textOf(result)).toContain("Field value matched; application effect unverified");
        expect(textOf(result)).not.toContain("private value");
        expect(audit).toHaveBeenCalledWith(
          expect.objectContaining({ effect: "dispatched-unknown" }),
        );
      }),
    ),
  );

  it.effect(
    "offers one honest next step after unsupported profile attachment without launching it",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const backend = new FakeComputerBackend({
            browser: () =>
              Effect.succeed({
                structuredContent: {
                  status: "refused",
                  refusal: {
                    code: "browser_consent_required",
                    message: "consent provider absent",
                  },
                },
              }),
          });
          const { call } = yield* setup({ backend, authorizeAction: approve });
          const result = yield* call("computer_browser_prepare", { pid: 42 });
          expect(result.structuredContent).toMatchObject({
            status: "refused",
            refusal: { code: "browser_consent_required" },
          });
          expect(textOf(result)).toContain("cannot attach to your existing browser profile");
          expect(textOf(result)).toContain(
            'computer_browser_prepare({allow_launch:true,profile:{mode:"isolated_new"',
          );
          expect(textOf(result)).toContain("without your cookies");
          expect(textOf(result)).toContain(
            "Do not substitute it when the task requires your existing profile",
          );
          expect(backend.callsFor("browser.browser_prepare")).toHaveLength(1);
        }),
      ),
  );

  it.effect("asks the gate once per mutating call and dispatches the mapped driver name", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const seen: ComputerBrowserCall[] = [];
        const backend = new FakeComputerBackend({
          browser: (call) =>
            Effect.sync(() => {
              seen.push(call);
              return { structuredContent: { status: "ok" } };
            }),
        });
        const asked: string[] = [];
        const { call } = yield* setup({
          backend,
          authorizeAction: (name) =>
            Effect.sync(() => {
              asked.push(name);
              return "approved" as const;
            }),
        });
        const result = yield* call("computer_browser_click", {
          target_id: "t",
          tab_id: "tab",
          ref: "p1:0",
        });
        expect(result.isError).not.toBe(true);
        expect(asked).toEqual(["computer_browser_click"]);
        expect(seen).toHaveLength(1);
        expect(seen[0]?.name).toBe("browser_click");
        expect(seen[0]?.task).toMatchObject({ threadId: THREAD, turnId: "turn-browser" });
        expect(seen[0]?.mutation).toBe(true);
      }),
    ),
  );

  it.effect("treats a driver refusal as a result, never a tool error", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = new FakeComputerBackend({
          browser: () =>
            Effect.succeed({
              structuredContent: {
                status: "refused",
                refusal: { code: "browser_requires_setup", message: "Prepare a browser first." },
              },
              content: [{ type: "text", text: "refused (browser_requires_setup)" }],
            }),
        });
        const { call } = yield* setup({ backend });
        const result = yield* call("computer_browser_state", {
          target_id: "t",
          tab_id: "tab",
        });
        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({
          status: "refused",
          refusal: { code: "browser_requires_setup" },
        });
      }),
    ),
  );

  it.effect("marks get_browser_state non-mutating on the wire but mutating otherwise", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const seen: ComputerBrowserCall[] = [];
        const backend = new FakeComputerBackend({
          browser: (call) =>
            Effect.sync(() => {
              seen.push(call);
              return {};
            }),
        });
        const { call } = yield* setup({ backend, authorizeAction: approve });
        yield* call("computer_browser_state", { target_id: "t", tab_id: "tab" });
        yield* call("computer_browser_dialog", {
          target_id: "t",
          tab_id: "tab",
          action: "inspect",
        });
        yield* call("computer_browser_navigate", {
          target_id: "t",
          tab_id: "tab",
          url: "https://example.com/",
        });
        expect(seen.map((entry) => [entry.name, entry.mutation])).toEqual([
          ["get_browser_state", false],
          ["browser_dialog", true],
          ["browser_navigate", true],
        ]);
      }),
    ),
  );

  it.effect(
    "refuses an upload that resolves outside the workspace before it reaches the driver",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "pathway-browser-ws-" });
          const outside = yield* fs.makeTempDirectoryScoped({
            prefix: "pathway-browser-outside-",
          });
          const file = path.join(outside, "secret.txt");
          yield* fs.writeFileString(file, "x");
          const { backend, call } = yield* setup({
            authorizeAction: approve,
            resolveWorkspaceRoot: () => Effect.succeed(root),
          });
          const result = yield* call("computer_browser_upload", {
            target_id: "t",
            tab_id: "tab",
            ref: "p1:0",
            files: [file],
          });
          expect(result.isError).toBe(true);
          expect(textOf(result)).toContain("outside the active workspace");
          expect(backend.callsFor("browser.browser_set_input_files")).toHaveLength(0);
        }),
      ),
  );

  it.effect("canonicalizes workspace upload paths before dispatch", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "pathway-browser-ws-" });
        const file = path.join(root, "attach.txt");
        yield* fs.writeFileString(file, "x");
        const seen: ComputerBrowserCall[] = [];
        const backend = new FakeComputerBackend({
          browser: (call) =>
            Effect.sync(() => {
              seen.push(call);
              return { structuredContent: { status: "ok" } };
            }),
        });
        const { call } = yield* setup({
          backend,
          authorizeAction: approve,
          resolveWorkspaceRoot: () => Effect.succeed(root),
        });
        const result = yield* call("computer_browser_upload", {
          target_id: "t",
          tab_id: "tab",
          ref: "p1:0",
          files: [file],
        });
        expect(result.isError).not.toBe(true);
        expect(seen[0]?.name).toBe("browser_set_input_files");
        // The driver receives the canonical path — /var resolves to /private/var
        // on macOS — so a symlink can never widen the approved set.
        expect(seen[0]?.args.files).toEqual([yield* fs.realPath(file)]);
      }),
    ),
  );

  it.effect("refuses file transfer tools outright when no workspace boundary exists", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { backend, call } = yield* setup({ authorizeAction: approve });
        const upload = yield* call("computer_browser_upload", {
          target_id: "t",
          tab_id: "tab",
          ref: "p1:0",
          files: ["/tmp/anything.txt"],
        });
        expect(upload.isError).toBe(true);
        expect(textOf(upload)).toContain("No canonical workspace");
        const download = yield* call("computer_browser_download", {
          target_id: "t",
          tab_id: "tab",
          ref: "p1:0",
          destination_root: "/tmp",
        });
        expect(download.isError).toBe(true);
        expect(backend.calls.filter((entry) => entry.method.startsWith("browser."))).toHaveLength(
          0,
        );
      }),
    ),
  );

  it.effect("bounds the download destination to the workspace", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "pathway-browser-ws-" });
        const seen: ComputerBrowserCall[] = [];
        const backend = new FakeComputerBackend({
          browser: (call) =>
            Effect.sync(() => {
              seen.push(call);
              return { structuredContent: { status: "ok" } };
            }),
        });
        const { call } = yield* setup({
          backend,
          authorizeAction: approve,
          resolveWorkspaceRoot: () => Effect.succeed(root),
        });
        const denied = yield* call("computer_browser_download", {
          target_id: "t",
          tab_id: "tab",
          ref: "p1:0",
          destination_root: path.dirname(root),
        });
        expect(denied.isError).toBe(true);
        const allowed = yield* call("computer_browser_download", {
          target_id: "t",
          tab_id: "tab",
          ref: "p1:0",
          destination_root: root,
        });
        expect(allowed.isError).not.toBe(true);
        expect(seen.map((entry) => entry.name)).toEqual(["browser_download"]);
      }),
    ),
  );

  it.effect("reports no browser route on a desktop-only backend", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = new FakeComputerBackend();
        const { manager, call } = yield* setup({ backend });
        expect(manager.supportsBrowser).toBe(false);
        const result = yield* call("computer_browser_state", { target_id: "t", tab_id: "tab" });
        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain("does not provide browser automation");
      }),
    ),
  );

  it.effect("ends the driver browser session when the thread is removed", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = new FakeComputerBackend({ browser: true });
        const { manager, call } = yield* setup({ backend });
        yield* call("computer_browser_state", { target_id: "t", tab_id: "tab" });
        yield* manager.handleThreadRemoved(THREAD);
        expect(backend.callsFor("browser.endThread").map((entry) => entry.args[0])).toEqual([
          THREAD,
        ]);
      }),
    ),
  );
});

it.layer(NodeServices.layer)("browser id ergonomics", (it) => {
  const oneTab = [{ tab_id: "tab-1", active: true, title: "about:blank", url: "about:blank" }];
  const bindOr = (tabs: ReadonlyArray<Record<string, unknown>>) =>
    new FakeComputerBackend({
      browser: (call) =>
        Effect.succeed(
          call.name === "get_browser_state"
            ? bindingResult(tabs)
            : { structuredContent: { status: "ok" } },
        ),
    });

  it.effect.each([
    { pid: 42, window_id: 99 },
    { target_id: "", tab_id: "tab-1" },
    { target_id: "bt-1", tab_id: "tab-1", pid: 42, window_id: 99 },
  ])("refuses native window identities on browser actions before approval or dispatch", (scope) =>
    Effect.scoped(
      Effect.gen(function* () {
        const authorizeAction = vi.fn(approve);
        const { backend, call, manager } = yield* setup({ authorizeAction });
        const audit = vi.spyOn(manager, "recordComputerAudit");
        const result = yield* call("computer_browser_navigate", {
          ...scope,
          url: "https://example.com/",
        });
        expect(result.structuredContent).toMatchObject({
          status: "refused",
          refusal: { code: "browser_target_required" },
        });
        expect(textOf(result)).toContain("If the bind was refused");
        expect(textOf(result)).not.toContain("computer_browser_prepare");
        expect(authorizeAction).not.toHaveBeenCalled();
        expect(backend.callsFor("browser.browser_navigate")).toHaveLength(0);
        expect(audit).toHaveBeenCalledWith(
          expect.objectContaining({ effect: "refused", code: "browser_target_required" }),
        );
      }),
    ),
  );

  it.effect("explains a pid-only bind refusal without suggesting an invalid navigation scope", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = new FakeComputerBackend({
          browser: () =>
            Effect.succeed({
              structuredContent: {
                status: "refused",
                refusal: {
                  code: "browser_wrong_target_refused",
                  detail: { headless_driver_owned: false },
                },
              },
            }),
        });
        const { call } = yield* setup({ backend });
        const result = yield* call("computer_browser_state", { pid: 42 });
        expect(result.structuredContent).toMatchObject({
          status: "refused",
          refusal: {
            code: "browser_wrong_target_refused",
            detail: { headless_driver_owned: false },
          },
        });
        expect(textOf(result)).toContain("computer_browser_state({pid,window_id})");
        expect(textOf(result)).toContain("Only a successful bind returns target_id");
        expect(textOf(result)).toContain("do not send pid/window_id to browser actions");
        expect(textOf(result)).not.toContain("computer_browser_prepare");
      }),
    ),
  );

  it.effect(
    "labels target_id and tab_id in the bind result instead of leaving the model to guess",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { call } = yield* setup({ backend: bindOr(oneTab) });
          const result = yield* call("computer_browser_state", { pid: 33_526, window_id: 8_196 });
          expect(result.isError).not.toBe(true);
          expect(result.structuredContent).toMatchObject({ target_id: "bt-1", tab_id: "tab-1" });
          expect(textOf(result)).toContain("target_id=bt-1");
          expect(textOf(result)).toContain("tab_id=tab-1");
        }),
      ),
  );

  it.effect("resolves an omitted tab_id in navigate from the last bind", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = bindOr(oneTab);
        const { call } = yield* setup({ backend, authorizeAction: approve });
        yield* call("computer_browser_state", { pid: 33_526, window_id: 8_196 });
        const result = yield* call("computer_browser_navigate", {
          target_id: "bt-1",
          url: "https://www.newegg.com/",
        });
        expect(result.isError).not.toBe(true);
        const navigations = backend.callsFor("browser.browser_navigate");
        expect(navigations).toHaveLength(1);
        expect(navigations[0]?.args[0]).toMatchObject({ target_id: "bt-1", tab_id: "tab-1" });
      }),
    ),
  );

  it.effect("resolves an omitted tab_id in a snapshot from the same bind", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = bindOr(oneTab);
        const { call } = yield* setup({ backend });
        yield* call("computer_browser_state", { pid: 33_526, window_id: 8_196 });
        yield* call("computer_browser_state", { target_id: "bt-1" });
        const states = backend.callsFor("browser.get_browser_state");
        expect(states).toHaveLength(2);
        expect(states[1]?.args[0]).toMatchObject({ target_id: "bt-1", tab_id: "tab-1" });
      }),
    ),
  );

  it.effect("defaults to the single active tab when several are open", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = bindOr([
          { tab_id: "tab-a", active: false },
          { tab_id: "tab-b", active: true },
        ]);
        const { call } = yield* setup({ backend, authorizeAction: approve });
        const bound = yield* call("computer_browser_state", { pid: 1, window_id: 2 });
        expect(bound.structuredContent).toMatchObject({ tab_id: "tab-b" });
        yield* call("computer_browser_navigate", {
          target_id: "bt-1",
          url: "https://example.com/",
        });
        expect(backend.callsFor("browser.browser_navigate")[0]?.args[0]).toMatchObject({
          tab_id: "tab-b",
        });
      }),
    ),
  );

  it.effect("refuses an ambiguous target with its tab listing and dispatches nothing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = bindOr([
          { tab_id: "tab-a", active: false },
          { tab_id: "tab-b", active: false },
        ]);
        const { call } = yield* setup({ backend, authorizeAction: approve });
        yield* call("computer_browser_state", { pid: 1, window_id: 2 });
        const result = yield* call("computer_browser_navigate", {
          target_id: "bt-1",
          url: "https://example.com/",
        });
        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({
          status: "refused",
          refusal: { code: "browser_tab_required" },
        });
        expect(textOf(result)).toContain("tab-a");
        expect(textOf(result)).toContain("tab-b");
        expect(backend.callsFor("browser.browser_navigate")).toHaveLength(0);
      }),
    ),
  );

  it.effect("refuses an omitted tab_id for a target this thread never bound", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = new FakeComputerBackend({ browser: true });
        const { call } = yield* setup({ backend, authorizeAction: approve });
        const result = yield* call("computer_browser_navigate", {
          target_id: "bt-never-bound",
          url: "https://example.com/",
        });
        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({
          status: "refused",
          refusal: { code: "browser_tab_required" },
        });
        expect(backend.callsFor("browser.browser_navigate")).toHaveLength(0);
      }),
    ),
  );

  it.effect("does not resolve a target that belongs to another thread", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = bindOr(oneTab);
        const { call } = yield* setup({ backend, authorizeAction: approve });
        yield* call("computer_browser_state", { pid: 1, window_id: 2 }, THREAD);
        const result = yield* call(
          "computer_browser_navigate",
          { target_id: "bt-1", url: "https://example.com/" },
          "other-thread",
        );
        expect(result.structuredContent).toMatchObject({
          refusal: { code: "browser_tab_required" },
        });
        expect(backend.callsFor("browser.browser_navigate")).toHaveLength(0);
      }),
    ),
  );

  it.effect("explains a swapped target/tab id when the driver cannot find the tab", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = new FakeComputerBackend({
          browser: () =>
            Effect.succeed({
              structuredContent: {
                status: "refused",
                refusal: {
                  code: "browser_tab_not_found",
                  message: "tab bt-85991064 is not known for target bt-85991064",
                },
              },
            }),
        });
        const { call } = yield* setup({ backend, authorizeAction: approve });
        const result = yield* call("computer_browser_navigate", {
          target_id: "bt-85991064",
          tab_id: "bt-85991064",
          url: "https://example.com/",
        });
        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({
          status: "refused",
          refusal: { code: "browser_tab_not_found" },
        });
        expect(textOf(result)).toContain("is a target id, not a tab id");
        expect(textOf(result)).toContain("tab-");
      }),
    ),
  );

  it.effect(
    "labels the bind key on a prepare result and leaves tab_id optional on target tools",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const backend = new FakeComputerBackend({
            browser: (call) =>
              Effect.succeed(
                call.name === "browser_prepare"
                  ? {
                      structuredContent: {
                        status: "ok",
                        prepared: true,
                        prepared_pid: 33_526,
                        action: "launched_isolated_browser",
                      },
                    }
                  : { structuredContent: { status: "ok" } },
              ),
          });
          const { call, byName } = yield* setup({ backend, authorizeAction: approve });
          const prepared = yield* call("computer_browser_prepare", {
            allow_launch: true,
            profile: { mode: "isolated_new" },
          });
          expect(textOf(prepared)).toContain("prepared_pid=33526");
          expect(textOf(prepared)).toContain("computer_browser_state");
          expect(textOf(prepared)).toContain("takes pid alone");
          for (const name of [
            "computer_browser_navigate",
            "computer_browser_click",
            "computer_browser_type",
            "computer_browser_dialog",
            "computer_browser_upload",
            "computer_browser_download",
            "computer_browser_pointer",
            "computer_browser_press",
          ]) {
            const required = byName.get(name)?.definition.inputSchema.required as string[];
            expect(required).toContain("target_id");
            expect(required).not.toContain("tab_id");
          }
        }),
      ),
  );
});
