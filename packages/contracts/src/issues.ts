/**
 * Issue tracker contracts — see `docs/internals/decisions/0006-issue-tracker.md`.
 *
 * The tracker is environment-scoped plain state, not an orchestration aggregate: clients read a
 * snapshot once and stay live on `issues.stream`, which carries diffs rather than snapshots so a
 * tracker with thousands of rows does not resend itself on every keystroke.
 *
 * @module issues
 */
import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  TrimmedString,
} from "./baseSchemas.ts";
import { ChatAttachmentId, PROVIDER_SEND_TURN_MAX_IMAGE_BYTES } from "./chatAttachment.ts";
import { ModelSelection } from "./modelSelection.ts";
import { ProviderDriverKind } from "./providerInstance.ts";

export const ISSUES_WS_METHODS = {
  getSnapshot: "issues.getSnapshot",
  /** The per-issue tail of the model — todos, relations, comments — read when a detail opens. */
  getDetail: "issues.getDetail",
  create: "issues.create",
  update: "issues.update",
  delete: "issues.delete",
  restore: "issues.restore",
  bulkUpdate: "issues.bulkUpdate",
  setSortOrder: "issues.setSortOrder",
  createStatus: "issues.createStatus",
  updateStatus: "issues.updateStatus",
  deleteStatus: "issues.deleteStatus",
  reorderStatuses: "issues.reorderStatuses",
  createLabel: "issues.createLabel",
  updateLabel: "issues.updateLabel",
  deleteLabel: "issues.deleteLabel",
  milestoneCreate: "issues.milestoneCreate",
  milestoneUpdate: "issues.milestoneUpdate",
  milestoneDelete: "issues.milestoneDelete",
  milestonesReorder: "issues.milestonesReorder",
  /** One point per day, aggregated on the server: the raw change log is far too big to ship. */
  milestoneHistory: "issues.milestoneHistory",
  cycleCreate: "issues.cycleCreate",
  cycleUpdate: "issues.cycleUpdate",
  cycleDelete: "issues.cycleDelete",
  todoCreate: "issues.todoCreate",
  todoUpdate: "issues.todoUpdate",
  todoDelete: "issues.todoDelete",
  todosReorder: "issues.todosReorder",
  relationCreate: "issues.relationCreate",
  relationDelete: "issues.relationDelete",
  commentCreate: "issues.commentCreate",
  commentUpdate: "issues.commentUpdate",
  commentDelete: "issues.commentDelete",
  commentsList: "issues.commentsList",
  /** Writes one image into the issue attachment namespace and answers with its id. */
  uploadCommentAttachment: "issues.uploadCommentAttachment",
  viewCreate: "issues.viewCreate",
  viewUpdate: "issues.viewUpdate",
  viewDelete: "issues.viewDelete",
  viewsReorder: "issues.viewsReorder",
  setKeyPrefix: "issues.setKeyPrefix",
  importCsv: "issues.importCsv",
  getEvents: "issues.getEvents",
  /** Fires the read-only investigation by hand. Never on import, never on a rootless project. */
  startEnrichment: "issues.startEnrichment",
  cancelEnrichment: "issues.cancelEnrichment",
  getEnrichmentRuns: "issues.getEnrichmentRuns",
  /** Records that a thread is working this issue. Opening the thread is the client's job. */
  linkThread: "issues.linkThread",
  unlinkThread: "issues.unlinkThread",
  getThreadLinks: "issues.getThreadLinks",
  /** Write-only: the bot token never comes back out. An empty string clears it. */
  slackSetToken: "issues.slackSetToken",
  slackGetStatus: "issues.slackGetStatus",
  /** Asked of Slack, not of the database: the picker lists what the bot can actually see. */
  slackListChannels: "issues.slackListChannels",
  slackWatchCreate: "issues.slackWatchCreate",
  slackWatchUpdate: "issues.slackWatchUpdate",
  slackWatchDelete: "issues.slackWatchDelete",
  /** Status, project, and priority in one write, and the only place enrichment fires by itself. */
  triageAccept: "issues.triageAccept",
  triageReject: "issues.triageReject",
  stream: "issues.stream",
} as const;

const makeIssueEntityId = <Brand extends string>(brand: Brand) =>
  TrimmedNonEmptyString.pipe(Schema.brand(brand));

export const IssueId = makeIssueEntityId("IssueId");
export type IssueId = typeof IssueId.Type;
export const IssueStatusId = makeIssueEntityId("IssueStatusId");
export type IssueStatusId = typeof IssueStatusId.Type;
export const IssueLabelId = makeIssueEntityId("IssueLabelId");
export type IssueLabelId = typeof IssueLabelId.Type;
export const IssueEventId = makeIssueEntityId("IssueEventId");
export type IssueEventId = typeof IssueEventId.Type;
export const IssueMilestoneId = makeIssueEntityId("IssueMilestoneId");
export type IssueMilestoneId = typeof IssueMilestoneId.Type;
export const IssueCycleId = makeIssueEntityId("IssueCycleId");
export type IssueCycleId = typeof IssueCycleId.Type;
export const IssueTodoId = makeIssueEntityId("IssueTodoId");
export type IssueTodoId = typeof IssueTodoId.Type;
export const IssueRelationId = makeIssueEntityId("IssueRelationId");
export type IssueRelationId = typeof IssueRelationId.Type;
export const IssueCommentId = makeIssueEntityId("IssueCommentId");
export type IssueCommentId = typeof IssueCommentId.Type;
export const IssueViewId = makeIssueEntityId("IssueViewId");
export type IssueViewId = typeof IssueViewId.Type;
export const IssueEnrichmentRunId = makeIssueEntityId("IssueEnrichmentRunId");
export type IssueEnrichmentRunId = typeof IssueEnrichmentRunId.Type;
export const SlackChannelWatchId = makeIssueEntityId("SlackChannelWatchId");
export type SlackChannelWatchId = typeof SlackChannelWatchId.Type;

export const ISSUE_TITLE_MAX_CHARS = 512;
export const ISSUE_DESCRIPTION_MAX_CHARS = 100_000;
/**
 * Titles that carry no information about the issue — intake defaults ("Slack message" is what an
 * image-only Slack ingest gets) and editor defaults. An investigation may only propose a title
 * for these; both the server normalizer and the web apply gate consult this one list.
 */
const ISSUE_PLACEHOLDER_TITLES: ReadonlySet<string> = new Set([
  "slack message",
  "untitled",
  "new issue",
]);
export function isPlaceholderIssueTitle(title: string): boolean {
  const normalized = title.trim().toLowerCase();
  return normalized.length === 0 || ISSUE_PLACEHOLDER_TITLES.has(normalized);
}
export const ISSUE_COMMENT_MAX_CHARS = 100_000;
/** Mirrors the composer's own limit: a comment is written in the same editor a turn is. */
export const ISSUE_COMMENT_MAX_ATTACHMENTS = 8;
/**
 * How deep sub-issues nest, counted in ancestors: a root issue sits at depth 0, so a parent three
 * levels up is the last one accepted. Deeper than this stops reading as a tree in a list row.
 */
export const ISSUE_MAX_PARENT_DEPTH = 3;
/** One import is a paste of a whole export; past this it belongs on disk, not on a socket. */
export const ISSUES_IMPORT_CSV_MAX_CHARS = 5_000_000;
/** A bulk write is what a selection can hold, and a selection is what a list can show. */
export const ISSUE_BULK_UPDATE_MAX_ISSUES = 500;
export const ISSUE_LABELS_MAX_PER_ISSUE = 50;
/**
 * How many values one filter chip can hold. A chip is a picker over a configured set — statuses,
 * labels, projects — and none of those sets is meant to reach this, so the bound only exists to
 * stop a stored view from growing without limit.
 */
export const ISSUE_VIEW_FILTER_MAX_VALUES = 200;
/**
 * How much of an enrichment run's transcript is kept. Generous on purpose: this is a whole
 * read-only investigation of a repository, and the panel renders it live. Past the ceiling the
 * *head* is dropped rather than the tail — a run's conclusion is the part anybody rereads.
 */
export const ISSUE_ENRICHMENT_TRANSCRIPT_MAX_CHARS = 2_000_000;
/**
 * How often a growing transcript is republished on the stream. A model emits tokens far faster
 * than a panel can paint them, and every republish carries the whole run, so the server batches
 * appends into windows of this length rather than sending one event per chunk.
 */
export const ISSUE_ENRICHMENT_TRANSCRIPT_PUBLISH_INTERVAL_MS = 250;
/** A restated problem, not a report: the summary is a paragraph the description can absorb. */
export const ISSUE_ENRICHMENT_SUMMARY_MAX_CHARS = 8_000;
/** A pointer into the repository, not a file listing. */
export const ISSUE_ENRICHMENT_MAX_LIKELY_FILES = 25;
export const ISSUE_ENRICHMENT_MAX_RELATED_ISSUES = 25;
export const ISSUE_ENRICHMENT_MAX_SUGGESTED_LABELS = 10;
/**
 * How long a bot token may be. Slack's `xoxb-` tokens are around seventy characters; the ceiling
 * only exists so a paste of the wrong thing entirely is refused on the wire rather than written
 * to disk.
 */
export const SLACK_BOT_TOKEN_MAX_CHARS = 512;
/**
 * How many channels one environment can watch. Every watch costs a `conversations.history` call
 * per poll interval, forever, on a laptop — the bound is what stops that bill from being unpayable
 * by accident.
 */
export const SLACK_MAX_CHANNEL_WATCHES = 50;
/**
 * How many reaction-specific routes one watched channel may hold. A route is configuration read
 * on every poll, not a message, and twenty is already more reactions than a channel can explain
 * without becoming its own routing system.
 */
export const SLACK_MAX_REACTION_ROUTES = 20;
/** One comment attachment, held to the same ceiling a turn's image is. */
export const ISSUE_COMMENT_ATTACHMENT_MAX_BYTES = PROVIDER_SEND_TURN_MAX_IMAGE_BYTES;
/**
 * The wire bound on the upload. Base64 spends four characters on every three bytes, and the
 * `data:image/webp;base64,` header and any wrapping whitespace ride on top of that.
 */
export const ISSUE_COMMENT_ATTACHMENT_MAX_DATA_URL_CHARS =
  Math.ceil(ISSUE_COMMENT_ATTACHMENT_MAX_BYTES / 3) * 4 + 1024;

/** `#rgb` or `#rrggbb`. Statuses and labels are drawn from this directly, so it is not free text. */
export const IssueColor = TrimmedNonEmptyString.check(
  Schema.isPattern(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/),
);
export type IssueColor = typeof IssueColor.Type;

/**
 * The human-facing identifier, `PAT-221`. One prefix and one counter per environment, so a key
 * survives a move between projects — project is a field on an issue, not the source of its name.
 */
export const IssueKey = TrimmedNonEmptyString.check(Schema.isPattern(/^[A-Z][A-Z0-9]*-\d+$/));
export type IssueKey = typeof IssueKey.Type;

export const IssueKeyPrefix = TrimmedNonEmptyString.check(Schema.isPattern(/^[A-Z][A-Z0-9]{0,9}$/));
export type IssueKeyPrefix = typeof IssueKeyPrefix.Type;

/**
 * A due date is a calendar day, not an instant: "due Friday" means the same thing in every time
 * zone, and rendering it from a timestamp moves it across a boundary for half the world.
 */
export const IssueDate = TrimmedNonEmptyString.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/));
export type IssueDate = typeof IssueDate.Type;

/**
 * The category — not a hand-maintained list of status names — is what drives the Active/Backlog
 * tabs, progress rollups, and what an agent means by "complete".
 */
export const IssueStatusCategory = Schema.Literals([
  "backlog",
  "unstarted",
  "started",
  "review",
  "completed",
  "canceled",
]);
export type IssueStatusCategory = typeof IssueStatusCategory.Type;

export const IssueStatus = Schema.Struct({
  id: IssueStatusId,
  name: TrimmedNonEmptyString,
  color: IssueColor,
  category: IssueStatusCategory,
  /** Ascending; ties are broken by `id` so an order is always total. */
  position: Schema.Number,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type IssueStatus = typeof IssueStatus.Type;

export const IssuePriority = Schema.Literals(["none", "urgent", "high", "medium", "low"]);
export type IssuePriority = typeof IssuePriority.Type;

/** The sole human on this environment. Carries no identity because there is nobody to tell apart. */
const IssueUserActor = Schema.Struct({ kind: Schema.Literal("user") });
const IssueAgentActor = Schema.Struct({
  kind: Schema.Literal("agent"),
  provider: ProviderDriverKind,
});
/**
 * Not a person: a write the tracker made on somebody's behalf. `cycles` is the lazy carry-over of
 * an ended cycle, which is the one write nobody asked for. `slack` lands with intake.
 */
const IssueSystemActor = Schema.Struct({
  kind: Schema.Literal("system"),
  source: Schema.Literals(["import", "cycles", "slack", "automation"]),
});

/**
 * Assignment records intent. It does not start anything: a stray kanban drag must not spawn three
 * agents, so an assigned agent surfaces a "Start work" button rather than a running turn.
 */
export const IssueAssignee = Schema.Union([IssueUserActor, IssueAgentActor]);
export type IssueAssignee = typeof IssueAssignee.Type;

export const IssueActor = Schema.Union([IssueUserActor, IssueAgentActor, IssueSystemActor]);
export type IssueActor = typeof IssueActor.Type;

/**
 * A Slack channel id, `C0123ABCD`. Opaque on purpose: it is whatever Slack handed back, and the
 * poller's cursor, the echo registry, and the dedupe table are all keyed on it verbatim.
 */
export const SlackChannelId = TrimmedNonEmptyString;
export type SlackChannelId = typeof SlackChannelId.Type;

/**
 * A Slack message timestamp, `1723459200.001900`. It is Slack's message *identity*, not a clock
 * reading, which is why it is a string: it is the thread key a reply attaches to, the cursor the
 * poller resumes from, and the id the echo registry recognises the bot's own post by.
 */
export const SlackMessageTs = TrimmedNonEmptyString;
export type SlackMessageTs = typeof SlackMessageTs.Type;

/**
 * Where an issue came in from, when it came in from Slack.
 *
 * `messageTs` is the load-bearing field: it is the thread a reply attaches to, the thread the bot
 * posts its own updates back into, and the id the poller skips its own posts by.
 */
export const IssueSlackSource = Schema.Struct({
  issueId: IssueId,
  channelId: SlackChannelId,
  messageTs: SlackMessageTs,
  /** Null until Slack answers with one; a permalink is a nicety, not a requirement to file. */
  permalink: Schema.NullOr(TrimmedNonEmptyString),
  /** The display name of whoever wrote the source message, for the attribution on the issue. */
  authorName: Schema.NullOr(TrimmedNonEmptyString),
});
export type IssueSlackSource = typeof IssueSlackSource.Type;

export const IssueAutomationAssignment = Schema.Struct({
  routingRuleId: Schema.NullOr(TrimmedNonEmptyString),
  auditRuleIds: Schema.Array(TrimmedNonEmptyString),
  rationale: Schema.String,
  assignedAt: IsoDateTime,
});
export type IssueAutomationAssignment = typeof IssueAutomationAssignment.Type;

export const Issue = Schema.Struct({
  id: IssueId,
  key: IssueKey,
  title: TrimmedNonEmptyString,
  /** Markdown. Not trimmed: leading spaces open a code block and two trailing ones break a line. */
  description: Schema.String,
  statusId: IssueStatusId,
  priority: IssuePriority,
  assignee: Schema.NullOr(IssueAssignee),
  /** Exact worker choice pinned by automatic routing or learned from the linked work thread. */
  workModelSelection: Schema.optionalKey(Schema.NullOr(ModelSelection)),
  /** Human-readable provenance for an automatic assignment. Absent on older and manual issues. */
  automationAssignment: Schema.optionalKey(Schema.NullOr(IssueAutomationAssignment)),
  projectId: Schema.NullOr(ProjectId),
  /** A milestone belongs to a project, so this is only meaningful alongside that project. */
  milestoneId: Schema.NullOr(IssueMilestoneId),
  /** Cycles span everything, so this is independent of the project. */
  cycleId: Schema.NullOr(IssueCycleId),
  /** Nests at most {@link ISSUE_MAX_PARENT_DEPTH} deep, and never into its own descendants. */
  parentId: Schema.NullOr(IssueId),
  /** Fractional key, the same manual-ordering scheme `pin_order_key` already uses. */
  sortOrder: TrimmedNonEmptyString,
  labelIds: Schema.Array(IssueLabelId),
  dueDate: Schema.NullOr(IssueDate),
  /**
   * Outside the workflow rather than a seventh status category: a triage item appears in no board
   * and no count, and accepting it assigns status, project, and priority in one action.
   */
  triage: Schema.Boolean,
  /**
   * Where this issue came in from, when it came in from Slack.
   *
   * Carried on the row rather than in a side table: the list draws a Slack marker on a triage
   * item and the sheet links back to the thread, so a side table would make the tracker's first
   * read two reads.
   */
  slackSource: Schema.NullOr(IssueSlackSource),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  /** Soft delete, which is what makes agent writes recoverable. */
  deletedAt: Schema.NullOr(IsoDateTime),
});
export type Issue = typeof Issue.Type;

export const IssueLabel = Schema.Struct({
  id: IssueLabelId,
  name: TrimmedNonEmptyString,
  color: IssueColor,
  createdAt: IsoDateTime,
});
export type IssueLabel = typeof IssueLabel.Type;

/**
 * A named checkpoint inside a project. `projectId` is required: a milestone with no project is a
 * second, weaker cycle, and the sidebar reaches milestones by expanding the project they sit under.
 */
export const IssueMilestone = Schema.Struct({
  id: IssueMilestoneId,
  projectId: ProjectId,
  name: TrimmedNonEmptyString,
  /** Markdown, like an issue body. Null rather than empty, so "cleared" is a state a patch can set. */
  description: Schema.NullOr(Schema.String),
  /**
   * A calendar day for the same reason a due date is one. Null keeps a milestone a point on the
   * timeline rather than a bar, which is what every milestone created before dates existed is.
   */
  startDate: Schema.NullOr(IssueDate),
  /** A calendar day for the same reason a due date is one. */
  targetDate: Schema.NullOr(IssueDate),
  /** Ascending within the project; ties are broken by `id` so an order is always total. */
  position: Schema.Number,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type IssueMilestone = typeof IssueMilestone.Type;

/**
 * A manually created date range spanning everything. Only the dates are stored: whether a cycle is
 * upcoming, active, or ended is a function of today, and a stored copy of that would be stale the
 * moment this server went to sleep. See {@link issueCycleStatusOn}.
 */
export const IssueCycle = Schema.Struct({
  id: IssueCycleId,
  name: TrimmedNonEmptyString,
  startDate: IssueDate,
  endDate: IssueDate,
  /**
   * Set when the server has finalised the cycle — carried unfinished issues to the next one and
   * frozen the completed set. Finalisation is lazy, on read, because there is no scheduler here,
   * so an ended cycle can sit un-finalised until somebody looks at the tracker again.
   */
  completedAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type IssueCycle = typeof IssueCycle.Type;

export const IssueCycleStatus = Schema.Literals(["upcoming", "active", "ended"]);
export type IssueCycleStatus = typeof IssueCycleStatus.Type;

/**
 * Derived, never stored. `YYYY-MM-DD` sorts lexicographically, so plain string comparison is the
 * whole calculation; both ends are inclusive, because a cycle ending Friday includes Friday.
 */
export const issueCycleStatusOn = (
  cycle: Pick<IssueCycle, "startDate" | "endDate">,
  today: IssueDate,
): IssueCycleStatus =>
  today < cycle.startDate ? "upcoming" : today > cycle.endDate ? "ended" : "active";

export const IssueMilestoneStatus = Schema.Literals([
  "upcoming",
  "in-progress",
  "completed",
  "overdue",
]);
export type IssueMilestoneStatus = typeof IssueMilestoneStatus.Type;

/**
 * Derived, never stored, for the reason {@link IssueCycle} gives: a milestone that went overdue
 * overnight would still read "in progress" from a stored copy. `tally` is the category rollup its
 * issues make — `started` counts everything past the backlog and short of done, so a `review` issue
 * moves a milestone off "upcoming" without completing it, and `done` counts the same way, because
 * work that is finished is work that was started.
 */
export const issueMilestoneStatusOn = (
  milestone: Pick<IssueMilestone, "startDate" | "targetDate">,
  tally: { readonly done: number; readonly total: number; readonly started: number },
  today: IssueDate,
): IssueMilestoneStatus =>
  tally.total > 0 && tally.done === tally.total
    ? "completed"
    : milestone.targetDate !== null && today > milestone.targetDate
      ? "overdue"
      : tally.started > 0 ||
          tally.done > 0 ||
          (milestone.startDate !== null && today >= milestone.startDate)
        ? "in-progress"
        : "upcoming";

/** Which of the three category-driven tabs a view opens on. */
export const IssueViewTab = Schema.Literals(["active", "backlog", "all"]);
export type IssueViewTab = typeof IssueViewTab.Type;

/** Grouping is a read concern and can vary; ordering is one column, so it is not listed here. */
export const IssueViewGrouping = Schema.Literals([
  "status",
  "project",
  "priority",
  "assignee",
  "none",
]);
export type IssueViewGrouping = typeof IssueViewGrouping.Type;

/** `manual` is the stored fractional key — the only one a drag can write back to. */
export const IssueViewSortMode = Schema.Literals(["manual", "priority", "updated", "created"]);
export type IssueViewSortMode = typeof IssueViewSortMode.Type;

export const IssueViewMode = Schema.Literals(["list", "board"]);
export type IssueViewMode = typeof IssueViewMode.Type;

/**
 * The one filter that is a predicate rather than a set. `none` means "no due date at all", which
 * is a thing a person filters for and cannot be said with a range.
 */
export const IssueViewDueFilter = Schema.Literals(["overdue", "week", "month", "none"]);
export type IssueViewDueFilter = typeof IssueViewDueFilter.Type;

const issueViewFilterValues = <S extends Schema.Top>(schema: S) =>
  Schema.optional(Schema.Array(schema).check(Schema.isMaxLength(ISSUE_VIEW_FILTER_MAX_VALUES)));

/**
 * A saved chip bar. Each present array is one chip: OR inside it, AND across the chips, with no
 * nesting and no negation — the decision record's whole filter model. An absent key is not an
 * empty chip: it is a chip that was never added, which is why every filter is optional rather
 * than a possibly-empty array.
 */
export const IssueViewConfig = Schema.Struct({
  tab: IssueViewTab,
  statusIds: issueViewFilterValues(IssueStatusId),
  projectIds: issueViewFilterValues(ProjectId),
  labelIds: issueViewFilterValues(IssueLabelId),
  milestoneIds: issueViewFilterValues(IssueMilestoneId),
  cycleIds: issueViewFilterValues(IssueCycleId),
  assignees: issueViewFilterValues(IssueAssignee),
  priorities: issueViewFilterValues(IssuePriority),
  dueFilter: Schema.optional(IssueViewDueFilter),
  grouping: IssueViewGrouping,
  sortMode: IssueViewSortMode,
  viewMode: IssueViewMode,
});
export type IssueViewConfig = typeof IssueViewConfig.Type;

/**
 * A named filter, grouping, sort, and layout, pinned to the sidebar. Views are environment-wide
 * like statuses and labels rather than per-project: a view is a question about the tracker, and
 * the project it asks about is one of the chips.
 */
export const IssueView = Schema.Struct({
  id: IssueViewId,
  name: TrimmedNonEmptyString,
  /** Ascending; ties are broken by `id` so an order is always total. */
  position: Schema.Number,
  config: IssueViewConfig,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type IssueView = typeof IssueView.Type;

/**
 * A checklist row. Distinct from a sub-issue, which is a real issue with its own status: a todo
 * has no key, no assignee, and no place in the list view.
 */
export const IssueTodo = Schema.Struct({
  id: IssueTodoId,
  issueId: IssueId,
  text: TrimmedNonEmptyString,
  done: Schema.Boolean,
  /** Ascending within the issue; ties are broken by `id`. */
  position: Schema.Number,
});
export type IssueTodo = typeof IssueTodo.Type;

/**
 * `blocks` is directed and `relates`/`duplicate` are symmetric, but all three store exactly one
 * row. "Blocked by" is that row read from the other end, which is why there is no such kind here:
 * materialising the inverse would mean two rows to keep agreeing with each other.
 */
export const IssueRelationKind = Schema.Literals(["blocks", "relates", "duplicate"]);
export type IssueRelationKind = typeof IssueRelationKind.Type;

/**
 * The canonical directed pair. `issueId` and `relatedIssueId` must differ — an issue cannot block
 * itself — and the server rejects a self-relation as `invalid`; the schema cannot express it
 * because a struct check has no way to name one field from another's error.
 */
export const IssueRelation = Schema.Struct({
  id: IssueRelationId,
  issueId: IssueId,
  relatedIssueId: IssueId,
  kind: IssueRelationKind,
});
export type IssueRelation = typeof IssueRelation.Type;

/** Which end of the stored row the issue being read sits on. `blocks` inbound reads as blocked-by. */
export const IssueRelationDirection = Schema.Literals(["outgoing", "incoming"]);
export type IssueRelationDirection = typeof IssueRelationDirection.Type;

export const IssueRelationEdge = Schema.Struct({
  relation: IssueRelation,
  direction: IssueRelationDirection,
});
export type IssueRelationEdge = typeof IssueRelationEdge.Type;

/** One issue's complete edge list. A relation write touches two issues, so results carry two. */
export const IssueRelationsForIssue = Schema.Struct({
  issueId: IssueId,
  relations: Schema.Array(IssueRelationEdge),
});
export type IssueRelationsForIssue = typeof IssueRelationsForIssue.Type;

export const IssueComment = Schema.Struct({
  id: IssueCommentId,
  issueId: IssueId,
  /** An agent comments the same way a person does, and the feed says which. */
  author: IssueActor,
  /** Markdown, written in the composer and rendered by `ChatMarkdown`. Untrimmed, as ever. */
  body: Schema.String,
  /** The existing chat attachment store, with an issue segment in the id namespace. */
  attachmentIds: Schema.Array(ChatAttachmentId),
  createdAt: IsoDateTime,
  /** Null until edited; an edit does not move `createdAt`, so the feed keeps its order. */
  editedAt: Schema.NullOr(IsoDateTime),
});
export type IssueComment = typeof IssueComment.Type;

export const IssueEventKind = Schema.Literals([
  "created",
  "field_changed",
  "deleted",
  "restored",
  "imported",
  /**
   * A triage item turned down. It is a soft delete underneath, but the feed has to tell "somebody
   * deleted this issue" apart from "this never was one" — the second is the normal outcome of
   * intake and should not read as destruction.
   */
  "triage_rejected",
]);
export type IssueEventKind = typeof IssueEventKind.Type;

/**
 * One row of the change log, written by every mutation. This is the activity feed, the audit
 * trail for agent writes, and the undo substrate at once.
 *
 * `before` and `after` hold display values rather than ids — a status name, a label list, a
 * priority — because the feed has to read back after the referenced row is gone.
 */
export const IssueEvent = Schema.Struct({
  id: IssueEventId,
  issueId: IssueId,
  actor: IssueActor,
  kind: IssueEventKind,
  /** Null for anything but `field_changed`. */
  field: Schema.NullOr(TrimmedNonEmptyString),
  before: Schema.NullOr(Schema.String),
  after: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
});
export type IssueEvent = typeof IssueEvent.Type;

/**
 * A one-shot, read-only investigation of the issue's repository. `queued` is the record written
 * before anything runs, `running` is the process in the project's directory, and both terminal
 * states are final — a run is never resumed, because the answer would be about a different tree.
 *
 * There is no `canceled`: cancelling stops the process and lands the run in `failed` with the
 * reason, so the panel has one place to look for why a run has no result.
 */
export const IssueEnrichmentRunState = Schema.Literals(["queued", "running", "done", "failed"]);
export type IssueEnrichmentRunState = typeof IssueEnrichmentRunState.Type;

/** One file the investigation thinks the work lands in, and why it thinks so. */
export const IssueEnrichmentLikelyFile = Schema.Struct({
  /** Repository-relative, as the model saw it. */
  path: TrimmedNonEmptyString,
  reason: Schema.String,
});
export type IssueEnrichmentLikelyFile = typeof IssueEnrichmentLikelyFile.Type;

/**
 * What a finished run hands back. Structured rather than prose so the client can render the run,
 * leave a durable investigation comment, apply safe automatic fields, and offer the remaining
 * suggestions as one-click writes.
 */
export const IssueEnrichmentResult = Schema.Struct({
  /** The problem restated, in the model's words. Markdown, so it is not trimmed. */
  summary: Schema.String.check(Schema.isMaxLength(ISSUE_ENRICHMENT_SUMMARY_MAX_CHARS)),
  likelyFiles: Schema.Array(IssueEnrichmentLikelyFile).check(
    Schema.isMaxLength(ISSUE_ENRICHMENT_MAX_LIKELY_FILES),
  ),
  /** Keys rather than ids: the model reads keys in the tree and never sees a row id. */
  relatedIssueKeys: Schema.Array(IssueKey).check(
    Schema.isMaxLength(ISSUE_ENRICHMENT_MAX_RELATED_ISSUES),
  ),
  /** Names, not ids. A suggested label may not exist yet, and creating one is the human's call. */
  suggestedLabels: Schema.Array(TrimmedNonEmptyString).check(
    Schema.isMaxLength(ISSUE_ENRICHMENT_MAX_SUGGESTED_LABELS),
  ),
  suggestedPriority: Schema.NullOr(IssuePriority),
  /**
   * A title for an issue that arrived without one — usually a Slack message ingested with no
   * user-entered text. The live issue and its title provenance decide whether this is automatic or
   * remains a confirmation action when the run finishes.
   */
  suggestedTitle: Schema.optionalKey(
    TrimmedNonEmptyString.check(Schema.isMaxLength(ISSUE_TITLE_MAX_CHARS)),
  ),
  /** A body for an issue that has none. Markdown, so it is not trimmed. Absent means leave it. */
  suggestedDescription: Schema.optionalKey(
    Schema.String.check(Schema.isMaxLength(ISSUE_DESCRIPTION_MAX_CHARS)),
  ),
});
export type IssueEnrichmentResult = typeof IssueEnrichmentResult.Type;

/**
 * One investigation, owned by its own table rather than by a thread. That is the whole point: a
 * run is not a conversation, has no turns, and must not appear in the threads view, so making it
 * a thread with a `hidden` flag would have been a lie every consumer had to remember.
 */
export const IssueEnrichmentRun = Schema.Struct({
  id: IssueEnrichmentRunId,
  issueId: IssueId,
  state: IssueEnrichmentRunState,
  /** Pinned at creation, so a later settings change does not relabel a finished run. */
  modelSelection: ModelSelection,
  /**
   * The process output so far, appended as it arrives and bounded by
   * {@link ISSUE_ENRICHMENT_TRANSCRIPT_MAX_CHARS}. Sent whole on every republish: the panel
   * renders a live log, and a chunk protocol would need the client to reassemble it in order.
   */
  transcript: Schema.String.check(Schema.isMaxLength(ISSUE_ENRICHMENT_TRANSCRIPT_MAX_CHARS)),
  /** Only ever set on `done`. */
  result: Schema.NullOr(IssueEnrichmentResult),
  /** Only ever set on `failed`: the refusal, the crash, or the cancellation. */
  error: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  /** Null while queued. `finishedAt - startedAt` is the duration the panel prints. */
  startedAt: Schema.NullOr(IsoDateTime),
  finishedAt: Schema.NullOr(IsoDateTime),
});
export type IssueEnrichmentRun = typeof IssueEnrichmentRun.Type;

/**
 * Where a link came from. `start-work` is the button on an agent-assigned issue; `manual` is a
 * thread somebody attached afterwards. Assignment records intent and this records the thread that
 * followed — neither one spawns anything.
 */
export const IssueThreadLinkOrigin = Schema.Literals(["start-work", "manual"]);
export type IssueThreadLinkOrigin = typeof IssueThreadLinkOrigin.Type;

/**
 * A thread working an issue. One row per pair, so linking the same thread twice is idempotent
 * rather than a second row saying the same thing.
 */
export const IssueThreadLink = Schema.Struct({
  issueId: IssueId,
  threadId: ThreadId,
  createdAt: IsoDateTime,
  origin: IssueThreadLinkOrigin,
});
export type IssueThreadLink = typeof IssueThreadLink.Type;

/**
 * A reaction name as Slack spells it — `ticket`, `white_check_mark`, `+1`, `-1` — with no colons.
 * The poller compares this against `reaction.name` verbatim, so a decorated or capitalised value
 * would never match anything.
 */
export const SlackEmojiName = TrimmedNonEmptyString.check(Schema.isPattern(/^[a-z0-9_+-]+$/));
export type SlackEmojiName = typeof SlackEmojiName.Type;

/**
 * One deliberate reaction and the behavior it overrides for that reaction.
 *
 * Null project and investigation values inherit the watched channel's defaults. The list is
 * ordered because a Slack message may carry several configured reactions; the first match wins.
 */
export const SlackReactionRoute = Schema.Struct({
  emoji: SlackEmojiName,
  projectId: Schema.NullOr(ProjectId),
  autoInvestigate: Schema.NullOr(Schema.Boolean),
});
export type SlackReactionRoute = typeof SlackReactionRoute.Type;

const uniqueSlackReactionRoutes = Schema.makeFilter(
  (routes: ReadonlyArray<SlackReactionRoute>) =>
    new Set(routes.map((route) => route.emoji)).size === routes.length ||
    "Slack reaction routes must use different reactions.",
);

/**
 * What turns a message in a watched channel into a triage item. Any combination: a channel can
 * file on reactions *and* on a mention. All triggers off is a paused watch rather than an invalid
 * one — pausing a channel and forgetting how it was configured are different things.
 */
export const SlackIntakeTrigger = Schema.Struct({
  /** Ordered, unique reactions. A matching route wins over either channel-wide trigger below. */
  reactionRoutes: Schema.Array(SlackReactionRoute)
    .check(Schema.isMaxLength(SLACK_MAX_REACTION_ROUTES))
    .check(uniqueSlackReactionRoutes),
  /** Every message in the channel becomes an issue. For a dedicated intake channel. */
  everyMessage: Schema.Boolean,
  botMention: Schema.Boolean,
});
export type SlackIntakeTrigger = typeof SlackIntakeTrigger.Type;

/** Whether a watch can file anything at all. All triggers off is a paused channel. */
export const isSlackIntakeTriggerActive = (trigger: SlackIntakeTrigger): boolean =>
  trigger.reactionRoutes.length > 0 || trigger.everyMessage || trigger.botMention;

/**
 * One watched channel. `projectId` is the auto-tag target rather than a filter: an issue filed
 * from this channel lands on that project, and null means it lands with none — which is also what
 * makes enrichment skip it, since there is no directory to read.
 */
export const SlackChannelWatch = Schema.Struct({
  id: SlackChannelWatchId,
  channelId: SlackChannelId,
  /**
   * Cached from the channel picker so the settings page reads without a Slack call. It can go
   * stale after a rename; the id is what everything else is keyed on.
   */
  channelName: TrimmedNonEmptyString,
  /** Fallback route for channel-wide triggers and reaction routes that inherit their project. */
  projectId: Schema.NullOr(ProjectId),
  /** Release cycle assigned to every issue filed from this channel. */
  cycleId: Schema.optionalKey(Schema.NullOr(IssueCycleId)),
  /** Fallback investigation policy. A matching reaction route may override it. */
  autoInvestigate: Schema.Boolean,
  /** Whether matching messages should be assigned by the global model-routing rules. */
  autoAssign: Schema.optionalKey(Schema.Boolean),
  trigger: SlackIntakeTrigger,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type SlackChannelWatch = typeof SlackChannelWatch.Type;

/**
 * Whether intake is working, and what it last said. Runtime state, not a stored row: `configured`
 * is whether a token is on disk, and the rest is what the poller has managed since this server
 * woke up. A server that has been asleep for a week reports no poll and no error, which is the
 * truth.
 */
export const SlackIntakeStatus = Schema.Struct({
  /** A token is present in the secrets directory. Never the token itself. */
  configured: Schema.Boolean,
  lastPollAt: Schema.NullOr(IsoDateTime),
  /** The last thing that went wrong, cleared by the next poll that does not. */
  lastError: Schema.NullOr(Schema.String),
  /** Read back from Slack when the token was accepted, so the page can say which workspace. */
  workspaceName: Schema.NullOr(TrimmedNonEmptyString),
});
export type SlackIntakeStatus = typeof SlackIntakeStatus.Type;

/** One channel the bot can see, as the picker lists it. Asked of Slack, never stored. */
export const SlackChannelRef = Schema.Struct({
  id: SlackChannelId,
  name: TrimmedNonEmptyString,
});
export type SlackChannelRef = typeof SlackChannelRef.Type;

export const IssueTrackerConfig = Schema.Struct({
  keyPrefix: IssueKeyPrefix,
  /** The number the next issue takes. Never reused, so a deleted key is never handed out twice. */
  nextNumber: PositiveInt,
});
export type IssueTrackerConfig = typeof IssueTrackerConfig.Type;

/**
 * Diffs, not snapshots. The initial state arrives once through `issues.getSnapshot`; this stream
 * only says what changed afterwards, which is what keeps a tracker of a few thousand rows from
 * resending itself on every edit.
 */
export const IssuesStreamEvent = Schema.Union([
  Schema.TaggedStruct("IssueUpserted", { issue: Issue }),
  /**
   * The row is gone for good. A *soft* delete is an `IssueUpserted` carrying `deletedAt`, not
   * this: the depth cap counts soft-deleted rows as ancestors (they still hold a `parentId`), so a
   * client that dropped them would offer parents the server refuses. Nothing emits this yet — it
   * is here for the hard purge that will one day empty the tracker's bin.
   */
  Schema.TaggedStruct("IssueDeleted", { issueId: IssueId }),
  Schema.TaggedStruct("StatusesChanged", { statuses: Schema.Array(IssueStatus) }),
  Schema.TaggedStruct("LabelsChanged", { labels: Schema.Array(IssueLabel) }),
  /**
   * The whole set across every project, like statuses and labels. There are tens of these, not
   * thousands, and a per-project diff would need the client to know which projects it has loaded.
   */
  Schema.TaggedStruct("MilestonesChanged", { milestones: Schema.Array(IssueMilestone) }),
  /** The whole set, and the carrier for a lazy finalisation the client did not ask for. */
  Schema.TaggedStruct("CyclesChanged", { cycles: Schema.Array(IssueCycle) }),
  /** The whole set, like statuses: there are a handful of views and a reorder rewrites them all. */
  Schema.TaggedStruct("ViewsChanged", { views: Schema.Array(IssueView) }),
  /** Per-issue rather than global: these are loaded on demand, so a diff is scoped to one issue. */
  Schema.TaggedStruct("IssueTodosChanged", { issueId: IssueId, todos: Schema.Array(IssueTodo) }),
  /** One per affected end of the pair, each carrying that issue's complete edge list. */
  Schema.TaggedStruct("IssueRelationsChanged", {
    issueId: IssueId,
    relations: Schema.Array(IssueRelationEdge),
  }),
  /** A single comment, because a busy issue's thread is the one per-issue set worth diffing. */
  Schema.TaggedStruct("IssueCommentUpserted", { comment: IssueComment }),
  Schema.TaggedStruct("IssueCommentDeleted", { issueId: IssueId, commentId: IssueCommentId }),
  /**
   * The whole run on every state transition and on every batch of transcript. Transcript growth
   * is republished at most every {@link ISSUE_ENRICHMENT_TRANSCRIPT_PUBLISH_INTERVAL_MS}
   * milliseconds — a model outruns a panel, and each of these carries the full log.
   */
  Schema.TaggedStruct("EnrichmentRunChanged", { run: IssueEnrichmentRun }),
  /** Per-issue, and the whole set: an issue has a handful of threads, never a feed of them. */
  Schema.TaggedStruct("IssueThreadLinksChanged", {
    issueId: IssueId,
    links: Schema.Array(IssueThreadLink),
  }),
  Schema.TaggedStruct("ConfigChanged", { config: IssueTrackerConfig }),
  /** The whole set, like statuses: there are a handful of channels and a write rewrites one. */
  Schema.TaggedStruct("SlackWatchesChanged", { watches: Schema.Array(SlackChannelWatch) }),
  /**
   * Intake's health, republished whenever it moves: a token accepted or cleared, a poll that
   * landed, a poll that failed. Four small fields, so there is nothing here worth diffing.
   */
  Schema.TaggedStruct("SlackStatusChanged", { status: SlackIntakeStatus }),
]);
export type IssuesStreamEvent = typeof IssuesStreamEvent.Type;

/**
 * Everything the list view needs and nothing it does not. Todos, relations, and comments are
 * per-issue tails read through `issues.getDetail` when a detail sheet opens: they are the three
 * sets that grow with usage rather than with configuration, and putting them here would make the
 * first read of the tracker proportional to its history.
 */
export const IssuesSnapshot = Schema.Struct({
  /** Includes soft-deleted rows so the client can restore one without a second read. */
  issues: Schema.Array(Issue),
  statuses: Schema.Array(IssueStatus),
  labels: Schema.Array(IssueLabel),
  milestones: Schema.Array(IssueMilestone),
  cycles: Schema.Array(IssueCycle),
  views: Schema.Array(IssueView),
  /**
   * Configuration like statuses and labels, not a tail: the triage queue is read on the first
   * paint, and knowing which channel an item came from is part of reading it.
   */
  slackWatches: Schema.Array(SlackChannelWatch),
  slackStatus: SlackIntakeStatus,
  config: IssueTrackerConfig,
});
export type IssuesSnapshot = typeof IssuesSnapshot.Type;

/** The tail of one issue, read when its detail sheet opens and kept live by the stream after. */
export const IssueDetail = Schema.Struct({
  todos: Schema.Array(IssueTodo),
  /** Both ends: `blocks` inbound is what the sheet renders as "blocked by". */
  relations: Schema.Array(IssueRelationEdge),
  comments: Schema.Array(IssueComment),
});
export type IssueDetail = typeof IssueDetail.Type;

const IssueTitleInput = TrimmedNonEmptyString.check(Schema.isMaxLength(ISSUE_TITLE_MAX_CHARS));
const IssueDescriptionInput = Schema.String.check(
  Schema.isMaxLength(ISSUE_DESCRIPTION_MAX_CHARS),
).annotate({ description: "Markdown body; whitespace is significant so it is not trimmed." });
const IssueLabelIdsInput = Schema.Array(IssueLabelId).check(
  Schema.isMaxLength(ISSUE_LABELS_MAX_PER_ISSUE),
);

export const IssueCreateInput = Schema.Struct({
  title: IssueTitleInput,
  description: Schema.optional(IssueDescriptionInput),
  /** Absent takes the first status by position, except on a triage item, which has none yet. */
  statusId: Schema.optional(IssueStatusId),
  priority: Schema.optional(IssuePriority),
  assignee: Schema.optional(IssueAssignee),
  projectId: Schema.optional(ProjectId),
  milestoneId: Schema.optional(IssueMilestoneId),
  cycleId: Schema.optional(IssueCycleId),
  parentId: Schema.optional(IssueId),
  labelIds: Schema.optional(IssueLabelIdsInput),
  dueDate: Schema.optional(IssueDate),
  triage: Schema.optional(Schema.Boolean),
});
export type IssueCreateInput = typeof IssueCreateInput.Type;

/**
 * An absent key leaves the field alone; an explicit `null` clears it. That distinction is the
 * whole reason the nullable fields are `optional(NullOr(...))` rather than one or the other —
 * "unassign" and "do not touch the assignee" are different requests.
 */
export const IssuePatch = Schema.Struct({
  title: Schema.optional(IssueTitleInput),
  description: Schema.optional(IssueDescriptionInput),
  statusId: Schema.optional(IssueStatusId),
  priority: Schema.optional(IssuePriority),
  assignee: Schema.optional(Schema.NullOr(IssueAssignee)),
  workModelSelection: Schema.optional(Schema.NullOr(ModelSelection)),
  automationAssignment: Schema.optional(Schema.NullOr(IssueAutomationAssignment)),
  projectId: Schema.optional(Schema.NullOr(ProjectId)),
  /** Cleared by the server when the issue leaves the project the milestone belongs to. */
  milestoneId: Schema.optional(Schema.NullOr(IssueMilestoneId)),
  cycleId: Schema.optional(Schema.NullOr(IssueCycleId)),
  parentId: Schema.optional(Schema.NullOr(IssueId)),
  labelIds: Schema.optional(IssueLabelIdsInput),
  dueDate: Schema.optional(Schema.NullOr(IssueDate)),
  triage: Schema.optional(Schema.Boolean),
});
export type IssuePatch = typeof IssuePatch.Type;

export const IssueUpdateInput = Schema.Struct({
  issueId: IssueId,
  patch: IssuePatch,
});
export type IssueUpdateInput = typeof IssueUpdateInput.Type;

export const IssueBulkUpdateInput = Schema.Struct({
  issueIds: Schema.Array(IssueId).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(ISSUE_BULK_UPDATE_MAX_ISSUES),
  ),
  patch: IssuePatch,
});
export type IssueBulkUpdateInput = typeof IssueBulkUpdateInput.Type;

export const IssueRefInput = Schema.Struct({ issueId: IssueId });
export type IssueRefInput = typeof IssueRefInput.Type;

export const IssueSetSortOrderInput = Schema.Struct({
  issueId: IssueId,
  sortOrder: TrimmedNonEmptyString,
  /**
   * Set alongside the order in one write, so a drag across kanban columns is a single change
   * rather than a status change the list briefly renders in the wrong place.
   */
  statusId: Schema.optional(IssueStatusId),
});
export type IssueSetSortOrderInput = typeof IssueSetSortOrderInput.Type;

/** One issue after a write. Every single-issue mutation answers with the row it produced. */
export const IssueResult = Schema.Struct({ issue: Issue });
export type IssueResult = typeof IssueResult.Type;

export const IssuesResult = Schema.Struct({ issues: Schema.Array(Issue) });
export type IssuesResult = typeof IssuesResult.Type;

export const IssueStatusCreateInput = Schema.Struct({
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(ISSUE_TITLE_MAX_CHARS)),
  color: IssueColor,
  category: IssueStatusCategory,
  /** Absent appends after the last status in the same category. */
  position: Schema.optional(Schema.Number),
});
export type IssueStatusCreateInput = typeof IssueStatusCreateInput.Type;

export const IssueStatusPatch = Schema.Struct({
  name: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(ISSUE_TITLE_MAX_CHARS))),
  color: Schema.optional(IssueColor),
  category: Schema.optional(IssueStatusCategory),
  position: Schema.optional(Schema.Number),
});
export type IssueStatusPatch = typeof IssueStatusPatch.Type;

export const IssueStatusUpdateInput = Schema.Struct({
  statusId: IssueStatusId,
  patch: IssueStatusPatch,
});
export type IssueStatusUpdateInput = typeof IssueStatusUpdateInput.Type;

/**
 * Deleting a status has to say where its issues go. There is no unset status outside triage, and
 * silently dropping rows into the first remaining column is a worse answer than asking.
 */
export const IssueStatusDeleteInput = Schema.Struct({
  statusId: IssueStatusId,
  reassignToStatusId: IssueStatusId,
});
export type IssueStatusDeleteInput = typeof IssueStatusDeleteInput.Type;

/** The complete order, not a move: positions are rewritten from this list. */
export const IssueStatusesReorderInput = Schema.Struct({
  statusIds: Schema.Array(IssueStatusId).check(Schema.isMinLength(1)),
});
export type IssueStatusesReorderInput = typeof IssueStatusesReorderInput.Type;

/**
 * The whole set after the write, because every status mutation can move the others: a reorder
 * rewrites positions, and a delete reassigns issues.
 */
export const IssueStatusesResult = Schema.Struct({ statuses: Schema.Array(IssueStatus) });
export type IssueStatusesResult = typeof IssueStatusesResult.Type;

export const IssueStatusResult = Schema.Struct({
  status: IssueStatus,
  statuses: Schema.Array(IssueStatus),
});
export type IssueStatusResult = typeof IssueStatusResult.Type;

export const IssueLabelCreateInput = Schema.Struct({
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(ISSUE_TITLE_MAX_CHARS)),
  color: IssueColor,
});
export type IssueLabelCreateInput = typeof IssueLabelCreateInput.Type;

export const IssueLabelPatch = Schema.Struct({
  name: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(ISSUE_TITLE_MAX_CHARS))),
  color: Schema.optional(IssueColor),
});
export type IssueLabelPatch = typeof IssueLabelPatch.Type;

export const IssueLabelUpdateInput = Schema.Struct({
  labelId: IssueLabelId,
  patch: IssueLabelPatch,
});
export type IssueLabelUpdateInput = typeof IssueLabelUpdateInput.Type;

export const IssueLabelDeleteInput = Schema.Struct({ labelId: IssueLabelId });
export type IssueLabelDeleteInput = typeof IssueLabelDeleteInput.Type;

export const IssueLabelsResult = Schema.Struct({ labels: Schema.Array(IssueLabel) });
export type IssueLabelsResult = typeof IssueLabelsResult.Type;

export const IssueLabelResult = Schema.Struct({
  label: IssueLabel,
  labels: Schema.Array(IssueLabel),
});
export type IssueLabelResult = typeof IssueLabelResult.Type;

const IssueNameInput = TrimmedNonEmptyString.check(Schema.isMaxLength(ISSUE_TITLE_MAX_CHARS));

export const IssueMilestoneCreateInput = Schema.Struct({
  projectId: ProjectId,
  name: IssueNameInput,
  description: Schema.optional(IssueDescriptionInput),
  startDate: Schema.optional(IssueDate),
  targetDate: Schema.optional(IssueDate),
  /** Absent appends after the last milestone in the same project. */
  position: Schema.optional(Schema.Number),
});
export type IssueMilestoneCreateInput = typeof IssueMilestoneCreateInput.Type;

export const IssueMilestonePatch = Schema.Struct({
  name: Schema.optional(IssueNameInput),
  description: Schema.optional(Schema.NullOr(IssueDescriptionInput)),
  startDate: Schema.optional(Schema.NullOr(IssueDate)),
  targetDate: Schema.optional(Schema.NullOr(IssueDate)),
  position: Schema.optional(Schema.Number),
  /**
   * Moving a milestone between projects is a move of its issues' planning context too, so the
   * server clears `milestoneId` on any issue left behind in the old project.
   */
  projectId: Schema.optional(ProjectId),
});
export type IssueMilestonePatch = typeof IssueMilestonePatch.Type;

export const IssueMilestoneUpdateInput = Schema.Struct({
  milestoneId: IssueMilestoneId,
  patch: IssueMilestonePatch,
});
export type IssueMilestoneUpdateInput = typeof IssueMilestoneUpdateInput.Type;

/**
 * Unlike a status, a milestone has an empty value — no milestone — so a delete does not have to
 * ask where its issues go. They land unassigned and stay in the project.
 */
export const IssueMilestoneDeleteInput = Schema.Struct({ milestoneId: IssueMilestoneId });
export type IssueMilestoneDeleteInput = typeof IssueMilestoneDeleteInput.Type;

/** The complete order within one project, not a move: positions are rewritten from this list. */
export const IssueMilestonesReorderInput = Schema.Struct({
  projectId: ProjectId,
  milestoneIds: Schema.Array(IssueMilestoneId).check(Schema.isMinLength(1)),
});
export type IssueMilestonesReorderInput = typeof IssueMilestonesReorderInput.Type;

/** The whole set across every project, matching the stream event and the snapshot field. */
export const IssueMilestonesResult = Schema.Struct({
  milestones: Schema.Array(IssueMilestone),
});
export type IssueMilestonesResult = typeof IssueMilestonesResult.Type;

export const IssueMilestoneResult = Schema.Struct({
  milestone: IssueMilestone,
  milestones: Schema.Array(IssueMilestone),
});
export type IssueMilestoneResult = typeof IssueMilestoneResult.Type;

export const IssueMilestoneHistoryInput = Schema.Struct({ milestoneId: IssueMilestoneId });
export type IssueMilestoneHistoryInput = typeof IssueMilestoneHistoryInput.Type;

/**
 * The milestone as it stood at the end of one calendar day. `started` includes everything already
 * completed, so the three numbers stack: `completed <= started <= scope`.
 */
export const IssueMilestoneHistoryPoint = Schema.Struct({
  date: IssueDate,
  /** Issues assigned to the milestone that day — the burn-up's moving ceiling. */
  scope: NonNegativeInt,
  started: NonNegativeInt,
  completed: NonNegativeInt,
});
export type IssueMilestoneHistoryPoint = typeof IssueMilestoneHistoryPoint.Type;

export const IssueMilestoneHistoryResult = Schema.Struct({
  /** Ascending by date, one per day. Empty when the milestone has no members and no start date. */
  points: Schema.Array(IssueMilestoneHistoryPoint),
  /**
   * True when the reconstruction met a name the change log records but nothing live carries — a
   * status renamed or deleted since, or the milestone itself renamed — so the counts are a best
   * guess. The chart says so rather than presenting a number it cannot stand behind.
   */
  approximate: Schema.Boolean,
});
export type IssueMilestoneHistoryResult = typeof IssueMilestoneHistoryResult.Type;

export const IssueCycleCreateInput = Schema.Struct({
  name: IssueNameInput,
  startDate: IssueDate,
  endDate: IssueDate,
});
export type IssueCycleCreateInput = typeof IssueCycleCreateInput.Type;

/**
 * No `completedAt`: finalisation is the server's, run lazily when an ended cycle is next read.
 * A client that could set it would freeze a completed set nobody had carried over yet.
 */
export const IssueCyclePatch = Schema.Struct({
  name: Schema.optional(IssueNameInput),
  startDate: Schema.optional(IssueDate),
  endDate: Schema.optional(IssueDate),
});
export type IssueCyclePatch = typeof IssueCyclePatch.Type;

export const IssueCycleUpdateInput = Schema.Struct({
  cycleId: IssueCycleId,
  patch: IssueCyclePatch,
});
export type IssueCycleUpdateInput = typeof IssueCycleUpdateInput.Type;

export const IssueCycleDeleteInput = Schema.Struct({ cycleId: IssueCycleId });
export type IssueCycleDeleteInput = typeof IssueCycleDeleteInput.Type;

export const IssueCyclesResult = Schema.Struct({ cycles: Schema.Array(IssueCycle) });
export type IssueCyclesResult = typeof IssueCyclesResult.Type;

export const IssueCycleResult = Schema.Struct({
  cycle: IssueCycle,
  cycles: Schema.Array(IssueCycle),
});
export type IssueCycleResult = typeof IssueCycleResult.Type;

export const IssueViewCreateInput = Schema.Struct({
  name: IssueNameInput,
  config: IssueViewConfig,
  /** Absent appends after the last view. */
  position: Schema.optional(Schema.Number),
});
export type IssueViewCreateInput = typeof IssueViewCreateInput.Type;

/**
 * `config` is replaced wholesale rather than merged. A chip bar is edited as a unit and every
 * filter on it is optional, so a partial patch could never say "remove the label chip".
 */
export const IssueViewPatch = Schema.Struct({
  name: Schema.optional(IssueNameInput),
  config: Schema.optional(IssueViewConfig),
  position: Schema.optional(Schema.Number),
});
export type IssueViewPatch = typeof IssueViewPatch.Type;

export const IssueViewUpdateInput = Schema.Struct({
  viewId: IssueViewId,
  patch: IssueViewPatch,
});
export type IssueViewUpdateInput = typeof IssueViewUpdateInput.Type;

export const IssueViewDeleteInput = Schema.Struct({ viewId: IssueViewId });
export type IssueViewDeleteInput = typeof IssueViewDeleteInput.Type;

/** The complete order, not a move: positions are rewritten from this list, as statuses are. */
export const IssueViewsReorderInput = Schema.Struct({
  viewIds: Schema.Array(IssueViewId).check(Schema.isMinLength(1)),
});
export type IssueViewsReorderInput = typeof IssueViewsReorderInput.Type;

/** The whole set after the write, matching the stream event and the snapshot field. */
export const IssueViewsResult = Schema.Struct({ views: Schema.Array(IssueView) });
export type IssueViewsResult = typeof IssueViewsResult.Type;

export const IssueViewResult = Schema.Struct({
  view: IssueView,
  views: Schema.Array(IssueView),
});
export type IssueViewResult = typeof IssueViewResult.Type;

const IssueTodoTextInput = TrimmedNonEmptyString.check(Schema.isMaxLength(ISSUE_TITLE_MAX_CHARS));

export const IssueTodoCreateInput = Schema.Struct({
  issueId: IssueId,
  text: IssueTodoTextInput,
  /** Absent appends after the last todo on the issue. */
  position: Schema.optional(Schema.Number),
});
export type IssueTodoCreateInput = typeof IssueTodoCreateInput.Type;

export const IssueTodoPatch = Schema.Struct({
  text: Schema.optional(IssueTodoTextInput),
  done: Schema.optional(Schema.Boolean),
});
export type IssueTodoPatch = typeof IssueTodoPatch.Type;

export const IssueTodoUpdateInput = Schema.Struct({
  todoId: IssueTodoId,
  patch: IssueTodoPatch,
});
export type IssueTodoUpdateInput = typeof IssueTodoUpdateInput.Type;

export const IssueTodoDeleteInput = Schema.Struct({ todoId: IssueTodoId });
export type IssueTodoDeleteInput = typeof IssueTodoDeleteInput.Type;

/** The complete order for one issue; the issue is named because a reorder can empty no list. */
export const IssueTodosReorderInput = Schema.Struct({
  issueId: IssueId,
  todoIds: Schema.Array(IssueTodoId).check(Schema.isMinLength(1)),
});
export type IssueTodosReorderInput = typeof IssueTodosReorderInput.Type;

/**
 * The issue's whole checklist after the write. Todos are a handful of rows and every mutation
 * renumbers positions, so answering with the list is cheaper than reasoning about the delta.
 */
export const IssueTodosResult = Schema.Struct({
  issueId: IssueId,
  todos: Schema.Array(IssueTodo),
});
export type IssueTodosResult = typeof IssueTodosResult.Type;

/**
 * The server rejects `issueId === relatedIssueId` and a duplicate pair as `invalid`: nothing
 * blocks itself, and a second identical row would render as two rows of the same sentence.
 */
export const IssueRelationCreateInput = Schema.Struct({
  issueId: IssueId,
  relatedIssueId: IssueId,
  kind: IssueRelationKind,
});
export type IssueRelationCreateInput = typeof IssueRelationCreateInput.Type;

export const IssueRelationDeleteInput = Schema.Struct({ relationId: IssueRelationId });
export type IssueRelationDeleteInput = typeof IssueRelationDeleteInput.Type;

/**
 * Both ends of the pair, each with its complete edge list. A delete names only the row, so the
 * caller cannot know in advance which of the two issues it is looking at.
 */
export const IssueRelationsResult = Schema.Struct({
  affected: Schema.Array(IssueRelationsForIssue),
});
export type IssueRelationsResult = typeof IssueRelationsResult.Type;

const IssueCommentBodyInput = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(ISSUE_COMMENT_MAX_CHARS),
).annotate({ description: "Markdown body; whitespace is significant so it is not trimmed." });
const IssueCommentAttachmentIdsInput = Schema.Array(ChatAttachmentId).check(
  Schema.isMaxLength(ISSUE_COMMENT_MAX_ATTACHMENTS),
);

export const IssueCommentCreateInput = Schema.Struct({
  issueId: IssueId,
  body: IssueCommentBodyInput,
  attachmentIds: Schema.optional(IssueCommentAttachmentIdsInput),
});
export type IssueCommentCreateInput = typeof IssueCommentCreateInput.Type;

export const IssueCommentPatch = Schema.Struct({
  body: Schema.optional(IssueCommentBodyInput),
  attachmentIds: Schema.optional(IssueCommentAttachmentIdsInput),
});
export type IssueCommentPatch = typeof IssueCommentPatch.Type;

/** The server refuses an edit by anyone but the author, so there is no author field to send. */
export const IssueCommentUpdateInput = Schema.Struct({
  commentId: IssueCommentId,
  patch: IssueCommentPatch,
});
export type IssueCommentUpdateInput = typeof IssueCommentUpdateInput.Type;

export const IssueCommentDeleteInput = Schema.Struct({ commentId: IssueCommentId });
export type IssueCommentDeleteInput = typeof IssueCommentDeleteInput.Type;

/** One comment after a write, matching the stream event a watching client will also see. */
export const IssueCommentResult = Schema.Struct({ comment: IssueComment });
export type IssueCommentResult = typeof IssueCommentResult.Type;

export const IssueCommentsResult = Schema.Struct({
  issueId: IssueId,
  comments: Schema.Array(IssueComment),
});
export type IssueCommentsResult = typeof IssueCommentsResult.Type;

/**
 * One image, sent the way a turn's attachment is: a base64 data URL the server decodes, checks,
 * and writes into the issue's namespace in the attachment store. The id it answers with is the
 * only thing a comment ever holds — the bytes are served by the assets route, not by this socket.
 *
 * Images only, matching the decision record: `mimeType` must start with `image/`, and the decoded
 * payload must be non-empty and no larger than {@link ISSUE_COMMENT_ATTACHMENT_MAX_BYTES}.
 */
export const IssueCommentAttachmentUploadInput = Schema.Struct({
  /** The owner. Its id is baked into the attachment id, and a comment cannot use another's. */
  issueId: IssueId,
  dataUrl: Schema.String.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(ISSUE_COMMENT_ATTACHMENT_MAX_DATA_URL_CHARS),
  ),
});
export type IssueCommentAttachmentUploadInput = typeof IssueCommentAttachmentUploadInput.Type;

export const IssueCommentAttachmentUploadResult = Schema.Struct({
  attachmentId: ChatAttachmentId,
});
export type IssueCommentAttachmentUploadResult = typeof IssueCommentAttachmentUploadResult.Type;

/**
 * Renaming the prefix moves the keys issued from now on. Keys already handed out keep the prefix
 * they were minted with: they are what the change log, a commit message, and a Slack thread all
 * refer to, and rewriting them would break every one of those references.
 */
export const IssueKeyPrefixInput = Schema.Struct({ keyPrefix: IssueKeyPrefix });
export type IssueKeyPrefixInput = typeof IssueKeyPrefixInput.Type;

export const IssueTrackerConfigResult = Schema.Struct({ config: IssueTrackerConfig });
export type IssueTrackerConfigResult = typeof IssueTrackerConfigResult.Type;

export const IssuesImportCsvInput = Schema.Struct({
  csvText: Schema.String.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(ISSUES_IMPORT_CSV_MAX_CHARS),
  ),
});
export type IssuesImportCsvInput = typeof IssuesImportCsvInput.Type;

/** One row the import refused, named by its line in the file so it can be found and fixed. */
export const IssuesImportCsvSkip = Schema.Struct({
  line: PositiveInt,
  reason: TrimmedNonEmptyString,
});
export type IssuesImportCsvSkip = typeof IssuesImportCsvSkip.Type;

/**
 * A partial import is the normal outcome: a bad row is skipped and reported rather than taking
 * the other two hundred down with it.
 */
export const IssuesImportCsvResult = Schema.Struct({
  created: NonNegativeInt,
  skipped: Schema.Array(IssuesImportCsvSkip),
});
export type IssuesImportCsvResult = typeof IssuesImportCsvResult.Type;

export const IssuesGetEventsResult = Schema.Struct({ events: Schema.Array(IssueEvent) });
export type IssuesGetEventsResult = typeof IssuesGetEventsResult.Type;

/**
 * Fire the investigation by hand. Refused as `invalid` when a run for this issue is already
 * queued or running, and when the issue's project is rootless or absent: enrichment is a
 * read-only process in a directory, and there is no directory to run it in.
 */
export const IssueEnrichmentStartInput = Schema.Struct({ issueId: IssueId });
export type IssueEnrichmentStartInput = typeof IssueEnrichmentStartInput.Type;

export const IssueEnrichmentRunRefInput = Schema.Struct({ runId: IssueEnrichmentRunId });
export type IssueEnrichmentRunRefInput = typeof IssueEnrichmentRunRefInput.Type;

/** One run after a write. The stream carries the same row to everybody else watching. */
export const IssueEnrichmentRunResult = Schema.Struct({ run: IssueEnrichmentRun });
export type IssueEnrichmentRunResult = typeof IssueEnrichmentRunResult.Type;

/** Newest first: the panel opens on the latest run, and older ones are history below it. */
export const IssueEnrichmentRunsResult = Schema.Struct({
  issueId: IssueId,
  runs: Schema.Array(IssueEnrichmentRun),
});
export type IssueEnrichmentRunsResult = typeof IssueEnrichmentRunsResult.Type;

/** Linking the same thread twice restates the origin rather than adding a row. */
export const IssueThreadLinkInput = Schema.Struct({
  issueId: IssueId,
  threadId: ThreadId,
  origin: IssueThreadLinkOrigin,
});
export type IssueThreadLinkInput = typeof IssueThreadLinkInput.Type;

export const IssueThreadUnlinkInput = Schema.Struct({ issueId: IssueId, threadId: ThreadId });
export type IssueThreadUnlinkInput = typeof IssueThreadUnlinkInput.Type;

/** The issue's whole thread list after the write, matching the stream event beside it. */
export const IssueThreadLinksResult = Schema.Struct({
  issueId: IssueId,
  links: Schema.Array(IssueThreadLink),
});
export type IssueThreadLinksResult = typeof IssueThreadLinksResult.Type;

/**
 * The bot token, on its way in and never on its way out.
 *
 * An empty string clears it, which is why this is `Schema.String` and not a trimmed non-empty one:
 * "disconnect Slack" and "set the token" are the same write, and a client that had to call a
 * second method to disconnect would eventually forget to.
 */
export const SlackSetTokenInput = Schema.Struct({
  token: Schema.String.check(Schema.isMaxLength(SLACK_BOT_TOKEN_MAX_CHARS)),
});
export type SlackSetTokenInput = typeof SlackSetTokenInput.Type;

/** Intake's health after a write, matching the stream event a watching client also sees. */
export const SlackIntakeStatusResult = Schema.Struct({ status: SlackIntakeStatus });
export type SlackIntakeStatusResult = typeof SlackIntakeStatusResult.Type;

/** What the bot can see right now. Answered by Slack, so it is a read that can fail. */
export const SlackChannelsResult = Schema.Struct({
  channels: Schema.Array(SlackChannelRef),
});
export type SlackChannelsResult = typeof SlackChannelsResult.Type;

/**
 * Watching a channel already watched is refused as `conflict` rather than silently rewriting the
 * existing row: two watches on one channel would poll it twice and file everything twice.
 */
export const SlackWatchCreateInput = Schema.Struct({
  channelId: SlackChannelId,
  channelName: TrimmedNonEmptyString,
  projectId: Schema.optional(Schema.NullOr(ProjectId)),
  cycleId: Schema.optional(Schema.NullOr(IssueCycleId)),
  /** Whether matching messages investigate immediately. Defaults off for a new watch. */
  autoInvestigate: Schema.optional(Schema.Boolean),
  autoAssign: Schema.optional(Schema.Boolean),
  /** Absent starts the channel paused: configured, watched, and filing nothing yet. */
  trigger: Schema.optional(SlackIntakeTrigger),
});
export type SlackWatchCreateInput = typeof SlackWatchCreateInput.Type;

/**
 * `trigger` is replaced wholesale rather than merged, for the same reason a saved view's config
 * is: it is edited as one ordered rule set, and a partial patch could not safely delete a route.
 */
export const SlackWatchPatch = Schema.Struct({
  channelName: Schema.optional(TrimmedNonEmptyString),
  projectId: Schema.optional(Schema.NullOr(ProjectId)),
  cycleId: Schema.optional(Schema.NullOr(IssueCycleId)),
  autoInvestigate: Schema.optional(Schema.Boolean),
  autoAssign: Schema.optional(Schema.Boolean),
  trigger: Schema.optional(SlackIntakeTrigger),
});
export type SlackWatchPatch = typeof SlackWatchPatch.Type;

export const SlackWatchUpdateInput = Schema.Struct({
  watchId: SlackChannelWatchId,
  patch: SlackWatchPatch,
});
export type SlackWatchUpdateInput = typeof SlackWatchUpdateInput.Type;

export const SlackWatchDeleteInput = Schema.Struct({ watchId: SlackChannelWatchId });
export type SlackWatchDeleteInput = typeof SlackWatchDeleteInput.Type;

/** The whole set after the write, matching the stream event and the snapshot field. */
export const SlackWatchesResult = Schema.Struct({
  watches: Schema.Array(SlackChannelWatch),
});
export type SlackWatchesResult = typeof SlackWatchesResult.Type;

export const SlackWatchResult = Schema.Struct({
  watch: SlackChannelWatch,
  watches: Schema.Array(SlackChannelWatch),
});
export type SlackWatchResult = typeof SlackWatchResult.Type;

/**
 * Accept a triage item: status, project, priority, and assignment in one write.
 *
 * One action rather than three, because a triage item has no status at all — applying them one at
 * a time would put the issue on a board halfway through being triaged, which is exactly the state
 * triage exists to keep out of the board.
 */
export const IssueTriageAcceptInput = Schema.Struct({
  issueId: IssueId,
  /** Required: leaving triage means landing in the workflow, and the workflow is statuses. */
  statusId: IssueStatusId,
  /** Absent keeps whatever the channel auto-tagged; an explicit null files it under no project. */
  projectId: Schema.optional(Schema.NullOr(ProjectId)),
  priority: Schema.optional(IssuePriority),
  /** Absent keeps the current assignment; an explicit null leaves the issue unassigned. */
  assignee: Schema.optional(Schema.NullOr(IssueAssignee)),
  /**
   * Fire the read-only investigation as part of accepting. Refused for a rootless or absent
   * project — and that refusal does not undo the accept, it is reported alongside it.
   */
  runEnrichment: Schema.Boolean,
});
export type IssueTriageAcceptInput = typeof IssueTriageAcceptInput.Type;

/**
 * The accepted issue, and what became of the investigation that was asked for.
 *
 * Both `enrichment` fields are null when `runEnrichment` was false. When it was true, exactly one
 * of them is set: enrichment refusing — a rootless project, a run already in flight, no model
 * configured — must not take the accept down with it, so the refusal is reported here rather than
 * raised.
 */
export const IssueTriageAcceptResult = Schema.Struct({
  issue: Issue,
  enrichmentRun: Schema.NullOr(IssueEnrichmentRun),
  /** Why no run was started, in a sentence the accept toast can show underneath itself. */
  enrichmentRefusal: Schema.NullOr(Schema.String),
});
export type IssueTriageAcceptResult = typeof IssueTriageAcceptResult.Type;

export const IssueTrackerErrorReason = Schema.Literals([
  /** The row named by the request — issue, status, label, milestone, cycle, todo, comment — is gone. */
  "not-found",
  /** The request contradicts the state it arrived at — deleting the last status, say. */
  "conflict",
  /**
   * The request is well-formed but not usable: a key prefix already in use, a cyclic parent, a
   * parent past {@link ISSUE_MAX_PARENT_DEPTH}, a self-relation, an edit of somebody else's
   * comment, a milestone from a project the issue is not in, or an enrichment run asked for on a
   * rootless project or while one is already in flight.
   */
  "invalid",
  /** The write did not reach the database. */
  "storage",
]);
export type IssueTrackerErrorReason = typeof IssueTrackerErrorReason.Type;

export class IssueTrackerError extends Schema.TaggedErrorClass<IssueTrackerError>()(
  "IssueTrackerError",
  {
    reason: IssueTrackerErrorReason,
    message: Schema.String,
    /** What the request named, where naming it helps: an issue key, a status name. */
    subject: Schema.optional(TrimmedString),
  },
) {}
