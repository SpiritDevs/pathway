import { assert, it } from "@effect/vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import {
  CommandId,
  type ComputerAccessPolicy,
  type ComputerAutonomy,
  EnvironmentId,
  EventId,
  MessageId,
  NodeId,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@spiritdevs/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import {
  ComputerApprovalsTestLayer,
  pendingComputerRequest,
  seedRunningTurn,
} from "../computer/computerApprovals.testkit.ts";
import { ComputerApprovalGate } from "../computer/ComputerApprovalGate.ts";
import { ComputerManager } from "../computer/ComputerManager.ts";
import { FakeComputerBackend } from "../computer/FakeComputerBackend.ts";
import { ComputerService } from "../computer/Services/ComputerService.ts";
import { EventSinkV2 } from "../orchestration-v2/EventSink.ts";
import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import { ProjectionStoreV2 } from "../orchestration-v2/ProjectionStore.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { type ComputerMcpTools, makeComputerMcpTools } from "./computerMcpTools.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import type { McpCapability, McpInvocationScope } from "./McpInvocationContext.ts";
import type { McpToolCallResult } from "./toolkits/computer/toolRuntime.ts";

const backend = new FakeComputerBackend();

const ComputerServiceTest = Layer.effect(
  ComputerService,
  Effect.gen(function* () {
    const manager = yield* ComputerManager.make({
      backend,
      actionSettleMs: 0,
      approvals: yield* ComputerApprovalGate,
    });
    return { supported: true, availability: { kind: "available", backend: "fake" }, manager };
  }),
);

const TestLayer = ComputerServiceTest.pipe(Layer.provideMerge(ComputerApprovalsTestLayer));

const invocationFor = (
  threadId: ThreadId,
  capabilities: ReadonlyArray<McpCapability>,
): McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-computer-mcp-test"),
  threadId,
  providerSessionId: `${threadId}-session`,
  providerInstanceId: ProviderInstanceId.make("codex"),
  providerDriverKind: ProviderDriverKind.make("codex"),
  capabilities: new Set(capabilities),
  issuedAt: 1,
});

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const errorCode = (result: McpToolCallResult | undefined) => {
  const first = result?.content[0];
  return first?.type === "text" && result?.isError === true
    ? (/"(?:code|error)": ?"([a-z_]+)"/u.exec(first.text)?.[1] ?? null)
    : null;
};

/** How a scheduled run and a subagent look to Computer. */
const unattended = {
  subagent: (projection: OrchestrationV2ThreadProjection) => ({
    ...projection,
    thread: {
      ...projection.thread,
      lineage: { ...projection.thread.lineage, relationshipToParent: "subagent" as const },
    },
  }),
  scheduled: (projection: OrchestrationV2ThreadProjection) => ({
    ...projection,
    runs: projection.runs.map((run) => ({
      ...run,
      userMessageId: MessageId.make(`scheduled-task-message:${run.id}`),
    })),
  }),
};

/** Accepts the thread's pending Computer card once it lands. */
const acceptCard = Effect.fn("acceptCard")(function* (threadId: ThreadId, commandId: string) {
  const { request } = yield* pendingComputerRequest(threadId);
  yield* (yield* OrchestratorV2).dispatch({
    type: "runtime-request.respond",
    commandId: CommandId.make(commandId),
    threadId,
    requestId: request.id,
    decision: "accept",
  });
});

const noticesOf = (items: ReadonlyArray<OrchestrationV2TurnItem>, toolName: string) =>
  items.filter((item) => item.type === "dynamic_tool" && item.toolName === toolName);

const callsTo = (method: string) => backend.calls.filter((call) => call.method === method).length;

/** The seeded run as the projection holds it. */
const seededRun = Effect.fn("seededRun")(function* (threadId: ThreadId, runId: RunId) {
  const projection = yield* (yield* OrchestratorV2).getThreadProjection(threadId);
  const run = projection.runs.find((candidate) => candidate.id === runId);
  if (run === undefined) return yield* Effect.die("the seeded run is missing");
  return run;
});

/** Holds the backend's target lookups, for the test, until `release`; `targeting` marks the first. */
const holdTargeting = Effect.fn("holdTargeting")(function* () {
  const targeting = yield* Deferred.make<void>();
  const release = yield* Deferred.make<void>();
  const original = backend.getState.bind(backend);
  backend.getState = (options) =>
    Deferred.succeed(targeting, undefined).pipe(
      Effect.andThen(Deferred.await(release)),
      Effect.andThen(original(options)),
    );
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      backend.getState = original;
    }),
  );
  return { targeting, release };
});

const clickDisplay = (tools: ComputerMcpTools, threadId: ThreadId) =>
  tools.call({
    invocation: invocationFor(threadId, ["computer"]),
    name: "computer_click",
    args: { window_id: "fake-calculator", label: "Display", include_screenshot: false },
    jsonRpcRequestId: 1,
  });

/**
 * Tools reading an environment ceiling the test can change between steps, and
 * thread projections as `reshape` presents them.
 */
const toolsUnderCeiling = Effect.fn("toolsUnderCeiling")(function* (
  ceiling: ComputerAutonomy,
  reshape: (projection: OrchestrationV2ThreadProjection) => OrchestrationV2ThreadProjection = (
    projection,
  ) => projection,
) {
  const settings = yield* ServerSettingsService;
  const projections = yield* ProjectionStoreV2;
  const policy = { autonomy: ceiling };
  const tools = yield* makeComputerMcpTools.pipe(
    Effect.provideService(ProjectionStoreV2, {
      ...projections,
      getThreadProjection: (threadId) =>
        projections.getThreadProjection(threadId).pipe(Effect.map(reshape)),
    }),
    Effect.provideService(ServerSettingsService, {
      ...settings,
      getSettings: settings.getSettings.pipe(
        Effect.map((current) => ({
          ...current,
          computer: { ...current.computer, autonomy: policy.autonomy },
        })),
      ),
    }),
  );
  return { tools, policy };
});

it.layer(TestLayer)("computerMcpTools", (it) => {
  it.effect.each(["the caller hangs up", "the caller cancels", "the endpoint shuts down"] as const)(
    "interrupts a running Computer call when %s",
    (trigger) =>
      Effect.scoped(
        Effect.gen(function* () {
          const started = yield* Deferred.make<void>();
          const interrupted = yield* Deferred.make<void>();
          const handler = yield* McpHttpServer.makeComputerTestHandler({
            advertised: [],
            handles: () => true,
            call: () =>
              Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
              ),
          });
          const invocation = invocationFor(ThreadId.make("thread-cancel"), ["computer"]);
          const post = (body: object, signal?: AbortSignal) =>
            handler.fetch(
              new Request("http://pathway.test/mcp", {
                method: "POST",
                headers: {
                  "content-type": "application/json",
                  accept: "application/json, text/event-stream",
                },
                body: encodeJson(body),
                ...(signal === undefined ? {} : { signal }),
              }),
              invocation,
            );
          const hangUp = new AbortController();
          const response = post(
            {
              jsonrpc: "2.0",
              id: 7,
              method: "tools/call",
              params: { name: "computer_click", arguments: {} },
            },
            hangUp.signal,
          );
          yield* Deferred.await(started);
          switch (trigger) {
            case "the caller hangs up":
              hangUp.abort();
              break;
            case "the caller cancels":
              yield* Effect.promise(() =>
                post({
                  jsonrpc: "2.0",
                  method: "notifications/cancelled",
                  params: { requestId: 7 },
                }),
              );
              break;
            case "the endpoint shuts down":
              yield* Effect.promise(() => handler.close());
              break;
          }
          yield* Deferred.await(interrupted);
          const answer = decodeJson(yield* Effect.promise(async () => (await response).text()));
          assert.deepInclude(answer, {
            id: 7,
            error: { code: -32800, message: "Request cancelled." },
          });
        }),
      ),
  );

  it.effect("lists computer_* when the switch is on and drops them when it is off", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const handler = yield* McpHttpServer.makeComputerTestHandler(yield* makeComputerMcpTools);
        const { threadId } = yield* seedRunningTurn("listing");
        const listFor = (capabilities: ReadonlyArray<McpCapability>) =>
          Effect.promise(async () => {
            const client = new Client(
              { name: "computer-mcp-test", version: "1.0.0" },
              {
                capabilities: {},
                versionNegotiation: { mode: { pin: McpHttpServer.MCP_PROTOCOL_VERSION } },
              },
            );
            const invocation = invocationFor(threadId, capabilities);
            await client.connect(
              new StreamableHTTPClientTransport(new URL("http://pathway.test/mcp"), {
                fetch: (input, init) =>
                  handler.fetch(
                    new Request(typeof input === "string" ? input : input.href, init),
                    invocation,
                  ),
              }),
            );
            const { tools } = await client.listTools();
            // Only reached by name: a permitted click would wait on its card.
            const denied = capabilities.includes("computer")
              ? undefined
              : await client.callTool({ name: "computer_click", arguments: {} });
            await client.close();
            return { names: tools.map((tool) => tool.name), denied };
          });

        const on = yield* listFor(["computer"]);
        assert.include(on.names, "computer_click");
        // Discovery-only tools are callable by name but never advertised.
        assert.notInclude(on.names, "computer_move_cursor");

        const off = yield* listFor([]);
        assert.isFalse(off.names.some((name) => name.startsWith("computer_")));
        assert.equal(errorCode(off.denied as McpToolCallResult), "capability_denied");
      }),
    ),
  );

  it.effect("refuses a caller without the capability and tells the human once", () =>
    Effect.gen(function* () {
      const tools = yield* makeComputerMcpTools;
      const orchestrator = yield* OrchestratorV2;
      const { threadId } = yield* seedRunningTurn("denied");
      const call = (jsonRpcRequestId: number) =>
        tools.call({
          invocation: invocationFor(threadId, []),
          name: "computer_click",
          args: { x: 1, y: 1 },
          jsonRpcRequestId,
        });
      assert.equal(errorCode(yield* call(1)), "capability_denied");
      assert.equal(errorCode(yield* call(2)), "capability_denied");
      const projection = yield* orchestrator.getThreadProjection(threadId);
      assert.lengthOf(noticesOf(projection.turnItems, "computer_capability_denied"), 1);
    }),
  );

  it.effect("lets an interrupt through a notice it was posting", () =>
    Effect.gen(function* () {
      const eventSink = yield* EventSinkV2;
      const tools = yield* makeComputerMcpTools.pipe(
        Effect.provideService(EventSinkV2, { ...eventSink, write: () => Effect.interrupt }),
      );
      const { threadId } = yield* seedRunningTurn("notice-interrupt");
      const exit = yield* Effect.exit(
        tools.call({
          invocation: invocationFor(threadId, []),
          name: "computer_click",
          args: { x: 1, y: 1 },
          jsonRpcRequestId: 1,
        }),
      );
      assert.isTrue(Exit.hasInterrupts(exit));
    }),
  );

  it.effect("leaves an unknown name to the SDK for a permitted caller", () =>
    Effect.gen(function* () {
      const tools = yield* makeComputerMcpTools;
      const { threadId } = yield* seedRunningTurn("unknown");
      const result = yield* tools.call({
        invocation: invocationFor(threadId, ["computer"]),
        name: "computer_not_a_tool",
        args: {},
        jsonRpcRequestId: 1,
      });
      assert.isUndefined(result);
    }),
  );

  it.effect("refuses a call whose thread has no running turn", () =>
    Effect.gen(function* () {
      const tools = yield* makeComputerMcpTools;
      const result = yield* tools.call({
        invocation: invocationFor(ThreadId.make("idle-thread"), ["computer"]),
        name: "computer_list_windows",
        args: {},
        jsonRpcRequestId: 1,
      });
      assert.equal(errorCode(result), "caller_turn_inactive");
    }),
  );

  it.effect("holds a full-access thread to the environment's per-task ceiling", () =>
    Effect.gen(function* () {
      const tools = yield* makeComputerMcpTools;
      const orchestrator = yield* OrchestratorV2;
      const { threadId } = yield* seedRunningTurn("ceiling", "full-access");
      const call = (name: string, args: Record<string, unknown>) =>
        tools.call({
          invocation: invocationFor(threadId, ["computer"]),
          name,
          args,
          jsonRpcRequestId: 1,
        });
      const typedBefore = callsTo("typeText");
      const waiting = yield* Effect.forkChild(
        call("computer_type_text", { text: "ceiling", include_screenshot: false }),
      );
      const { request, projection } = yield* pendingComputerRequest(threadId);
      const card = projection.turnItems.find(
        (item) => item.type === "approval_request" && item.requestId === request.id,
      );
      assert.equal(
        card?.type === "approval_request" ? card.prompt : null,
        "Allow Computer for this task",
      );
      yield* orchestrator.dispatch({
        type: "runtime-request.respond",
        commandId: CommandId.make("ceiling-respond"),
        threadId,
        requestId: request.id,
        decision: "accept",
      });
      const typed = yield* Fiber.join(waiting);
      assert.notEqual(typed?.isError, true);
      assert.equal(callsTo("typeText"), typedBefore + 1);

      // The task's consent now covers a discovery-only tool called by name.
      const movedBefore = callsTo("moveCursor");
      yield* call("computer_screenshot", { window_id: "fake-terminal" });
      const moved = yield* call("computer_move_cursor", { x: 10, y: 10 });
      assert.notEqual(moved?.isError, true);
      assert.equal(callsTo("moveCursor"), movedBefore + 1);
      yield* (yield* ComputerService).manager.releaseDesktopControl(threadId);
    }),
  );
  it.effect("lets a full-access task raise a window only when the ceiling is full access too", () =>
    Effect.gen(function* () {
      const { manager } = yield* ComputerService;
      const { tools, policy } = yield* toolsUnderCeiling("auto");
      const { threadId } = yield* seedRunningTurn("foreground-full-access", "full-access");
      const activate = () =>
        tools.call({
          invocation: invocationFor(threadId, ["computer"]),
          name: "computer_activate_window",
          args: { window_id: "fake-terminal", include_screenshot: false },
          jsonRpcRequestId: 1,
        });
      assert.equal(errorCode(yield* activate()), "foreground_not_requested");
      policy.autonomy = "full-access";
      const raised = yield* activate();
      assert.notEqual(raised?.isError, true);
      yield* manager.releaseDesktopControl(threadId);
    }),
  );
  it.effect.each(["subagent", "scheduled"] as const)(
    "keeps a %s caller to the environment ceiling alone",
    (kind) =>
      Effect.gen(function* () {
        const { manager } = yield* ComputerService;
        const { tools, policy } = yield* toolsUnderCeiling("auto", unattended[kind]);
        // A supervised thread mode would ask; the ceiling alone governs an unattended run.
        const { threadId } = yield* seedRunningTurn(`unattended-${kind}`, "approval-required");
        const type = () =>
          tools.call({
            invocation: invocationFor(threadId, ["computer"]),
            name: "computer_type_text",
            args: { text: kind, window_id: "fake-terminal", include_screenshot: false },
            jsonRpcRequestId: 1,
          });
        const typedBefore = callsTo("typeText");
        assert.equal(errorCode(yield* type()), "unattended_not_allowed");
        assert.equal(callsTo("typeText"), typedBefore);

        policy.autonomy = "full-access";
        const typed = yield* type();
        assert.notEqual(typed?.isError, true);
        assert.equal(callsTo("typeText"), typedBefore + 1);
        yield* manager.releaseDesktopControl(threadId);
      }),
  );
  it.effect("refuses a call approved before its card's ceiling tightened", () =>
    Effect.gen(function* () {
      const { manager } = yield* ComputerService;
      const { tools, policy } = yield* toolsUnderCeiling("per-task");
      const { threadId } = yield* seedRunningTurn("tightened-while-asking", "full-access");
      const type = () =>
        tools.call({
          invocation: invocationFor(threadId, ["computer"]),
          name: "computer_type_text",
          args: { text: "tightened", window_id: "fake-terminal", include_screenshot: false },
          jsonRpcRequestId: 1,
        });
      const typedBefore = callsTo("typeText");
      const waiting = yield* Effect.forkChild(type());
      yield* pendingComputerRequest(threadId);
      policy.autonomy = "supervised";
      yield* acceptCard(threadId, "tightened-while-asking-accept");
      assert.equal(errorCode(yield* Fiber.join(waiting)), "computer_policy_changed");
      assert.equal(callsTo("typeText"), typedBefore);

      // Called again, it asks under the new policy.
      const retry = yield* Effect.forkChild(type());
      yield* acceptCard(threadId, "tightened-while-asking-retry");
      assert.notEqual((yield* Fiber.join(retry))?.isError, true);
      assert.equal(callsTo("typeText"), typedBefore + 1);
      yield* manager.releaseDesktopControl(threadId);
    }),
  );

  it.effect("refuses a queued call whose ceiling tightened while it waited for the desktop", () =>
    Effect.gen(function* () {
      const { manager } = yield* ComputerService;
      const gate = yield* ComputerApprovalGate;
      const { threadId, runId } = yield* seedRunningTurn("tightened-in-queue", "full-access");
      const held = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const holder = yield* Effect.forkChild(
        manager.withAgentActivity(
          threadId,
          Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release))),
          undefined,
          runId,
        ),
      );
      yield* Deferred.await(held);
      const approved = yield* Deferred.make<void>();
      const { tools, policy } = yield* toolsUnderCeiling("full-access").pipe(
        Effect.provideService(ComputerApprovalGate, {
          ...gate,
          authorizeAction: (input) =>
            gate
              .authorizeAction(input)
              .pipe(Effect.tap(() => Deferred.succeed(approved, undefined))),
        }),
      );
      const typedBefore = callsTo("typeText");
      const queued = yield* Effect.forkChild(
        tools.call({
          invocation: invocationFor(threadId, ["computer"]),
          name: "computer_type_text",
          args: { text: "queued", window_id: "fake-terminal", include_screenshot: false },
          jsonRpcRequestId: 1,
        }),
      );
      yield* Deferred.await(approved);
      policy.autonomy = "supervised";
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(holder);
      assert.equal(errorCode(yield* Fiber.join(queued)), "computer_policy_changed");
      assert.equal(callsTo("typeText"), typedBefore);
      yield* manager.releaseDesktopControl(threadId);
    }),
  );
  it.effect("refuses a credential kept past its run once a later run starts without Computer", () =>
    Effect.gen(function* () {
      const { manager } = yield* ComputerService;
      const { threadId, runId } = yield* seedRunningTurn("outlived-run", "full-access");
      yield* Effect.addFinalizer(() => Effect.orDie(manager.releaseDesktopControl(threadId)));
      assert.isTrue(yield* manager.admitControl(threadId, "request", 0, true));
      const original = yield* seededRun(threadId, runId);
      const now = yield* DateTime.now;
      const laterRunId = RunId.make("outlived-run-later");
      yield* (yield* EventSinkV2).write({
        events: [
          {
            id: EventId.make("outlived-run-completed"),
            type: "run.updated",
            threadId,
            runId,
            occurredAt: now,
            payload: { ...original, status: "completed", completedAt: now },
          },
          {
            id: EventId.make("outlived-run-later"),
            type: "run.created",
            threadId,
            runId: laterRunId,
            occurredAt: now,
            payload: {
              ...original,
              id: laterRunId,
              ordinal: 2,
              userMessageId: MessageId.make("outlived-run-plain-message"),
              computerControl: undefined,
            },
          },
        ],
      });
      assert.isFalse(yield* manager.admitControl(threadId, "off", 0));
      const { tools } = yield* toolsUnderCeiling("full-access");
      const typedBefore = callsTo("typeText");
      const typed = yield* tools.call({
        invocation: invocationFor(threadId, ["computer"]),
        name: "computer_type_text",
        args: { text: "after Computer off", window_id: "fake-terminal", include_screenshot: false },
        jsonRpcRequestId: 1,
      });
      assert.equal(errorCode(typed), "capability_denied");
      assert.equal(callsTo("typeText"), typedBefore);
    }),
  );

  it.effect("refuses a caller once the access policy tightens past its sender's clearance", () =>
    Effect.gen(function* () {
      const { manager } = yield* ComputerService;
      const settings = yield* ServerSettingsService;
      const { threadId, runId } = yield* seedRunningTurn("access-tightened", "full-access");
      yield* Effect.addFinalizer(() => Effect.orDie(manager.releaseDesktopControl(threadId)));
      const original = yield* seededRun(threadId, runId);
      yield* (yield* EventSinkV2).write({
        events: [
          {
            id: EventId.make("access-tightened-operator"),
            type: "run.updated",
            threadId,
            runId,
            occurredAt: yield* DateTime.now,
            payload: {
              ...original,
              computerControl: { mode: "request", generation: 0, clearance: "any-operator" },
            },
          },
        ],
      });
      const access: { policy: ComputerAccessPolicy } = { policy: "any-operator" };
      const tools = yield* makeComputerMcpTools.pipe(
        Effect.provideService(ServerSettingsService, {
          ...settings,
          getSettings: settings.getSettings.pipe(
            Effect.map((current) => ({
              ...current,
              computer: {
                ...current.computer,
                autonomy: "full-access" as const,
                accessPolicy: access.policy,
              },
            })),
          ),
        }),
      );
      const type = () =>
        tools.call({
          invocation: invocationFor(threadId, ["computer"]),
          name: "computer_type_text",
          args: { text: "access", window_id: "fake-terminal", include_screenshot: false },
          jsonRpcRequestId: 1,
        });
      assert.notEqual((yield* type())?.isError, true);
      access.policy = "admins-only";
      const typedBefore = callsTo("typeText");
      assert.equal(errorCode(yield* type()), "computer_policy_changed");
      assert.equal(callsTo("typeText"), typedBefore);
    }),
  );

  it.effect("sends no click when the ceiling tightens while the call finds its target", () =>
    Effect.gen(function* () {
      const { manager } = yield* ComputerService;
      const { threadId } = yield* seedRunningTurn("tightened-targeting", "full-access");
      yield* Effect.addFinalizer(() => Effect.orDie(manager.releaseDesktopControl(threadId)));
      const { tools, policy } = yield* toolsUnderCeiling("full-access");
      const { targeting, release } = yield* holdTargeting();
      const clicksBefore = callsTo("click");
      const clicking = yield* Effect.forkChild(clickDisplay(tools, threadId));
      yield* Deferred.await(targeting);
      policy.autonomy = "supervised";
      yield* Deferred.succeed(release, undefined);
      const clicked = yield* Fiber.join(clicking);
      assert.equal(clicked?.isError, true);
      assert.equal(callsTo("click"), clicksBefore);
    }),
  );

  it.effect("Stop ends a call still finding its target, and nothing is clicked", () =>
    Effect.gen(function* () {
      const { manager } = yield* ComputerService;
      const orchestrator = yield* OrchestratorV2;
      const { threadId, runId } = yield* seedRunningTurn("stopped-targeting", "full-access");
      yield* Effect.addFinalizer(() => Effect.orDie(manager.releaseDesktopControl(threadId)));
      const run = yield* seededRun(threadId, runId);
      const now = yield* DateTime.now;
      const rootNodeId = run.rootNodeId ?? NodeId.make("stopped-targeting-root");
      // A run Stop can reach has its root node.
      yield* (yield* EventSinkV2).write({
        events: [
          {
            id: EventId.make("stopped-targeting-node"),
            type: "node.updated",
            threadId,
            runId,
            nodeId: rootNodeId,
            providerInstanceId: run.providerInstanceId,
            occurredAt: now,
            payload: {
              id: rootNodeId,
              threadId,
              runId,
              parentNodeId: null,
              rootNodeId,
              kind: "root_turn",
              status: "running",
              countsForRun: true,
              providerThreadId: run.providerThreadId,
              providerTurnId: null,
              nativeItemRef: null,
              runtimeRequestId: null,
              checkpointScopeId: null,
              startedAt: now,
              completedAt: null,
            },
          },
        ],
      });
      const { tools } = yield* toolsUnderCeiling("full-access");
      const { targeting, release } = yield* holdTargeting();
      const clicksBefore = callsTo("click");
      const clicking = yield* Effect.forkChild(clickDisplay(tools, threadId));
      yield* Deferred.await(targeting);
      yield* orchestrator.dispatch({
        type: "run.interrupt",
        commandId: CommandId.make("stopped-targeting-stop"),
        threadId,
        runId,
      });
      // Stop returned once the call unwound; a lookup that resumes now finds nothing to do.
      yield* Deferred.succeed(release, undefined);
      const stopped = yield* Fiber.join(clicking);
      assert.equal(errorCode(stopped), "caller_turn_inactive");
      assert.equal(callsTo("click"), clicksBefore);
      assert.equal(
        (yield* orchestrator.getThreadProjection(threadId)).runs.find(
          (candidate) => candidate.id === runId,
        )?.status,
        "interrupted",
      );
    }),
  );

  it.effect("asks once for each further app the task's input reaches", () =>
    Effect.gen(function* () {
      const { manager } = yield* ComputerService;
      const orchestrator = yield* OrchestratorV2;
      const { tools } = yield* toolsUnderCeiling("per-task");
      const { threadId } = yield* seedRunningTurn("second-app", "full-access");
      const call = (name: string, args: Record<string, unknown>) =>
        tools.call({
          invocation: invocationFor(threadId, ["computer"]),
          name,
          args,
          jsonRpcRequestId: 1,
        });
      const typeInto = (window_id: string) =>
        call("computer_type_text", { text: window_id, window_id, include_screenshot: false });
      // A run step aims at the second app; nothing in the call names it.
      const frameCalculator = () =>
        call("computer_run", {
          steps: [
            {
              type: "set_window_frame",
              window_id: "fake-calculator",
              x: 10,
              y: 10,
              width: 500,
              height: 400,
            },
          ],
        });
      const cardPrompt = Effect.fn("cardPrompt")(function* () {
        const { request, projection } = yield* pendingComputerRequest(threadId);
        const card = projection.turnItems.find(
          (item) => item.type === "approval_request" && item.requestId === request.id,
        );
        return card?.type === "approval_request" ? card.prompt : null;
      });

      const first = yield* Effect.forkChild(typeInto("fake-terminal"));
      assert.equal(yield* cardPrompt(), "Allow Computer for this task");
      yield* acceptCard(threadId, "second-app-task");
      assert.notEqual((yield* Fiber.join(first))?.isError, true);

      const framedBefore = callsTo("setWindowFrame");
      // A run reports a refused step in its result rather than failing the call.
      const refused = (yield* frameCalculator())?.content[0];
      assert.include(
        refused?.type === "text" ? refused.text : "",
        '"computer_app_approval_required"',
      );
      assert.equal(callsTo("setWindowFrame"), framedBefore);

      const retry = yield* Effect.forkChild(frameCalculator());
      assert.equal(yield* cardPrompt(), "Allow Computer to use org.kde.kcalc in this task");
      yield* acceptCard(threadId, "second-app-app");
      assert.notEqual((yield* Fiber.join(retry))?.isError, true);
      assert.equal(callsTo("setWindowFrame"), framedBefore + 1);

      // Allowed once, the app takes further input without another card.
      const typedBefore = callsTo("typeText");
      assert.notEqual((yield* typeInto("fake-calculator"))?.isError, true);
      assert.equal(callsTo("typeText"), typedBefore + 1);
      const projection = yield* orchestrator.getThreadProjection(threadId);
      assert.lengthOf(
        projection.runtimeRequests.filter((request) => request.kind === "computer"),
        2,
      );
      yield* manager.releaseDesktopControl(threadId);
    }),
  );
});
