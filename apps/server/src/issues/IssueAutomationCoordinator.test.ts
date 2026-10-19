import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type IssueActor,
  type IssueId,
  type IssuesStreamEvent,
  type IssueThreadLinkOrigin,
  type ModelSelection,
} from "@spiritdevs/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { IssueAutomationAuditRepositoryLive } from "../persistence/Layers/IssueAutomationAudits.ts";
import { IssueCommentRepositoryLive } from "../persistence/Layers/IssueComments.ts";
import { IssueCycleRepositoryLive } from "../persistence/Layers/IssueCycles.ts";
import { IssueEnrichmentRunRepositoryLive } from "../persistence/Layers/IssueEnrichmentRuns.ts";
import { IssueEventRepositoryLive } from "../persistence/Layers/IssueEvents.ts";
import { IssueLabelRepositoryLive } from "../persistence/Layers/IssueLabels.ts";
import { IssueMilestoneRepositoryLive } from "../persistence/Layers/IssueMilestones.ts";
import { IssueRelationRepositoryLive } from "../persistence/Layers/IssueRelations.ts";
import { IssueRepositoryLive } from "../persistence/Layers/Issues.ts";
import { IssueStatusRepositoryLive } from "../persistence/Layers/IssueStatuses.ts";
import { IssueThreadLinkRepositoryLive } from "../persistence/Layers/IssueThreadLinks.ts";
import { IssueTodoRepositoryLive } from "../persistence/Layers/IssueTodos.ts";
import { IssueTrackerConfigRepositoryLive } from "../persistence/Layers/IssueTrackerConfig.ts";
import { IssueViewRepositoryLive } from "../persistence/Layers/IssueViews.ts";
import { ProjectionProjectRepositoryLive } from "../persistence/Layers/ProjectionProjects.ts";
import { ProjectionStateRepositoryLive } from "../persistence/Layers/ProjectionState.ts";
import { SlackChannelWatchRepositoryLive } from "../persistence/Layers/SlackChannelWatches.ts";
import { SlackIntakeLedgerRepositoryLive } from "../persistence/Layers/SlackIntakeLedger.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import { TextGeneration } from "../textGeneration/TextGeneration.ts";
import { makeHandler } from "./IssueAutomationCoordinator.ts";
import { layerStub as IssueCommentAgentEngineStub } from "./IssueCommentAgentEngine.ts";
import { IssueEnrichmentEngine } from "./IssueEnrichmentEngine.ts";
import { IssueTrackerService, layer as trackerLayer } from "./IssueTrackerService.ts";
import { SlackIntakeEngine } from "./slack/SlackIntakeEngine.ts";

const ACTOR: IssueActor = { kind: "user" };
const DRIVER = ProviderDriverKind.make("codex");
const WORK_THREAD = ThreadId.make("thread-work");
const CHAT_THREAD = ThreadId.make("thread-chat");
const SELECTION: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5-codex",
};

/** The one thing the coordinator reads off a thread: which model the work thread runs. */
const threadsLayer = Layer.succeed(
  ThreadManagementService,
  ThreadManagementService.of({
    getThreadProjection: (threadId: ThreadId) =>
      Effect.succeed({
        thread: { id: threadId, modelSelection: SELECTION, worktreePath: null },
      }),
  } as never),
);

const persistenceLayer = Layer.mergeAll(
  IssueRepositoryLive,
  IssueStatusRepositoryLive,
  IssueLabelRepositoryLive,
  IssueEventRepositoryLive,
  IssueTrackerConfigRepositoryLive,
  IssueMilestoneRepositoryLive,
  IssueCycleRepositoryLive,
  IssueTodoRepositoryLive,
  IssueRelationRepositoryLive,
  IssueCommentRepositoryLive,
  IssueViewRepositoryLive,
  IssueEnrichmentRunRepositoryLive,
  IssueThreadLinkRepositoryLive,
  IssueAutomationAuditRepositoryLive,
  SlackChannelWatchRepositoryLive,
  SlackIntakeLedgerRepositoryLive,
  ProjectionProjectRepositoryLive,
  ProjectionStateRepositoryLive,
).pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(ServerSecretStore.layer),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "pathway-automation-test-" })),
  Layer.provideMerge(NodeServices.layer),
);

const testLayer = trackerLayer.pipe(
  Layer.provide(IssueCommentAgentEngineStub),
  Layer.provide(
    Layer.succeed(IssueEnrichmentEngine, {
      resolveModelSelection: Effect.succeed(SELECTION),
      start: () => Effect.void,
      cancel: () => Effect.void,
    }),
  ),
  Layer.provide(
    Layer.succeed(SlackIntakeEngine, {
      testConnection: () => Effect.succeed({ workspaceName: "Pathway HQ" }),
      listChannels: Effect.succeed([]),
      notifyWatchesChanged: Effect.void,
      postIssueUpdate: () => Effect.succeed({ messageTs: "1723459200.000100" }),
    }),
  ),
  Layer.provideMerge(threadsLayer),
  Layer.provideMerge(
    Layer.succeed(ProviderInstanceRegistry, {
      getInstance: () => Effect.succeed({ driverKind: DRIVER, enabled: true }),
    } as never),
  ),
  Layer.provideMerge(
    Layer.succeed(TextGeneration, {
      investigate: () => Effect.die("the coordinator must not classify in these tests"),
    } as never),
  ),
  Layer.provideMerge(ServerSettings.layerTest()),
  Layer.provideMerge(persistenceLayer),
);

/** The status the tracker seeds for work in progress, which is where automation parks a card. */
const startedStatusId = Effect.gen(function* () {
  const tracker = yield* IssueTrackerService;
  const { statuses } = yield* tracker.getSnapshot();
  const started = statuses.find((status) => status.category === "started");
  assert.ok(started !== undefined);
  return started.id;
});

const reviewStatusId = Effect.gen(function* () {
  const tracker = yield* IssueTrackerService;
  const { statuses } = yield* tracker.getSnapshot();
  const review = statuses.find((status) => status.category === "review");
  assert.ok(review !== undefined);
  return review.id;
});

/** The issue as the tracker holds it now; `getDetail` is the tail, not the card. */
const readIssue = (issueId: IssueId) =>
  Effect.gen(function* () {
    const tracker = yield* IssueTrackerService;
    const { issues } = yield* tracker.getSnapshot();
    const issue = issues.find((candidate) => candidate.id === issueId);
    assert.ok(issue !== undefined);
    return issue;
  });

/** One published thread list, exactly as the tracker republishes it after any link changes. */
const linksChanged = (
  issueId: IssueId,
  links: ReadonlyArray<{ readonly threadId: ThreadId; readonly origin: IssueThreadLinkOrigin }>,
  createdAt: string,
): IssuesStreamEvent => ({
  _tag: "IssueThreadLinksChanged",
  issueId,
  links: links.map((link) => ({
    issueId,
    threadId: link.threadId,
    origin: link.origin,
    createdAt,
  })),
});

describe("IssueAutomationCoordinator", () => {
  it.effect("moves a card to the work status when a start-work link appears", () =>
    Effect.gen(function* () {
      const tracker = yield* IssueTrackerService;
      const handle = yield* makeHandler;
      const { issue } = yield* tracker.create({ title: "Ship the linker" }, ACTOR);

      yield* handle({ _tag: "IssueUpserted", issue });
      yield* handle(
        linksChanged(issue.id, [{ threadId: WORK_THREAD, origin: "start-work" }], issue.createdAt),
      );

      const started = yield* startedStatusId;
      const moved = yield* readIssue(issue.id);
      assert.strictEqual(moved.statusId, started);
      assert.deepStrictEqual(moved.assignee, { kind: "agent", provider: DRIVER });
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("leaves a card alone when a later mention republishes the same start-work link", () =>
    Effect.gen(function* () {
      const tracker = yield* IssueTrackerService;
      const handle = yield* makeHandler;
      const { issue } = yield* tracker.create({ title: "Ship the linker" }, ACTOR);

      yield* handle({ _tag: "IssueUpserted", issue });
      yield* handle(
        linksChanged(issue.id, [{ threadId: WORK_THREAD, origin: "start-work" }], issue.createdAt),
      );

      // The user reads the work and moves the card on, then unassigns it: whatever the automation
      // decided when work started is not what the issue says now.
      const review = yield* reviewStatusId;
      const { issue: reviewed } = yield* tracker.update(
        { issueId: issue.id, patch: { statusId: review, assignee: null } },
        ACTOR,
      );
      yield* handle({ _tag: "IssueUpserted", issue: reviewed });

      // Somebody says the key in a different thread. The mention reactor links that thread, so the
      // issue's list is republished — with the old start-work link still on it.
      yield* handle(
        linksChanged(
          issue.id,
          [
            { threadId: WORK_THREAD, origin: "start-work" },
            { threadId: CHAT_THREAD, origin: "mention" },
          ],
          issue.createdAt,
        ),
      );

      const after = yield* readIssue(issue.id);
      assert.strictEqual(after.statusId, review);
      assert.strictEqual(after.assignee, null);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("does not restart work it already did when the stream replays on boot", () =>
    Effect.gen(function* () {
      const tracker = yield* IssueTrackerService;
      const { issue } = yield* tracker.create({ title: "Ship the linker" }, ACTOR);
      yield* tracker.linkThread(
        { issueId: issue.id, threadId: WORK_THREAD, origin: "start-work" },
        ACTOR,
      );
      const review = yield* reviewStatusId;
      const { issue: reviewed } = yield* tracker.update(
        { issueId: issue.id, patch: { statusId: review, assignee: null } },
        ACTOR,
      );

      // A restart: the coordinator is built against links that already exist, and the tracker's
      // stream opens by replaying every issue and every thread list.
      const handle = yield* makeHandler;
      const { links } = yield* tracker.getThreadLinks({ issueId: issue.id });
      yield* handle({ _tag: "IssueUpserted", issue: reviewed });
      yield* handle({ _tag: "IssueThreadLinksChanged", issueId: issue.id, links });

      const after = yield* readIssue(issue.id);
      assert.strictEqual(after.statusId, review);
      assert.strictEqual(after.assignee, null);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("starts work again when a different thread takes the issue over", () =>
    Effect.gen(function* () {
      const tracker = yield* IssueTrackerService;
      const handle = yield* makeHandler;
      const { issue } = yield* tracker.create({ title: "Ship the linker" }, ACTOR);

      yield* handle({ _tag: "IssueUpserted", issue });
      yield* handle(
        linksChanged(issue.id, [{ threadId: WORK_THREAD, origin: "start-work" }], issue.createdAt),
      );
      const review = yield* reviewStatusId;
      const { issue: reviewed } = yield* tracker.update(
        { issueId: issue.id, patch: { statusId: review } },
        ACTOR,
      );
      yield* handle({ _tag: "IssueUpserted", issue: reviewed });

      // A genuinely new start-work link is a new fact, and the card goes back to work.
      yield* handle(
        linksChanged(
          issue.id,
          [
            { threadId: WORK_THREAD, origin: "start-work" },
            { threadId: CHAT_THREAD, origin: "start-work" },
          ],
          issue.createdAt,
        ),
      );

      const after = yield* readIssue(issue.id);
      assert.strictEqual(after.statusId, yield* startedStatusId);
    }).pipe(Effect.provide(testLayer)),
  );
});
