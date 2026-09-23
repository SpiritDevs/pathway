import { assert, it } from "@effect/vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import {
  CommandId,
  EnvironmentId,
  type OrchestrationV2TurnItem,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@spiritdevs/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";

import {
  ComputerApprovalsTestLayer,
  pendingComputerRequest,
  seedRunningTurn,
} from "../computer/computerApprovals.testkit.ts";
import { ComputerManager } from "../computer/ComputerManager.ts";
import { FakeComputerBackend } from "../computer/FakeComputerBackend.ts";
import { ComputerService } from "../computer/Services/ComputerService.ts";
import { EventSinkV2 } from "../orchestration-v2/EventSink.ts";
import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import { makeComputerMcpTools } from "./computerMcpTools.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import type { McpCapability, McpInvocationScope } from "./McpInvocationContext.ts";
import type { McpToolCallResult } from "./toolkits/computer/toolRuntime.ts";

const backend = new FakeComputerBackend();

const ComputerServiceTest = Layer.effect(
  ComputerService,
  Effect.gen(function* () {
    const manager = yield* ComputerManager.make({ backend, actionSettleMs: 0 });
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

const errorCode = (result: McpToolCallResult | undefined) => {
  const first = result?.content[0];
  return first?.type === "text" && result?.isError === true
    ? (/"code": "([a-z_]+)"/u.exec(first.text)?.[1] ?? null)
    : null;
};

const noticesOf = (items: ReadonlyArray<OrchestrationV2TurnItem>, toolName: string) =>
  items.filter((item) => item.type === "dynamic_tool" && item.toolName === toolName);

it.layer(TestLayer)("computerMcpTools", (it) => {
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
      const callsTo = (method: string) =>
        backend.calls.filter((call) => call.method === method).length;
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
    }),
  );
});
