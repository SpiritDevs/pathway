import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
  type ModelSelection,
  type OrchestrationV2TurnItem,
} from "@spiritdevs/contracts";
import { CompanyId } from "@spiritdevs/contracts/company";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import { createAttachmentId, createIssueAttachmentId } from "../attachmentStore.ts";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import { ServerConfig } from "../config.ts";
import { layer as mcpSessionRegistryTestLayer } from "../mcp/McpSessionRegistry.testkit.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { TerminalManager } from "../terminal/Manager.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { EffectOutboxV2 } from "./EffectOutbox.ts";
import { OrchestrationEffectWorkerV2 } from "./EffectWorker.ts";
import { EventSinkV2 } from "./EventSink.ts";
import { OrchestratorV2 } from "./Orchestrator.ts";
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import * as ResourceCleanupService from "./ResourceCleanupService.ts";
import { OrchestrationV2EventSinkLayerLive, OrchestrationV2LayerLive } from "./runtimeLayer.ts";
import { ThreadWorkspaceService } from "./ThreadWorkspaceService.ts";

const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "pathway-html-render-lifecycle-",
});

const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;
const driver = ProviderDriverKind.make("codex");
const providerInstance = {
  instanceId: modelSelection.instanceId,
  driverKind: driver,
  continuationIdentity: { driverKind: driver, continuationKey: "codex:test" },
  displayName: "Codex test",
  enabled: true,
  snapshot: {} as ProviderInstance["snapshot"],
  orchestrationAdapter: {
    instanceId: modelSelection.instanceId,
    driver,
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: () => Effect.die("sessions are not used by lifecycle tests"),
  } as ProviderAdapterV2Shape,
  textGeneration: {} as ProviderInstance["textGeneration"],
} satisfies ProviderInstance;

// Each test gets its own database and attachments directory, with real attachment cleanup.
const TestLayer = Layer.mergeAll(OrchestrationV2LayerLive, OrchestrationV2EventSinkLayerLive).pipe(
  Layer.provide(
    Layer.succeed(ThreadWorkspaceService, {
      createConversation: (threadId) => Effect.succeed(`/conversation-test/${threadId}`),
      attachProject: () => Effect.succeed({ worktreePath: null, branch: null }),
      hasUnfinishedGitWork: () => Effect.succeed(false),
      hasMergedPullRequest: () => Effect.succeed(false),
      cleanup: () => Effect.void,
    }),
  ),
  Layer.provide(
    ResourceCleanupService.live.pipe(
      Layer.provide(Layer.mock(TerminalManager)({ close: () => Effect.void })),
    ),
  ),
  Layer.provide(mcpSessionRegistryTestLayer),
  Layer.provide(SqlitePersistenceMemory),
  Layer.provide(
    CheckpointStore.layer.pipe(
      Layer.provide(VcsDriverRegistry.layer),
      Layer.provide(VcsProcess.layer),
    ),
  ),
  Layer.provide(ServerSettingsService.layerTest()),
  Layer.provide(
    Layer.succeed(ProviderInstanceRegistry, {
      getInstance: (instanceId) =>
        Effect.succeed(instanceId === providerInstance.instanceId ? providerInstance : undefined),
      listInstances: Effect.succeed([providerInstance]),
      listUnavailable: Effect.succeed([]),
      streamChanges: Stream.empty,
      subscribeChanges: Effect.never,
    }),
  ),
  Layer.provideMerge(ServerConfigLayer),
  Layer.provideMerge(NodeServices.layer),
);

const createThread = Effect.fn("createThread")(function* (id: string, temporary = false) {
  const orchestrator = yield* OrchestratorV2;
  const threadId = ThreadId.make(id);
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make(`${id}:create`),
    threadId,
    projectId: null,
    conversationCompanyId: CompanyId.make("company-conversations-test"),
    temporary,
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

/** Saves a page the way the publisher does and returns its attachment id. */
const savePage = Effect.fn("savePage")(function* (threadId: ThreadId) {
  const fileSystem = yield* FileSystem.FileSystem;
  const attachmentId = createAttachmentId(threadId, "html")!;
  yield* fileSystem.writeFileString(yield* attachmentPath(`${attachmentId}.html`), "<h1>Page</h1>");
  return attachmentId;
});

const attachmentPath = Effect.fn("attachmentPath")(function* (fileName: string) {
  const path = yield* Path.Path;
  return path.join((yield* ServerConfig).attachmentsDir, fileName);
});

const exists = Effect.fn("exists")(function* (attachmentId: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.exists(yield* attachmentPath(`${attachmentId}.html`));
});

/** Projects a normalized `html_render` tool item, as adapters emit it. */
const projectRender = Effect.fn("projectRender")(function* (input: {
  readonly threadId: ThreadId;
  readonly itemId: string;
  readonly attachmentId: string;
  readonly runId?: RunId;
  readonly status?: OrchestrationV2TurnItem["status"];
}) {
  const eventSink = yield* EventSinkV2;
  const now = yield* DateTime.now;
  yield* eventSink.write({
    events: [
      {
        id: EventId.make(`${input.itemId}:event`),
        type: "turn-item.updated",
        threadId: input.threadId,
        occurredAt: now,
        payload: {
          id: TurnItemId.make(input.itemId),
          threadId: input.threadId,
          runId: input.runId ?? null,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 0,
          status: input.status ?? "completed",
          title: "Render an HTML page",
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          type: "dynamic_tool",
          toolName: "pathway.html_render",
          input: { title: "Chart", htmlBytes: 13 },
          output: {
            htmlRender: { attachmentId: input.attachmentId, title: "Chart", height: 320 },
            message: "Published.",
          },
        },
      },
    ],
  });
});

const deleteThread = Effect.fn("deleteThread")(function* (threadId: ThreadId) {
  const orchestrator = yield* OrchestratorV2;
  const commandId = CommandId.make(`${threadId}:delete`);
  yield* orchestrator.dispatch({ type: "thread.delete", commandId, threadId });
  return commandId;
});

const drainEffects = Effect.gen(function* () {
  const worker = yield* OrchestrationEffectWorkerV2;
  yield* worker.drain();
});

it.effect("deletes every page a thread published, and nothing it inherited or does not own", () =>
  Effect.gen(function* () {
    const orchestrator = yield* OrchestratorV2;
    const eventSink = yield* EventSinkV2;
    const outbox = yield* EffectOutboxV2;
    const fileSystem = yield* FileSystem.FileSystem;
    const source = yield* createThread("html-source");
    const unrelated = yield* createThread("html-unrelated");
    const now = yield* DateTime.now;
    const runId = RunId.make("html-source-run");
    yield* eventSink.write({
      events: [
        {
          id: EventId.make("html-source-run:created"),
          type: "run.created",
          threadId: source,
          runId,
          occurredAt: now,
          payload: {
            id: runId,
            threadId: source,
            ordinal: 1,
            providerInstanceId: modelSelection.instanceId,
            modelSelection,
            providerThreadId: null,
            userMessageId: MessageId.make("html-source-message"),
            rootNodeId: null,
            activeAttemptId: null,
            status: "completed",
            requestedAt: now,
            startedAt: now,
            completedAt: now,
            checkpointId: null,
            contextHandoffId: null,
          },
        },
      ],
    });
    const shown = yield* savePage(source);
    const replaced = yield* savePage(source);
    const failed = yield* savePage(source);
    const unprojected = yield* savePage(source);
    yield* projectRender({ threadId: source, itemId: "shown", attachmentId: shown, runId });
    // A retry supersedes this attempt, but its item stays in the local projection.
    yield* projectRender({ threadId: source, itemId: "replaced", attachmentId: replaced, runId });
    yield* projectRender({
      threadId: source,
      itemId: "failed",
      attachmentId: failed,
      runId,
      status: "failed",
    });
    const unrelatedPage = yield* savePage(unrelated);
    yield* projectRender({ threadId: unrelated, itemId: "unrelated", attachmentId: unrelatedPage });
    const ownUpload = `${createAttachmentId(source)!}.png`;
    const issueUpload = `${createIssueAttachmentId("issue-1")!}.png`;
    for (const name of [ownUpload, issueUpload]) {
      yield* fileSystem.writeFileString(yield* attachmentPath(name), name);
    }

    const sourceThread = (yield* orchestrator.getThreadProjection(source)).thread;
    const fork = ThreadId.make("html-fork");
    yield* eventSink.write({
      events: [
        {
          id: EventId.make("html-fork:created"),
          type: "thread.created",
          threadId: fork,
          occurredAt: now,
          payload: {
            ...sourceThread,
            id: fork,
            title: "Fork",
            conversationPath: null,
            forkedFrom: { type: "run", threadId: source, runId },
            lineage: { parentThreadId: source, relationshipToParent: "fork", rootThreadId: source },
          },
        },
      ],
    });
    const forkPage = yield* savePage(fork);
    yield* projectRender({ threadId: fork, itemId: "fork-own", attachmentId: forkPage });
    yield* projectRender({ threadId: fork, itemId: "fork-copied", attachmentId: shown });
    assert.isTrue(
      (yield* orchestrator.getThreadProjection(fork)).visibleTurnItems.some(
        (row) => row.visibility === "inherited" && row.sourceItemId === TurnItemId.make("shown"),
      ),
    );

    const archive = CommandId.make("html-source:archive");
    yield* orchestrator.dispatch({ type: "thread.archive", commandId: archive, threadId: source });
    yield* drainEffects;
    assert.notInclude(
      (yield* outbox.listByCommandId(archive)).map((effect) => effect.request.type),
      "attachment.cleanup",
    );
    for (const page of [shown, replaced, failed, unprojected]) {
      assert.isTrue(yield* exists(page), `archive kept ${page}`);
    }

    yield* deleteThread(fork);
    yield* drainEffects;
    assert.isFalse(yield* exists(forkPage));
    for (const page of [shown, replaced, failed, unprojected]) {
      assert.isTrue(yield* exists(page), `fork deletion kept source page ${page}`);
    }

    const deletion = yield* deleteThread(source);
    const cleanup = (yield* outbox.get(`effect:${deletion}:attachment.cleanup`)).pipe(
      Option.getOrThrow,
    );
    assert.deepEqual(cleanup.request, {
      type: "attachment.cleanup",
      attachmentIds: [],
      htmlRenderThreadId: source,
    });
    yield* drainEffects;
    assert.equal((yield* outbox.get(cleanup.id)).pipe(Option.getOrThrow).status, "succeeded");
    for (const page of [shown, replaced, failed, unprojected]) {
      assert.isFalse(yield* exists(page), `deletion removed ${page}`);
    }
    assert.isTrue(yield* exists(unrelatedPage));
    for (const name of [ownUpload, issueUpload]) {
      assert.isTrue(yield* fileSystem.exists(yield* attachmentPath(name)), name);
    }
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("deletes pages of a temporary thread and its subagents when it settles", () =>
  Effect.gen(function* () {
    const orchestrator = yield* OrchestratorV2;
    const eventSink = yield* EventSinkV2;
    const parent = yield* createThread("html-temporary-parent", true);
    const child = ThreadId.make("html-temporary-child");
    yield* eventSink.write({
      events: [
        {
          id: EventId.make(`${child}:created`),
          type: "thread.created",
          threadId: child,
          occurredAt: yield* DateTime.now,
          payload: {
            ...(yield* orchestrator.getThreadProjection(parent)).thread,
            id: child,
            lineage: {
              parentThreadId: parent,
              relationshipToParent: "subagent",
              rootThreadId: parent,
            },
          },
        },
      ],
    });
    const parentPage = yield* savePage(parent);
    yield* projectRender({ threadId: parent, itemId: "parent-page", attachmentId: parentPage });
    const childPage = yield* savePage(child);

    yield* orchestrator.dispatch({
      type: "thread.settle",
      commandId: CommandId.make(`${parent}:settle`),
      threadId: parent,
    });
    assert.isNotNull((yield* orchestrator.getThreadProjection(child)).thread.deletedAt);
    yield* drainEffects;

    assert.isFalse(yield* exists(parentPage));
    assert.isFalse(yield* exists(childPage));
  }).pipe(Effect.provide(TestLayer)),
);

// The publisher writes the page, then rechecks its caller before returning and removes the page
// if its thread was deleted meanwhile. The deletion sweep and that final guard together cover
// every ordering of a save against a deletion.
const orderings = ["before deletion", "between deletion and sweep", "after the sweep"] as const;
for (const ordering of orderings)
  it.effect(`removes a page saved ${ordering}, before its result projected`, () =>
    Effect.gen(function* () {
      const orchestrator = yield* OrchestratorV2;
      const fileSystem = yield* FileSystem.FileSystem;
      const threadId = yield* createThread("html-race");
      const bystander = yield* createThread("html-race-bystander");
      const bystanderPage = yield* savePage(bystander);
      const write = yield* Deferred.make<void>();
      const saved = yield* Deferred.make<string>();
      const recheck = yield* Deferred.make<void>();
      const publisher = yield* Effect.gen(function* () {
        yield* Deferred.await(write);
        const attachmentId = yield* savePage(threadId);
        yield* Deferred.succeed(saved, attachmentId);
        yield* Deferred.await(recheck);
        if ((yield* orchestrator.getThreadProjection(threadId)).thread.deletedAt === null) return;
        yield* fileSystem.remove(yield* attachmentPath(`${attachmentId}.html`), { force: true });
      }).pipe(Effect.forkChild);
      const save = Deferred.succeed(write, undefined).pipe(Effect.andThen(Deferred.await(saved)));

      let page: string;
      if (ordering === "before deletion") {
        page = yield* save;
        yield* deleteThread(threadId);
        yield* drainEffects;
        assert.isFalse(yield* exists(page), "the owner sweep removed the unprojected page");
      } else if (ordering === "between deletion and sweep") {
        yield* deleteThread(threadId);
        page = yield* save;
        yield* drainEffects;
        assert.isFalse(yield* exists(page), "the owner sweep removed the unprojected page");
      } else {
        yield* deleteThread(threadId);
        yield* drainEffects;
        page = yield* save;
        assert.isTrue(yield* exists(page), "a save after the sweep is the publisher's to undo");
      }
      yield* Deferred.succeed(recheck, undefined);
      yield* Fiber.join(publisher);

      assert.isFalse(yield* exists(page));
      assert.isTrue(yield* exists(bystanderPage));
    }).pipe(Effect.provide(TestLayer)),
  );
