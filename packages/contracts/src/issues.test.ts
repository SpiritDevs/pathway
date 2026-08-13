import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  Issue,
  IssueAssignee,
  IssueComment,
  IssueCommentCreateInput,
  IssueCycle,
  IssueDate,
  IssueDetail,
  IssueEvent,
  IssueMilestone,
  IssueMilestoneHistoryResult,
  IssueMilestonePatch,
  IssuePatch,
  IssueRelation,
  IssueRelationCreateInput,
  IssueBulkUpdateInput,
  IssueStatus,
  IssueTodo,
  IssueTodosReorderInput,
  IssueTrackerConfig,
  IssueView,
  IssueViewCreateInput,
  IssueViewsReorderInput,
  IssueCommentAttachmentUploadInput,
  IssueEnrichmentRun,
  IssueEnrichmentResult,
  IssueThreadLink,
  IssuesImportCsvInput,
  IssueSlackSource,
  IssueTriageAcceptInput,
  IssuesSnapshot,
  IssuesStreamEvent,
  SlackChannelWatch,
  SlackIntakeStatus,
  SlackIntakeTrigger,
  SlackSetTokenInput,
  issueCycleStatusOn,
  issueMilestoneStatusOn,
  isPlaceholderIssueTitle,
  isSlackIntakeTriggerActive,
  ISSUES_IMPORT_CSV_MAX_CHARS,
  ISSUE_BULK_UPDATE_MAX_ISSUES,
  ISSUE_COMMENT_MAX_ATTACHMENTS,
  ISSUE_COMMENT_MAX_CHARS,
  ISSUE_MAX_PARENT_DEPTH,
  ISSUE_COMMENT_ATTACHMENT_MAX_BYTES,
  ISSUE_COMMENT_ATTACHMENT_MAX_DATA_URL_CHARS,
  ISSUE_ENRICHMENT_MAX_LIKELY_FILES,
  ISSUE_ENRICHMENT_TRANSCRIPT_MAX_CHARS,
  ISSUE_VIEW_FILTER_MAX_VALUES,
  SLACK_BOT_TOKEN_MAX_CHARS,
  SLACK_MAX_REACTION_ROUTES,
} from "./issues.ts";

const decodeIssue = Schema.decodeUnknownSync(Issue);
const decodeStatus = Schema.decodeUnknownSync(IssueStatus);
const decodeEvent = Schema.decodeUnknownSync(IssueEvent);
const decodeAssignee = Schema.decodeUnknownSync(IssueAssignee);
const decodePatch = Schema.decodeUnknownSync(IssuePatch);
const decodeStreamEvent = Schema.decodeUnknownSync(IssuesStreamEvent);
const decodeBulkUpdate = Schema.decodeUnknownSync(IssueBulkUpdateInput);
const decodeImportCsv = Schema.decodeUnknownSync(IssuesImportCsvInput);
const decodeConfig = Schema.decodeUnknownSync(IssueTrackerConfig);
const decodeMilestone = Schema.decodeUnknownSync(IssueMilestone);
const decodeMilestonePatch = Schema.decodeUnknownSync(IssueMilestonePatch);
const decodeCycle = Schema.decodeUnknownSync(IssueCycle);
const decodeTodo = Schema.decodeUnknownSync(IssueTodo);
const decodeRelation = Schema.decodeUnknownSync(IssueRelation);
const decodeRelationCreate = Schema.decodeUnknownSync(IssueRelationCreateInput);
const decodeComment = Schema.decodeUnknownSync(IssueComment);
const decodeCommentCreate = Schema.decodeUnknownSync(IssueCommentCreateInput);
const decodeSnapshot = Schema.decodeUnknownSync(IssuesSnapshot);
const decodeDetail = Schema.decodeUnknownSync(IssueDetail);
const decodeDate = Schema.decodeUnknownSync(IssueDate);
const decodeView = Schema.decodeUnknownSync(IssueView);
const decodeViewCreate = Schema.decodeUnknownSync(IssueViewCreateInput);
const decodeViewsReorder = Schema.decodeUnknownSync(IssueViewsReorderInput);
const decodeAttachmentUpload = Schema.decodeUnknownSync(IssueCommentAttachmentUploadInput);
const decodeEnrichmentRun = Schema.decodeUnknownSync(IssueEnrichmentRun);
const decodeEnrichmentResult = Schema.decodeUnknownSync(IssueEnrichmentResult);
const decodeThreadLink = Schema.decodeUnknownSync(IssueThreadLink);

const ENRICHMENT_RESULT_JSON = {
  summary: "The tracker cannot start a run without a directory.",
  likelyFiles: [{ path: "apps/server/src/issues/IssueTrackerService.ts", reason: "Owns the run." }],
  relatedIssueKeys: ["PAT-12"],
  suggestedLabels: ["Bug"],
  suggestedPriority: "high",
};

const ENRICHMENT_RUN_JSON = {
  id: "run-1",
  issueId: "issue-1",
  state: "done",
  modelSelection: { instanceId: "codex", model: "gpt-5-codex" },
  transcript: "reading files\n",
  result: ENRICHMENT_RESULT_JSON,
  error: null,
  createdAt: "2026-08-12T00:00:00Z",
  startedAt: "2026-08-12T00:00:01Z",
  finishedAt: "2026-08-12T00:02:00Z",
};

const THREAD_LINK_JSON = {
  issueId: "issue-1",
  threadId: "thread-1",
  createdAt: "2026-08-12T00:00:00Z",
  origin: "start-work",
};

const ISSUE_JSON = {
  id: "issue-1",
  key: "PAT-221",
  title: "Issue tracker foundation",
  description: "  leading spaces open a code block\n",
  statusId: "status-todo",
  priority: "high",
  assignee: { kind: "agent", provider: "codex" },
  projectId: "project-1",
  milestoneId: "milestone-1",
  cycleId: "cycle-1",
  parentId: null,
  sortOrder: "a0",
  labelIds: ["label-backend"],
  dueDate: "2026-08-20",
  triage: false,
  slackSource: null,
  createdAt: "2026-08-12T00:00:00Z",
  updatedAt: "2026-08-12T00:00:00Z",
  deletedAt: null,
};

const STATUS_JSON = {
  id: "status-todo",
  name: "Todo",
  color: "#6b7280",
  category: "unstarted",
  position: 1,
  createdAt: "2026-08-12T00:00:00Z",
  updatedAt: "2026-08-12T00:00:00Z",
};

const LABEL_JSON = {
  id: "label-backend",
  name: "backend",
  color: "#0ea5e9",
  createdAt: "2026-08-12T00:00:00Z",
};

const CONFIG_JSON = { keyPrefix: "PAT", nextNumber: 222 };

const SLACK_SOURCE_JSON = {
  issueId: "issue-1",
  channelId: "C0123ABCD",
  messageTs: "1723459200.001900",
  permalink: "https://pathway.slack.com/archives/C0123ABCD/p1723459200001900",
  authorName: "Corey",
};

const SLACK_WATCH_JSON = {
  id: "watch-1",
  channelId: "C0123ABCD",
  channelName: "triage",
  projectId: "project-1",
  cycleId: "cycle-1",
  autoInvestigate: true,
  autoAssign: true,
  trigger: {
    reactionRoutes: [{ emoji: "ticket", projectId: null, autoInvestigate: null }],
    everyMessage: false,
    botMention: true,
  },
  createdAt: "2026-08-12T00:00:00Z",
  updatedAt: "2026-08-12T00:00:00Z",
};

const SLACK_STATUS_JSON = {
  configured: true,
  lastPollAt: "2026-08-12T00:00:30Z",
  lastError: null,
  workspaceName: "Pathway HQ",
};

const MILESTONE_JSON = {
  id: "milestone-1",
  projectId: "project-1",
  name: "Structure",
  description: "Milestones, cycles, todos, relations.",
  startDate: "2026-08-15",
  targetDate: "2026-09-01",
  position: 1,
  createdAt: "2026-08-12T00:00:00Z",
  updatedAt: "2026-08-12T00:00:00Z",
};

const CYCLE_JSON = {
  id: "cycle-1",
  name: "Cycle 4",
  startDate: "2026-08-10",
  endDate: "2026-08-24",
  completedAt: null,
  createdAt: "2026-08-12T00:00:00Z",
  updatedAt: "2026-08-12T00:00:00Z",
};

const VIEW_JSON = {
  id: "view-1",
  name: "Urgent, mine",
  position: 1,
  config: {
    tab: "active",
    statusIds: ["status-todo"],
    labelIds: ["label-1"],
    assignees: [{ kind: "agent", provider: "codex" }],
    priorities: ["urgent", "high"],
    dueFilter: "week",
    grouping: "project",
    sortMode: "priority",
    viewMode: "board",
  },
  createdAt: "2026-08-12T00:00:00Z",
  updatedAt: "2026-08-12T00:00:00Z",
};

const TODO_JSON = {
  id: "todo-1",
  issueId: "issue-1",
  text: "Write the migration",
  done: false,
  position: 1,
};

const RELATION_JSON = {
  id: "relation-1",
  issueId: "issue-1",
  relatedIssueId: "issue-2",
  kind: "blocks",
};

const COMMENT_JSON = {
  id: "comment-1",
  issueId: "issue-1",
  author: { kind: "user" },
  body: "  two trailing spaces break a line  \n",
  attachmentIds: ["attachment-1"],
  createdAt: "2026-08-12T00:00:00Z",
  editedAt: null,
};

describe("Issue", () => {
  /**
   * The RPC builds this codec at call time, so a shape it cannot lower fails as an interrupted
   * request rather than as a schema error. Building it here turns that into a test failure.
   */
  it("round-trips through the JSON codec the RPC serializes with", () => {
    const codec = Schema.toCodecJson(Issue);
    const issue = decodeIssue(ISSUE_JSON);

    expect(Schema.decodeUnknownSync(codec)(Schema.encodeUnknownSync(codec)(issue))).toStrictEqual(
      issue,
    );
  });

  it("keeps the description untrimmed, because whitespace is markdown", () => {
    expect(decodeIssue(ISSUE_JSON).description).toBe("  leading spaces open a code block\n");
  });

  it("takes a due date as a calendar day, not an instant", () => {
    expect(() => decodeIssue({ ...ISSUE_JSON, dueDate: "2026-08-20T12:00:00Z" })).toThrow();
    expect(decodeIssue({ ...ISSUE_JSON, dueDate: null }).dueDate).toBeNull();
  });

  it("refuses a key that is not the environment prefix and a number", () => {
    expect(() => decodeIssue({ ...ISSUE_JSON, key: "pat-221" })).toThrow();
    expect(() => decodeIssue({ ...ISSUE_JSON, key: "PAT" })).toThrow();
  });
});

describe("IssueAssignee", () => {
  it("tells a person from an agent, and carries the agent's driver", () => {
    expect(decodeAssignee({ kind: "user" }).kind).toBe("user");

    const agent = decodeAssignee({ kind: "agent", provider: "claudeAgent" });
    expect(agent).toStrictEqual({ kind: "agent", provider: "claudeAgent" });
  });

  it("refuses an agent with no driver, which nothing could be started as", () => {
    expect(() => decodeAssignee({ kind: "agent" })).toThrow();
  });
});

describe("IssueStatus", () => {
  it("takes a hex colour and nothing else, because it is drawn from directly", () => {
    expect(decodeStatus({ ...STATUS_JSON, color: "#abc" }).color).toBe("#abc");
    expect(() => decodeStatus({ ...STATUS_JSON, color: "slate" })).toThrow();
    expect(() => decodeStatus({ ...STATUS_JSON, color: "6b7280" })).toThrow();
  });

  it("refuses a category outside the five the rollups are computed from", () => {
    expect(() => decodeStatus({ ...STATUS_JSON, category: "triage" })).toThrow();
  });
});

describe("IssuePatch", () => {
  // The whole point of `optional(NullOr(...))`: "unassign" and "leave the assignee alone" are
  // different requests, and a patch that could not say which would silently clear fields.
  it("tells clearing a field from leaving it alone", () => {
    expect(decodePatch({ assignee: null }).assignee).toBeNull();
    expect(decodePatch({ title: "Renamed" }).assignee).toBeUndefined();
  });

  it("clears every nullable reference the same way", () => {
    const cleared = decodePatch({
      projectId: null,
      milestoneId: null,
      cycleId: null,
      parentId: null,
      dueDate: null,
    });

    expect(cleared).toStrictEqual({
      projectId: null,
      milestoneId: null,
      cycleId: null,
      parentId: null,
      dueDate: null,
    });
  });

  it("moves an issue onto a milestone and a cycle without touching the other", () => {
    expect(decodePatch({ milestoneId: "milestone-1" })).toStrictEqual({
      milestoneId: "milestone-1",
    });
    expect(decodePatch({ cycleId: "cycle-2" }).milestoneId).toBeUndefined();
  });

  it("refuses a null on a field that has no empty value", () => {
    expect(() => decodePatch({ statusId: null })).toThrow();
    expect(() => decodePatch({ priority: null })).toThrow();
  });
});

describe("IssueBulkUpdateInput", () => {
  const ids = (count: number) => Array.from({ length: count }, (_, index) => `issue-${index}`);

  it("refuses a write that names nobody", () => {
    expect(() => decodeBulkUpdate({ issueIds: [], patch: { priority: "low" } })).toThrow();
  });

  it("bounds the selection, because each id becomes a row write and a change log entry", () => {
    const patch = { priority: "low" };
    expect(
      decodeBulkUpdate({ issueIds: ids(ISSUE_BULK_UPDATE_MAX_ISSUES), patch }).issueIds,
    ).toHaveLength(ISSUE_BULK_UPDATE_MAX_ISSUES);
    expect(() =>
      decodeBulkUpdate({ issueIds: ids(ISSUE_BULK_UPDATE_MAX_ISSUES + 1), patch }),
    ).toThrow();
  });
});

describe("IssueEvent", () => {
  it("records who wrote, including the tracker itself on an import", () => {
    const imported = decodeEvent({
      id: "event-1",
      issueId: "issue-1",
      actor: { kind: "system", source: "import" },
      kind: "imported",
      field: null,
      before: null,
      after: null,
      createdAt: "2026-08-12T00:00:00Z",
    });

    expect(imported.actor).toStrictEqual({ kind: "system", source: "import" });
  });

  it("carries display values, so a field change reads back after the row it named is gone", () => {
    const changed = decodeEvent({
      id: "event-2",
      issueId: "issue-1",
      actor: { kind: "agent", provider: "codex" },
      kind: "field_changed",
      field: "status",
      before: "Todo",
      after: "In Review",
      createdAt: "2026-08-12T00:00:01Z",
    });

    expect([changed.before, changed.after]).toStrictEqual(["Todo", "In Review"]);
  });
});

describe("IssuesStreamEvent", () => {
  it("round-trips every variant through the JSON codec", () => {
    const codec = Schema.toCodecJson(IssuesStreamEvent);
    const events = [
      { _tag: "IssueUpserted", issue: ISSUE_JSON },
      { _tag: "IssueDeleted", issueId: "issue-1" },
      { _tag: "StatusesChanged", statuses: [STATUS_JSON] },
      { _tag: "LabelsChanged", labels: [LABEL_JSON] },
      { _tag: "MilestonesChanged", milestones: [MILESTONE_JSON] },
      { _tag: "CyclesChanged", cycles: [CYCLE_JSON] },
      { _tag: "ViewsChanged", views: [VIEW_JSON] },
      { _tag: "IssueTodosChanged", issueId: "issue-1", todos: [TODO_JSON] },
      {
        _tag: "IssueRelationsChanged",
        issueId: "issue-2",
        relations: [{ relation: RELATION_JSON, direction: "incoming" }],
      },
      { _tag: "IssueCommentUpserted", comment: COMMENT_JSON },
      { _tag: "IssueCommentDeleted", issueId: "issue-1", commentId: "comment-1" },
      { _tag: "EnrichmentRunChanged", run: ENRICHMENT_RUN_JSON },
      { _tag: "IssueThreadLinksChanged", issueId: "issue-1", links: [THREAD_LINK_JSON] },
      { _tag: "ConfigChanged", config: CONFIG_JSON },
    ].map((event) => decodeStreamEvent(event));

    for (const event of events) {
      expect(Schema.decodeUnknownSync(codec)(Schema.encodeUnknownSync(codec)(event))).toStrictEqual(
        event,
      );
    }
  });

  it("has no snapshot variant: the initial read is issues.getSnapshot, the stream is diffs", () => {
    expect(() => decodeStreamEvent({ _tag: "Snapshot", issues: [] })).toThrow();
  });
});

describe("IssuesSnapshot", () => {
  it("round-trips the whole tracker through the JSON codec", () => {
    const codec = Schema.toCodecJson(IssuesSnapshot);
    const snapshot = decodeSnapshot({
      issues: [ISSUE_JSON],
      statuses: [STATUS_JSON],
      labels: [LABEL_JSON],
      milestones: [MILESTONE_JSON],
      cycles: [CYCLE_JSON],
      views: [VIEW_JSON],
      slackWatches: [SLACK_WATCH_JSON],
      slackStatus: SLACK_STATUS_JSON,
      config: CONFIG_JSON,
    });

    expect(
      Schema.decodeUnknownSync(codec)(Schema.encodeUnknownSync(codec)(snapshot)),
    ).toStrictEqual(snapshot);
  });

  // Todos, relations, and comments grow with usage rather than with configuration, so the first
  // read of the tracker must not be proportional to its history. They arrive per issue instead.
  it("leaves the per-issue tails out, and carries the planning containers", () => {
    const fields = Object.keys(IssuesSnapshot.fields);

    expect(fields).toContain("milestones");
    expect(fields).toContain("cycles");
    expect(fields).toContain("views");
    expect(fields).not.toContain("todos");
    expect(fields).not.toContain("relations");
    expect(fields).not.toContain("comments");
  });
});

describe("IssueMilestone", () => {
  it("round-trips through the JSON codec the RPC serializes with", () => {
    const codec = Schema.toCodecJson(IssueMilestone);
    const milestone = decodeMilestone(MILESTONE_JSON);

    expect(
      Schema.decodeUnknownSync(codec)(Schema.encodeUnknownSync(codec)(milestone)),
    ).toStrictEqual(milestone);
  });

  // A milestone with no project is a second, weaker cycle, and the sidebar reaches it by
  // expanding the project it sits under.
  it("insists on a project, unlike an issue", () => {
    expect(() => decodeMilestone({ ...MILESTONE_JSON, projectId: null })).toThrow();
  });

  it("takes a target date as a calendar day, or none at all", () => {
    expect(decodeMilestone({ ...MILESTONE_JSON, targetDate: null }).targetDate).toBeNull();
    expect(() => decodeMilestone({ ...MILESTONE_JSON, targetDate: "next friday" })).toThrow();
  });

  // Every milestone created before dates existed is a point, so both ends have to be droppable.
  it("takes a start date on the same terms", () => {
    expect(decodeMilestone({ ...MILESTONE_JSON, startDate: null }).startDate).toBeNull();
    expect(() => decodeMilestone({ ...MILESTONE_JSON, startDate: "next friday" })).toThrow();
  });

  it("tells clearing a date from leaving it alone", () => {
    expect(decodeMilestonePatch({ targetDate: null }).targetDate).toBeNull();
    expect(decodeMilestonePatch({ name: "Renamed" }).targetDate).toBeUndefined();
    expect(decodeMilestonePatch({ startDate: null }).startDate).toBeNull();
    expect(decodeMilestonePatch({ name: "Renamed" }).startDate).toBeUndefined();
  });

  // Storing the status would make it stale the moment this server went to sleep.
  it("stores dates and no status", () => {
    expect(Object.keys(IssueMilestone.fields)).not.toContain("status");
  });

  it("derives completion before lateness, so a finished milestone is never overdue", () => {
    const milestone = decodeMilestone(MILESTONE_JSON);
    const on = (done: number, total: number, started: number, today: string) =>
      issueMilestoneStatusOn(milestone, { done, total, started }, decodeDate(today));

    expect(on(3, 3, 0, "2026-09-30")).toBe("completed");
    expect(on(2, 3, 0, "2026-09-30")).toBe("overdue");
    expect(on(0, 0, 0, "2026-09-30")).toBe("overdue");
  });

  it("starts once anything is in flight or the start date has arrived", () => {
    const milestone = decodeMilestone(MILESTONE_JSON);
    const on = (started: number, today: string) =>
      issueMilestoneStatusOn(milestone, { done: 0, total: 3, started }, decodeDate(today));

    expect(on(0, "2026-08-14")).toBe("upcoming");
    // The day itself counts, the same way a cycle's start day does.
    expect(on(0, "2026-08-15")).toBe("in-progress");
    // A `review` issue is started-but-not-done work, so it moves the milestone off "upcoming".
    expect(on(1, "2026-08-01")).toBe("in-progress");
  });

  // `started` counts what is in flight, so finished work only shows up in `done` — a milestone
  // that has completed something has plainly started, whatever its dates say.
  it("starts on completed work alone, without a start date and with nothing in flight", () => {
    const undated = decodeMilestone({ ...MILESTONE_JSON, startDate: null });

    expect(
      issueMilestoneStatusOn(undated, { done: 3, total: 5, started: 0 }, decodeDate("2026-08-01")),
    ).toBe("in-progress");
  });

  it("leaves an undated milestone upcoming until its issues move", () => {
    const undated = decodeMilestone({ ...MILESTONE_JSON, startDate: null, targetDate: null });
    const on = (done: number, total: number, started: number) =>
      issueMilestoneStatusOn(undated, { done, total, started }, decodeDate("2026-12-25"));

    expect(on(0, 0, 0)).toBe("upcoming");
    expect(on(0, 3, 0)).toBe("upcoming");
    expect(on(1, 3, 1)).toBe("in-progress");
    expect(on(3, 3, 0)).toBe("completed");
  });
});

describe("IssueMilestoneHistoryResult", () => {
  const codec = Schema.toCodecJson(IssueMilestoneHistoryResult);
  const RESULT_JSON = {
    points: [
      { date: "2026-08-15", scope: 3, started: 1, completed: 0 },
      { date: "2026-08-16", scope: 3, started: 2, completed: 1 },
    ],
    approximate: false,
  };

  it("round-trips through the JSON codec the RPC serializes with", () => {
    const result = Schema.decodeUnknownSync(codec)(RESULT_JSON);

    expect(Schema.decodeUnknownSync(codec)(Schema.encodeUnknownSync(codec)(result))).toStrictEqual(
      result,
    );
  });

  // The series is a count of issues, so a fraction or a negative is a bug on the wire.
  it("refuses a count that is not a whole number of issues", () => {
    expect(() =>
      Schema.decodeUnknownSync(codec)({
        ...RESULT_JSON,
        points: [{ date: "2026-08-15", scope: -1, started: 0, completed: 0 }],
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(codec)({
        ...RESULT_JSON,
        points: [{ date: "2026-08-15", scope: 1.5, started: 0, completed: 0 }],
      }),
    ).toThrow();
  });

  it("dates each point to a calendar day, matching the milestone's own dates", () => {
    expect(() =>
      Schema.decodeUnknownSync(codec)({
        ...RESULT_JSON,
        points: [{ date: "2026-08-15T00:00:00Z", scope: 0, started: 0, completed: 0 }],
      }),
    ).toThrow();
  });
});

describe("IssueCycle", () => {
  it("round-trips through the JSON codec the RPC serializes with", () => {
    const codec = Schema.toCodecJson(IssueCycle);
    const cycle = decodeCycle(CYCLE_JSON);

    expect(Schema.decodeUnknownSync(codec)(Schema.encodeUnknownSync(codec)(cycle))).toStrictEqual(
      cycle,
    );
  });

  // Storing the status would make it stale the moment this server went to sleep.
  it("stores dates and no status", () => {
    expect(Object.keys(IssueCycle.fields)).not.toContain("status");
    expect(() => decodeCycle({ ...CYCLE_JSON, startDate: "2026-08-10T00:00:00Z" })).toThrow();
  });

  it("derives upcoming, active, and ended from today, with both ends inclusive", () => {
    const cycle = decodeCycle(CYCLE_JSON);
    const on = (today: string) => issueCycleStatusOn(cycle, decodeDate(today));

    expect(on("2026-08-09")).toBe("upcoming");
    expect(on("2026-08-10")).toBe("active");
    expect(on("2026-08-24")).toBe("active");
    expect(on("2026-08-25")).toBe("ended");
  });

  // Finalisation is lazy — there is no scheduler here — so an ended cycle sits un-finalised
  // until somebody looks at the tracker again.
  it("marks finalisation separately from ending", () => {
    expect(decodeCycle(CYCLE_JSON).completedAt).toBeNull();
    expect(decodeCycle({ ...CYCLE_JSON, completedAt: "2026-08-25T09:00:00Z" }).completedAt).toBe(
      "2026-08-25T09:00:00Z",
    );
  });
});

describe("IssueTodo", () => {
  it("round-trips through the JSON codec the RPC serializes with", () => {
    const codec = Schema.toCodecJson(IssueTodo);
    const todo = decodeTodo(TODO_JSON);

    expect(Schema.decodeUnknownSync(codec)(Schema.encodeUnknownSync(codec)(todo))).toStrictEqual(
      todo,
    );
  });

  // A todo is not a sub-issue: no key, no status, no assignee.
  it("carries nothing but text, doneness, and a place in the list", () => {
    expect(Object.keys(IssueTodo.fields).sort()).toStrictEqual([
      "done",
      "id",
      "issueId",
      "position",
      "text",
    ]);
    expect(() => decodeTodo({ ...TODO_JSON, text: "   " })).toThrow();
  });

  it("reorders by naming the issue and the whole order", () => {
    const decodeReorder = Schema.decodeUnknownSync(IssueTodosReorderInput);

    expect(decodeReorder({ issueId: "issue-1", todoIds: ["todo-2", "todo-1"] }).todoIds).toContain(
      "todo-2",
    );
    expect(() => decodeReorder({ issueId: "issue-1", todoIds: [] })).toThrow();
  });
});

describe("IssueRelation", () => {
  it("round-trips through the JSON codec the RPC serializes with", () => {
    const codec = Schema.toCodecJson(IssueRelation);
    const relation = decodeRelation(RELATION_JSON);

    expect(
      Schema.decodeUnknownSync(codec)(Schema.encodeUnknownSync(codec)(relation)),
    ).toStrictEqual(relation);
  });

  // One row per pair. "Blocked by" is that row read from the other end, so materialising it as a
  // kind would mean two rows to keep agreeing with each other.
  it("has no blocked-by kind, because the inverse is a read", () => {
    expect(() => decodeRelation({ ...RELATION_JSON, kind: "blocked-by" })).toThrow();
    expect(decodeRelation({ ...RELATION_JSON, kind: "duplicate" }).kind).toBe("duplicate");
  });

  // The schema cannot express "these two fields differ"; the server answers `invalid`.
  it("leaves the self-relation check to the server", () => {
    expect(
      decodeRelationCreate({ issueId: "issue-1", relatedIssueId: "issue-1", kind: "blocks" }),
    ).toBeDefined();
  });
});

describe("IssueComment", () => {
  it("round-trips through the JSON codec the RPC serializes with", () => {
    const codec = Schema.toCodecJson(IssueComment);
    const comment = decodeComment(COMMENT_JSON);

    expect(Schema.decodeUnknownSync(codec)(Schema.encodeUnknownSync(codec)(comment))).toStrictEqual(
      comment,
    );
  });

  it("keeps the body untrimmed, and says when it was edited without moving when it was written", () => {
    expect(decodeComment(COMMENT_JSON).body).toBe("  two trailing spaces break a line  \n");

    const edited = decodeComment({ ...COMMENT_JSON, editedAt: "2026-08-12T01:00:00Z" });
    expect([edited.createdAt, edited.editedAt]).toStrictEqual([
      "2026-08-12T00:00:00Z",
      "2026-08-12T01:00:00Z",
    ]);
  });

  it("lets an agent comment, and says so", () => {
    expect(
      decodeComment({ ...COMMENT_JSON, author: { kind: "agent", provider: "codex" } }).author,
    ).toStrictEqual({ kind: "agent", provider: "codex" });
  });

  it("bounds the body and the attachment list, and refuses an empty comment", () => {
    const attachments = (count: number) =>
      Array.from({ length: count }, (_, index) => `attachment-${index}`);

    expect(
      decodeCommentCreate({ issueId: "issue-1", body: "a".repeat(ISSUE_COMMENT_MAX_CHARS) }),
    ).toBeDefined();
    expect(() =>
      decodeCommentCreate({ issueId: "issue-1", body: "a".repeat(ISSUE_COMMENT_MAX_CHARS + 1) }),
    ).toThrow();
    expect(() => decodeCommentCreate({ issueId: "issue-1", body: "" })).toThrow();
    expect(
      decodeCommentCreate({
        issueId: "issue-1",
        body: "hi",
        attachmentIds: attachments(ISSUE_COMMENT_MAX_ATTACHMENTS),
      }).attachmentIds,
    ).toHaveLength(ISSUE_COMMENT_MAX_ATTACHMENTS);
    expect(() =>
      decodeCommentCreate({
        issueId: "issue-1",
        body: "hi",
        attachmentIds: attachments(ISSUE_COMMENT_MAX_ATTACHMENTS + 1),
      }),
    ).toThrow();
  });
});

describe("IssueDetail", () => {
  it("round-trips one issue's tail, with relations read from both ends", () => {
    const codec = Schema.toCodecJson(IssueDetail);
    const detail = decodeDetail({
      todos: [TODO_JSON],
      relations: [
        { relation: RELATION_JSON, direction: "outgoing" },
        {
          relation: { ...RELATION_JSON, id: "relation-2", issueId: "issue-3" },
          direction: "incoming",
        },
      ],
      comments: [COMMENT_JSON],
    });

    expect(Schema.decodeUnknownSync(codec)(Schema.encodeUnknownSync(codec)(detail))).toStrictEqual(
      detail,
    );
    expect(detail.relations.map((edge) => edge.direction)).toStrictEqual(["outgoing", "incoming"]);
  });
});

describe("ISSUE_MAX_PARENT_DEPTH", () => {
  it("caps sub-issue nesting at three, which is what a list row can still indent", () => {
    expect(ISSUE_MAX_PARENT_DEPTH).toBe(3);
  });
});

describe("isPlaceholderIssueTitle", () => {
  // The one list both sides consult: the server drops a model's proposed title for anything else,
  // and the web hides the apply button for it. Disagreement between them is a suggestion a person
  // can see and not take.
  it("names the intake and editor defaults, however they were typed", () => {
    for (const title of [
      "Slack message",
      "slack message",
      "  SLACK MESSAGE  ",
      "Untitled",
      "untitled",
      "New issue",
      "new ISSUE",
    ]) {
      expect(isPlaceholderIssueTitle(title)).toBe(true);
    }
  });

  it("counts a title that says nothing at all", () => {
    expect(isPlaceholderIssueTitle("")).toBe(true);
    expect(isPlaceholderIssueTitle("   \n\t ")).toBe(true);
  });

  it("leaves anything a person wrote alone", () => {
    for (const title of [
      "Reconnect drops the queued turn",
      "Slack messages are dropped on reconnect",
      "Untitled column renders blank",
      "New issues do not appear in triage",
    ]) {
      expect(isPlaceholderIssueTitle(title)).toBe(false);
    }
  });
});

describe("IssueTrackerConfig", () => {
  it("takes one uppercase prefix per environment", () => {
    expect(decodeConfig(CONFIG_JSON).keyPrefix).toBe("PAT");
    expect(() => decodeConfig({ ...CONFIG_JSON, keyPrefix: "pat" })).toThrow();
    expect(() => decodeConfig({ ...CONFIG_JSON, keyPrefix: "1PAT" })).toThrow();
  });

  it("never hands out a zeroth key", () => {
    expect(() => decodeConfig({ ...CONFIG_JSON, nextNumber: 0 })).toThrow();
  });
});

describe("IssuesImportCsvInput", () => {
  it("bounds the paste, because the whole file travels over the socket in one frame", () => {
    expect(decodeImportCsv({ csvText: "a".repeat(ISSUES_IMPORT_CSV_MAX_CHARS) })).toBeDefined();
    expect(() =>
      decodeImportCsv({ csvText: "a".repeat(ISSUES_IMPORT_CSV_MAX_CHARS + 1) }),
    ).toThrow();
    expect(() => decodeImportCsv({ csvText: "" })).toThrow();
  });
});

describe("IssueView", () => {
  it("round-trips a full chip bar through the JSON codec", () => {
    const codec = Schema.toCodecJson(IssueView);
    const view = decodeView(VIEW_JSON);

    expect(Schema.decodeUnknownSync(codec)(Schema.encodeUnknownSync(codec)(view))).toStrictEqual(
      view,
    );
  });

  // An absent chip is not an empty chip: "no label filter" and "filter to no labels" are
  // different questions, and only the optional key can tell them apart.
  it("keeps an unadded chip absent rather than empty", () => {
    const view = decodeView({
      ...VIEW_JSON,
      config: { tab: "all", grouping: "none", sortMode: "manual", viewMode: "list" },
    });

    expect(view.config.labelIds).toBeUndefined();
    expect(view.config.dueFilter).toBeUndefined();
    expect(Object.hasOwn(view.config, "labelIds")).toBe(false);
  });

  it("insists on the four fields a view always has", () => {
    for (const missing of ["tab", "grouping", "sortMode", "viewMode"]) {
      const config: Record<string, unknown> = { ...VIEW_JSON.config };
      delete config[missing];
      expect(() => decodeView({ ...VIEW_JSON, config })).toThrow();
    }
  });

  it("refuses a grouping, sort, or layout it does not have", () => {
    expect(() =>
      decodeView({ ...VIEW_JSON, config: { ...VIEW_JSON.config, grouping: "label" } }),
    ).toThrow();
    expect(() =>
      decodeView({ ...VIEW_JSON, config: { ...VIEW_JSON.config, sortMode: "due" } }),
    ).toThrow();
    expect(() =>
      decodeView({ ...VIEW_JSON, config: { ...VIEW_JSON.config, viewMode: "calendar" } }),
    ).toThrow();
    expect(() =>
      decodeView({ ...VIEW_JSON, config: { ...VIEW_JSON.config, dueFilter: "year" } }),
    ).toThrow();
  });

  it("bounds one chip so a stored view cannot grow without limit", () => {
    const labelIds = Array.from(
      { length: ISSUE_VIEW_FILTER_MAX_VALUES + 1 },
      (_, index) => `label-${index}`,
    );

    expect(() => decodeView({ ...VIEW_JSON, config: { ...VIEW_JSON.config, labelIds } })).toThrow();
  });

  it("appends when a create names no position, and takes the complete order on a reorder", () => {
    expect(decodeViewCreate({ name: "Mine", config: VIEW_JSON.config }).position).toBeUndefined();
    expect(decodeViewsReorder({ viewIds: ["view-1", "view-2"] }).viewIds).toHaveLength(2);
    // Rewriting positions from an empty list would leave every view unpositioned.
    expect(() => decodeViewsReorder({ viewIds: [] })).toThrow();
  });
});

describe("IssueCommentAttachmentUploadInput", () => {
  it("carries the owning issue with the payload, because the id is namespaced to it", () => {
    const input = decodeAttachmentUpload({
      issueId: "issue-1",
      dataUrl: "data:image/png;base64,iVBORw0KGgo=",
    });

    expect(input.issueId).toBe("issue-1");
  });

  // Base64 spends four characters on three bytes, so the wire bound has to be the larger number
  // or a legal image would be refused before the server ever decoded it.
  it("bounds the data URL above the byte ceiling it is protecting", () => {
    expect(ISSUE_COMMENT_ATTACHMENT_MAX_DATA_URL_CHARS).toBeGreaterThan(
      ISSUE_COMMENT_ATTACHMENT_MAX_BYTES,
    );
    expect(() =>
      decodeAttachmentUpload({
        issueId: "issue-1",
        dataUrl: "x".repeat(ISSUE_COMMENT_ATTACHMENT_MAX_DATA_URL_CHARS + 1),
      }),
    ).toThrow();
    expect(() => decodeAttachmentUpload({ issueId: "issue-1", dataUrl: "" })).toThrow();
  });
});

describe("IssueEnrichmentRun", () => {
  it("round-trips a finished run, model selection and structured result and all", () => {
    const codec = Schema.toCodecJson(IssueEnrichmentRun);
    const run = decodeEnrichmentRun(ENRICHMENT_RUN_JSON);

    expect(run.modelSelection.model).toBe("gpt-5-codex");
    expect(run.result?.likelyFiles[0]?.path).toBe("apps/server/src/issues/IssueTrackerService.ts");
    expect(Schema.decodeUnknownSync(codec)(Schema.encodeUnknownSync(codec)(run))).toStrictEqual(
      run,
    );
  });

  it("carries no result and no timestamps while it is queued", () => {
    const run = decodeEnrichmentRun({
      ...ENRICHMENT_RUN_JSON,
      state: "queued",
      transcript: "",
      result: null,
      startedAt: null,
      finishedAt: null,
    });

    expect(run.result).toBeNull();
    expect(run.startedAt).toBeNull();
  });

  // Cancelling lands in `failed` with a reason, so the panel has one place to look for why a run
  // came back empty.
  it("has four states and `canceled` is not one of them", () => {
    for (const state of ["queued", "running", "done", "failed"]) {
      expect(decodeEnrichmentRun({ ...ENRICHMENT_RUN_JSON, state }).state).toBe(state);
    }
    expect(() => decodeEnrichmentRun({ ...ENRICHMENT_RUN_JSON, state: "canceled" })).toThrow();
  });

  it("bounds the transcript rather than letting one run grow without limit", () => {
    expect(() =>
      decodeEnrichmentRun({
        ...ENRICHMENT_RUN_JSON,
        transcript: "x".repeat(ISSUE_ENRICHMENT_TRANSCRIPT_MAX_CHARS + 1),
      }),
    ).toThrow();
  });

  it("takes suggestions rather than writes: labels by name, priority nullable, issues by key", () => {
    const result = decodeEnrichmentResult({
      ...ENRICHMENT_RESULT_JSON,
      suggestedPriority: null,
      suggestedLabels: ["Not a label yet"],
    });

    expect(result.suggestedPriority).toBeNull();
    expect(result.suggestedLabels).toStrictEqual(["Not a label yet"]);
    // A key the model read in the tree, never a row id it could not have seen.
    expect(() =>
      decodeEnrichmentResult({ ...ENRICHMENT_RESULT_JSON, relatedIssueKeys: ["issue-1"] }),
    ).toThrow();
    expect(() =>
      decodeEnrichmentResult({
        ...ENRICHMENT_RESULT_JSON,
        likelyFiles: Array.from({ length: ISSUE_ENRICHMENT_MAX_LIKELY_FILES + 1 }, (_, index) => ({
          path: `file-${index}.ts`,
          reason: "",
        })),
      }),
    ).toThrow();
  });
});

describe("IssueThreadLink", () => {
  it("names where the link came from, and refuses an origin it does not have", () => {
    expect(decodeThreadLink(THREAD_LINK_JSON).origin).toBe("start-work");
    expect(decodeThreadLink({ ...THREAD_LINK_JSON, origin: "manual" }).origin).toBe("manual");
    // Assignment records intent and a link records the thread that followed; nothing auto-spawns,
    // so there is no origin standing for one.
    expect(() => decodeThreadLink({ ...THREAD_LINK_JSON, origin: "auto" })).toThrow();
  });
});

describe("Slack intake", () => {
  const decodeWatch = Schema.decodeUnknownSync(SlackChannelWatch);
  const decodeTrigger = Schema.decodeUnknownSync(SlackIntakeTrigger);
  const decodeSlackStatus = Schema.decodeUnknownSync(SlackIntakeStatus);
  const decodeSlackSource = Schema.decodeUnknownSync(IssueSlackSource);
  const decodeTriageAccept = Schema.decodeUnknownSync(IssueTriageAcceptInput);
  const decodeSetToken = Schema.decodeUnknownSync(SlackSetTokenInput);

  it("round-trips a watch through the JSON codec the RPC serializes with", () => {
    const codec = Schema.toCodecJson(SlackChannelWatch);
    const watch = decodeWatch(SLACK_WATCH_JSON);

    expect(Schema.decodeUnknownSync(codec)(Schema.encodeUnknownSync(codec)(watch))).toStrictEqual(
      watch,
    );
    expect(watch.autoAssign).toBe(true);
    expect(watch.cycleId).toBe("cycle-1");
    const { autoAssign: _, ...legacyWatch } = SLACK_WATCH_JSON;
    expect(decodeWatch(legacyWatch).autoAssign).toBeUndefined();
    const { cycleId: __, ...watchWithoutCycle } = SLACK_WATCH_JSON;
    expect(decodeWatch(watchWithoutCycle).cycleId).toBeUndefined();
  });

  // A channel can file on a reaction *and* on a mention, and all triggers off is a paused watch
  // rather than an invalid one: pausing and forgetting the configuration are different things.
  it("takes any combination of triggers, including none at all", () => {
    expect(isSlackIntakeTriggerActive(decodeTrigger(SLACK_WATCH_JSON.trigger))).toBe(true);
    expect(
      isSlackIntakeTriggerActive(
        decodeTrigger({ reactionRoutes: [], everyMessage: true, botMention: true }),
      ),
    ).toBe(true);
    expect(
      isSlackIntakeTriggerActive(
        decodeTrigger({ reactionRoutes: [], everyMessage: false, botMention: false }),
      ),
    ).toBe(false);
  });

  // The poller compares this against `reaction.name` verbatim, so a decorated value never matches.
  it("accepts several unique reaction routes and bounds the list", () => {
    const route = (emoji: string) => ({ emoji, projectId: null, autoInvestigate: null });
    expect(
      decodeTrigger({
        ...SLACK_WATCH_JSON.trigger,
        reactionRoutes: [route("+1"), route("white_check_mark")],
      }).reactionRoutes.map((item) => item.emoji),
    ).toEqual(["+1", "white_check_mark"]);
    expect(() =>
      decodeTrigger({
        ...SLACK_WATCH_JSON.trigger,
        reactionRoutes: [route("ticket"), route("ticket")],
      }),
    ).toThrow();
    expect(() =>
      decodeTrigger({
        ...SLACK_WATCH_JSON.trigger,
        reactionRoutes: Array.from({ length: SLACK_MAX_REACTION_ROUTES + 1 }, (_, index) =>
          route(`ticket_${index}`),
        ),
      }),
    ).toThrow();
    expect(() =>
      decodeTrigger({ ...SLACK_WATCH_JSON.trigger, reactionRoutes: [route(":ticket:")] }),
    ).toThrow();
    expect(() =>
      decodeTrigger({ ...SLACK_WATCH_JSON.trigger, reactionRoutes: [route("Ticket")] }),
    ).toThrow();
  });

  it("carries no token on the status, only whether there is one", () => {
    const status = decodeSlackStatus(SLACK_STATUS_JSON);

    expect(status.configured).toBe(true);
    expect(Object.keys(SlackIntakeStatus.fields)).not.toContain("token");
  });

  // An empty string clears the token, so this is the one input that accepts one.
  it("lets the token input be empty, because clearing is the same write as setting", () => {
    expect(decodeSetToken({ token: "" }).token).toBe("");
    expect(decodeSetToken({ token: "xoxb-1-2-abc" }).token).toBe("xoxb-1-2-abc");
    expect(() => decodeSetToken({ token: "x".repeat(SLACK_BOT_TOKEN_MAX_CHARS + 1) })).toThrow();
  });

  it("hangs the source off the issue row rather than a side table", () => {
    const issue = decodeIssue({ ...ISSUE_JSON, slackSource: SLACK_SOURCE_JSON });

    expect(issue.slackSource?.messageTs).toBe("1723459200.001900");
    // A permalink is a nicety, not a requirement to file.
    expect(
      decodeSlackSource({ ...SLACK_SOURCE_JSON, permalink: null, authorName: null }).permalink,
    ).toBeNull();
  });

  // Status, project, and priority in one write: applying them separately would put a half-triaged
  // issue on the board, which is the state triage exists to keep out of it.
  it("accepts a triage item in one action, with the project optional and nullable", () => {
    const accepted = decodeTriageAccept({
      issueId: "issue-1",
      statusId: "status-todo",
      projectId: null,
      priority: "high",
      assignee: { kind: "agent", provider: "codex" },
      runEnrichment: true,
    });

    expect(accepted.projectId).toBeNull();
    expect(accepted.assignee).toEqual({ kind: "agent", provider: "codex" });
    // Absent keeps whatever the channel auto-tagged, which is not the same as clearing it.
    expect(
      decodeTriageAccept({ issueId: "issue-1", statusId: "status-todo", runEnrichment: false })
        .projectId,
    ).toBeUndefined();
    // A triage item leaves triage by landing in the workflow, and the workflow is statuses.
    expect(() => decodeTriageAccept({ issueId: "issue-1", runEnrichment: false })).toThrow();
  });

  it("carries intake on the stream and in the snapshot, not as a separate read", () => {
    expect(
      decodeStreamEvent({ _tag: "SlackWatchesChanged", watches: [SLACK_WATCH_JSON] })._tag,
    ).toBe("SlackWatchesChanged");
    expect(decodeStreamEvent({ _tag: "SlackStatusChanged", status: SLACK_STATUS_JSON })._tag).toBe(
      "SlackStatusChanged",
    );

    const fields = Object.keys(IssuesSnapshot.fields);
    expect(fields).toContain("slackWatches");
    expect(fields).toContain("slackStatus");
  });

  // A soft delete underneath, but the feed has to tell "this never was an issue" apart from
  // "somebody deleted this issue".
  it("logs a rejection as its own event kind", () => {
    const rejected = decodeEvent({
      id: "event-3",
      issueId: "issue-1",
      actor: { kind: "user" },
      kind: "triage_rejected",
      field: null,
      before: null,
      after: null,
      createdAt: "2026-08-12T00:00:02Z",
    });

    expect(rejected.kind).toBe("triage_rejected");
  });
});
