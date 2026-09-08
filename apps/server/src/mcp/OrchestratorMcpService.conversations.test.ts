import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestratorMcpFailure,
  type ServerProvider,
} from "@spiritdevs/contracts";
import { CompanyId } from "@spiritdevs/contracts/company";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import { makeLayer as makeProviderAdapterRegistryLayer } from "../orchestration-v2/ProviderAdapterRegistry.ts";
import {
  ThreadManagementService,
  ThreadManagementThreadNotFoundError,
  layer as threadManagementLayer,
} from "../orchestration-v2/ThreadManagementService.ts";
import { ThreadWorkspaceService } from "../orchestration-v2/ThreadWorkspaceService.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ScheduledTaskService } from "../scheduledTasks/ScheduledTaskService.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import { OrchestratorMcpService, layer as mcpServiceLayer } from "./OrchestratorMcpService.ts";

const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };
const driver = ProviderDriverKind.make("codex");
const companyA = CompanyId.make("mcp-conversation-company-a");
const companyB = CompanyId.make("mcp-conversation-company-b");
const provider: ServerProvider = {
  instanceId: modelSelection.instanceId,
  driver,
  enabled: true,
  installed: true,
  version: "test",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-09-08T00:00:00.000Z",
  models: [
    { slug: modelSelection.model, name: modelSelection.model, isCustom: false, capabilities: null },
  ],
  slashCommands: [],
  skills: [],
};
const orchestratorLayer = makeOrchestratorV2ReplayLayerWithRegistry(
  { name: "mcp-conversation-company-scope" },
  makeProviderAdapterRegistryLayer([
    {
      instanceId: modelSelection.instanceId,
      driver,
      getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
      planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
      openSession: () => Effect.die("Company scope tests never start providers"),
    },
  ]),
  { runEffectWorker: false },
).pipe(
  Layer.provide(
    Layer.succeed(ThreadWorkspaceService, {
      createConversation: (threadId) => Effect.succeed(`/mcp-conversation-test/${threadId}`),
      attachProject: () => Effect.die("Company scope tests do not attach projects"),
      hasMergedPullRequest: () => Effect.succeed(false),
      hasUnfinishedGitWork: () => Effect.succeed(false),
      cleanup: () => Effect.void,
    }),
  ),
);
const testLayer = mcpServiceLayer.pipe(
  Layer.provideMerge(threadManagementLayer.pipe(Layer.provideMerge(orchestratorLayer))),
  Layer.provide(
    Layer.mergeAll(
      NodeServices.layer,
      Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed([provider]) }),
      Layer.mock(ScheduledTaskService)({}),
    ),
  ),
);

const invocation = (threadId: ThreadId): McpInvocationScope => ({
  environmentId: EnvironmentId.make("mcp-conversation-environment"),
  threadId,
  providerSessionId: `provider-session:${threadId}`,
  providerInstanceId: modelSelection.instanceId,
  providerDriverKind: driver,
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
});
const createConversation = Effect.fn("test.createConversation")(function* (
  id: string,
  companyId: CompanyId,
) {
  const orchestrator = yield* OrchestratorV2;
  const threadId = ThreadId.make(id);
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make(`${id}:create`),
    threadId,
    projectId: null,
    conversationCompanyId: companyId,
    title: id,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  return threadId;
});

it.layer(testLayer)("MCP conversation company scope", (it) => {
  it.effect(
    "limits listing, reading, sending, waiting, and interruption to the caller's company",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* OrchestratorV2;
        const service = yield* OrchestratorMcpService;
        const threads = yield* ThreadManagementService;
        const parentId = yield* createConversation("company-scope-parent", companyA);
        const sameCompanyId = yield* createConversation("company-scope-sibling", companyA);
        const foreignId = yield* createConversation("company-scope-foreign", companyB);
        const scope = invocation(parentId);
        assert.sameMembers(
          (yield* service.listThreads(scope, {})).threads.map((thread) => thread.threadId),
          [parentId, sameCompanyId],
        );
        assert.deepEqual(
          (yield* service.listThreads(invocation(foreignId), {})).threads.map(
            (thread) => thread.threadId,
          ),
          [foreignId],
        );
        assert.equal(
          (yield* service.readThread(scope, { threadId: sameCompanyId })).thread.threadId,
          sameCompanyId,
        );
        assert.equal(
          (yield* service.waitForThread(scope, { threadId: sameCompanyId })).status,
          "idle",
        );
        assert.equal(
          (yield* service.interruptThread(scope, { threadId: sameCompanyId })).status,
          "no_active_run",
        );
        const deniedOperations: ReadonlyArray<Effect.Effect<unknown, OrchestratorMcpFailure>> = [
          service.readThread(scope, { threadId: foreignId }),
          service.sendToThread(scope, { threadId: foreignId, message: "Wrong company" }),
          service.waitForThread(scope, { threadId: foreignId }),
          service.interruptThread(scope, { threadId: foreignId }),
        ];
        for (const denied of deniedOperations) {
          const error = yield* denied.pipe(Effect.asVoid, Effect.flip);
          assert.equal(error.code, "thread_not_found");
        }
        assert.deepEqual((yield* orchestrator.getThreadProjection(foreignId)).messages, []);
        const sent = yield* service.sendToThread(scope, {
          threadId: sameCompanyId,
          message: "Same company",
        });
        assert.equal(sent.delivery, "started");
        assert.equal(
          (yield* orchestrator.getThreadProjection(sameCompanyId)).messages[0]?.text,
          "Same company",
        );
        // Missing company context never grants access to all projectless conversations.
        assert.deepEqual(
          yield* threads.listProjectThreads({ projectId: null, includeSubagents: true }),
          [],
        );
        assert.instanceOf(
          yield* threads
            .getProjectThread({ projectId: null, threadId: sameCompanyId })
            .pipe(Effect.flip),
          ThreadManagementThreadNotFoundError,
        );
      }),
  );

  it.effect("creates an independently owned conversation in the active parent's company", () =>
    Effect.gen(function* () {
      const orchestrator = yield* OrchestratorV2;
      const service = yield* OrchestratorMcpService;
      const parentId = yield* createConversation("company-create-parent", companyA);
      const foreignId = yield* createConversation("company-create-foreign", companyB);
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`${parentId}:message`),
        threadId: parentId,
        messageId: MessageId.make(`${parentId}:message`),
        text: "Create another conversation",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      const input = {
        clientRequestId: "create-company-conversation",
        threads: [{ title: "New company conversation" }],
      };
      const created = yield* service.createThreads(invocation(parentId), input);
      assert.equal(created.threads.length, 1);
      const createdId = created.threads[0]!.threadId;
      const projection = yield* orchestrator.getThreadProjection(createdId);
      assert.isNull(projection.thread.projectId);
      assert.equal(projection.thread.conversationCompanyId, companyA);
      assert.equal(projection.thread.conversationPath, `/mcp-conversation-test/${createdId}`);
      assert.equal(projection.thread.lineage.rootThreadId, createdId);
      assert.equal(projection.thread.creationSource, "mcp");
      assert.isTrue(
        (yield* service.listThreads(invocation(parentId), {})).threads.some(
          (thread) => thread.threadId === createdId,
        ),
      );
      assert.isFalse(
        (yield* service.listThreads(invocation(foreignId), {})).threads.some(
          (thread) => thread.threadId === createdId,
        ),
      );
      assert.equal(
        (yield* service.createThreads(invocation(parentId), input)).threads[0]?.threadId,
        createdId,
      );
    }),
  );
});
