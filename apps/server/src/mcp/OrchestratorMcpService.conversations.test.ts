import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
  type OrchestratorMcpFailure,
  type ServerProvider,
} from "@spiritdevs/contracts";
import { CompanyId } from "@spiritdevs/contracts/company";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { RemoteThreads } from "../cloud/remoteThreads.ts";
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
const remoteThreadId = ThreadId.make("thread-on-another-environment");
const remoteEnvironmentId = EnvironmentId.make("mcp-conversation-remote-environment");
// Filled by the test with a real projection so the stub can serve it as another environment's.
let remoteProjection: OrchestrationV2ThreadProjection | null = null;
const requestedRemoteSources: Array<ReadonlyArray<ThreadId>> = [];
const remoteSends: Array<string> = [];
const remoteThreadsLayer = Layer.succeed(
  RemoteThreads,
  RemoteThreads.of({
    launchTargets: Effect.succeed([]),
    launchGrant: () => Effect.succeed(null),
    read: (threadId, sourcesFor) =>
      Effect.sync(() => {
        if (threadId !== remoteThreadId || remoteProjection === null) return null;
        requestedRemoteSources.push(sourcesFor(remoteProjection));
        return { environmentId: remoteEnvironmentId, projection: remoteProjection, sources: [] };
      }),
    send: (input) =>
      Effect.gen(function* () {
        if (input.threadId !== remoteThreadId || remoteProjection === null) return null;
        yield* input.authorize(remoteProjection);
        remoteSends.push(input.text);
        const run = remoteProjection.runs.at(-1);
        return run === undefined
          ? yield* Effect.die("The remote stand-in needs a run")
          : { environmentId: remoteEnvironmentId, run, delivery: "started" as const };
      }),
  }),
);
const testLayer = mcpServiceLayer.pipe(
  Layer.provideMerge(threadManagementLayer.pipe(Layer.provideMerge(orchestratorLayer))),
  Layer.provide(
    Layer.mergeAll(
      NodeServices.layer,
      remoteThreadsLayer,
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
  runtimeMode: "full-access" | "approval-required" = "full-access",
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
    runtimeMode,
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
    "limits listing, waiting, and interruption to the caller's company but reads and sends anywhere",
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
        assert.equal(
          (yield* service.readThread(scope, { threadId: foreignId })).thread.threadId,
          foreignId,
        );
        assert.equal(
          (yield* service.sendToThread(scope, { threadId: foreignId, message: "Other company" }))
            .delivery,
          "started",
        );
        const deniedOperations: ReadonlyArray<Effect.Effect<unknown, OrchestratorMcpFailure>> = [
          service.waitForThread(scope, { threadId: foreignId }),
          service.interruptThread(scope, { threadId: foreignId }),
        ];
        for (const denied of deniedOperations) {
          const error = yield* denied.pipe(Effect.asVoid, Effect.flip);
          assert.equal(error.code, "thread_not_found");
        }
        assert.equal(
          (yield* orchestrator.getThreadProjection(foreignId)).messages[0]?.text,
          "Other company",
        );
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

  it.effect("attaches a thread started from another environment under its remote parent", () =>
    Effect.gen(function* () {
      const orchestrator = yield* OrchestratorV2;
      const threadId = ThreadId.make("remote-launched-child");
      const remoteParent = { threadId: remoteThreadId, environmentId: remoteEnvironmentId };
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("remote-launched-child:create"),
        threadId,
        projectId: null,
        conversationCompanyId: companyA,
        remoteParent,
        title: "Remote launch",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "agent",
        creationSource: "mcp",
      });

      const { thread } = yield* orchestrator.getThreadProjection(threadId);
      assert.deepEqual(thread.lineage, {
        parentThreadId: remoteThreadId,
        relationshipToParent: null,
        rootThreadId: threadId,
        parentEnvironmentId: remoteEnvironmentId,
      });
    }),
  );

  it.effect("reads threads from the account's other environments when they are not local", () =>
    Effect.gen(function* () {
      const orchestrator = yield* OrchestratorV2;
      const service = yield* OrchestratorMcpService;
      const parentId = yield* createConversation("remote-read-parent", companyA);
      const standInId = yield* createConversation("remote-read-stand-in", companyB);
      const standIn = yield* orchestrator.getThreadProjection(standInId);
      remoteProjection = { ...standIn, thread: { ...standIn.thread, id: remoteThreadId } };

      const read = yield* service.readThread(invocation(parentId), { threadId: remoteThreadId });
      assert.equal(read.thread.threadId, remoteThreadId);
      // Only the returned page's sources are fetched; this thread has none.
      assert.deepEqual(requestedRemoteSources, [[]]);

      const missing = yield* service
        .readThread(invocation(parentId), { threadId: ThreadId.make("thread-nowhere") })
        .pipe(Effect.flip);
      assert.equal(missing.code, "thread_not_found");
    }),
  );

  it.effect("sends to threads on the account's other environments without escalating access", () =>
    Effect.gen(function* () {
      const orchestrator = yield* OrchestratorV2;
      const service = yield* OrchestratorMcpService;
      const parentId = yield* createConversation("remote-send-parent", companyA);
      const standInId = yield* createConversation("remote-send-stand-in", companyB);
      yield* service.sendToThread(invocation(parentId), {
        threadId: standInId,
        message: "Warm up",
      });
      const standIn = yield* orchestrator.getThreadProjection(standInId);
      remoteProjection = { ...standIn, thread: { ...standIn.thread, id: remoteThreadId } };

      const sent = yield* service.sendToThread(invocation(parentId), {
        threadId: remoteThreadId,
        message: "Kick off",
      });
      assert.equal(sent.delivery, "started");
      assert.deepEqual(remoteSends, ["Kick off"]);

      // A thread with approval-required access may not kick off a full-access one elsewhere.
      const restrictedId = yield* createConversation(
        "remote-send-restricted",
        companyA,
        "approval-required",
      );
      const denied = yield* service
        .sendToThread(invocation(restrictedId), { threadId: remoteThreadId, message: "Escalate" })
        .pipe(Effect.flip);
      assert.equal(denied.code, "runtime_mode_escalation_denied");
      assert.deepEqual(remoteSends, ["Kick off"]);

      const missing = yield* service
        .sendToThread(invocation(parentId), {
          threadId: ThreadId.make("thread-nowhere"),
          message: "Hello?",
        })
        .pipe(Effect.flip);
      assert.equal(missing.code, "thread_not_found");
    }),
  );
});
