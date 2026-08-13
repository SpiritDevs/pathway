import {
  ChatAttachmentId,
  ISSUE_ENRICHMENT_TRANSCRIPT_MAX_CHARS,
  IssueCommentAgentRunId,
  IssueCommentId,
  IssueEnrichmentRunId,
  IssueCycleId,
  IssueEventId,
  IssueId,
  IssueLabelId,
  IssueMilestoneId,
  IssueRelationId,
  IssueStatusId,
  IssueTodoId,
  IssueViewId,
  ProjectId,
  SlackChannelWatchId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type IssueCommentAgentRun,
  type IssueEnrichmentRun,
  type ModelSelection,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { IssueCommentRepositoryLive } from "./IssueComments.ts";
import { IssueAutomationAuditRepositoryLive } from "./IssueAutomationAudits.ts";
import { IssueCycleRepositoryLive } from "./IssueCycles.ts";
import { IssueEnrichmentRunRepositoryLive } from "./IssueEnrichmentRuns.ts";
import { IssueEventRepositoryLive } from "./IssueEvents.ts";
import { IssueLabelRepositoryLive } from "./IssueLabels.ts";
import { IssueMilestoneRepositoryLive } from "./IssueMilestones.ts";
import { IssueRelationRepositoryLive } from "./IssueRelations.ts";
import { IssueRepositoryLive } from "./Issues.ts";
import { IssueStatusRepositoryLive } from "./IssueStatuses.ts";
import { IssueThreadLinkRepositoryLive } from "./IssueThreadLinks.ts";
import { IssueTodoRepositoryLive } from "./IssueTodos.ts";
import { IssueTrackerConfigRepositoryLive } from "./IssueTrackerConfig.ts";
import { IssueViewRepositoryLive } from "./IssueViews.ts";
import { SlackChannelWatchRepositoryLive } from "./SlackChannelWatches.ts";
import { SlackIntakeLedgerRepositoryLive } from "./SlackIntakeLedger.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { IssueCommentRepository } from "../Services/IssueComments.ts";
import { IssueAutomationAuditRepository } from "../Services/IssueAutomationAudits.ts";
import { IssueCycleRepository } from "../Services/IssueCycles.ts";
import { IssueEnrichmentRunRepository } from "../Services/IssueEnrichmentRuns.ts";
import { IssueEventRepository } from "../Services/IssueEvents.ts";
import { IssueLabelRepository } from "../Services/IssueLabels.ts";
import { IssueMilestoneRepository } from "../Services/IssueMilestones.ts";
import { IssueRelationRepository } from "../Services/IssueRelations.ts";
import { IssueRepository, type IssueRecord } from "../Services/Issues.ts";
import { IssueStatusRepository } from "../Services/IssueStatuses.ts";
import { IssueThreadLinkRepository } from "../Services/IssueThreadLinks.ts";
import { IssueTodoRepository } from "../Services/IssueTodos.ts";
import { IssueTrackerConfigRepository } from "../Services/IssueTrackerConfig.ts";
import { IssueViewRepository } from "../Services/IssueViews.ts";
import { SlackChannelWatchRepository } from "../Services/SlackChannelWatches.ts";
import { SlackIntakeLedgerRepository } from "../Services/SlackIntakeLedger.ts";

// One in-memory database behind every repository: these tables reference each other.
const issueTrackerLayer = it.layer(
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
    IssueAutomationAuditRepositoryLive,
    IssueViewRepositoryLive,
    IssueEnrichmentRunRepositoryLive,
    IssueThreadLinkRepositoryLive,
    SlackChannelWatchRepositoryLive,
    SlackIntakeLedgerRepositoryLive,
  ).pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

const ENRICHMENT_MODEL: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5-codex",
};

const makeRun = (overrides: Partial<IssueEnrichmentRun> = {}): IssueEnrichmentRun => ({
  id: IssueEnrichmentRunId.make("run-1"),
  issueId: IssueId.make("issue-1"),
  state: "queued",
  modelSelection: ENRICHMENT_MODEL,
  transcript: "",
  result: null,
  error: null,
  createdAt: "2026-08-12T00:00:00.000Z",
  startedAt: null,
  finishedAt: null,
  ...overrides,
});

const makeIssue = (overrides: Partial<IssueRecord> = {}): IssueRecord => ({
  id: IssueId.make("issue-1"),
  key: "ISS-1",
  title: "Ship the tracker",
  description: "  indented, so not trimmed",
  statusId: IssueStatusId.make("todo"),
  priority: "medium",
  assignee: null,
  workModelSelection: null,
  automationAssignment: null,
  projectId: null,
  milestoneId: null,
  cycleId: null,
  parentId: null,
  sortOrder: "a0",
  dueDate: null,
  triage: false,
  slackSource: null,
  createdAt: "2026-08-12T00:00:00.000Z",
  updatedAt: "2026-08-12T00:00:00.000Z",
  deletedAt: null,
  ...overrides,
});

issueTrackerLayer("Issue tracker repositories", (it) => {
  it.effect("reads the seeded statuses and config", () =>
    Effect.gen(function* () {
      const statuses = yield* IssueStatusRepository;
      const config = yield* IssueTrackerConfigRepository;

      const seeded = yield* statuses.listAll();
      assert.deepStrictEqual(
        seeded.map((status) => status.id),
        ["backlog", "todo", "in-progress", "in-review", "done", "canceled"],
      );

      assert.deepStrictEqual(yield* config.get(), { keyPrefix: "ISS", nextNumber: 1 });
    }),
  );

  it.effect("hands out every key number exactly once", () =>
    Effect.gen(function* () {
      const config = yield* IssueTrackerConfigRepository;
      const first = (yield* config.get()).nextNumber;

      // The sqlite drivers are synchronous, so concurrent fibers here usually run to completion
      // one at a time; this asserts the sequence, not the interleaving the transaction guards.
      const keys = yield* Effect.all(
        Array.from({ length: 25 }, () => config.allocateKey()),
        { concurrency: "unbounded" },
      );

      assert.strictEqual(new Set(keys).size, 25);
      assert.deepStrictEqual(
        keys.map((key) => Number(key.slice("ISS-".length))).sort((a, b) => a - b),
        Array.from({ length: 25 }, (_, index) => first + index),
      );
      assert.strictEqual((yield* config.get()).nextNumber, first + 25);
    }),
  );

  it.effect("renames the prefix without reusing numbers", () =>
    Effect.gen(function* () {
      const config = yield* IssueTrackerConfigRepository;
      const next = (yield* config.get()).nextNumber;

      assert.strictEqual(yield* config.allocateKey(), `ISS-${next}`);
      const renamed = yield* config.setPrefix({ keyPrefix: "PAT" });

      assert.deepStrictEqual(renamed, { keyPrefix: "PAT", nextNumber: next + 1 });
      assert.strictEqual(yield* config.allocateKey(), `PAT-${next + 1}`);
    }),
  );

  it.effect("round-trips an issue through soft delete and restore", () =>
    Effect.gen(function* () {
      const issues = yield* IssueRepository;
      const issueId = IssueId.make("issue-soft-delete");
      const row = makeIssue({
        id: issueId,
        key: "ISS-7",
        triage: true,
        assignee: { kind: "agent", provider: ProviderDriverKind.make("codex") },
        dueDate: "2026-09-01",
      });

      yield* issues.upsert(row);
      assert.deepStrictEqual(Option.getOrNull(yield* issues.getById({ issueId })), row);
      assert.deepStrictEqual(
        (yield* issues.listLive()).map((issue) => issue.id),
        [issueId],
      );

      yield* issues.softDelete({ issueId, deletedAt: "2026-08-13T00:00:00.000Z" });

      assert.deepStrictEqual(yield* issues.listLive(), []);
      const deleted = yield* issues.listDeleted();
      assert.strictEqual(deleted[0]?.deletedAt, "2026-08-13T00:00:00.000Z");
      // The snapshot carries deleted rows so a client can restore one without a second read.
      assert.strictEqual((yield* issues.listAll()).length, 1);

      yield* issues.restore({ issueId, updatedAt: "2026-08-14T00:00:00.000Z" });

      const restored = Option.getOrNull(yield* issues.getById({ issueId }));
      assert.strictEqual(restored?.deletedAt, null);
      assert.strictEqual(restored?.updatedAt, "2026-08-14T00:00:00.000Z");
      assert.strictEqual(restored?.triage, true);
      assert.deepStrictEqual(restored?.assignee, {
        kind: "agent",
        provider: ProviderDriverKind.make("codex"),
      });
    }),
  );

  it.effect("replaces the label set on an issue", () =>
    Effect.gen(function* () {
      const issues = yield* IssueRepository;
      const labels = yield* IssueLabelRepository;
      const issueId = IssueId.make("issue-labels");
      const bug = IssueLabelId.make("label-bug");
      const chore = IssueLabelId.make("label-chore");
      const docs = IssueLabelId.make("label-docs");

      yield* issues.upsert(makeIssue({ id: issueId, key: "ISS-9" }));
      for (const [id, name, color] of [
        [bug, "Bug", "#eb5757"],
        [chore, "Chore", "#95a2b3"],
        [docs, "Docs", "#26b5ce"],
      ] as const) {
        yield* labels.upsert({ id, name, color, createdAt: "2026-08-12T00:00:00.000Z" });
      }

      yield* labels.setAssignments({ issueId, labelIds: [bug, chore] });
      assert.deepStrictEqual(yield* labels.listAssignmentsByIssue({ issueId }), [bug, chore]);

      yield* labels.setAssignments({ issueId, labelIds: [chore, docs] });
      assert.deepStrictEqual(yield* labels.listAssignmentsByIssue({ issueId }), [chore, docs]);
      assert.deepStrictEqual(yield* labels.listAssignments(), [
        { issueId, labelId: chore },
        { issueId, labelId: docs },
      ]);

      yield* labels.deleteById({ labelId: chore });

      assert.isTrue(Option.isNone(yield* labels.getById({ labelId: chore })));
      assert.deepStrictEqual(yield* labels.listAssignmentsByIssue({ issueId }), [docs]);

      yield* labels.setAssignments({ issueId, labelIds: [] });
      assert.deepStrictEqual(yield* labels.listAssignments(), []);
    }),
  );

  it.effect("moves issues off a deleted status", () =>
    Effect.gen(function* () {
      const issues = yield* IssueRepository;
      const statuses = yield* IssueStatusRepository;
      const todo = IssueStatusId.make("todo");
      const done = IssueStatusId.make("done");
      const moved = new Set(["issue-a", "issue-b", "issue-c"]);

      yield* issues.upsertMany([
        makeIssue({ id: IssueId.make("issue-a"), key: "ISS-11", statusId: todo }),
        makeIssue({ id: IssueId.make("issue-b"), key: "ISS-12", statusId: todo }),
        makeIssue({ id: IssueId.make("issue-c"), key: "ISS-13", statusId: done }),
      ]);

      yield* issues.reassignStatus({
        fromStatusId: todo,
        toStatusId: done,
        updatedAt: "2026-08-15T00:00:00.000Z",
      });
      yield* statuses.deleteById({ statusId: todo });

      assert.deepStrictEqual(
        (yield* issues.listLive())
          .filter((issue) => moved.has(issue.id))
          .map((issue) => issue.statusId),
        [done, done, done],
      );
      assert.isTrue(Option.isNone(yield* statuses.getById({ statusId: todo })));
    }),
  );

  it.effect("appends the change log in order with the actor intact", () =>
    Effect.gen(function* () {
      const events = yield* IssueEventRepository;
      const issueId = IssueId.make("issue-events");

      yield* events.appendMany([
        {
          id: IssueEventId.make("event-1"),
          issueId,
          actor: { kind: "system", source: "import" },
          kind: "imported",
          field: null,
          before: null,
          after: null,
          createdAt: "2026-08-12T00:00:00.000Z",
        },
        {
          id: IssueEventId.make("event-2"),
          issueId,
          actor: { kind: "agent", provider: ProviderDriverKind.make("claudeAgent") },
          kind: "field_changed",
          field: "status",
          before: "Todo",
          after: "In Review",
          createdAt: "2026-08-12T00:01:00.000Z",
        },
      ]);
      yield* events.append({
        id: IssueEventId.make("event-3"),
        issueId: IssueId.make("issue-other"),
        actor: { kind: "user" },
        kind: "created",
        field: null,
        before: null,
        after: null,
        createdAt: "2026-08-12T00:02:00.000Z",
      });

      const log = yield* events.listByIssue({ issueId });
      assert.deepStrictEqual(
        log.map((event) => event.id),
        ["event-1", "event-2"],
      );
      assert.deepStrictEqual(log[1]?.actor, {
        kind: "agent",
        provider: ProviderDriverKind.make("claudeAgent"),
      });
      assert.strictEqual(log[1]?.before, "Todo");
    }),
  );

  it.effect("orders milestones by project then position and reorders them in place", () =>
    Effect.gen(function* () {
      const milestones = yield* IssueMilestoneRepository;
      const alpha = ProjectId.make("project-alpha");
      const beta = ProjectId.make("project-beta");
      const makeMilestone = (id: string, projectId: ProjectId, name: string, position: number) => ({
        id: IssueMilestoneId.make(id),
        projectId,
        name,
        description: null,
        startDate: null,
        targetDate: null,
        position,
        createdAt: "2026-08-12T00:00:00.000Z",
        updatedAt: "2026-08-12T00:00:00.000Z",
      });

      yield* milestones.upsert(makeMilestone("m-2", alpha, "Second", 2));
      yield* milestones.upsert(makeMilestone("m-1", alpha, "First", 1));
      yield* milestones.upsert(makeMilestone("m-3", beta, "Elsewhere", 1));

      assert.deepStrictEqual(
        (yield* milestones.listAll()).map((milestone) => milestone.id),
        ["m-1", "m-2", "m-3"],
      );

      yield* milestones.setPositions({
        positions: [
          { milestoneId: IssueMilestoneId.make("m-2"), position: 1 },
          { milestoneId: IssueMilestoneId.make("m-1"), position: 2 },
        ],
        updatedAt: "2026-08-13T00:00:00.000Z",
      });
      assert.deepStrictEqual(
        (yield* milestones.listAll()).map((milestone) => milestone.id),
        ["m-2", "m-1", "m-3"],
      );

      yield* milestones.deleteById({ milestoneId: IssueMilestoneId.make("m-1") });
      assert.isTrue(
        Option.isNone(yield* milestones.getById({ milestoneId: IssueMilestoneId.make("m-1") })),
      );
    }),
  );

  it.effect("stamps a cycle complete exactly once", () =>
    Effect.gen(function* () {
      const cycles = yield* IssueCycleRepository;
      const cycleId = IssueCycleId.make("cycle-1");

      yield* cycles.upsert({
        id: cycleId,
        name: "Cycle 1",
        startDate: "2026-08-01",
        endDate: "2026-08-14",
        completedAt: null,
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
      });

      yield* cycles.complete({ cycleId, completedAt: "2026-08-15T00:00:00.000Z" });
      // A second carry-over must not move the stamp: the predicate, not the caller, is the guard.
      yield* cycles.complete({ cycleId, completedAt: "2026-08-20T00:00:00.000Z" });

      const stored = yield* cycles.getById({ cycleId });
      assert.strictEqual(
        Option.isSome(stored) ? stored.value.completedAt : null,
        "2026-08-15T00:00:00.000Z",
      );
    }),
  );

  it.effect("points issues at a milestone and a cycle without touching the others", () =>
    Effect.gen(function* () {
      const issues = yield* IssueRepository;
      const moved = IssueId.make("issue-planned");
      const untouched = IssueId.make("issue-unplanned");

      yield* issues.upsertMany([
        makeIssue({ id: moved, key: "ISS-21" }),
        makeIssue({ id: untouched, key: "ISS-22" }),
      ]);

      yield* issues.setMilestone({
        issueIds: [moved],
        milestoneId: IssueMilestoneId.make("m-1"),
        updatedAt: "2026-08-13T00:00:00.000Z",
      });
      yield* issues.setCycle({
        issueIds: [moved],
        cycleId: IssueCycleId.make("cycle-1"),
        updatedAt: "2026-08-13T00:00:00.000Z",
      });

      const planned = yield* issues.getById({ issueId: moved });
      assert.deepStrictEqual(
        Option.isSome(planned)
          ? [planned.value.milestoneId as string | null, planned.value.cycleId as string | null]
          : null,
        ["m-1", "cycle-1"],
      );
      const other = yield* issues.getById({ issueId: untouched });
      assert.deepStrictEqual(
        Option.isSome(other) ? [other.value.milestoneId, other.value.cycleId] : null,
        [null, null],
      );

      yield* issues.setCycle({
        issueIds: [moved],
        cycleId: null,
        updatedAt: "2026-08-14T00:00:00.000Z",
      });
      const cleared = yield* issues.getById({ issueId: moved });
      assert.strictEqual(Option.isSome(cleared) ? cleared.value.cycleId : "unset", null);
    }),
  );

  it.effect("keeps a checklist in position order", () =>
    Effect.gen(function* () {
      const todos = yield* IssueTodoRepository;
      const issueId = IssueId.make("issue-checklist");
      const makeTodo = (id: string, text: string, position: number) => ({
        id: IssueTodoId.make(id),
        issueId,
        text,
        done: false,
        position,
      });

      yield* todos.upsert(makeTodo("todo-2", "Second", 2));
      yield* todos.upsert(makeTodo("todo-1", "First", 1));
      yield* todos.upsert({
        ...makeTodo("todo-3", "Elsewhere", 1),
        issueId: IssueId.make("other"),
      });

      assert.deepStrictEqual(
        (yield* todos.listByIssue({ issueId })).map((todo) => todo.id),
        ["todo-1", "todo-2"],
      );

      yield* todos.upsert({ ...makeTodo("todo-1", "First", 1), done: true });
      const ticked = yield* todos.getById({ todoId: IssueTodoId.make("todo-1") });
      // Stored as a bit, read back as a boolean.
      assert.strictEqual(Option.isSome(ticked) ? ticked.value.done : null, true);

      yield* todos.deleteById({ todoId: IssueTodoId.make("todo-2") });
      assert.strictEqual((yield* todos.listByIssue({ issueId })).length, 1);
    }),
  );

  it.effect("reads a relation from both of its ends", () =>
    Effect.gen(function* () {
      const relations = yield* IssueRelationRepository;
      const blocker = IssueId.make("issue-blocker");
      const blocked = IssueId.make("issue-blocked");

      yield* relations.insert({
        id: IssueRelationId.make("relation-1"),
        issueId: blocker,
        relatedIssueId: blocked,
        kind: "blocks",
      });

      const outgoing = yield* relations.listByIssue({ issueId: blocker });
      assert.deepStrictEqual(
        outgoing.map((edge) => [edge.direction, edge.relation.relatedIssueId]),
        [["outgoing", blocked]],
      );
      // The inverse is the same row read from the other side, not a second row.
      const incoming = yield* relations.listByIssue({ issueId: blocked });
      assert.deepStrictEqual(
        incoming.map((edge) => [edge.direction, edge.relation.issueId]),
        [["incoming", blocker]],
      );

      yield* relations.deleteById({ relationId: IssueRelationId.make("relation-1") });
      assert.deepStrictEqual(yield* relations.listByIssue({ issueId: blocked }), []);
    }),
  );

  it.effect("round-trips a comment with its author and attachments", () =>
    Effect.gen(function* () {
      const comments = yield* IssueCommentRepository;
      const issueId = IssueId.make("issue-discussed");
      const commentId = IssueCommentId.make("comment-1");

      yield* comments.upsert({
        id: commentId,
        issueId,
        author: { kind: "agent", provider: ProviderDriverKind.make("claudeAgent") },
        body: "  leading spaces are a code block, so nothing is trimmed",
        attachmentIds: [ChatAttachmentId.make("iss_issue-discussed-0000")],
        createdAt: "2026-08-12T00:00:00.000Z",
        editedAt: null,
      });

      const [stored] = yield* comments.listByIssue({ issueId });
      assert.deepStrictEqual(stored?.author, {
        kind: "agent",
        provider: ProviderDriverKind.make("claudeAgent"),
      });
      assert.deepStrictEqual(stored?.attachmentIds, ["iss_issue-discussed-0000"]);
      assert.strictEqual(stored?.body, "  leading spaces are a code block, so nothing is trimmed");

      yield* comments.upsert({ ...stored!, body: "edited", editedAt: "2026-08-13T00:00:00.000Z" });
      const edited = yield* comments.getById({ commentId });
      assert.strictEqual(
        Option.isSome(edited) ? edited.value.editedAt : null,
        "2026-08-13T00:00:00.000Z",
      );

      yield* comments.deleteById({ commentId });
      assert.deepStrictEqual(yield* comments.listByIssue({ issueId }), []);
    }),
  );

  it.effect("round-trips a comment's agent run and lists only the comments that carry one", () =>
    Effect.gen(function* () {
      const comments = yield* IssueCommentRepository;
      const issueId = IssueId.make("issue-mentioned");
      const askId = IssueCommentId.make("comment-ask");
      const replyId = IssueCommentId.make("comment-reply");
      const agentRun = {
        id: IssueCommentAgentRunId.make("comment-run-1"),
        state: "running",
        mention: {
          kind: "agent",
          provider: ProviderDriverKind.make("claudeAgent"),
          modelSelection: {
            instanceId: ProviderInstanceId.make("claude"),
            model: "claude-sonnet-4-5",
          },
        },
        phase: "researching",
        transcript: "reading files\n",
        error: null,
        replyCommentId: null,
        createdAt: "2026-08-12T00:00:00.000Z",
        startedAt: "2026-08-12T00:00:01.000Z",
        finishedAt: null,
      } as const satisfies IssueCommentAgentRun;

      yield* comments.upsert({
        id: askId,
        issueId,
        author: { kind: "user" },
        body: "[@Claude](mention:agent:claudeAgent) what broke?",
        attachmentIds: [],
        agentRun,
        createdAt: "2026-08-12T00:00:00.000Z",
        editedAt: null,
      });
      // The ordinary comment beside it: the column is null, and the field reads back as null.
      yield* comments.upsert({
        id: replyId,
        issueId,
        author: { kind: "agent", provider: ProviderDriverKind.make("claudeAgent") },
        body: "It is the decoder.",
        attachmentIds: [],
        createdAt: "2026-08-12T00:00:02.000Z",
        editedAt: null,
      });

      const stored = yield* comments.listByIssue({ issueId });
      assert.deepStrictEqual(stored[0]?.agentRun, agentRun);
      assert.isNull(stored[1]?.agentRun ?? null);

      // What the startup sweep reads: every live run on the whole tracker, whatever its issue.
      const carrying = yield* comments.listWithAgentRuns();
      assert.deepStrictEqual(
        carrying.map((comment) => comment.id),
        [askId],
      );

      // A terminal run is still a run on the comment, and the column is rewritten in place.
      yield* comments.upsert({
        ...stored[0]!,
        agentRun: { ...agentRun, state: "completed", phase: null, replyCommentId: replyId },
      });
      const finished = yield* comments.getById({ commentId: askId });
      assert.strictEqual(
        Option.isSome(finished) ? (finished.value.agentRun?.replyCommentId ?? null) : null,
        replyId,
      );
      assert.strictEqual((yield* comments.listWithAgentRuns()).length, 1);
    }),
  );

  it.effect("round-trips a view's chip bar through its JSON column", () =>
    Effect.gen(function* () {
      const views = yield* IssueViewRepository;
      const viewId = IssueViewId.make("view-1");

      yield* views.upsert({
        id: viewId,
        name: "Urgent, mine",
        position: 2,
        config: {
          tab: "active",
          statusIds: [IssueStatusId.make("todo")],
          priorities: ["urgent"],
          dueFilter: "week",
          grouping: "project",
          sortMode: "priority",
          viewMode: "board",
        },
        createdAt: "2026-08-12T00:00:00.000Z",
        updatedAt: "2026-08-12T00:00:00.000Z",
      });
      yield* views.upsert({
        id: IssueViewId.make("view-2"),
        name: "Everything",
        position: 1,
        config: { tab: "all", grouping: "none", sortMode: "manual", viewMode: "list" },
        createdAt: "2026-08-12T00:00:00.000Z",
        updatedAt: "2026-08-12T00:00:00.000Z",
      });

      const ordered = yield* views.listAll();
      assert.deepStrictEqual(
        ordered.map((view) => view.name),
        ["Everything", "Urgent, mine"],
      );
      // An unadded chip comes back absent, not empty: the two mean different things.
      assert.isUndefined(ordered[0]?.config.priorities);
      assert.deepStrictEqual(ordered[1]?.config.priorities, ["urgent"]);
      assert.strictEqual(ordered[1]?.config.dueFilter, "week");
      assert.strictEqual(ordered[1]?.config.viewMode, "board");

      yield* views.setPositions({
        positions: [
          { viewId, position: 1 },
          { viewId: IssueViewId.make("view-2"), position: 2 },
        ],
        updatedAt: "2026-08-13T00:00:00.000Z",
      });
      const reordered = yield* views.listAll();
      assert.deepStrictEqual(
        reordered.map((view) => view.name),
        ["Urgent, mine", "Everything"],
      );
      assert.strictEqual(reordered[0]?.updatedAt, "2026-08-13T00:00:00.000Z");

      yield* views.deleteById({ viewId });
      assert.isTrue(Option.isNone(yield* views.getById({ viewId })));
    }),
  );

  it.effect("walks a run from queued to done, appending the transcript as it goes", () =>
    Effect.gen(function* () {
      const runs = yield* IssueEnrichmentRunRepository;
      const runId = IssueEnrichmentRunId.make("run-lifecycle");

      yield* runs.create(makeRun({ id: runId, issueId: IssueId.make("issue-lifecycle") }));
      assert.include(
        (yield* runs.listUnfinished()).map((run) => run.id),
        runId,
      );

      yield* runs.start({ runId, startedAt: "2026-08-12T00:00:01.000Z" });
      yield* runs.appendTranscript({ runId, chunk: "reading " });
      yield* runs.appendTranscript({ runId, chunk: "files\n" });

      const running = yield* runs.getById({ runId });
      assert.isTrue(Option.isSome(running));
      if (Option.isSome(running)) {
        assert.strictEqual(running.value.state, "running");
        assert.strictEqual(running.value.startedAt, "2026-08-12T00:00:01.000Z");
        assert.strictEqual(running.value.transcript, "reading files\n");
        // Pinned at creation, so a later settings change cannot relabel this run.
        assert.strictEqual(running.value.modelSelection.model, "gpt-5-codex");
      }

      yield* runs.finish({
        runId,
        state: "done",
        result: {
          summary: "Start here.",
          likelyFiles: [{ path: "apps/server/src/issues/IssueTrackerService.ts", reason: "Owner" }],
          relatedIssueKeys: ["ISS-2"],
          suggestedLabels: ["Bug"],
          suggestedPriority: "high",
        },
        error: null,
        finishedAt: "2026-08-12T00:02:00.000Z",
      });

      const done = yield* runs.getById({ runId });
      assert.isTrue(Option.isSome(done));
      if (Option.isSome(done)) {
        assert.strictEqual(done.value.state, "done");
        assert.strictEqual(done.value.result?.suggestedPriority, "high");
        assert.strictEqual(done.value.finishedAt, "2026-08-12T00:02:00.000Z");
      }
      // A finished run is no longer in flight, which is what the startup sweep reads.
      assert.notInclude(
        (yield* runs.listUnfinished()).map((run) => run.id),
        runId,
      );
    }),
  );

  it.effect("lists one issue's runs newest first and leaves other issues alone", () =>
    Effect.gen(function* () {
      const runs = yield* IssueEnrichmentRunRepository;
      const issueId = IssueId.make("issue-ordered");

      yield* runs.create(
        makeRun({
          id: IssueEnrichmentRunId.make("run-old"),
          issueId,
          createdAt: "2026-08-11T00:00:00.000Z",
        }),
      );
      yield* runs.create(
        makeRun({
          id: IssueEnrichmentRunId.make("run-new"),
          issueId,
          createdAt: "2026-08-12T00:00:00.000Z",
        }),
      );
      yield* runs.create(
        makeRun({
          id: IssueEnrichmentRunId.make("run-other"),
          issueId: IssueId.make("issue-else"),
        }),
      );

      assert.deepStrictEqual(
        (yield* runs.listByIssue({ issueId })).map((run) => run.id),
        ["run-new", "run-old"],
      );
    }),
  );

  it.effect("claims each configured auditor once and records its independent verdict", () =>
    Effect.gen(function* () {
      const audits = yield* IssueAutomationAuditRepository;
      const issueId = IssueId.make("issue-audited");
      const running = {
        id: "audit-1",
        issueId,
        triggerKey: "review-transition-1",
        ruleId: "implementation",
        auditorIndex: 0,
        modelSelection: ENRICHMENT_MODEL,
        state: "running" as const,
        verdict: null,
        summary: null,
        findings: [],
        error: null,
        remediationCycle: 0,
        createdAt: "2026-08-12T00:00:00.000Z",
        finishedAt: null,
      };

      assert.isTrue(yield* audits.claim(running));
      assert.isFalse(yield* audits.claim({ ...running, id: "audit-duplicate" }));
      yield* audits.releaseInterruptedClaims();
      const recovered = { ...running, id: "audit-recovered" };
      assert.isTrue(yield* audits.claim(recovered));

      yield* audits.finish({
        ...recovered,
        state: "done",
        verdict: "changes_requested",
        summary: "A regression remains.",
        findings: ["The empty state no longer renders."],
        finishedAt: "2026-08-12T00:01:00.000Z",
      });

      const stored = yield* audits.listByTrigger({
        issueId,
        triggerKey: "review-transition-1",
      });
      assert.strictEqual(stored.length, 1);
      assert.strictEqual(stored[0]?.modelSelection.model, "gpt-5-codex");
      assert.deepStrictEqual(stored[0]?.findings, ["The empty state no longer renders."]);
      assert.strictEqual(yield* audits.countChangesRequested(issueId), 1);
    }),
  );

  // The bound exists so one runaway process cannot fill the database, and the head is what goes:
  // a run's conclusion is the part anybody rereads.
  it.effect("drops the head of an over-long transcript rather than its tail", () =>
    Effect.gen(function* () {
      const runs = yield* IssueEnrichmentRunRepository;
      const runId = IssueEnrichmentRunId.make("run-bounded");
      yield* runs.create(makeRun({ id: runId, issueId: IssueId.make("issue-bounded") }));

      yield* runs.appendTranscript({
        runId,
        chunk: "a".repeat(ISSUE_ENRICHMENT_TRANSCRIPT_MAX_CHARS),
      });
      yield* runs.appendTranscript({ runId, chunk: "END" });

      const stored = yield* runs.getById({ runId });
      assert.isTrue(Option.isSome(stored));
      if (Option.isSome(stored)) {
        assert.strictEqual(stored.value.transcript.length, ISSUE_ENRICHMENT_TRANSCRIPT_MAX_CHARS);
        assert.isTrue(stored.value.transcript.endsWith("END"));
      }
    }),
  );

  it.effect("keys a thread link by the pair and reads it from both ends", () =>
    Effect.gen(function* () {
      const links = yield* IssueThreadLinkRepository;
      const issueId = IssueId.make("issue-linked");
      const threadId = ThreadId.make("thread-1");

      yield* links.link({
        issueId,
        threadId,
        origin: "start-work",
        createdAt: "2026-08-12T00:00:00.000Z",
      });
      // The same pair again restates the origin; `createdAt` is when the thread started on the
      // issue, so the first one stands.
      yield* links.link({
        issueId,
        threadId,
        origin: "manual",
        createdAt: "2026-08-13T00:00:00.000Z",
      });
      yield* links.link({
        issueId: IssueId.make("issue-other"),
        threadId,
        origin: "manual",
        createdAt: "2026-08-14T00:00:00.000Z",
      });

      const byIssue = yield* links.listByIssue({ issueId });
      assert.deepStrictEqual(
        byIssue.map((link) => [link.threadId, link.origin, link.createdAt]),
        [[threadId, "manual", "2026-08-12T00:00:00.000Z"]],
      );
      assert.deepStrictEqual(
        (yield* links.listByThread({ threadId })).map((link) => link.issueId),
        ["issue-linked", "issue-other"],
      );

      yield* links.unlink({ issueId, threadId });
      assert.deepStrictEqual(yield* links.listByIssue({ issueId }), []);
      // Unlinking one end leaves the other alone.
      assert.deepStrictEqual(
        (yield* links.listByThread({ threadId })).map((link) => link.issueId),
        ["issue-other"],
      );
    }),
  );

  // Precedence between origins is the tracker's business, not this table's: the row takes whatever
  // it is handed, including the weakest origin, so a mention persists like any other link.
  it.effect("stores a mention origin and lets a later write replace it", () =>
    Effect.gen(function* () {
      const links = yield* IssueThreadLinkRepository;
      const issueId = IssueId.make("issue-mentioned");
      const threadId = ThreadId.make("thread-9");

      yield* links.link({
        issueId,
        threadId,
        origin: "mention",
        createdAt: "2026-08-12T00:00:00.000Z",
      });
      assert.deepStrictEqual(
        (yield* links.listByIssue({ issueId })).map((link) => [link.origin, link.createdAt]),
        [["mention", "2026-08-12T00:00:00.000Z"]],
      );

      yield* links.link({
        issueId,
        threadId,
        origin: "start-work",
        createdAt: "2026-08-13T00:00:00.000Z",
      });
      assert.deepStrictEqual(
        (yield* links.listByIssue({ issueId })).map((link) => [link.origin, link.createdAt]),
        [["start-work", "2026-08-12T00:00:00.000Z"]],
      );
    }),
  );

  it.effect("stores a watch's trigger as switches and reads it back as one struct", () =>
    Effect.gen(function* () {
      const watches = yield* SlackChannelWatchRepository;

      yield* watches.upsert({
        id: SlackChannelWatchId.make("watch-1"),
        channelId: "C1",
        channelName: "triage",
        projectId: ProjectId.make("project-1"),
        cycleId: IssueCycleId.make("cycle-1"),
        autoInvestigate: true,
        autoAssign: true,
        trigger: {
          reactionRoutes: [
            {
              emoji: "ticket",
              projectId: ProjectId.make("project-2"),
              autoInvestigate: false,
            },
          ],
          everyMessage: false,
          botMention: true,
        },
        createdAt: "2026-08-12T00:00:00.000Z",
        updatedAt: "2026-08-12T00:00:00.000Z",
      });

      const byChannel = yield* watches.getByChannel({ channelId: "C1" });
      assert.deepStrictEqual(Option.isSome(byChannel) ? byChannel.value.trigger : null, {
        reactionRoutes: [
          { emoji: "ticket", projectId: ProjectId.make("project-2"), autoInvestigate: false },
        ],
        everyMessage: false,
        botMention: true,
      });
      assert.isTrue(Option.isSome(byChannel) && byChannel.value.autoInvestigate);
      assert.isTrue(Option.isSome(byChannel) && byChannel.value.autoAssign);
      assert.strictEqual(
        Option.isSome(byChannel) ? byChannel.value.cycleId : null,
        IssueCycleId.make("cycle-1"),
      );

      // All three off is a paused watch, and a paused watch has to round-trip like any other.
      yield* watches.upsert({
        id: SlackChannelWatchId.make("watch-1"),
        channelId: "C1",
        channelName: "triage",
        projectId: null,
        cycleId: null,
        autoInvestigate: false,
        autoAssign: false,
        trigger: { reactionRoutes: [], everyMessage: false, botMention: false },
        createdAt: "2026-08-12T00:00:00.000Z",
        updatedAt: "2026-08-12T00:01:00.000Z",
      });
      const paused = yield* watches.listAll();
      assert.deepStrictEqual(
        paused.map((watch) => watch.trigger),
        [{ reactionRoutes: [], everyMessage: false, botMention: false }],
      );
      assert.isNull(paused[0]?.projectId ?? null);

      yield* watches.deleteById({ watchId: SlackChannelWatchId.make("watch-1") });
      assert.deepStrictEqual(yield* watches.listAll(), []);
    }),
  );

  it.effect("keeps the cursor, the echo registry, and the dedupe ledger apart", () =>
    Effect.gen(function* () {
      const ledger = yield* SlackIntakeLedgerRepository;

      assert.isTrue(Option.isNone(yield* ledger.getCursor({ channelId: "C1" })));
      yield* ledger.setCursor({
        channelId: "C1",
        lastTs: "1723459300.000100",
        // A reaction arrives after the message it decorates, so this trails the history mark.
        reactionScanTs: "1723458000.000100",
        updatedAt: "2026-08-12T00:00:00.000Z",
      });
      const cursor = yield* ledger.getCursor({ channelId: "C1" });
      assert.deepStrictEqual(
        Option.isSome(cursor) ? [cursor.value.lastTs, cursor.value.reactionScanTs] : null,
        ["1723459300.000100", "1723458000.000100"],
      );

      // The whole echo-suppression story: the poller asks this of every message it reads.
      assert.isFalse(
        yield* ledger.hasOutbound({ channelId: "C1", messageTs: "1723459400.000100" }),
      );
      yield* ledger.recordOutbound({
        channelId: "C1",
        messageTs: "1723459400.000100",
        createdAt: "2026-08-12T00:00:00.000Z",
      });
      assert.isTrue(yield* ledger.hasOutbound({ channelId: "C1", messageTs: "1723459400.000100" }));
      // The same ts in another channel is another message.
      assert.isFalse(
        yield* ledger.hasOutbound({ channelId: "C2", messageTs: "1723459400.000100" }),
      );

      // A message can be seen and deliberately not filed, and filed later when somebody adds the
      // trigger reaction to it.
      yield* ledger.recordProcessed({
        channelId: "C1",
        messageTs: "1723459200.000100",
        issueId: null,
        createdAt: "2026-08-12T00:00:00.000Z",
      });
      yield* ledger.recordProcessed({
        channelId: "C1",
        messageTs: "1723459200.000100",
        issueId: IssueId.make("issue-1"),
        createdAt: "2026-08-12T00:05:00.000Z",
      });
      const processed = yield* ledger.getProcessed({
        channelId: "C1",
        messageTs: "1723459200.000100",
      });
      assert.strictEqual(Option.isSome(processed) ? processed.value.issueId : null, "issue-1");
    }),
  );
});
