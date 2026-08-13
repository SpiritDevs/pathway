import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ISSUE_COMMENT_ATTACHMENT_MAX_BYTES,
  IssueEnrichmentRunId,
  IssueId,
  IssueMilestoneId,
  IssueStatusId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  IssueTrackerError,
  ThreadId,
  type IssueActor,
  type IssueDate,
  type IssueEnrichmentResult,
  type IssueEnrichmentRun,
  type IssueViewConfig,
  type ModelSelection,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import { resolveAttachmentPathById } from "../attachmentStore.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
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
import { SlackChannelWatchRepositoryLive } from "../persistence/Layers/SlackChannelWatches.ts";
import { SlackIntakeLedgerRepositoryLive } from "../persistence/Layers/SlackIntakeLedger.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import { IssueEnrichmentRunRepository } from "../persistence/Services/IssueEnrichmentRuns.ts";
import { IssueEnrichmentEngine, type IssueEnrichmentEngineShape } from "./IssueEnrichmentEngine.ts";
import { SlackIntakeEngine, type SlackIntakeEngineShape } from "./slack/SlackIntakeEngine.ts";
import { IssueTrackerService, layer } from "./IssueTrackerService.ts";

const ACTOR: IssueActor = { kind: "user" };
const AGENT: IssueActor = { kind: "agent", provider: ProviderDriverKind.make("claudeAgent") };
const PROJECT = ProjectId.make("project-alpha");
const OTHER_PROJECT = ProjectId.make("project-beta");
/** Created from a name alone, never given a directory: the case enrichment has to refuse. */
const ROOTLESS_PROJECT = ProjectId.make("project-rootless");

/**
 * Cycle finalisation compares against the local calendar day, so the fixtures are relative to it:
 * pinning literal dates would make these tests pass or fail depending on the day they ran.
 */
const dateDaysFromToday = (days: number): Effect.Effect<IssueDate> =>
  Effect.map(DateTime.now, (instant) =>
    DateTime.formatIsoDate(
      DateTime.setZone(
        days < 0 ? DateTime.subtract(instant, { days: -days }) : DateTime.add(instant, { days }),
        DateTime.zoneMakeLocal(),
      ),
    ),
  );

/** What a run is pinned to. The engine resolves this for real; the tests only need a value. */
const ENRICHMENT_MODEL: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5-codex",
};

/**
 * The engine, faked. Enrichment's process half lives behind its own tag precisely so these tests
 * can drive the record half without spawning anything: the default resolves a model and then does
 * nothing, and a test that cares about transitions passes its own `start`.
 */
const makeFakeEngine = (
  overrides: Partial<IssueEnrichmentEngineShape> = {},
): IssueEnrichmentEngineShape => ({
  resolveModelSelection: Effect.succeed(ENRICHMENT_MODEL),
  start: () => Effect.void,
  cancel: () => Effect.void,
  ...overrides,
});

/**
 * Slack, faked. Every real call intake makes is HTTPS, and nothing in these tests may reach the
 * network: the default answers plausibly, and a test that cares passes its own.
 */
const makeFakeSlackEngine = (
  overrides: Partial<SlackIntakeEngineShape> = {},
): SlackIntakeEngineShape => ({
  testConnection: () => Effect.succeed({ workspaceName: "Pathway HQ" }),
  listChannels: Effect.succeed([]),
  notifyWatchesChanged: Effect.void,
  postIssueUpdate: () => Effect.succeed({ messageTs: "1723459200.000100" }),
  ...overrides,
});

/**
 * Everything the tracker reads, without the tracker itself. Merged out rather than provided, so a
 * test can seed a project or a leftover run and then build the tracker over the same database —
 * which is how the startup sweep is exercised at all.
 */
const makeDependencyLayer = () =>
  Layer.mergeAll(
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
  ).pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
    // The bot token is written through the same store every other secret uses, into the
    // throwaway state directory `layerTest` makes below.
    Layer.provideMerge(ServerSecretStore.layer),
    // A throwaway state directory, for the one write that puts bytes on disk: a comment
    // attachment. `layerTest` creates the attachments directory it names, and both this and the
    // platform services are merged out so a test can read back what the service wrote.
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-issues-test-" })),
    // `Crypto`, for the ids the service mints; `FileSystem` and `Path`, for that same write.
    Layer.provideMerge(NodeServices.layer),
  );

/** A fresh in-memory tracker per test: the key counter and the seeded statuses are shared state. */
const makeTestLayer = (
  engine: IssueEnrichmentEngineShape = makeFakeEngine(),
  slack: SlackIntakeEngineShape = makeFakeSlackEngine(),
) =>
  layer.pipe(
    Layer.provide(Layer.succeed(IssueEnrichmentEngine, engine)),
    Layer.provide(Layer.succeed(SlackIntakeEngine, slack)),
    Layer.provideMerge(makeDependencyLayer()),
  );

/**
 * Build a tracker over the database already in context. Two of these in one test is a restart:
 * the second build sweeps whatever the first left in flight.
 */
const buildTracker = (
  engine: IssueEnrichmentEngineShape = makeFakeEngine(),
  slack: SlackIntakeEngineShape = makeFakeSlackEngine(),
) =>
  Effect.provide(
    IssueTrackerService,
    layer.pipe(
      Layer.provide(Layer.succeed(IssueEnrichmentEngine, engine)),
      Layer.provide(Layer.succeed(SlackIntakeEngine, slack)),
    ),
  );

/** A run as a killed server would have left it: queued, with nothing to show for itself. */
const makeQueuedRun = (id: IssueEnrichmentRunId, issueId: IssueId): IssueEnrichmentRun => ({
  id,
  issueId,
  state: "queued",
  modelSelection: ENRICHMENT_MODEL,
  transcript: "",
  result: null,
  error: null,
  createdAt: "2026-08-12T00:00:00.000Z",
  startedAt: null,
  finishedAt: null,
});

/** A project with a directory, which is the only kind an enrichment run can be asked for. */
const seedProject = (projectId: ProjectId, workspaceRoot: string | null) =>
  Effect.flatMap(ProjectionProjectRepository, (projects) =>
    projects.upsert({
      projectId,
      title: "Pathway",
      workspaceRoot,
      defaultModelSelection: null,
      defaultThreadEnvMode: null,
      scripts: [],
      createdAt: "2026-08-12T00:00:00.000Z",
      updatedAt: "2026-08-12T00:00:00.000Z",
      deletedAt: null,
    }),
  );

/** The shape a saved view stores: a tab, a grouping, a sort, a layout, and whichever chips are on. */
const VIEW_CONFIG: IssueViewConfig = {
  tab: "active",
  grouping: "status",
  sortMode: "manual",
  viewMode: "list",
};

/** A 1x1 transparent PNG — the smallest thing that is genuinely an image. */
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

const LINEAR_EXPORT = [
  "ID,Team,Title,Description,Status,Priority,Labels,Created,Updated,Due Date,Parent issue",
  'PAT-12,Pathway,Ship the tracker,"Body, with a comma",In Progress,High,"Bug, Chore",2026-08-01T09:00:00.000Z,2026-08-02T09:00:00.000Z,2026-09-01,',
  "PAT-13,Pathway,Sub-task,,Marinating,Low,Bug,2026-08-01T10:00:00.000Z,,,PAT-12",
  "",
].join("\n");

describe("IssueTrackerService", () => {
  it.effect("allocates keys in order and appends each issue after the last in its column", () =>
    Effect.gen(function* () {
      const tracker = yield* IssueTrackerService;

      const first = yield* tracker.create({ title: "First" }, ACTOR);
      const second = yield* tracker.create({ title: "Second" }, ACTOR);
      const elsewhere = yield* tracker.create(
        {
          title: "In review",
          statusId: IssueStatusId.make("in-review"),
          assignee: { kind: "agent", provider: ProviderDriverKind.make("codex") },
        },
        ACTOR,
      );

      assert.deepStrictEqual(
        [first.issue.key, second.issue.key, elsewhere.issue.key],
        ["ISS-1", "ISS-2", "ISS-3"],
      );
      // Absent status means the lowest-position backlog-or-unstarted column.
      assert.strictEqual(first.issue.statusId, "backlog");
      assert.strictEqual(elsewhere.issue.statusId, "in-review");
      assert.deepStrictEqual(elsewhere.issue.assignee, {
        kind: "agent",
        provider: ProviderDriverKind.make("codex"),
      });
      assert.isTrue(first.issue.sortOrder < second.issue.sortOrder);

      const snapshot = yield* tracker.getSnapshot();
      assert.strictEqual(snapshot.config.nextNumber, 4);
      assert.strictEqual(snapshot.issues.length, 3);
    }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect("writes one change log row for every field an update moved", () =>
    Effect.gen(function* () {
      const tracker = yield* IssueTrackerService;
      const { label } = yield* tracker.createLabel({ name: "Bug", color: "#eb5757" });
      const { issue } = yield* tracker.create({ title: "Before", priority: "low" }, ACTOR);

      const updated = yield* tracker.update(
        {
          issueId: issue.id,
          patch: {
            title: "After",
            statusId: IssueStatusId.make("in-progress"),
            labelIds: [label.id],
            // Unchanged, so it writes no row.
            priority: "low",
          },
        },
        ACTOR,
      );

      assert.strictEqual(updated.issue.title, "After");
      assert.deepStrictEqual(updated.issue.labelIds, [label.id]);

      const { events } = yield* tracker.getEvents({ issueId: issue.id });
      assert.deepStrictEqual(
        events.map((event) => [event.kind, event.field, event.before, event.after]),
        [
          ["created", null, null, null],
          ["field_changed", "title", "Before", "After"],
          ["field_changed", "status", "Backlog", "In Progress"],
          ["field_changed", "labels", "", "Bug"],
        ],
      );
      assert.deepStrictEqual(events[1]?.actor, { kind: "user" });
    }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect("logs a delete and a restore without losing the row", () =>
    Effect.gen(function* () {
      const tracker = yield* IssueTrackerService;
      const { issue } = yield* tracker.create({ title: "Doomed" }, ACTOR);

      const deleted = yield* tracker.remove({ issueId: issue.id }, ACTOR);
      assert.isNotNull(deleted.issue.deletedAt);
      // The snapshot carries deleted rows so a client can restore one without a second read.
      assert.strictEqual((yield* tracker.getSnapshot()).issues.length, 1);
      assert.isNotNull((yield* tracker.getSnapshot()).issues[0]?.deletedAt);

      const restored = yield* tracker.restore({ issueId: issue.id }, ACTOR);
      assert.isNull(restored.issue.deletedAt);

      const { events } = yield* tracker.getEvents({ issueId: issue.id });
      assert.deepStrictEqual(
        events.map((event) => event.kind),
        ["created", "deleted", "restored"],
      );
    }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect("moves issues off a deleted status and keeps the last unstarted one", () =>
    Effect.gen(function* () {
      const tracker = yield* IssueTrackerService;
      const inProgress = IssueStatusId.make("in-progress");
      const done = IssueStatusId.make("done");
      const { issue } = yield* tracker.create({ title: "Halfway", statusId: inProgress }, ACTOR);

      const refused = yield* tracker
        .deleteStatus({ statusId: IssueStatusId.make("todo"), reassignToStatusId: done }, ACTOR)
        .pipe(Effect.flip);
      assert.strictEqual(refused.reason, "conflict");

      const { statuses } = yield* tracker.deleteStatus(
        { statusId: inProgress, reassignToStatusId: done },
        ACTOR,
      );

      assert.isFalse(statuses.some((status) => status.id === inProgress));
      const snapshot = yield* tracker.getSnapshot();
      assert.strictEqual(snapshot.issues[0]?.statusId, done);

      const { events } = yield* tracker.getEvents({ issueId: issue.id });
      assert.deepStrictEqual(events.at(-1)?.after, "Done");
      assert.strictEqual(events.at(-1)?.before, "In Progress");
    }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect("refuses to reassign a deleted status to itself", () =>
    Effect.gen(function* () {
      const tracker = yield* IssueTrackerService;
      const done = IssueStatusId.make("done");

      const error = yield* tracker
        .deleteStatus({ statusId: done, reassignToStatusId: done }, ACTOR)
        .pipe(Effect.flip);

      assert.strictEqual(error.reason, "invalid");
    }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect("rewrites every position on a reorder and refuses a partial order", () =>
    Effect.gen(function* () {
      const tracker = yield* IssueTrackerService;
      const before = (yield* tracker.getSnapshot()).statuses.map((status) => status.id);

      const partial = yield* tracker
        .reorderStatuses({ statusIds: before.slice(0, 2) })
        .pipe(Effect.flip);
      assert.strictEqual(partial.reason, "invalid");

      const { statuses } = yield* tracker.reorderStatuses({ statusIds: [...before].toReversed() });

      assert.deepStrictEqual(
        statuses.map((status) => status.id),
        [...before].toReversed(),
      );
      assert.deepStrictEqual(
        statuses.map((status) => status.position),
        [1, 2, 3, 4, 5, 6],
      );
    }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect("imports a Linear export, adopting its prefix and its keys", () =>
    Effect.gen(function* () {
      const tracker = yield* IssueTrackerService;

      const result = yield* tracker.importCsv({ csvText: LINEAR_EXPORT }, ACTOR);
      assert.deepStrictEqual(result, { created: 2, skipped: [] });

      const snapshot = yield* tracker.getSnapshot();
      const parent = snapshot.issues.find((issue) => issue.key === "PAT-12");
      const child = snapshot.issues.find((issue) => issue.key === "PAT-13");

      assert.strictEqual(parent?.description, "Body, with a comma");
      assert.strictEqual(parent?.priority, "high");
      assert.strictEqual(parent?.dueDate, "2026-09-01");
      assert.strictEqual(parent?.createdAt, "2026-08-01T09:00:00.000Z");
      assert.strictEqual(parent?.statusId, "in-progress");
      // The parent is linked by key, and the child came first in neither file order nor id order.
      assert.strictEqual(child?.parentId, parent?.id);

      // A status name the tracker has never seen is created, guessed as work not yet begun.
      const marinating = snapshot.statuses.find((status) => status.name === "Marinating");
      assert.strictEqual(marinating?.category, "unstarted");
      assert.strictEqual(child?.statusId, marinating?.id);

      assert.deepStrictEqual(snapshot.labels.map((label) => label.name).toSorted(), [
        "Bug",
        "Chore",
      ]);
      assert.strictEqual(parent?.labelIds.length, 2);
      assert.strictEqual(child?.labelIds.length, 1);

      // The default prefix yields to the import, and the counter clears every imported number.
      assert.deepStrictEqual(snapshot.config, { keyPrefix: "PAT", nextNumber: 14 });
      const next = yield* tracker.create({ title: "After the import" }, ACTOR);
      assert.strictEqual(next.issue.key, "PAT-14");

      const { events } = yield* tracker.getEvents({ issueId: parent!.id });
      assert.deepStrictEqual(
        events.map((event) => [event.kind, event.actor]),
        [["imported", { kind: "user" }]],
      );
    }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect("keeps a prefix somebody already chose", () =>
    Effect.gen(function* () {
      const tracker = yield* IssueTrackerService;
      yield* tracker.importCsv({ csvText: "ID,Title\nPAT-4,Adopted\n" }, ACTOR);
      yield* tracker.importCsv({ csvText: "ID,Title\nZZZ-9,Not adopted\n" }, ACTOR);

      const { config, issues } = yield* tracker.getSnapshot();
      assert.strictEqual(config.keyPrefix, "PAT");
      // The second import's own key still survives; only the tracker's prefix is unmoved.
      assert.deepStrictEqual(issues.map((issue) => issue.key).toSorted(), ["PAT-4", "ZZZ-9"]);
      assert.strictEqual(config.nextNumber, 10);
    }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect("renames the prefix for new keys and leaves issued ones alone", () =>
    Effect.gen(function* () {
      const tracker = yield* IssueTrackerService;
      const before = yield* tracker.create({ title: "Issued under the default" }, ACTOR);

      const renamed = yield* tracker.setKeyPrefix({ keyPrefix: "PAT" });
      assert.deepStrictEqual(renamed.config, { keyPrefix: "PAT", nextNumber: 2 });

      const after = yield* tracker.create({ title: "Issued after the rename" }, ACTOR);
      assert.deepStrictEqual([before.issue.key, after.issue.key], ["ISS-1", "PAT-2"]);

      // A prefix somebody chose is no longer the default, so a later import cannot take it over.
      yield* tracker.importCsv({ csvText: "ID,Title\nZZZ-9,Imported\n" }, ACTOR);
      const { config } = yield* tracker.getSnapshot();
      assert.strictEqual(config.keyPrefix, "PAT");
    }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect("publishes the renamed config and stays quiet when the prefix did not move", () =>
    Effect.gen(function* () {
      const tracker = yield* IssueTrackerService;
      // A rename to the prefix already in place publishes nothing, so the only event after the
      // opening replay is the one write that moved something.
      const events = yield* Stream.runCollect(
        Stream.take(tracker.stream, 9).pipe(
          Stream.merge(
            Stream.fromEffect(
              tracker
                .setKeyPrefix({ keyPrefix: "ISS" })
                .pipe(Effect.andThen(tracker.setKeyPrefix({ keyPrefix: "PAT" }))),
            ).pipe(Stream.drain),
          ),
        ),
      );

      assert.deepStrictEqual(
        events.map((event) => event._tag),
        [
          "StatusesChanged",
          "LabelsChanged",
          "MilestonesChanged",
          "CyclesChanged",
          "ViewsChanged",
          "SlackWatchesChanged",
          "SlackStatusChanged",
          "ConfigChanged",
          "ConfigChanged",
        ],
      );
      const last = events.at(-1);
      assert.strictEqual(last?._tag === "ConfigChanged" ? last.config.keyPrefix : null, "PAT");
    }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect("skips the rows it cannot read and reports them by line", () =>
    Effect.gen(function* () {
      const tracker = yield* IssueTrackerService;
      yield* tracker.importCsv({ csvText: "ID,Title\nPAT-1,Already here\n" }, ACTOR);

      const result = yield* tracker.importCsv(
        {
          csvText: [
            "ID,Title,Status",
            "PAT-2,Good,Todo",
            'PAT-3,"quoted"junk,Todo',
            "PAT-4,Short a column",
            "PAT-5,,Todo",
            "PAT-1,Key already taken,Todo",
            "",
          ].join("\n"),
        },
        ACTOR,
      );

      assert.strictEqual(result.created, 1);
      assert.deepStrictEqual(result.skipped, [
        { line: 3, reason: "Unbalanced quotes." },
        { line: 4, reason: "Expected 3 columns, found 2." },
        { line: 5, reason: "Missing title." },
        { line: 6, reason: "An issue with key PAT-1 already exists." },
      ]);
      assert.deepStrictEqual(
        (yield* tracker.getSnapshot()).issues.map((issue) => issue.key).toSorted(),
        ["PAT-1", "PAT-2"],
      );
    }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect("reports a header it cannot use without touching the tracker", () =>
    Effect.gen(function* () {
      const tracker = yield* IssueTrackerService;

      const result = yield* tracker.importCsv({ csvText: "ID,Status\nPAT-1,Todo\n" }, ACTOR);

      assert.deepStrictEqual(result, {
        created: 0,
        skipped: [{ line: 1, reason: "No Title column in the header row." }],
      });
      assert.deepStrictEqual((yield* tracker.getSnapshot()).issues, []);
    }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect("applies a bulk patch whole or not at all", () =>
    Effect.gen(function* () {
      const tracker = yield* IssueTrackerService;
      const first = yield* tracker.create({ title: "One" }, ACTOR);
      const second = yield* tracker.create({ title: "Two" }, ACTOR);

      const missing = yield* tracker
        .bulkUpdate(
          { issueIds: [first.issue.id, second.issue.id], patch: { priority: "urgent" } },
          ACTOR,
        )
        .pipe(
          Effect.andThen(
            tracker.bulkUpdate(
              {
                issueIds: [first.issue.id],
                patch: { statusId: IssueStatusId.make("nonexistent") },
              },
              ACTOR,
            ),
          ),
          Effect.flip,
        );

      assert.strictEqual(missing.reason, "not-found");
      assert.deepStrictEqual(
        (yield* tracker.getSnapshot()).issues.map((issue) => [issue.priority, issue.statusId]),
        [
          ["urgent", "backlog"],
          ["urgent", "backlog"],
        ],
      );
    }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect("streams the tracker as diffs, then the diffs that follow", () =>
    Effect.gen(function* () {
      const tracker = yield* IssueTrackerService;
      yield* tracker.create({ title: "Already here" }, ACTOR);

      const opening = yield* Stream.runCollect(Stream.take(tracker.stream, 9));
      assert.deepStrictEqual(
        opening.map((event) => event._tag),
        [
          "StatusesChanged",
          "LabelsChanged",
          "MilestonesChanged",
          "CyclesChanged",
          "ViewsChanged",
          "SlackWatchesChanged",
          "SlackStatusChanged",
          "ConfigChanged",
          "IssueUpserted",
        ],
      );

      // Subscription happens before the read, so a write racing the read is repeated, not lost.
      const live = yield* Stream.runCollect(
        Stream.take(tracker.stream, 10).pipe(
          Stream.merge(
            Stream.fromEffect(tracker.create({ title: "Arrived later" }, ACTOR)).pipe(Stream.drain),
          ),
        ),
      );
      assert.strictEqual(live.at(-1)?._tag, "IssueUpserted");
    }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect("caps sub-issues at three ancestors and refuses a cycle in the tree", () =>
    Effect.gen(function* () {
      const tracker = yield* IssueTrackerService;
      const root = yield* tracker.create({ title: "Root" }, ACTOR);
      const second = yield* tracker.create({ title: "Second", parentId: root.issue.id }, ACTOR);
      const third = yield* tracker.create({ title: "Third", parentId: second.issue.id }, ACTOR);
      // Depth counts ancestors, so this one sits at three and is the last accepted.
      const fourth = yield* tracker.create({ title: "Fourth", parentId: third.issue.id }, ACTOR);
      assert.strictEqual(fourth.issue.parentId, third.issue.id);

      const tooDeep = yield* tracker
        .create({ title: "Fifth", parentId: fourth.issue.id }, ACTOR)
        .pipe(Effect.flip);
      assert.strictEqual(tooDeep.reason, "invalid");

      // The same cap on an update, and the same cap on a bulk edit, since both reparent.
      const loose = yield* tracker.create({ title: "Loose" }, ACTOR);
      const updateTooDeep = yield* tracker
        .update({ issueId: loose.issue.id, patch: { parentId: fourth.issue.id } }, ACTOR)
        .pipe(Effect.flip);
      assert.strictEqual(updateTooDeep.reason, "invalid");
      const bulkTooDeep = yield* tracker
        .bulkUpdate({ issueIds: [loose.issue.id], patch: { parentId: fourth.issue.id } }, ACTOR)
        .pipe(Effect.flip);
      assert.strictEqual(bulkTooDeep.reason, "invalid");
      assert.isNull(
        (yield* tracker.getSnapshot()).issues.find((issue) => issue.id === loose.issue.id)
          ?.parentId ?? null,
      );

      // A subtree comes along with the issue, so a two-deep branch cannot move under a parent
      // that already sits at two.
      const shallowMove = yield* tracker
        .update({ issueId: second.issue.id, patch: { parentId: third.issue.id } }, ACTOR)
        .pipe(Effect.flip);
      assert.strictEqual(shallowMove.reason, "invalid");
      assert.strictEqual(shallowMove.message, "An issue cannot be moved under its own sub-issue.");

      const selfParent = yield* tracker
        .update({ issueId: root.issue.id, patch: { parentId: root.issue.id } }, ACTOR)
        .pipe(Effect.flip);
      assert.strictEqual(selfParent.reason, "invalid");
    }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect("unassigns the issues on a deleted milestone and logs the move", () =>
    Effect.gen(function* () {
      const tracker = yield* IssueTrackerService;
      const { milestone } = yield* tracker.milestoneCreate({ projectId: PROJECT, name: "Beta" });
      const { issue } = yield* tracker.create(
        { title: "Planned", projectId: PROJECT, milestoneId: milestone.id },
        ACTOR,
      );
      assert.strictEqual(issue.milestoneId, milestone.id);

      const { milestones } = yield* tracker.milestoneDelete({ milestoneId: milestone.id }, ACTOR);

      assert.deepStrictEqual(milestones, []);
      const snapshot = yield* tracker.getSnapshot();
      assert.strictEqual(snapshot.issues[0]?.milestoneId, null);
      const { events } = yield* tracker.getEvents({ issueId: issue.id });
      assert.deepStrictEqual(events.at(-1)?.field, "milestone");
      assert.deepStrictEqual([events.at(-1)?.before, events.at(-1)?.after], ["Beta", null]);
    }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect("refuses a milestone from another project and clears one left behind by a move", () =>
    Effect.gen(function* () {
      const tracker = yield* IssueTrackerService;
      const { milestone } = yield* tracker.milestoneCreate({ projectId: PROJECT, name: "Beta" });
      const { issue } = yield* tracker.create(
        { title: "Elsewhere", projectId: OTHER_PROJECT },
        ACTOR,
      );

      const foreign = yield* tracker
        .update({ issueId: issue.id, patch: { milestoneId: milestone.id } }, ACTOR)
        .pipe(Effect.flip);
      assert.strictEqual(foreign.reason, "invalid");

      const { issue: planned } = yield* tracker.create(
        { title: "Planned", projectId: PROJECT, milestoneId: milestone.id },
        ACTOR,
      );
      // Moving the milestone takes its planning context with it; the issue left behind loses it.
      yield* tracker.milestoneUpdate(
        { milestoneId: milestone.id, patch: { projectId: OTHER_PROJECT } },
        ACTOR,
      );
      const snapshot = yield* tracker.getSnapshot();
      assert.strictEqual(
        snapshot.issues.find((candidate) => candidate.id === planned.id)?.milestoneId,
        null,
      );

      // Leaving the project on the issue's own edit clears it too, without being asked.
      const { issue: rejoined } = yield* tracker.update(
        { issueId: planned.id, patch: { projectId: OTHER_PROJECT, milestoneId: milestone.id } },
        ACTOR,
      );
      assert.strictEqual(rejoined.milestoneId, milestone.id);
      const { issue: moved } = yield* tracker.update(
        { issueId: planned.id, patch: { projectId: PROJECT } },
        ACTOR,
      );
      assert.isNull(moved.milestoneId);
    }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect("carries a milestone's two dates and refuses a backwards range", () =>
    Effect.gen(function* () {
      const tracker = yield* IssueTrackerService;
      const { milestone } = yield* tracker.milestoneCreate({
        projectId: PROJECT,
        name: "Structure",
        startDate: "2026-08-15",
        targetDate: "2026-09-01",
      });
      assert.deepStrictEqual(
        [milestone.startDate, milestone.targetDate],
        ["2026-08-15", "2026-09-01"],
      );

      const backwards = yield* tracker
        .milestoneCreate({
          projectId: PROJECT,
          name: "Backwards",
          startDate: "2026-09-02",
          targetDate: "2026-09-01",
        })
        .pipe(Effect.flip);
      assert.strictEqual(backwards.reason, "invalid");

      // A patch is judged on the pair it merges into, not the half it carries.
      const halfPatch = yield* tracker
        .milestoneUpdate({ milestoneId: milestone.id, patch: { startDate: "2026-09-05" } }, ACTOR)
        .pipe(Effect.flip);
      assert.strictEqual(halfPatch.reason, "invalid");

      // Clearing the target date makes that same start date fine again.
      const { milestone: cleared } = yield* tracker.milestoneUpdate(
        { milestoneId: milestone.id, patch: { startDate: "2026-09-05", targetDate: null } },
        ACTOR,
      );
      assert.deepStrictEqual([cleared.startDate, cleared.targetDate], ["2026-09-05", null]);

      const { milestone: undated } = yield* tracker.milestoneUpdate(
        { milestoneId: milestone.id, patch: { startDate: null } },
        ACTOR,
      );
      assert.isNull(undated.startDate);

      // A milestone created before dates existed reads back as a point, not a bar.
      const { milestone: point } = yield* tracker.milestoneCreate({
        projectId: PROJECT,
        name: "Point",
      });
      assert.deepStrictEqual([point.startDate, point.targetDate], [null, null]);

      const snapshot = yield* tracker.getSnapshot();
      assert.deepStrictEqual(
        snapshot.milestones.map((candidate) => [candidate.name, candidate.startDate]),
        [
          ["Structure", null],
          ["Point", null],
        ],
      );
    }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect("reconstructs a milestone's burn-up from the change log", () =>
    Effect.gen(function* () {
      const tracker = yield* IssueTrackerService;
      const startDate = yield* dateDaysFromToday(-3);
      const today = yield* dateDaysFromToday(0);
      const { milestone } = yield* tracker.milestoneCreate({
        projectId: PROJECT,
        name: "Beta",
        startDate,
        targetDate: yield* dateDaysFromToday(3),
      });

      // Created straight into the milestone, which writes no `milestone` event at all — the case
      // a forward replay over the change log would miss entirely.
      const { issue: planned } = yield* tracker.create(
        { title: "Planned", projectId: PROJECT, milestoneId: milestone.id },
        ACTOR,
      );
      yield* tracker.update(
        { issueId: planned.id, patch: { statusId: IssueStatusId.make("in-review") } },
        ACTOR,
      );
      const { issue: shipped } = yield* tracker.create(
        {
          title: "Shipped",
          projectId: PROJECT,
          milestoneId: milestone.id,
          statusId: IssueStatusId.make("done"),
        },
        ACTOR,
      );
      // Neither of these is work anybody is tracking, so neither belongs in the counts.
      yield* tracker.create(
        { title: "Intake", projectId: PROJECT, milestoneId: milestone.id, triage: true },
        ACTOR,
      );
      const { issue: dropped } = yield* tracker.create(
        { title: "Dropped", projectId: PROJECT, milestoneId: milestone.id },
        ACTOR,
      );
      yield* tracker.remove({ issueId: dropped.id }, ACTOR);

      const history = yield* tracker.milestoneHistory({ milestoneId: milestone.id });

      assert.isFalse(history.approximate);
      assert.strictEqual(history.points[0]?.date, startDate);
      assert.strictEqual(history.points.length, 4);
      // Everything happened today, so only the last point has anything in it. `review` counts as
      // started without counting as done, which is the whole reason the tally is by category.
      assert.deepStrictEqual(history.points.at(-1), {
        date: today,
        scope: 2,
        started: 2,
        completed: 1,
      });
      assert.deepStrictEqual(history.points.at(-2), {
        date: yield* dateDaysFromToday(-1),
        scope: 0,
        started: 0,
        completed: 0,
      });

      // Moving an issue out takes it out of the current member set, and the log cannot bring it
      // back — the documented limitation, pinned so a change to it is a deliberate one.
      yield* tracker.update({ issueId: shipped.id, patch: { milestoneId: null } }, ACTOR);
      const after = yield* tracker.milestoneHistory({ milestoneId: milestone.id });
      assert.deepStrictEqual(after.points.at(-1), {
        date: today,
        scope: 1,
        started: 1,
        completed: 0,
      });

      const missing = yield* tracker
        .milestoneHistory({ milestoneId: IssueMilestoneId.make("nonexistent") })
        .pipe(Effect.flip);
      assert.strictEqual(missing.reason, "not-found");
    }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect("rewrites milestone positions within one project only", () =>
    Effect.gen(function* () {
      const tracker = yield* IssueTrackerService;
      const first = yield* tracker.milestoneCreate({ projectId: PROJECT, name: "First" });
      const second = yield* tracker.milestoneCreate({ projectId: PROJECT, name: "Second" });
      const elsewhere = yield* tracker.milestoneCreate({
        projectId: OTHER_PROJECT,
        name: "Elsewhere",
      });

      const partial = yield* tracker
        .milestonesReorder({ projectId: PROJECT, milestoneIds: [first.milestone.id] })
        .pipe(Effect.flip);
      assert.strictEqual(partial.reason, "invalid");
      const foreign = yield* tracker
        .milestonesReorder({ projectId: PROJECT, milestoneIds: [elsewhere.milestone.id] })
        .pipe(Effect.flip);
      assert.strictEqual(foreign.reason, "not-found");

      const { milestones } = yield* tracker.milestonesReorder({
        projectId: PROJECT,
        milestoneIds: [second.milestone.id, first.milestone.id],
      });
      assert.deepStrictEqual(
        milestones.map((milestone) => milestone.name),
        ["Second", "First", "Elsewhere"],
      );

      const duplicate = yield* tracker
        .milestoneCreate({ projectId: PROJECT, name: "first" })
        .pipe(Effect.flip);
      assert.strictEqual(duplicate.reason, "conflict");
    }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect("clears the cycle on its issues when the cycle is deleted", () =>
    Effect.gen(function* () {
      const tracker = yield* IssueTrackerService;
      const startDate = yield* dateDaysFromToday(1);
      const endDate = yield* dateDaysFromToday(14);
      const { cycle } = yield* tracker.cycleCreate({ name: "Cycle 1", startDate, endDate });
      const { issue } = yield* tracker.create({ title: "Scheduled", cycleId: cycle.id }, ACTOR);
      yield* tracker.slackWatchCreate({
        channelId: "C1",
        channelName: "releases",
        cycleId: cycle.id,
      });

      const backwards = yield* tracker
        .cycleCreate({ name: "Backwards", startDate: endDate, endDate: startDate })
        .pipe(Effect.flip);
      assert.strictEqual(backwards.reason, "invalid");

      const { cycles } = yield* tracker.cycleDelete({ cycleId: cycle.id }, ACTOR);
      assert.deepStrictEqual(cycles, []);
      const snapshot = yield* tracker.getSnapshot();
      assert.strictEqual(snapshot.issues[0]?.cycleId, null);
      assert.strictEqual(snapshot.slackWatches[0]?.cycleId, null);
      const { events } = yield* tracker.getEvents({ issueId: issue.id });
      assert.deepStrictEqual(
        [events.at(-1)?.field, events.at(-1)?.before, events.at(-1)?.after],
        ["cycle", "Cycle 1", null],
      );
    }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect("carries an ended cycle's unfinished issues into the next one", () =>
    Effect.gen(function* () {
      const tracker = yield* IssueTrackerService;
      const ended = yield* tracker.cycleCreate({
        name: "Cycle 1",
        startDate: yield* dateDaysFromToday(-14),
        endDate: yield* dateDaysFromToday(-3),
      });
      const next = yield* tracker.cycleCreate({
        name: "Cycle 2",
        startDate: yield* dateDaysFromToday(-2),
        endDate: yield* dateDaysFromToday(9),
      });
      const unfinished = yield* tracker.create(
        { title: "Still going", cycleId: ended.cycle.id },
        ACTOR,
      );
      const done = yield* tracker.create(
        { title: "Shipped", cycleId: ended.cycle.id, statusId: IssueStatusId.make("done") },
        ACTOR,
      );

      const snapshot = yield* tracker.getSnapshot();

      const byId = new Map(snapshot.issues.map((issue) => [issue.id, issue]));
      assert.strictEqual(byId.get(unfinished.issue.id)?.cycleId, next.cycle.id);
      // The completed set freezes: finished work stays where it was finished.
      assert.strictEqual(byId.get(done.issue.id)?.cycleId, ended.cycle.id);
      const cycles = new Map(snapshot.cycles.map((cycle) => [cycle.id, cycle]));
      assert.isNotNull(cycles.get(ended.cycle.id)?.completedAt ?? null);
      assert.strictEqual(cycles.get(next.cycle.id)?.completedAt, null);

      const { events } = yield* tracker.getEvents({ issueId: unfinished.issue.id });
      assert.deepStrictEqual(
        [events.at(-1)?.field, events.at(-1)?.before, events.at(-1)?.after],
        ["cycle", "Cycle 1", "Cycle 2"],
      );
      // Not a person, and not whoever happened to open the tracker.
      assert.deepStrictEqual(events.at(-1)?.actor, { kind: "system", source: "cycles" });
    }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect("drops an ended cycle's issues to no cycle when nothing follows it", () =>
    Effect.gen(function* () {
      const tracker = yield* IssueTrackerService;
      const ended = yield* tracker.cycleCreate({
        name: "Only cycle",
        startDate: yield* dateDaysFromToday(-14),
        endDate: yield* dateDaysFromToday(-1),
      });
      const { issue } = yield* tracker.create(
        { title: "Still going", cycleId: ended.cycle.id },
        ACTOR,
      );

      const snapshot = yield* tracker.getSnapshot();

      assert.strictEqual(snapshot.issues.find((row) => row.id === issue.id)?.cycleId, null);
      assert.isNotNull(snapshot.cycles[0]?.completedAt ?? null);
      const { events } = yield* tracker.getEvents({ issueId: issue.id });
      assert.deepStrictEqual([events.at(-1)?.before, events.at(-1)?.after], ["Only cycle", null]);
    }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect("finalises an ended cycle once, however often the tracker is read", () =>
    Effect.gen(function* () {
      const tracker = yield* IssueTrackerService;
      const ended = yield* tracker.cycleCreate({
        name: "Cycle 1",
        startDate: yield* dateDaysFromToday(-14),
        endDate: yield* dateDaysFromToday(-3),
      });
      const { issue } = yield* tracker.create({ title: "Carried", cycleId: ended.cycle.id }, ACTOR);

      const first = yield* tracker.getSnapshot();
      const firstLog = yield* tracker.getEvents({ issueId: issue.id });
      const second = yield* tracker.getSnapshot();
      const secondLog = yield* tracker.getEvents({ issueId: issue.id });

      // The second read is a no-op: same stamp, same log, no second carry-over.
      assert.strictEqual(second.cycles[0]?.completedAt, first.cycles[0]?.completedAt);
      assert.strictEqual(secondLog.events.length, firstLog.events.length);
      assert.strictEqual(secondLog.events.filter((event) => event.field === "cycle").length, 1);
    }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect("keeps a checklist in order and out of the change log", () =>
    Effect.gen(function* () {
      const tracker = yield* IssueTrackerService;
      const { issue } = yield* tracker.create({ title: "With a checklist" }, ACTOR);

      const first = yield* tracker.todoCreate({ issueId: issue.id, text: "First" });
      const second = yield* tracker.todoCreate({ issueId: issue.id, text: "Second" });
      const third = yield* tracker.todoCreate({ issueId: issue.id, text: "Third" });
      assert.deepStrictEqual(
        third.todos.map((todo) => todo.text),
        ["First", "Second", "Third"],
      );

      const ticked = yield* tracker.todoUpdate({
        todoId: first.todos[0]!.id,
        patch: { done: true },
      });
      assert.isTrue(ticked.todos[0]?.done);

      const reordered = yield* tracker.todosReorder({
        issueId: issue.id,
        todoIds: [third.todos[2]!.id, second.todos[1]!.id, first.todos[0]!.id],
      });
      assert.deepStrictEqual(
        reordered.todos.map((todo) => todo.text),
        ["Third", "Second", "First"],
      );

      const partial = yield* tracker
        .todosReorder({ issueId: issue.id, todoIds: [first.todos[0]!.id] })
        .pipe(Effect.flip);
      assert.strictEqual(partial.reason, "invalid");

      const afterDelete = yield* tracker.todoDelete({ todoId: second.todos[1]!.id });
      assert.deepStrictEqual(
        afterDelete.todos.map((todo) => todo.text),
        ["Third", "First"],
      );

      // Checklist churn would bury the feed, so none of that wrote a change-log row.
      const { events } = yield* tracker.getEvents({ issueId: issue.id });
      assert.deepStrictEqual(
        events.map((event) => event.kind),
        ["created"],
      );
    }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect("writes a relation once and logs it from both ends", () =>
    Effect.gen(function* () {
      const tracker = yield* IssueTrackerService;
      const blocker = yield* tracker.create({ title: "Blocker" }, ACTOR);
      const blocked = yield* tracker.create({ title: "Blocked" }, ACTOR);

      const itself = yield* tracker
        .relationCreate(
          { issueId: blocker.issue.id, relatedIssueId: blocker.issue.id, kind: "blocks" },
          ACTOR,
        )
        .pipe(Effect.flip);
      assert.strictEqual(itself.reason, "invalid");

      const created = yield* tracker.relationCreate(
        { issueId: blocker.issue.id, relatedIssueId: blocked.issue.id, kind: "blocks" },
        ACTOR,
      );

      assert.deepStrictEqual(
        created.affected.map((entry) => [entry.issueId, entry.relations[0]?.direction]),
        [
          [blocker.issue.id, "outgoing"],
          [blocked.issue.id, "incoming"],
        ],
      );
      const blockerLog = yield* tracker.getEvents({ issueId: blocker.issue.id });
      const blockedLog = yield* tracker.getEvents({ issueId: blocked.issue.id });
      assert.deepStrictEqual(
        [blockerLog.events.at(-1)?.field, blockerLog.events.at(-1)?.after],
        ["relation", `blocks ${blocked.issue.key}`],
      );
      assert.strictEqual(blockedLog.events.at(-1)?.after, `blocked by ${blocker.issue.key}`);

      const duplicate = yield* tracker
        .relationCreate(
          { issueId: blocker.issue.id, relatedIssueId: blocked.issue.id, kind: "blocks" },
          ACTOR,
        )
        .pipe(Effect.flip);
      assert.strictEqual(duplicate.reason, "invalid");

      // `relates` reads the same from either side, so the mirrored row is the same statement.
      yield* tracker.relationCreate(
        { issueId: blocker.issue.id, relatedIssueId: blocked.issue.id, kind: "relates" },
        ACTOR,
      );
      const mirrored = yield* tracker
        .relationCreate(
          { issueId: blocked.issue.id, relatedIssueId: blocker.issue.id, kind: "relates" },
          ACTOR,
        )
        .pipe(Effect.flip);
      assert.strictEqual(mirrored.reason, "invalid");

      const relationId = created.affected[0]!.relations[0]!.relation.id;
      const removed = yield* tracker.relationDelete({ relationId }, ACTOR);
      assert.deepStrictEqual(
        removed.affected.map((entry) => entry.relations.length),
        [1, 1],
      );
      const afterDelete = yield* tracker.getEvents({ issueId: blocked.issue.id });
      assert.deepStrictEqual(
        [afterDelete.events.at(-1)?.before, afterDelete.events.at(-1)?.after],
        [`blocked by ${blocker.issue.key}`, null],
      );
    }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect("lets an author edit their comment and the user delete anybody's", () =>
    Effect.gen(function* () {
      const tracker = yield* IssueTrackerService;
      const { issue } = yield* tracker.create({ title: "Discussed" }, ACTOR);

      const mine = yield* tracker.commentCreate({ issueId: issue.id, body: "Mine" }, ACTOR);
      const theirs = yield* tracker.commentCreate({ issueId: issue.id, body: "Theirs" }, AGENT);
      assert.deepStrictEqual(theirs.comment.author, AGENT);
      assert.isNull(mine.comment.editedAt);

      const edited = yield* tracker.commentUpdate(
        { commentId: mine.comment.id, patch: { body: "Mine, revised" } },
        ACTOR,
      );
      assert.strictEqual(edited.comment.body, "Mine, revised");
      // An edit does not move `createdAt`, so the thread keeps its order.
      assert.strictEqual(edited.comment.createdAt, mine.comment.createdAt);
      assert.isNotNull(edited.comment.editedAt);

      const notMine = yield* tracker
        .commentUpdate({ commentId: theirs.comment.id, patch: { body: "Rewritten" } }, ACTOR)
        .pipe(Effect.flip);
      assert.strictEqual(notMine.reason, "invalid");
      const agentDeletingMine = yield* tracker
        .commentDelete({ commentId: mine.comment.id }, AGENT)
        .pipe(Effect.flip);
      assert.strictEqual(agentDeletingMine.reason, "invalid");

      // The sole human can delete an agent's comment: an agent commenting in a loop is stoppable.
      const remaining = yield* tracker.commentDelete({ commentId: theirs.comment.id }, ACTOR);
      assert.deepStrictEqual(
        remaining.comments.map((comment) => comment.body),
        ["Mine, revised"],
      );
      // Comments are their own visible record, so none of this is in the change log.
      const { events } = yield* tracker.getEvents({ issueId: issue.id });
      assert.deepStrictEqual(
        events.map((event) => event.kind),
        ["created"],
      );
    }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect("only accepts attachments minted for the issue the comment is on", () =>
    Effect.gen(function* () {
      const tracker = yield* IssueTrackerService;
      const { issue } = yield* tracker.create({ title: "With a screenshot" }, ACTOR);
      const mine = `iss_${issue.id}-00000000-0000-4000-8000-000000000001`;

      const created = yield* tracker.commentCreate(
        { issueId: issue.id, body: "Look", attachmentIds: [mine] },
        ACTOR,
      );
      assert.deepStrictEqual(created.comment.attachmentIds, [mine]);

      const foreign = yield* tracker
        .commentCreate(
          {
            issueId: issue.id,
            body: "Look",
            attachmentIds: ["thread-1-00000000-0000-4000-8000-000000000002"],
          },
          ACTOR,
        )
        .pipe(Effect.flip);
      assert.strictEqual(foreign.reason, "invalid");
    }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect("reads the per-issue tail through getDetail", () =>
    Effect.gen(function* () {
      const tracker = yield* IssueTrackerService;
      const { issue } = yield* tracker.create({ title: "Detailed" }, ACTOR);
      const other = yield* tracker.create({ title: "Related" }, ACTOR);
      yield* tracker.todoCreate({ issueId: issue.id, text: "A step" });
      yield* tracker.relationCreate(
        { issueId: issue.id, relatedIssueId: other.issue.id, kind: "relates" },
        ACTOR,
      );
      yield* tracker.commentCreate({ issueId: issue.id, body: "A word" }, ACTOR);

      const detail = yield* tracker.getDetail({ issueId: issue.id });

      assert.deepStrictEqual(
        detail.todos.map((todo) => todo.text),
        ["A step"],
      );
      assert.deepStrictEqual(
        detail.relations.map((edge) => edge.direction),
        ["outgoing"],
      );
      assert.deepStrictEqual(
        detail.comments.map((comment) => comment.body),
        ["A word"],
      );
      // The tail is per-issue: none of it rides along in the snapshot.
      assert.isFalse(Object.hasOwn(yield* tracker.getSnapshot(), "todos"));

      const missing = yield* tracker
        .getDetail({ issueId: other.issue.id })
        .pipe(Effect.map((found) => found.comments.length));
      assert.strictEqual(missing, 0);
    }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect("streams milestone, cycle, todo, relation, and comment diffs", () =>
    Effect.gen(function* () {
      const tracker = yield* IssueTrackerService;
      const { issue } = yield* tracker.create({ title: "Watched" }, ACTOR);
      const other = yield* tracker.create({ title: "Other" }, ACTOR);

      const events = yield* Stream.runCollect(
        Stream.take(tracker.stream, 17).pipe(
          Stream.merge(
            Stream.fromEffect(
              Effect.gen(function* () {
                yield* tracker.milestoneCreate({ projectId: PROJECT, name: "Beta" });
                yield* tracker.cycleCreate({
                  name: "Cycle 1",
                  startDate: yield* dateDaysFromToday(1),
                  endDate: yield* dateDaysFromToday(9),
                });
                yield* tracker.todoCreate({ issueId: issue.id, text: "A step" });
                yield* tracker.relationCreate(
                  { issueId: issue.id, relatedIssueId: other.issue.id, kind: "blocks" },
                  ACTOR,
                );
                const comment = yield* tracker.commentCreate(
                  { issueId: issue.id, body: "A word" },
                  ACTOR,
                );
                yield* tracker.commentDelete({ commentId: comment.comment.id }, ACTOR);
              }),
            ).pipe(Stream.drain),
          ),
        ),
      );

      assert.deepStrictEqual(
        // Eight opening diffs and one `IssueUpserted` per issue that already existed.
        events.slice(10).map((event) => event._tag),
        [
          "MilestonesChanged",
          "CyclesChanged",
          "IssueTodosChanged",
          "IssueRelationsChanged",
          "IssueRelationsChanged",
          "IssueCommentUpserted",
          "IssueCommentDeleted",
        ],
      );
    }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect("publishes a soft delete as an upsert carrying deletedAt, never as IssueDeleted", () =>
    Effect.gen(function* () {
      const tracker = yield* IssueTrackerService;
      const { issue } = yield* tracker.create({ title: "Doomed" }, ACTOR);

      // Ten events: the eight opening diffs, the `IssueUpserted` replaying the issue that already
      // existed, and the one the delete publishes.
      const events = yield* Stream.runCollect(
        Stream.take(tracker.stream, 10).pipe(
          Stream.merge(
            Stream.fromEffect(tracker.remove({ issueId: issue.id }, ACTOR)).pipe(Stream.drain),
          ),
        ),
      );

      const last = events.at(-1);
      assert.strictEqual(last?._tag, "IssueUpserted");
      // The client keeps the row: the depth cap counts a soft-deleted ancestor, so dropping it
      // would make the parent picker offer parents this service refuses.
      assert.isNotNull(last?._tag === "IssueUpserted" ? last.issue.deletedAt : null);
      assert.isFalse(events.some((event) => event._tag === "IssueDeleted"));
    }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect("counts a soft-deleted ancestor against the depth cap", () =>
    Effect.gen(function* () {
      const tracker = yield* IssueTrackerService;
      const root = yield* tracker.create({ title: "Root" }, ACTOR);
      const second = yield* tracker.create({ title: "Second", parentId: root.issue.id }, ACTOR);
      const third = yield* tracker.create({ title: "Third", parentId: second.issue.id }, ACTOR);
      const fourth = yield* tracker.create({ title: "Fourth", parentId: third.issue.id }, ACTOR);

      yield* tracker.remove({ issueId: root.issue.id }, ACTOR);

      // The chain is still four rows deep: a soft-deleted row keeps its children pointed at it.
      const tooDeep = yield* tracker
        .create({ title: "Fifth", parentId: fourth.issue.id }, ACTOR)
        .pipe(Effect.flip);
      assert.strictEqual(tooDeep.reason, "invalid");
    }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect("creates, renames, reorders, and deletes saved views", () =>
    Effect.gen(function* () {
      const tracker = yield* IssueTrackerService;

      const mine = yield* tracker.viewCreate({ name: "My issues", config: VIEW_CONFIG });
      const urgent = yield* tracker.viewCreate({
        name: "Urgent",
        config: { ...VIEW_CONFIG, priorities: ["urgent"], viewMode: "board" },
      });
      assert.deepStrictEqual(
        urgent.views.map((view) => view.name),
        ["My issues", "Urgent"],
      );

      const clash = yield* tracker
        .viewCreate({ name: "urgent", config: VIEW_CONFIG })
        .pipe(Effect.flip);
      assert.strictEqual(clash.reason, "conflict");

      // The config is replaced wholesale: a chip that is absent from the patch is a chip removed.
      const renamed = yield* tracker.viewUpdate({
        viewId: mine.view.id,
        patch: { name: "Mine", config: { ...VIEW_CONFIG, grouping: "assignee" } },
      });
      assert.strictEqual(renamed.view.name, "Mine");
      assert.strictEqual(renamed.view.config.grouping, "assignee");
      assert.isUndefined(renamed.view.config.priorities);
      assert.isTrue(renamed.view.updatedAt >= renamed.view.createdAt);

      const reordered = yield* tracker.viewsReorder({
        viewIds: [urgent.view.id, mine.view.id],
      });
      assert.deepStrictEqual(
        reordered.views.map((view) => view.name),
        ["Urgent", "Mine"],
      );
      assert.deepStrictEqual(
        reordered.views.map((view) => view.position),
        [1, 2],
      );

      // A reorder is the complete order, so an omission is refused rather than left unpositioned.
      const partial = yield* tracker.viewsReorder({ viewIds: [mine.view.id] }).pipe(Effect.flip);
      assert.strictEqual(partial.reason, "invalid");

      const remaining = yield* tracker.viewDelete({ viewId: urgent.view.id });
      assert.deepStrictEqual(
        remaining.views.map((view) => view.name),
        ["Mine"],
      );
      const gone = yield* tracker.viewDelete({ viewId: urgent.view.id }).pipe(Effect.flip);
      assert.strictEqual(gone.reason, "not-found");

      // Views ride the snapshot the way statuses and labels do.
      const snapshot = yield* tracker.getSnapshot();
      assert.deepStrictEqual(
        snapshot.views.map((view) => view.name),
        ["Mine"],
      );
    }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect("publishes the whole view set on every view write", () =>
    Effect.gen(function* () {
      const tracker = yield* IssueTrackerService;

      const events = yield* Stream.runCollect(
        Stream.take(tracker.stream, 9).pipe(
          Stream.merge(
            Stream.fromEffect(tracker.viewCreate({ name: "Board", config: VIEW_CONFIG })).pipe(
              Stream.drain,
            ),
          ),
        ),
      );

      const last = events.at(-1);
      assert.strictEqual(last?._tag, "ViewsChanged");
      assert.deepStrictEqual(
        last?._tag === "ViewsChanged" ? last.views.map((view) => view.name) : [],
        ["Board"],
      );
    }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect("writes a comment attachment into the issue namespace and serves it back", () =>
    Effect.gen(function* () {
      const tracker = yield* IssueTrackerService;
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const { issue } = yield* tracker.create({ title: "With a picture" }, ACTOR);

      const { attachmentId } = yield* tracker.uploadCommentAttachment({
        issueId: issue.id,
        dataUrl: `data:image/png;base64,${PNG_BASE64}`,
      });

      // Namespaced to the issue, which is what keeps thread attachment cleanup off this file.
      assert.isTrue(attachmentId.startsWith("iss_"));
      const resolved = resolveAttachmentPathById({
        attachmentsDir: config.attachmentsDir,
        attachmentId,
      });
      assert.isNotNull(resolved);
      assert.isTrue(resolved?.endsWith(".png"));
      const written = yield* fileSystem.readFile(resolved!);
      assert.strictEqual(written.byteLength, Buffer.from(PNG_BASE64, "base64").byteLength);

      // The comment write accepts exactly the id this handed out, and refuses another issue's.
      const { comment } = yield* tracker.commentCreate(
        { issueId: issue.id, body: "Look", attachmentIds: [attachmentId] },
        ACTOR,
      );
      assert.deepStrictEqual(comment.attachmentIds, [attachmentId]);

      const other = yield* tracker.create({ title: "Somebody else" }, ACTOR);
      const foreign = yield* tracker
        .commentCreate(
          { issueId: other.issue.id, body: "Stolen", attachmentIds: [attachmentId] },
          ACTOR,
        )
        .pipe(Effect.flip);
      assert.strictEqual(foreign.reason, "invalid");
    }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect("refuses an attachment that is not an image, is empty, or is too large", () =>
    Effect.gen(function* () {
      const tracker = yield* IssueTrackerService;
      const { issue } = yield* tracker.create({ title: "Guarded" }, ACTOR);

      const notAnImage = yield* tracker
        .uploadCommentAttachment({
          issueId: issue.id,
          dataUrl: "data:application/pdf;base64,JVBERi0=",
        })
        .pipe(Effect.flip);
      assert.strictEqual(notAnImage.reason, "invalid");

      const notADataUrl = yield* tracker
        .uploadCommentAttachment({ issueId: issue.id, dataUrl: "https://example.com/cat.png" })
        .pipe(Effect.flip);
      assert.strictEqual(notADataUrl.reason, "invalid");

      const empty = yield* tracker
        .uploadCommentAttachment({ issueId: issue.id, dataUrl: "data:image/png;base64," })
        .pipe(Effect.flip);
      assert.strictEqual(empty.reason, "invalid");

      // One byte past the ceiling the wire schema also caps, checked after the decode because a
      // base64 payload is a third larger than the image it carries.
      const tooLarge = yield* tracker
        .uploadCommentAttachment({
          issueId: issue.id,
          dataUrl: `data:image/png;base64,${Buffer.alloc(
            ISSUE_COMMENT_ATTACHMENT_MAX_BYTES + 3,
          ).toString("base64")}`,
        })
        .pipe(Effect.flip);
      assert.strictEqual(tooLarge.reason, "invalid");

      const missingIssue = yield* tracker
        .uploadCommentAttachment({
          issueId: IssueId.make("nobody"),
          dataUrl: `data:image/png;base64,${PNG_BASE64}`,
        })
        .pipe(Effect.flip);
      assert.strictEqual(missingIssue.reason, "not-found");
    }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect("links a thread once, restates the origin after that, and logs the first only", () =>
    Effect.gen(function* () {
      const tracker = yield* IssueTrackerService;
      const { issue } = yield* tracker.create({ title: "Ship the toolkit" }, ACTOR);
      const threadId = ThreadId.make("thread-1");

      const linked = yield* tracker.linkThread(
        { issueId: issue.id, threadId, origin: "start-work" },
        ACTOR,
      );
      assert.deepStrictEqual(
        linked.links.map((link) => [link.threadId, link.origin]),
        [[threadId, "start-work"]],
      );

      // The same thread again is the same fact restated: the origin moves, the row does not
      // multiply, and `createdAt` stays at when the thread started on this issue.
      const relinked = yield* tracker.linkThread(
        { issueId: issue.id, threadId, origin: "manual" },
        ACTOR,
      );
      assert.strictEqual(relinked.links.length, 1);
      assert.strictEqual(relinked.links[0]?.origin, "manual");
      assert.strictEqual(relinked.links[0]?.createdAt, linked.links[0]?.createdAt);

      const { events } = yield* tracker.getEvents({ issueId: issue.id });
      const threadEvents = events.filter((event) => event.field === "thread");
      assert.deepStrictEqual(
        threadEvents.map((event) => [event.before, event.after]),
        [[null, threadId]],
      );
      assert.strictEqual(threadEvents[0]?.kind, "field_changed");
    }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect("unlinks a thread into the change log, and forgetting twice is not an error", () =>
    Effect.gen(function* () {
      const tracker = yield* IssueTrackerService;
      const { issue } = yield* tracker.create({ title: "Ship the toolkit" }, AGENT);
      const threadId = ThreadId.make("thread-1");
      yield* tracker.linkThread({ issueId: issue.id, threadId, origin: "manual" }, ACTOR);

      const unlinked = yield* tracker.unlinkThread({ issueId: issue.id, threadId }, AGENT);
      assert.deepStrictEqual(unlinked.links, []);
      // Two clients can press this at once; the answer either way is the list without it on.
      assert.deepStrictEqual(
        (yield* tracker.unlinkThread({ issueId: issue.id, threadId }, AGENT)).links,
        [],
      );

      const { events } = yield* tracker.getEvents({ issueId: issue.id });
      const threadEvents = events.filter((event) => event.field === "thread");
      assert.deepStrictEqual(
        threadEvents.map((event) => [event.before, event.after]),
        [
          [null, threadId],
          [threadId, null],
        ],
      );
      // The feed names the writer, and an agent unlinking is not the same as a person doing it.
      assert.deepStrictEqual(threadEvents[1]?.actor, AGENT);
      assert.deepStrictEqual((yield* tracker.getThreadLinks({ issueId: issue.id })).links, []);
    }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect("publishes an issue's thread list on every link and unlink", () =>
    Effect.gen(function* () {
      const tracker = yield* IssueTrackerService;
      const { issue } = yield* tracker.create({ title: "Ship the toolkit" }, ACTOR);
      const threadId = ThreadId.make("thread-1");

      const events = yield* Stream.runCollect(
        Stream.take(tracker.stream, 11).pipe(
          Stream.merge(
            Stream.fromEffect(
              tracker
                .linkThread({ issueId: issue.id, threadId, origin: "start-work" }, ACTOR)
                .pipe(Effect.andThen(tracker.unlinkThread({ issueId: issue.id, threadId }, ACTOR))),
            ).pipe(Stream.drain),
          ),
        ),
      );

      const linkEvents = events.filter((event) => event._tag === "IssueThreadLinksChanged");
      assert.deepStrictEqual(
        linkEvents.map((event) => event.links.length),
        [1, 0],
      );
      assert.strictEqual(linkEvents[0]?.issueId, issue.id);
    }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect("refuses an enrichment run when the issue has no repository to read", () =>
    Effect.gen(function* () {
      const tracker = yield* IssueTrackerService;
      yield* seedProject(ROOTLESS_PROJECT, null);
      yield* seedProject(PROJECT, "/tmp/pathway");

      // No project at all.
      const { issue } = yield* tracker.create({ title: "Unfiled" }, ACTOR);
      const unfiled = yield* Effect.flip(tracker.startEnrichment({ issueId: issue.id }));
      assert.strictEqual(unfiled.reason, "invalid");

      // A project that was created from a name and never given a directory.
      const { issue: rootless } = yield* tracker.create(
        { title: "Rootless", projectId: ROOTLESS_PROJECT },
        ACTOR,
      );
      const refused = yield* Effect.flip(tracker.startEnrichment({ issueId: rootless.id }));
      assert.strictEqual(refused.reason, "invalid");
      assert.strictEqual(refused.subject, rootless.key);

      // A project nobody ever projected.
      const { issue: missing } = yield* tracker.create(
        { title: "Ghost project", projectId: ProjectId.make("project-ghost") },
        ACTOR,
      );
      assert.strictEqual(
        (yield* Effect.flip(tracker.startEnrichment({ issueId: missing.id }))).reason,
        "invalid",
      );

      // Nothing was written on the way to any of those refusals.
      assert.deepStrictEqual((yield* tracker.getEnrichmentRuns({ issueId: rootless.id })).runs, []);
    }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect("refuses a second run while one is still in flight, and allows one after", () =>
    Effect.gen(function* () {
      const tracker = yield* IssueTrackerService;
      yield* seedProject(PROJECT, "/tmp/pathway");
      const { issue } = yield* tracker.create(
        { title: "Investigate me", projectId: PROJECT },
        ACTOR,
      );

      const { run } = yield* tracker.startEnrichment({ issueId: issue.id });
      assert.strictEqual(run.state, "queued");
      assert.strictEqual(run.modelSelection.model, ENRICHMENT_MODEL.model);

      const refused = yield* Effect.flip(tracker.startEnrichment({ issueId: issue.id }));
      assert.strictEqual(refused.reason, "invalid");
      assert.strictEqual(refused.subject, issue.key);

      // Cancelling ends the flight, so the next one is allowed.
      yield* tracker.cancelEnrichment({ runId: run.id });
      const { run: second } = yield* tracker.startEnrichment({ issueId: issue.id });
      const { runs } = yield* tracker.getEnrichmentRuns({ issueId: issue.id });
      assert.deepStrictEqual(
        runs.map((each) => each.id),
        [second.id, run.id],
      );
    }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect("hands the queued run to the engine and publishes every transition it reports", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<string, never>();
      const finished = yield* Deferred.make<void, never>();
      const result: IssueEnrichmentResult = {
        summary: "Start in the tracker service.",
        likelyFiles: [{ path: "apps/server/src/issues/IssueTrackerService.ts", reason: "Owner" }],
        relatedIssueKeys: [],
        suggestedLabels: ["Bug"],
        suggestedPriority: "high",
      };
      const engine = makeFakeEngine({
        start: ({ workspaceRoot, recorder }) =>
          Deferred.succeed(started, workspaceRoot).pipe(
            Effect.andThen(recorder.markRunning),
            Effect.andThen(recorder.appendTranscript("reading ")),
            Effect.andThen(recorder.appendTranscript("files\n")),
            Effect.andThen(recorder.succeed(result)),
            Effect.andThen(Deferred.succeed(finished, undefined)),
            Effect.asVoid,
          ),
      });

      const tracker = yield* buildTracker(engine);
      yield* seedProject(PROJECT, "/tmp/pathway");
      const { issue } = yield* tracker.create(
        { title: "Investigate me", projectId: PROJECT },
        ACTOR,
      );

      const { run } = yield* tracker.startEnrichment({ issueId: issue.id });
      // The engine is handed the project's directory, which is why a rootless one never gets here.
      assert.strictEqual(yield* Deferred.await(started), "/tmp/pathway");
      yield* Deferred.await(finished);

      const { runs } = yield* tracker.getEnrichmentRuns({ issueId: issue.id });
      const finishedRun = runs[0];
      assert.strictEqual(finishedRun?.id, run.id);
      assert.strictEqual(finishedRun?.state, "done");
      assert.strictEqual(finishedRun?.transcript, "reading files\n");
      assert.deepStrictEqual(finishedRun?.result, result);
      assert.isNotNull(finishedRun?.startedAt);
      assert.isNotNull(finishedRun?.finishedAt);
    }).pipe(Effect.provide(makeDependencyLayer())),
  );

  it.effect("automatically applies investigation fields and a system-owned generic title", () =>
    Effect.gen(function* () {
      const finished = yield* Deferred.make<void, never>();
      const result: IssueEnrichmentResult = {
        summary: "The screenshot shows an editor menu with no available actions.",
        likelyFiles: [],
        relatedIssueKeys: [],
        suggestedLabels: [],
        suggestedPriority: "medium",
        suggestedTitle: "Hide editor menus that have no available actions",
        suggestedDescription: "Hide context-specific menus when they have no available actions.",
      };
      const tracker = yield* buildTracker(
        makeFakeEngine({
          start: ({ recorder }) =>
            recorder.markRunning.pipe(
              Effect.andThen(recorder.succeed(result)),
              Effect.andThen(Deferred.succeed(finished, undefined)),
              Effect.asVoid,
            ),
        }),
      );
      yield* seedProject(PROJECT, "/tmp/pathway");
      const { issue } = yield* tracker.intakeCreateIssue({
        channelId: "C1",
        messageTs: "1723459200.000100",
        title: "",
        projectId: PROJECT,
      });

      yield* tracker.startEnrichment({ issueId: issue.id });
      yield* Deferred.await(finished);

      const updated = (yield* tracker.getSnapshot()).issues.find(
        (candidate) => candidate.id === issue.id,
      );
      assert.strictEqual(updated?.title, result.suggestedTitle);
      assert.strictEqual(updated?.description, result.suggestedDescription);
      assert.strictEqual(updated?.priority, "medium");

      const automaticChanges = (yield* tracker.getEvents({ issueId: issue.id })).events.filter(
        (event) => event.kind === "field_changed",
      );
      assert.deepStrictEqual(
        automaticChanges.map((event) => event.field),
        ["title", "description", "priority"],
      );
      assert.isTrue(automaticChanges.every((event) => event.actor.kind === "agent"));
    }).pipe(Effect.provide(makeDependencyLayer())),
  );

  it.effect("keeps a user-authored generic title as a confirmation action", () =>
    Effect.gen(function* () {
      const finished = yield* Deferred.make<void, never>();
      const result: IssueEnrichmentResult = {
        summary: "The issue needs a specific name.",
        likelyFiles: [],
        relatedIssueKeys: [],
        suggestedLabels: [],
        suggestedPriority: "high",
        suggestedTitle: "Reconnect drops the queued turn",
        suggestedDescription: "A relay reconnect loses the queued turn.",
      };
      const tracker = yield* buildTracker(
        makeFakeEngine({
          start: ({ recorder }) =>
            recorder.markRunning.pipe(
              Effect.andThen(recorder.succeed(result)),
              Effect.andThen(Deferred.succeed(finished, undefined)),
              Effect.asVoid,
            ),
        }),
      );
      yield* seedProject(PROJECT, "/tmp/pathway");
      const { issue } = yield* tracker.create({ title: "Untitled", projectId: PROJECT }, ACTOR);

      yield* tracker.startEnrichment({ issueId: issue.id });
      yield* Deferred.await(finished);

      const updated = (yield* tracker.getSnapshot()).issues.find(
        (candidate) => candidate.id === issue.id,
      );
      assert.strictEqual(updated?.title, "Untitled");
      assert.strictEqual(updated?.description, result.suggestedDescription);
      assert.strictEqual(updated?.priority, "high");
      assert.strictEqual(
        (yield* tracker.getEnrichmentRuns({ issueId: issue.id })).runs[0]?.result?.suggestedTitle,
        result.suggestedTitle,
      );
    }).pipe(Effect.provide(makeDependencyLayer())),
  );

  it.effect("lands a cancelled run in failed, and refuses to cancel a finished one", () =>
    Effect.gen(function* () {
      const cancelled = yield* Deferred.make<IssueEnrichmentRunId, never>();
      const tracker = yield* buildTracker(
        makeFakeEngine({
          // A real engine kills its process here; the record is already failed by this point.
          cancel: ({ runId }) => Deferred.succeed(cancelled, runId).pipe(Effect.asVoid),
        }),
      );
      yield* seedProject(PROJECT, "/tmp/pathway");
      const { issue } = yield* tracker.create(
        { title: "Investigate me", projectId: PROJECT },
        ACTOR,
      );

      const { run } = yield* tracker.startEnrichment({ issueId: issue.id });
      const { run: stopped } = yield* tracker.cancelEnrichment({ runId: run.id });
      assert.strictEqual(stopped.state, "failed");
      assert.strictEqual(stopped.error, "Canceled.");
      assert.isNotNull(stopped.finishedAt);
      assert.strictEqual(yield* Deferred.await(cancelled), run.id);

      // Cancelling twice is a conflict rather than a second cancellation of the same run.
      const refused = yield* Effect.flip(tracker.cancelEnrichment({ runId: run.id }));
      assert.strictEqual(refused.reason, "conflict");
    }).pipe(Effect.provide(makeDependencyLayer())),
  );

  it.effect("fails every run a previous server left in flight, at startup", () =>
    Effect.gen(function* () {
      const runs = yield* IssueEnrichmentRunRepository;
      const before = yield* buildTracker();
      const { issue } = yield* before.create({ title: "Investigate me" }, ACTOR);

      // What a server that was killed mid-investigation leaves behind.
      yield* runs.create(makeQueuedRun(IssueEnrichmentRunId.make("run-queued"), issue.id));
      yield* runs.create({
        ...makeQueuedRun(IssueEnrichmentRunId.make("run-running"), issue.id),
        state: "running",
        startedAt: "2026-08-12T00:00:01.000Z",
      });

      // A second build of the layer is a restart of the server.
      const after = yield* buildTracker();
      const swept = (yield* after.getEnrichmentRuns({ issueId: issue.id })).runs;

      assert.deepStrictEqual(
        swept.map((run) => run.state),
        ["failed", "failed"],
      );
      for (const run of swept) {
        assert.include(run.error ?? "", "restarted");
        assert.isNotNull(run.finishedAt);
      }
      // Nothing is in flight any more, so the issue can be investigated again.
      assert.deepStrictEqual(yield* runs.listUnfinished(), []);
    }).pipe(Effect.provide(makeDependencyLayer())),
  );
  // ── Slack intake ─────────────────────────────────────────────────────

  it.effect(
    "writes the bot token into the secrets directory and clears it with an empty string",
    () =>
      Effect.gen(function* () {
        const tracker = yield* IssueTrackerService;
        const config = yield* ServerConfig.ServerConfig;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tokenPath = path.join(config.secretsDir, "slack-bot-token.bin");

        const stored = yield* tracker.slackSetToken({ token: "  xoxb-1-2-abcdef  " });
        assert.deepStrictEqual(
          [stored.status.configured, stored.status.workspaceName, stored.status.lastError],
          [true, "Pathway HQ", null],
        );
        // Trimmed on the way in: a pasted token carries whatever whitespace came with it.
        assert.strictEqual(yield* fileSystem.readFileString(tokenPath), "xoxb-1-2-abcdef");

        const cleared = yield* tracker.slackSetToken({ token: "" });
        assert.deepStrictEqual(
          [cleared.status.configured, cleared.status.workspaceName],
          [false, null],
        );
        assert.isFalse(yield* fileSystem.exists(tokenPath));
        assert.strictEqual((yield* tracker.slackGetStatus()).status.configured, false);
      }).pipe(Effect.provide(makeTestLayer())),
  );

  // Tried before it is written, so `configured` never means "configured with something broken".
  it.effect("refuses a token Slack will not accept, and leaves nothing on disk", () =>
    Effect.gen(function* () {
      const tracker = yield* IssueTrackerService;
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const refused = yield* Effect.flip(tracker.slackSetToken({ token: "xoxb-nope" }));
      assert.strictEqual(refused.reason, "invalid");

      assert.isFalse(yield* fileSystem.exists(path.join(config.secretsDir, "slack-bot-token.bin")));
      const { status } = yield* tracker.slackGetStatus();
      assert.strictEqual(status.configured, false);
      // The settings page reads the status, so the refusal has to be visible there too.
      assert.include(status.lastError ?? "", "invalid_auth");
    }).pipe(
      Effect.provide(
        makeTestLayer(
          makeFakeEngine(),
          makeFakeSlackEngine({
            testConnection: () =>
              Effect.fail(new IssueTrackerError({ reason: "invalid", message: "invalid_auth" })),
          }),
        ),
      ),
    ),
  );

  it.effect("creates, edits, and deletes a channel watch, publishing the whole set each time", () =>
    Effect.gen(function* () {
      const tracker = yield* IssueTrackerService;
      const startDate = yield* dateDaysFromToday(1);
      const endDate = yield* dateDaysFromToday(14);
      const { cycle } = yield* tracker.cycleCreate({ name: "Release 1", startDate, endDate });

      const created = yield* tracker.slackWatchCreate({
        channelId: "C1",
        channelName: "triage",
        projectId: PROJECT,
      });
      // A watch created without a trigger is paused, not broken.
      assert.deepStrictEqual(created.watch.trigger, {
        reactionRoutes: [],
        everyMessage: false,
        botMention: false,
      });
      assert.isFalse(created.watch.autoInvestigate);

      const updated = yield* tracker.slackWatchUpdate({
        watchId: created.watch.id,
        patch: {
          projectId: null,
          cycleId: cycle.id,
          autoInvestigate: true,
          trigger: {
            reactionRoutes: [{ emoji: "ticket", projectId: PROJECT, autoInvestigate: false }],
            everyMessage: false,
            botMention: true,
          },
        },
      });
      assert.isNull(updated.watch.projectId);
      assert.strictEqual(updated.watch.cycleId, cycle.id);
      assert.isTrue(updated.watch.autoInvestigate);
      assert.deepStrictEqual(updated.watch.trigger, {
        reactionRoutes: [{ emoji: "ticket", projectId: PROJECT, autoInvestigate: false }],
        everyMessage: false,
        botMention: true,
      });
      // Read back through the snapshot, so the round trip through SQLite is exercised.
      assert.deepStrictEqual((yield* tracker.getSnapshot()).slackWatches, [updated.watch]);

      // Two watches on one channel would poll it twice and file everything twice.
      const duplicate = yield* Effect.flip(
        tracker.slackWatchCreate({ channelId: "C1", channelName: "triage" }),
      );
      assert.strictEqual(duplicate.reason, "conflict");

      const deleted = yield* tracker.slackWatchDelete({ watchId: created.watch.id });
      assert.deepStrictEqual(deleted.watches, []);
      const gone = yield* Effect.flip(tracker.slackWatchDelete({ watchId: created.watch.id }));
      assert.strictEqual(gone.reason, "not-found");
    }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect("publishes the watch set on the stream and pokes the poller", () => {
    // Counted outside the effect because the fake is baked into the layer, and the layer is what
    // the tracker closes over: a service swapped in afterwards would never be the one it calls.
    let pokes = 0;
    return Effect.gen(function* () {
      const tracker = yield* IssueTrackerService;

      const events = yield* Stream.runCollect(
        Stream.take(tracker.stream, 9).pipe(
          Stream.merge(
            Stream.fromEffect(
              tracker.slackWatchCreate({ channelId: "C1", channelName: "triage" }),
            ).pipe(Stream.drain),
          ),
        ),
      );

      const last = events.at(-1);
      assert.strictEqual(last?._tag, "SlackWatchesChanged");
      assert.deepStrictEqual(
        last?._tag === "SlackWatchesChanged" ? last.watches.map((watch) => watch.channelName) : [],
        ["triage"],
      );
      // The next pass would read the new configuration anyway; the poke only shortens the wait.
      assert.strictEqual(pokes, 1);
    }).pipe(
      Effect.provide(
        makeTestLayer(
          makeFakeEngine(),
          makeFakeSlackEngine({
            notifyWatchesChanged: Effect.sync(() => {
              pokes += 1;
            }),
          }),
        ),
      ),
    );
  });

  it.effect("files a watched message once, however many polls read it", () =>
    Effect.gen(function* () {
      const tracker = yield* IssueTrackerService;

      const filed = yield* tracker.intakeCreateIssue({
        channelId: "C1",
        messageTs: "1723459200.000100",
        title: "  The deploy   is stuck\non staging  ",
        description: "The deploy is stuck on staging.",
        projectId: PROJECT,
        permalink: "https://pathway.slack.com/archives/C1/p1723459200000100",
        authorName: "  Corey  ",
      });

      assert.isTrue(filed.created);
      // A triage item has no status presence: it is in no board and no count until it is accepted.
      assert.isTrue(filed.issue.triage);
      assert.strictEqual(filed.issue.projectId, PROJECT);
      // Newlines collapse, because a title is one line and the body keeps the full text.
      assert.strictEqual(filed.issue.title, "The deploy is stuck on staging");
      assert.deepStrictEqual(filed.issue.slackSource, {
        issueId: filed.issue.id,
        channelId: "C1",
        messageTs: "1723459200.000100",
        permalink: "https://pathway.slack.com/archives/C1/p1723459200000100",
        authorName: "Corey",
      });

      // A poll window overlaps the last one by design, so the ledger is what stops a second file.
      const again = yield* tracker.intakeCreateIssue({
        channelId: "C1",
        messageTs: "1723459200.000100",
        title: "The deploy is stuck on staging",
      });
      assert.isFalse(again.created);
      assert.strictEqual(again.issue.id, filed.issue.id);
      assert.strictEqual((yield* tracker.getSnapshot()).issues.length, 1);

      // The same ts in another channel is another message: Slack's ts is unique per channel only.
      const elsewhere = yield* tracker.intakeCreateIssue({
        channelId: "C2",
        messageTs: "1723459200.000100",
        title: "Different room, same second",
      });
      assert.isTrue(elsewhere.created);

      // The source survives the trip through SQLite, which is four columns and back.
      const reread = (yield* tracker.getSnapshot()).issues.find(
        (issue) => issue.id === filed.issue.id,
      );
      assert.strictEqual(reread?.slackSource?.messageTs, "1723459200.000100");
      assert.strictEqual(reread?.slackSource?.channelId, "C1");
    }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect("routes a thread reply onto the issue its parent became, and only once", () =>
    Effect.gen(function* () {
      const tracker = yield* IssueTrackerService;
      const filed = yield* tracker.intakeCreateIssue({
        channelId: "C1",
        messageTs: "1723459200.000100",
        title: "The deploy is stuck",
      });

      const attached = yield* tracker.intakeAddComment({
        channelId: "C1",
        threadTs: "1723459200.000100",
        messageTs: "1723459260.000200",
        authorName: "Corey",
        body: "Restarting the worker fixed it.",
      });
      assert.strictEqual(attached.comment?.issueId, filed.issue.id);
      // The write is the tracker acting on somebody's behalf; the human's name rides in the body.
      assert.deepStrictEqual(attached.comment?.author, { kind: "system", source: "slack" });
      assert.strictEqual(attached.comment?.body, "**Corey:** Restarting the worker fixed it.");

      const replayed = yield* tracker.intakeAddComment({
        channelId: "C1",
        threadTs: "1723459200.000100",
        messageTs: "1723459260.000200",
        body: "Restarting the worker fixed it.",
      });
      assert.isNull(replayed.comment);
      assert.strictEqual(
        (yield* tracker.commentsList({ issueId: filed.issue.id })).comments.length,
        1,
      );

      // Most replies in a watched channel are on threads that never became issues.
      const orphan = yield* tracker.intakeAddComment({
        channelId: "C1",
        threadTs: "1723459999.000900",
        messageTs: "1723460000.000100",
        body: "Talking about lunch.",
      });
      assert.isNull(orphan.comment);
    }).pipe(Effect.provide(makeTestLayer())),
  );

  // ── Triage ───────────────────────────────────────────────────────────

  it.effect("accepts a triage item in one write, with one event row per field that moved", () =>
    Effect.gen(function* () {
      const tracker = yield* IssueTrackerService;
      yield* seedProject(PROJECT, "/tmp/pathway");
      const filed = yield* tracker.intakeCreateIssue({
        channelId: "C1",
        messageTs: "1723459200.000100",
        title: "The deploy is stuck",
      });

      const accepted = yield* tracker.triageAccept(
        {
          issueId: filed.issue.id,
          statusId: IssueStatusId.make("in-progress"),
          projectId: PROJECT,
          priority: "urgent",
          assignee: { kind: "agent", provider: ProviderDriverKind.make("codex") },
          runEnrichment: false,
        },
        ACTOR,
      );

      assert.isFalse(accepted.issue.triage);
      assert.strictEqual(accepted.issue.statusId, "in-progress");
      assert.strictEqual(accepted.issue.projectId, PROJECT);
      assert.strictEqual(accepted.issue.priority, "urgent");
      assert.deepStrictEqual(accepted.issue.assignee, {
        kind: "agent",
        provider: ProviderDriverKind.make("codex"),
      });
      assert.isNull(accepted.enrichmentRun);
      assert.isNull(accepted.enrichmentRefusal);

      const { events } = yield* tracker.getEvents({ issueId: filed.issue.id });
      assert.deepStrictEqual(
        events.map((event) => [event.kind, event.field]),
        [
          ["created", null],
          ["field_changed", "status"],
          ["field_changed", "priority"],
          ["field_changed", "assignee"],
          ["field_changed", "project"],
          ["field_changed", "triage"],
        ],
      );
      // The write that made it, not a person: intake filed it as `system:slack`.
      assert.deepStrictEqual(events[0]?.actor, { kind: "system", source: "slack" });

      // Accepting something already accepted is a stale client, not a no-op.
      const again = yield* Effect.flip(
        tracker.triageAccept(
          {
            issueId: filed.issue.id,
            statusId: IssueStatusId.make("done"),
            runEnrichment: false,
          },
          ACTOR,
        ),
      );
      assert.strictEqual(again.reason, "conflict");
    }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect("fires enrichment on accept, and reports a refusal without undoing the accept", () =>
    Effect.gen(function* () {
      const tracker = yield* IssueTrackerService;
      yield* seedProject(PROJECT, "/tmp/pathway");
      yield* seedProject(ROOTLESS_PROJECT, null);

      const withRepo = yield* tracker.create({ title: "Has a directory", triage: true }, ACTOR);
      const started = yield* tracker.triageAccept(
        {
          issueId: withRepo.issue.id,
          statusId: IssueStatusId.make("in-progress"),
          projectId: PROJECT,
          runEnrichment: true,
        },
        ACTOR,
      );
      assert.strictEqual(started.enrichmentRun?.issueId, withRepo.issue.id);
      assert.isNull(started.enrichmentRefusal);

      // A project created from a name alone has no directory, and enrichment reads a directory.
      const rootless = yield* tracker.create({ title: "No directory", triage: true }, ACTOR);
      const accepted = yield* tracker.triageAccept(
        {
          issueId: rootless.issue.id,
          statusId: IssueStatusId.make("in-progress"),
          projectId: ROOTLESS_PROJECT,
          runEnrichment: true,
        },
        ACTOR,
      );

      // The refusal is reported beside the accepted issue rather than raised: un-triaging an
      // issue because the investigation could not start would be the wrong answer.
      assert.isFalse(accepted.issue.triage);
      assert.strictEqual(accepted.issue.statusId, "in-progress");
      assert.isNull(accepted.enrichmentRun);
      assert.include(accepted.enrichmentRefusal ?? "", "no directory");
      assert.deepStrictEqual(
        (yield* tracker.getEnrichmentRuns({ issueId: rootless.issue.id })).runs,
        [],
      );
    }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect("rejects a triage item as a soft delete with its own event kind", () =>
    Effect.gen(function* () {
      const tracker = yield* IssueTrackerService;
      const filed = yield* tracker.intakeCreateIssue({
        channelId: "C1",
        messageTs: "1723459200.000100",
        title: "Somebody said hello",
      });

      const rejected = yield* tracker.triageReject({ issueId: filed.issue.id }, ACTOR);
      assert.isNotNull(rejected.issue.deletedAt);
      // The flag stays set, so restoring the row puts it back in the queue rather than the backlog.
      assert.isTrue(rejected.issue.triage);

      const { events } = yield* tracker.getEvents({ issueId: filed.issue.id });
      assert.deepStrictEqual(
        events.map((event) => event.kind),
        ["created", "triage_rejected"],
      );

      // Rejecting twice is not an error, and does not write a second row.
      const again = yield* tracker.triageReject({ issueId: filed.issue.id }, ACTOR);
      assert.strictEqual(again.issue.id, filed.issue.id);
      assert.strictEqual((yield* tracker.getEvents({ issueId: filed.issue.id })).events.length, 2);
    }).pipe(Effect.provide(makeTestLayer())),
  );
});
