import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  ProviderInstanceId,
  ThreadId,
  type IssueActor,
  type ModelSelection,
  type OrchestrationV2StoredEvent,
} from "@spiritdevs/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
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
import { ProjectionStateRepository } from "../persistence/Services/ProjectionState.ts";
import { layerStub as IssueCommentAgentEngineStub } from "./IssueCommentAgentEngine.ts";
import { IssueEnrichmentEngine } from "./IssueEnrichmentEngine.ts";
import { ISSUE_MENTION_PROJECTOR, run } from "./IssueMentionLinker.ts";
import { IssueTrackerService, layer as trackerLayer } from "./IssueTrackerService.ts";
import { SlackIntakeEngine } from "./slack/SlackIntakeEngine.ts";

const ACTOR: IssueActor = { kind: "user" };
const THREAD = ThreadId.make("thread-mention");
const CHILD_THREAD = ThreadId.make("thread-subagent");
const ENRICHMENT_MODEL: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5-codex",
};

/**
 * One settled chat message, as the event log holds it. The reactor reads the whole message off the
 * event, so these fixtures are the entire input: nothing else is fetched to decide a link.
 */
const messageEvent = (input: {
  readonly sequence: number;
  readonly text: string;
  readonly role?: "user" | "assistant" | "system";
  readonly streaming?: boolean;
  readonly threadId?: ThreadId;
}): OrchestrationV2StoredEvent => {
  const at = DateTime.makeUnsafe("2026-08-12T00:00:00.000Z");
  const threadId = input.threadId ?? THREAD;
  return {
    sequence: input.sequence,
    commandId: null,
    event: {
      id: EventId.make(`event-${input.sequence}`),
      threadId,
      occurredAt: at,
      type: "message.updated",
      payload: {
        createdBy: "agent",
        creationSource: "provider",
        id: MessageId.make(`message-${input.sequence}`),
        threadId,
        runId: null,
        nodeId: null,
        role: input.role ?? "assistant",
        text: input.text,
        attachments: [],
        streaming: input.streaming ?? false,
        createdAt: at,
        updatedAt: at,
      },
    },
  };
};

/**
 * The event log and the thread shells, faked down to the two methods the reactor uses.
 * `afterSequence` is honoured because the cursor is the thing under test: a stub that ignored it
 * would pass the backfill case for the wrong reason. The shell carries only lineage, which is all
 * the reactor asks it for.
 */
const threadsLayer = (
  stored: ReadonlyArray<OrchestrationV2StoredEvent>,
  children: ReadonlyArray<ThreadId>,
) =>
  Layer.succeed(
    ThreadManagementService,
    ThreadManagementService.of({
      streamStoredEventsFrom: (input?: { readonly afterSequence?: number }) =>
        Stream.fromIterable(stored.filter((event) => event.sequence > (input?.afterSequence ?? 0))),
      getThreadShell: (threadId: ThreadId) =>
        Effect.succeed(
          children.includes(threadId)
            ? {
                id: threadId,
                lineage: {
                  rootThreadId: THREAD,
                  parentThreadId: THREAD,
                  relationshipToParent: "subagent",
                },
              }
            : {
                id: threadId,
                lineage: {
                  rootThreadId: threadId,
                  parentThreadId: null,
                  relationshipToParent: null,
                },
              },
        ),
    } as never),
  );

/** The tracker for real over an in-memory database, plus the cursor table the reactor writes. */
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
  SlackChannelWatchRepositoryLive,
  SlackIntakeLedgerRepositoryLive,
  ProjectionProjectRepositoryLive,
  ProjectionStateRepositoryLive,
).pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(ServerSecretStore.layer),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "pathway-mention-test-" })),
  Layer.provideMerge(NodeServices.layer),
);

const makeTestLayer = (
  stored: ReadonlyArray<OrchestrationV2StoredEvent>,
  children: ReadonlyArray<ThreadId> = [],
) =>
  trackerLayer.pipe(
    Layer.provide(IssueCommentAgentEngineStub),
    Layer.provide(
      Layer.succeed(IssueEnrichmentEngine, {
        resolveModelSelection: Effect.succeed(ENRICHMENT_MODEL),
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
    Layer.provideMerge(threadsLayer(stored, children)),
    Layer.provideMerge(persistenceLayer),
  );

/** How far the reactor says it has read, or null when it has never written a cursor. */
const cursor = Effect.gen(function* () {
  const state = yield* ProjectionStateRepository;
  const row = yield* state.getByProjector({ projector: ISSUE_MENTION_PROJECTOR });
  return Option.match(row, { onNone: () => null, onSome: (it) => it.lastAppliedSequence });
});

describe("IssueMentionLinker", () => {
  it.effect("links the thread of a settled message that names a live issue", () =>
    Effect.gen(function* () {
      const tracker = yield* IssueTrackerService;
      const { issue } = yield* tracker.create({ title: "Ship the linker" }, ACTOR);

      yield* run;

      const { links } = yield* tracker.getThreadLinks({ issueId: issue.id });
      assert.deepStrictEqual(
        links.map((link) => [link.threadId, link.origin]),
        [[THREAD, "mention"]],
      );
      // A mention is a relation, not activity: nothing lands in the issue's feed.
      const { events } = yield* tracker.getEvents({ issueId: issue.id });
      assert.deepStrictEqual(
        events.filter((event) => event.field === "thread"),
        [],
      );
    }).pipe(
      Effect.provide(makeTestLayer([messageEvent({ sequence: 1, text: "Picking up ISS-1" })])),
    ),
  );

  it.effect("says the same thing twice without adding a second link", () =>
    Effect.gen(function* () {
      const tracker = yield* IssueTrackerService;
      const { issue } = yield* tracker.create({ title: "Ship the linker" }, ACTOR);

      yield* run;

      const { links } = yield* tracker.getThreadLinks({ issueId: issue.id });
      assert.strictEqual(links.length, 1);
      assert.strictEqual(links[0]?.origin, "mention");
    }).pipe(
      Effect.provide(
        makeTestLayer([
          messageEvent({ sequence: 1, text: "Picking up ISS-1" }),
          messageEvent({ sequence: 2, text: "Still on ISS-1" }),
        ]),
      ),
    ),
  );

  it.effect("never demotes a link a person made, however often the key comes up", () =>
    Effect.gen(function* () {
      const tracker = yield* IssueTrackerService;
      const { issue } = yield* tracker.create({ title: "Ship the linker" }, ACTOR);
      yield* tracker.linkThread(
        { issueId: issue.id, threadId: THREAD, origin: "start-work" },
        ACTOR,
      );

      yield* run;

      const { links } = yield* tracker.getThreadLinks({ issueId: issue.id });
      assert.deepStrictEqual(
        links.map((link) => link.origin),
        ["start-work"],
      );
    }).pipe(
      Effect.provide(makeTestLayer([messageEvent({ sequence: 1, text: "Picking up ISS-1" })])),
    ),
  );

  it.effect("takes a user's message as readily as an agent's", () =>
    Effect.gen(function* () {
      const tracker = yield* IssueTrackerService;
      const { issue } = yield* tracker.create({ title: "Ship the linker" }, ACTOR);

      yield* run;

      assert.strictEqual((yield* tracker.getThreadLinks({ issueId: issue.id })).links.length, 1);
    }).pipe(
      Effect.provide(
        makeTestLayer([messageEvent({ sequence: 1, text: "Do ISS-1 next", role: "user" })]),
      ),
    ),
  );

  it.effect("ignores keys the tracker does not know", () =>
    Effect.gen(function* () {
      const tracker = yield* IssueTrackerService;
      const { issue } = yield* tracker.create({ title: "Ship the linker" }, ACTOR);

      yield* run;

      assert.deepStrictEqual((yield* tracker.getThreadLinks({ issueId: issue.id })).links, []);
      assert.deepStrictEqual(
        (yield* tracker.getIssueLinksForThread({ threadId: THREAD })).links,
        [],
      );
      // The loose pattern matched both of these; resolving is what threw them out.
      assert.strictEqual(yield* cursor, 1);
    }).pipe(
      Effect.provide(
        makeTestLayer([messageEvent({ sequence: 1, text: "Chasing ISS-404, encoded as UTF-8" })]),
      ),
    ),
  );

  it.effect("leaves a deleted issue alone, so a mention cannot resurrect it in the UI", () =>
    Effect.gen(function* () {
      const tracker = yield* IssueTrackerService;
      const { issue } = yield* tracker.create({ title: "Ship the linker" }, ACTOR);
      yield* tracker.remove({ issueId: issue.id }, ACTOR);

      yield* run;

      assert.deepStrictEqual((yield* tracker.getThreadLinks({ issueId: issue.id })).links, []);
    }).pipe(
      Effect.provide(makeTestLayer([messageEvent({ sequence: 1, text: "Picking up ISS-1" })])),
    ),
  );

  it.effect("waits for a message to settle instead of linking mid-stream", () =>
    Effect.gen(function* () {
      const tracker = yield* IssueTrackerService;
      const { issue } = yield* tracker.create({ title: "Ship the linker" }, ACTOR);

      yield* run;

      assert.deepStrictEqual((yield* tracker.getThreadLinks({ issueId: issue.id })).links, []);
    }).pipe(
      Effect.provide(
        makeTestLayer([messageEvent({ sequence: 1, text: "Picking up ISS-1", streaming: true })]),
      ),
    ),
  );

  it.effect("does not link a key that only ever appears inside code", () =>
    Effect.gen(function* () {
      const tracker = yield* IssueTrackerService;
      const { issue } = yield* tracker.create({ title: "Ship the linker" }, ACTOR);

      yield* run;

      assert.deepStrictEqual((yield* tracker.getThreadLinks({ issueId: issue.id })).links, []);
    }).pipe(
      Effect.provide(
        makeTestLayer([
          messageEvent({
            sequence: 1,
            text: ["The log says:", "```", "warn: ISS-1 missing", "```"].join("\n"),
          }),
        ]),
      ),
    ),
  );

  it.effect("drags the cursor forward across events it never scanned", () =>
    Effect.gen(function* () {
      const tracker = yield* IssueTrackerService;
      yield* tracker.create({ title: "Ship the linker" }, ACTOR);

      yield* run;

      // Nothing here was worth linking, but a server that runs for a week without anybody naming
      // an issue still has to boot without re-reading the week.
      assert.strictEqual(yield* cursor, 900);
    }).pipe(
      Effect.provide(
        makeTestLayer([
          messageEvent({ sequence: 400, text: "Picking up ISS-1", streaming: true }),
          messageEvent({ sequence: 900, text: "Picking up ISS-1", streaming: true }),
        ]),
      ),
    ),
  );

  it.effect("catches up on messages committed while the server was down, exactly once", () =>
    Effect.gen(function* () {
      const tracker = yield* IssueTrackerService;
      const first = yield* tracker.create({ title: "Ship the linker" }, ACTOR);
      const second = yield* tracker.create({ title: "Wire the panel" }, ACTOR);

      // No cursor row yet: this install has never run the reactor, so the replay starts at genesis.
      assert.strictEqual(yield* cursor, null);
      yield* run;

      assert.deepStrictEqual(
        (yield* tracker.getThreadLinks({ issueId: first.issue.id })).links.map(
          (link) => link.origin,
        ),
        ["mention"],
      );
      assert.deepStrictEqual(
        (yield* tracker.getThreadLinks({ issueId: second.issue.id })).links.map(
          (link) => link.origin,
        ),
        ["mention"],
      );
      // The cursor is past both, so a restart replays neither.
      assert.strictEqual(yield* cursor, 7);

      // Restarting reads the cursor and asks for nothing before it; the links stand as they are.
      yield* run;
      assert.strictEqual(
        (yield* tracker.getThreadLinks({ issueId: first.issue.id })).links.length,
        1,
      );
      assert.strictEqual(yield* cursor, 7);
    }).pipe(
      Effect.provide(
        makeTestLayer([
          messageEvent({ sequence: 5, text: "Landed ISS-1." }),
          messageEvent({ sequence: 7, text: "Now ISS-2, which blocks nothing" }),
        ]),
      ),
    ),
  );

  it.effect("leaves a delegated subagent's own thread off the issue", () =>
    Effect.gen(function* () {
      const tracker = yield* IssueTrackerService;
      const { issue } = yield* tracker.create({ title: "Ship the linker" }, ACTOR);

      yield* run;

      // A delegated subagent is handed a prompt that quotes the key it is working under, and its
      // child thread is not on any list a person can open — a link to it renders as a dead id.
      assert.deepStrictEqual(
        (yield* tracker.getThreadLinks({ issueId: issue.id })).links.map((link) => link.threadId),
        [THREAD],
      );
    }).pipe(
      Effect.provide(
        makeTestLayer(
          [
            messageEvent({ sequence: 1, text: "Investigate ISS-1", threadId: CHILD_THREAD }),
            messageEvent({ sequence: 2, text: "Investigate ISS-1" }),
          ],
          [CHILD_THREAD],
        ),
      ),
    ),
  );

  it.effect("leaves an unlinked pair unlinked when nothing new says the key", () =>
    Effect.gen(function* () {
      const tracker = yield* IssueTrackerService;
      const { issue } = yield* tracker.create({ title: "Ship the linker" }, ACTOR);

      yield* run;
      assert.strictEqual((yield* tracker.getThreadLinks({ issueId: issue.id })).links.length, 1);

      // Somebody decides this thread is not about the issue after all. The cursor is past the
      // message that made the link, so a later pass has nothing to re-read and the removal holds.
      // (A new message naming the key links it again; that is the feature, not a regression.)
      yield* tracker.unlinkThread({ issueId: issue.id, threadId: THREAD }, ACTOR);
      yield* run;

      assert.deepStrictEqual((yield* tracker.getThreadLinks({ issueId: issue.id })).links, []);
    }).pipe(
      Effect.provide(makeTestLayer([messageEvent({ sequence: 1, text: "Picking up ISS-1" })])),
    ),
  );
});
