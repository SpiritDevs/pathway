/**
 * The `issues` MCP toolkit — schema half.
 *
 * This is how a coding agent reads and writes the tracker described in
 * `docs/internals/decisions/0006-issue-tracker.md`. Agents have full write access here, including
 * completing and deleting: soft deletes and the `issue_events` change log are what make that
 * recoverable, and there is deliberately no approval gate in front of any of it. Every tool
 * description therefore states its side effect in plain words, because the description is the only
 * warning an agent gets.
 *
 * The whole surface is keys and names — `PAT-12`, `"In Progress"`, `"bug"` — never ids. Ids exist
 * on the wire between the web client and `IssueTrackerService`; an agent has no way to have seen
 * one and no way to guess one. The server resolves names and answers a miss with the valid
 * options, so a wrong guess costs one round trip rather than a dead end.
 *
 * @module issues/tools
 */
import {
  ISSUE_COMMENT_MAX_ATTACHMENTS,
  ISSUE_COMMENT_MAX_CHARS,
  ISSUE_DESCRIPTION_MAX_CHARS,
  ISSUE_LABELS_MAX_PER_ISSUE,
  ISSUE_TITLE_MAX_CHARS,
  IssueColor,
  IssueDate,
  IssuePriority,
  IssueRelationDirection,
  IssueRelationKind,
  IssueStatusCategory,
  IssueMilestoneHistoryPoint,
  IssueThreadLinkOrigin,
  IssueTrackerError,
  PreviewAutomationRecordingArtifact,
  PreviewTabId,
} from "@spiritdevs/contracts";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import { IssueTrackerService } from "../../../issues/IssueTrackerService.ts";
import { ProjectionProjectRepository } from "../../../persistence/Services/ProjectionProjects.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";

/** How many rows `issues_list` answers with when the caller does not say. */
export const ISSUES_MCP_LIST_DEFAULT_LIMIT = 50;
/**
 * The hard cap. A tracker holds thousands of rows and a tool result is read into a context
 * window, so the tool always reports `matched` and `truncated` rather than quietly returning a
 * prefix and letting the agent conclude the rest does not exist.
 */
export const ISSUES_MCP_LIST_MAX_LIMIT = 200;

/**
 * Every tool needs the tracker, the calling agent's identity, and the project table — projects
 * are named in the orchestration projection, not in the tracker's own tables.
 */
const dependencies = [
  McpInvocationContext.McpInvocationContext,
  IssueTrackerService,
  ProjectionProjectRepository,
];

const evidenceDependencies = [...dependencies, PreviewAutomationBroker.PreviewAutomationBroker];

const fileDependencies = [...dependencies, FileSystem.FileSystem, Path.Path];

const ASSIGNEE_GRAMMAR =
  'Who owns the task: "user" for the environment\'s bound company member, "member:<membership-id>" for an explicit member, "agent" for you (the calling agent), or "agent:<driver>" for a specific provider such as "agent:codex".';

const STATUS_GRAMMAR =
  'Status name such as "In Progress" (case-insensitive), or one of the six categories — backlog, unstarted, started, review, completed, canceled — which resolves to the first status in that category. Use "review" for pre-completion checks and "completed" rather than guessing the name of the done column.';

const issueKeyField = (verb: string) =>
  Schema.String.annotate({
    description: `Task key to ${verb}, such as "PAT-12". Case-insensitive.`,
  });

const optionalName = (description: string) =>
  Schema.optional(Schema.String.annotate({ description }));

const clearableName = (description: string) =>
  Schema.optional(
    Schema.NullOr(Schema.String).annotate({
      description: `${description} Pass null to clear it; omit the field to leave it alone.`,
    }),
  );

const optionalDate = (description: string) =>
  Schema.optional(Schema.String.annotate({ description: `${description} Format: YYYY-MM-DD.` }));

const milestoneName = (description: string) =>
  Schema.String.check(
    Schema.isTrimmed(),
    Schema.isNonEmpty(),
    Schema.isMaxLength(ISSUE_TITLE_MAX_CHARS),
  ).annotate({ description });

const labelNames = (description: string) =>
  Schema.optional(
    Schema.Array(Schema.String)
      .check(Schema.isMaxLength(ISSUE_LABELS_MAX_PER_ISSUE))
      .annotate({ description }),
  );

/**
 * One issue as a list row. Deliberately not the wire `Issue`: that shape is ids, a fractional sort
 * key, and timestamps, none of which an agent can act on.
 */
export const IssuesMcpRow = Schema.Struct({
  key: Schema.String,
  title: Schema.String,
  /** The status name as configured on this environment. */
  status: Schema.String,
  /** What that status means to the workflow, which is what "is this done" actually asks. */
  statusCategory: IssueStatusCategory,
  priority: IssuePriority,
  assignee: Schema.NullOr(Schema.String),
  project: Schema.NullOr(Schema.String),
  parentKey: Schema.NullOr(Schema.String),
  dueDate: Schema.NullOr(Schema.String),
  /** Triage items sit outside the workflow: no board, no count, no rollup. */
  triage: Schema.Boolean,
  /** Set when the issue is in the bin. `issues_restore` takes it back out. */
  deletedAt: Schema.NullOr(Schema.String),
});
export type IssuesMcpRow = typeof IssuesMcpRow.Type;

export const IssuesMcpTodo = Schema.Struct({
  text: Schema.String,
  done: Schema.Boolean,
});

export const IssuesMcpRelation = Schema.Struct({
  /**
   * The edge read from this issue's side: "blocks", "blocked by", "relates to", "duplicates", or
   * "duplicated by". One stored row, two readings.
   */
  relation: Schema.String,
  kind: IssueRelationKind,
  direction: IssueRelationDirection,
  key: Schema.String,
  title: Schema.String,
});

export const IssuesMcpComment = Schema.Struct({
  /** "user", "agent:codex", or "system:import" — the feed says who wrote it. */
  author: Schema.String,
  body: Schema.String,
  /** Images owned by this comment, in display order. */
  attachmentIds: Schema.Array(Schema.String),
  createdAt: Schema.String,
  editedAt: Schema.NullOr(Schema.String),
});

/**
 * One item in the issue-level attachment shelf. Attachments are physically owned by comments;
 * carrying the source comment here lets an agent understand an image without reconstructing the
 * relationship from two arrays.
 */
export const IssuesMcpAttachment = Schema.Struct({
  attachmentId: Schema.String,
  kind: Schema.optional(Schema.Literals(["image", "video", "file"])),
  mimeType: Schema.optional(Schema.String),
  sizeBytes: Schema.optional(Schema.Int),
  /** One-based position in `comments`, matching how the accompanying MCP image block is labelled. */
  commentNumber: Schema.Int,
  author: Schema.String,
  commentBody: Schema.String,
  commentCreatedAt: Schema.String,
});
export type IssuesMcpAttachment = typeof IssuesMcpAttachment.Type;

export const IssuesMcpThreadLink = Schema.Struct({
  threadId: Schema.String,
  origin: IssueThreadLinkOrigin,
  createdAt: Schema.String,
});

export const IssuesMcpDetail = Schema.Struct({
  key: Schema.String,
  title: Schema.String,
  /** Markdown, including any Investigation block enrichment appended. */
  description: Schema.String,
  status: Schema.String,
  statusCategory: IssueStatusCategory,
  priority: IssuePriority,
  assignee: Schema.NullOr(Schema.String),
  project: Schema.NullOr(Schema.String),
  milestone: Schema.NullOr(Schema.String),
  cycle: Schema.NullOr(Schema.String),
  labels: Schema.Array(Schema.String),
  dueDate: Schema.NullOr(Schema.String),
  triage: Schema.Boolean,
  parentKey: Schema.NullOr(Schema.String),
  /** Real issues with their own status, unlike todos. */
  subIssueKeys: Schema.Array(Schema.String),
  todos: Schema.Array(IssuesMcpTodo),
  relations: Schema.Array(IssuesMcpRelation),
  comments: Schema.Array(IssuesMcpComment),
  /** Every attachment on the issue, deduplicated in comment order with its source comment. */
  attachments: Schema.Array(IssuesMcpAttachment),
  /** Threads recorded as working this issue. A link is a record, not a running turn. */
  threads: Schema.Array(IssuesMcpThreadLink),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  deletedAt: Schema.NullOr(Schema.String),
});
export type IssuesMcpDetail = typeof IssuesMcpDetail.Type;

export const IssuesMcpListInput = Schema.Struct({
  query: optionalName(
    "Case-insensitive substring matched against the task key and title. Not a full-text search of descriptions or comments.",
  ),
  status: optionalName("Only tasks in this status, by name (case-insensitive)."),
  statusCategory: Schema.optional(
    IssueStatusCategory.annotate({
      description:
        "Only tasks whose status is in this category. Use completed to find finished work regardless of what the column is called.",
    }),
  ),
  project: optionalName("Only tasks in this project, by project name (case-insensitive)."),
  label: optionalName("Only tasks carrying this label, by name (case-insensitive)."),
  assignee: optionalName(`${ASSIGNEE_GRAMMAR} Pass "none" for unassigned tasks.`),
  priority: Schema.optional(
    IssuePriority.annotate({ description: "Only tasks at this priority." }),
  ),
  triage: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "true for triage items only, false to exclude them. Omitted, both are returned — triage items are tasks with no status assigned yet.",
    }),
  ),
  includeDeleted: Schema.optional(
    Schema.Boolean.annotate({
      description: "Include soft-deleted tasks. Defaults to false.",
    }),
  ),
  limit: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: ISSUES_MCP_LIST_MAX_LIMIT })).annotate(
      {
        description: `Maximum rows to return, 1..${ISSUES_MCP_LIST_MAX_LIMIT}. Defaults to ${ISSUES_MCP_LIST_DEFAULT_LIMIT}; the result always reports how many matched.`,
      },
    ),
  ),
});
export type IssuesMcpListInput = typeof IssuesMcpListInput.Type;

export const IssuesMcpListResult = Schema.Struct({
  issues: Schema.Array(IssuesMcpRow),
  /** How many issues matched the filters, before the limit. */
  matched: Schema.Int,
  returned: Schema.Int,
  /** True when `matched` exceeds `returned`: narrow the filters rather than assuming this is all. */
  truncated: Schema.Boolean,
});
export type IssuesMcpListResult = typeof IssuesMcpListResult.Type;

export const IssuesMcpGetInput = Schema.Struct({
  key: issueKeyField("read"),
});

export const IssuesMcpGetAttachmentInput = Schema.Struct({
  key: issueKeyField("read an attachment from"),
  attachmentId: Schema.String.annotate({
    description:
      "Attachment id returned by issues_get. The attachment must belong to a comment on this task.",
  }),
});

export const IssuesMcpGetAttachmentResult = Schema.Struct({
  key: Schema.String,
  attachment: IssuesMcpAttachment,
});
export type IssuesMcpGetAttachmentResult = typeof IssuesMcpGetAttachmentResult.Type;

/** A project-scoped milestone in the names-and-dates vocabulary agents can act on. */
export const IssuesMcpMilestone = Schema.Struct({
  name: Schema.String,
  project: Schema.String,
  description: Schema.NullOr(Schema.String),
  startDate: Schema.NullOr(IssueDate),
  targetDate: Schema.NullOr(IssueDate),
});
export type IssuesMcpMilestone = typeof IssuesMcpMilestone.Type;

export const IssuesMcpMilestonesListInput = Schema.Struct({
  project: optionalName(
    "Only milestones in this project, by project name (case-insensitive). Omit to list every milestone.",
  ),
});

export const IssuesMcpMilestonesListResult = Schema.Struct({
  milestones: Schema.Array(IssuesMcpMilestone),
});
export type IssuesMcpMilestonesListResult = typeof IssuesMcpMilestonesListResult.Type;

export const IssuesMcpMilestoneCreateInput = Schema.Struct({
  project: Schema.String.annotate({
    description: "Project the milestone belongs to, by name (case-insensitive). Required.",
  }),
  name: milestoneName("Milestone name. Must be unique within the project."),
  description: Schema.optional(
    Schema.String.check(Schema.isMaxLength(ISSUE_DESCRIPTION_MAX_CHARS)).annotate({
      description: "Optional markdown description of what the milestone means.",
    }),
  ),
  startDate: Schema.optional(IssueDate).annotate({
    description: "Optional start day, formatted YYYY-MM-DD.",
  }),
  targetDate: Schema.optional(IssueDate).annotate({
    description: "Optional target day, formatted YYYY-MM-DD.",
  }),
});

export const IssuesMcpMilestoneUpdateInput = Schema.Struct({
  project: Schema.String.annotate({
    description: "Current project containing the milestone, by name (case-insensitive).",
  }),
  milestone: Schema.String.annotate({
    description: "Current milestone name (case-insensitive).",
  }),
  name: Schema.optional(milestoneName("Replacement milestone name.")),
  description: Schema.optional(
    Schema.NullOr(Schema.String.check(Schema.isMaxLength(ISSUE_DESCRIPTION_MAX_CHARS))).annotate({
      description:
        "Replacement markdown description. Pass null to clear it; omit the field to leave it alone.",
    }),
  ),
  startDate: Schema.optional(Schema.NullOr(IssueDate)).annotate({
    description:
      "Replacement start day, YYYY-MM-DD. Pass null to clear it; omit the field to leave it alone.",
  }),
  targetDate: Schema.optional(Schema.NullOr(IssueDate)).annotate({
    description:
      "Replacement target day, YYYY-MM-DD. Pass null to clear it; omit the field to leave it alone.",
  }),
  newProject: optionalName(
    "Move the milestone to this project. Tasks left in the old project are removed from the milestone.",
  ),
});

export const IssuesMcpMilestoneDeleteInput = Schema.Struct({
  project: Schema.String.annotate({
    description: "Project containing the milestone, by name (case-insensitive).",
  }),
  milestone: Schema.String.annotate({
    description: "Milestone name to delete (case-insensitive).",
  }),
});

export const IssuesMcpMilestoneResult = Schema.Struct({
  milestone: IssuesMcpMilestone,
});
export type IssuesMcpMilestoneResult = typeof IssuesMcpMilestoneResult.Type;

export const IssuesMcpMilestoneDeleteResult = Schema.Struct({
  deleted: IssuesMcpMilestone,
  clearedIssues: Schema.Int,
});
export type IssuesMcpMilestoneDeleteResult = typeof IssuesMcpMilestoneDeleteResult.Type;

export const IssuesMcpCreateInput = Schema.Struct({
  idempotencyKey: Schema.optional(
    Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(512)).annotate({
      description:
        "Stable retry token. Omit it on the first attempt. If a queued create tells you to retry, pass back the exact token from that error so the retry resumes the same task.",
    }),
  ),
  title: Schema.String.check(Schema.isMaxLength(ISSUE_TITLE_MAX_CHARS)).annotate({
    description: "One-line summary. Required.",
  }),
  description: Schema.optional(
    Schema.String.check(Schema.isMaxLength(ISSUE_DESCRIPTION_MAX_CHARS)).annotate({
      description: "Markdown body. Whitespace is significant and is not trimmed.",
    }),
  ),
  status: optionalName(
    `${STATUS_GRAMMAR} Omitted, the task takes the first configured status — or none at all when triage is true.`,
  ),
  priority: Schema.optional(IssuePriority.annotate({ description: 'Defaults to "none".' })),
  project: optionalName("Project name. Must already exist; this tool does not create projects."),
  milestone: optionalName(
    "Milestone name. When it does not exist in the selected project, it is created while filing the task. An existing milestone can supply the project when its name is unique; creating one requires project.",
  ),
  cycle: optionalName("Cycle name. Cycles span every project."),
  labels: labelNames(
    "Label names. A label that does not exist yet is created with a colour from the tracker's palette.",
  ),
  assignee: optionalName(ASSIGNEE_GRAMMAR),
  dueDate: optionalDate("Calendar day the task is due."),
  parentKey: optionalName(
    'Key of the parent task, making this a subtask, such as "PAT-4". Nesting is capped at three levels.',
  ),
  triage: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "File this as a triage item: no status, and it appears in no board or count until somebody accepts it.",
    }),
  ),
});
export type IssuesMcpCreateInput = typeof IssuesMcpCreateInput.Type;

export const IssuesMcpUpdateInput = Schema.Struct({
  key: issueKeyField("update"),
  title: optionalName("Replacement one-line summary."),
  description: Schema.optional(
    Schema.String.check(Schema.isMaxLength(ISSUE_DESCRIPTION_MAX_CHARS)).annotate({
      description:
        "Replacement markdown body. This overwrites the whole description, including any Investigation block already there — read the task first if you mean to append.",
    }),
  ),
  status: optionalName(STATUS_GRAMMAR),
  priority: Schema.optional(IssuePriority.annotate({ description: "Replacement priority." })),
  assignee: clearableName(ASSIGNEE_GRAMMAR),
  project: clearableName("Project name."),
  milestone: clearableName(
    "Milestone name. Cleared automatically when the task leaves the milestone's project.",
  ),
  cycle: clearableName("Cycle name."),
  labels: labelNames(
    "Replace the label set outright with these names. Names that do not exist yet are created. Prefer addLabels/removeLabels unless you mean to drop the rest.",
  ),
  addLabels: labelNames("Label names to add, keeping the ones already there. Created if missing."),
  removeLabels: labelNames(
    "Label names to take off this task. The label itself survives on other tasks.",
  ),
  dueDate: Schema.optional(
    Schema.NullOr(Schema.String).annotate({
      description: "Calendar day the task is due, YYYY-MM-DD. Pass null to clear it.",
    }),
  ),
  parentKey: clearableName('Key of the parent task, such as "PAT-4".'),
  triage: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "Move the task in or out of triage. Setting it false without a status leaves the task where it is.",
    }),
  ),
});
export type IssuesMcpUpdateInput = typeof IssuesMcpUpdateInput.Type;

const commentBody = (description: string) =>
  Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(ISSUE_COMMENT_MAX_CHARS)).annotate({
    description,
  });

export const IssuesMcpCommentInput = Schema.Struct({
  key: issueKeyField("comment on"),
  body: commentBody("Markdown comment body. Whitespace is significant and is not trimmed."),
  files: Schema.optional(
    Schema.Array(Schema.String).check(Schema.isMaxLength(ISSUE_COMMENT_MAX_ATTACHMENTS)).annotate({
      description:
        "Absolute paths of files on this computer to attach, such as screenshots. Tasks accept images, mp4 or webm recordings, and plain text or JSON files.",
    }),
  ),
});

export const IssuesMcpCommentEvidenceInput = Schema.Struct({
  key: issueKeyField("attach browser evidence to"),
  body: Schema.String.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(ISSUE_COMMENT_MAX_CHARS),
  ).annotate({
    description:
      "Markdown comment explaining what was verified, what the evidence shows, and any limitations.",
  }),
  evidence: Schema.Union([
    Schema.TaggedStruct("screenshot", {
      tabId: Schema.optional(PreviewTabId).annotate({
        description:
          "Exact collaborative browser tab to capture. Omit to use this agent session's current tab.",
      }),
    }),
    Schema.TaggedStruct("recording", {
      artifact: PreviewAutomationRecordingArtifact.annotate({
        description:
          "The complete artifact returned by preview_recording_stop in this agent session.",
      }),
    }),
  ]).annotate({
    description:
      "Capture the current Preview tab as a screenshot, or attach a recording returned by preview_recording_stop.",
  }),
});

export const IssuesMcpCommentResult = Schema.Struct({
  key: Schema.String,
  comment: IssuesMcpComment,
});
export type IssuesMcpCommentResult = typeof IssuesMcpCommentResult.Type;

export const IssuesMcpDeleteInput = Schema.Struct({
  key: issueKeyField("delete"),
});

export const IssuesMcpRestoreInput = Schema.Struct({
  key: issueKeyField("restore"),
});

export const IssuesMcpLinkThreadInput = Schema.Struct({
  key: issueKeyField("link a thread to"),
  threadId: optionalName(
    "Thread to link. Omitted, your own thread — the one this MCP credential was issued for — is used, which is what you want when you are the agent doing the work.",
  ),
});

export const IssuesMcpThreadLinksResult = Schema.Struct({
  key: Schema.String,
  threads: Schema.Array(IssuesMcpThreadLink),
});
export type IssuesMcpThreadLinksResult = typeof IssuesMcpThreadLinksResult.Type;

const commentNumberField = (verb: string) =>
  Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).annotate({
    description: `Which comment to ${verb}: its 1-based position in the comments issues_get returns. Only comments you wrote can be edited.`,
  });

export const IssuesMcpCommentUpdateInput = Schema.Struct({
  key: issueKeyField("edit a comment on"),
  comment: commentNumberField("edit"),
  body: commentBody("Replacement markdown body."),
});

export const IssuesMcpCommentDeleteInput = Schema.Struct({
  key: issueKeyField("delete a comment from"),
  comment: commentNumberField("delete"),
});

export const IssuesMcpCommentsResult = Schema.Struct({
  key: Schema.String,
  comments: Schema.Array(IssuesMcpComment),
});

const todoNumberField = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).annotate({
  description: "The checklist item's 1-based position in the todos issues_get returns.",
});
const todoText = Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty()).annotate({
  description: "Checklist item text.",
});

export const IssuesMcpTodoCreateInput = Schema.Struct({
  key: issueKeyField("add a checklist item to"),
  text: todoText,
});

export const IssuesMcpTodoUpdateInput = Schema.Struct({
  key: issueKeyField("change a checklist item on"),
  todo: todoNumberField,
  text: Schema.optional(todoText),
  done: Schema.optional(Schema.Boolean.annotate({ description: "Tick or untick the item." })),
});

export const IssuesMcpTodoDeleteInput = Schema.Struct({
  key: issueKeyField("remove a checklist item from"),
  todo: todoNumberField,
});

export const IssuesMcpTodosReorderInput = Schema.Struct({
  key: issueKeyField("reorder the checklist of"),
  order: Schema.Array(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))).annotate({
    description:
      "Every current item's 1-based position, listed in the new order. [3, 1, 2] moves the third item to the top.",
  }),
});

export const IssuesMcpTodosResult = Schema.Struct({
  key: Schema.String,
  todos: Schema.Array(IssuesMcpTodo),
});

export const IssuesMcpRelationPhrase = Schema.Literals([
  "blocks",
  "blocked by",
  "relates to",
  "duplicates",
  "duplicated by",
]);

export const IssuesMcpRelationInput = Schema.Struct({
  key: issueKeyField("link"),
  relation: IssuesMcpRelationPhrase.annotate({
    description: 'How the task relates to the other one, read as "<key> <relation> <otherKey>".',
  }),
  otherKey: Schema.String.annotate({ description: 'The other task\'s key, such as "PAT-9".' }),
});

export const IssuesMcpRelationsResult = Schema.Struct({
  key: Schema.String,
  relations: Schema.Array(IssuesMcpRelation),
});

/** A cycle in the names-and-dates vocabulary. Cycles span every project. */
export const IssuesMcpCycle = Schema.Struct({
  name: Schema.String,
  startDate: IssueDate,
  endDate: IssueDate,
  /** Set once the cycle has ended and its unfinished tasks have been carried over. */
  completed: Schema.Boolean,
});

export const IssuesMcpCyclesListResult = Schema.Struct({ cycles: Schema.Array(IssuesMcpCycle) });

const nameField = (description: string) =>
  Schema.String.check(
    Schema.isTrimmed(),
    Schema.isNonEmpty(),
    Schema.isMaxLength(ISSUE_TITLE_MAX_CHARS),
  ).annotate({ description });

/** A calendar day. Plain rather than `IssueDate`, whose trimming transform drops the description. */
const dayField = (description: string) =>
  Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/)).annotate({ description });

export const IssuesMcpCycleCreateInput = Schema.Struct({
  name: nameField('Cycle name, such as "Sprint 14".'),
  startDate: dayField("First day, YYYY-MM-DD."),
  endDate: dayField("Last day, YYYY-MM-DD."),
});

export const IssuesMcpCycleUpdateInput = Schema.Struct({
  cycle: Schema.String.annotate({ description: "Current cycle name (case-insensitive)." }),
  name: Schema.optional(nameField("Replacement name.")),
  startDate: Schema.optional(dayField("New first day, YYYY-MM-DD.")),
  endDate: Schema.optional(dayField("New last day, YYYY-MM-DD.")),
});

export const IssuesMcpCycleDeleteInput = Schema.Struct({
  cycle: Schema.String.annotate({ description: "Cycle name to delete (case-insensitive)." }),
});

export const IssuesMcpCycleResult = Schema.Struct({ cycle: IssuesMcpCycle });

export const IssuesMcpLabel = Schema.Struct({ name: Schema.String, color: Schema.String });

export const IssuesMcpLabelsListResult = Schema.Struct({ labels: Schema.Array(IssuesMcpLabel) });

const colorField = (description: string) =>
  Schema.optional(IssueColor).annotate({ description: `${description} Hex, such as "#5e6ad2".` });

export const IssuesMcpLabelCreateInput = Schema.Struct({
  name: nameField("Label name."),
  color: colorField("Label colour. Omitted, one is picked from the tracker's palette."),
});

export const IssuesMcpLabelUpdateInput = Schema.Struct({
  label: Schema.String.annotate({ description: "Current label name (case-insensitive)." }),
  name: Schema.optional(nameField("Replacement name.")),
  color: colorField("Replacement colour."),
});

export const IssuesMcpLabelDeleteInput = Schema.Struct({
  label: Schema.String.annotate({ description: "Label name to delete (case-insensitive)." }),
});

export const IssuesMcpLabelResult = Schema.Struct({ label: IssuesMcpLabel });

export const IssuesMcpStatus = Schema.Struct({
  name: Schema.String,
  category: IssueStatusCategory,
  color: Schema.String,
});

export const IssuesMcpStatusesListInput = Schema.Struct({
  project: optionalName(
    "Only the statuses tasks in this project can use, by project name. Omit for every status.",
  ),
});

export const IssuesMcpStatusesListResult = Schema.Struct({
  /** In board order. */
  statuses: Schema.Array(IssuesMcpStatus),
});

export const IssuesMcpStatusCreateInput = Schema.Struct({
  name: nameField("Status name, shown as a board column."),
  category: IssueStatusCategory.annotate({
    description: "What the status means to the workflow. It is placed last in its category.",
  }),
  color: colorField("Column colour. Omitted, one is picked from the tracker's palette."),
});

export const IssuesMcpStatusUpdateInput = Schema.Struct({
  status: Schema.String.annotate({ description: "Current status name (case-insensitive)." }),
  name: Schema.optional(nameField("Replacement name.")),
  category: Schema.optional(IssueStatusCategory.annotate({ description: "Replacement category." })),
  color: colorField("Replacement colour."),
});

export const IssuesMcpStatusDeleteInput = Schema.Struct({
  status: Schema.String.annotate({ description: "Status name to delete (case-insensitive)." }),
  moveTasksTo: Schema.String.annotate({
    description: "Status the deleted status's tasks move to. There is no statusless task.",
  }),
});

export const IssuesMcpStatusResult = Schema.Struct({ status: IssuesMcpStatus });

const orderByName = (what: string) =>
  Schema.Array(Schema.String).annotate({
    description: `Every ${what} name, in the new order. The result lists them as stored.`,
  });

export const IssuesMcpStatusesReorderInput = Schema.Struct({
  statuses: orderByName("status"),
});

export const IssuesMcpMilestonesReorderInput = Schema.Struct({
  project: Schema.String.annotate({ description: "Project whose milestones to reorder." }),
  milestones: orderByName("milestone in the project"),
});

export const IssuesMcpMilestoneHistoryInput = Schema.Struct({
  project: Schema.String.annotate({ description: "Project containing the milestone." }),
  milestone: Schema.String.annotate({ description: "Milestone name (case-insensitive)." }),
});

export const IssuesMcpMilestoneHistoryResult = Schema.Struct({
  milestone: Schema.String,
  /** One point per day: tasks in scope, started (including completed), and completed. */
  points: Schema.Array(IssueMilestoneHistoryPoint),
  /** True when renamed or deleted statuses made the reconstruction a best guess. */
  approximate: Schema.Boolean,
});

export const IssuesMcpHistoryEvent = Schema.Struct({
  at: Schema.String,
  actor: Schema.NullOr(Schema.String),
  kind: Schema.String,
  field: Schema.NullOr(Schema.String),
  before: Schema.NullOr(Schema.String),
  after: Schema.NullOr(Schema.String),
});

export const IssuesMcpHistoryResult = Schema.Struct({
  key: Schema.String,
  /** Oldest first. */
  events: Schema.Array(IssuesMcpHistoryEvent),
});

export const IssuesMcpUnlinkThreadInput = Schema.Struct({
  key: issueKeyField("unlink a thread from"),
  threadId: optionalName("Thread to unlink. Omitted, your own thread is used."),
});

export const IssuesMcpTriageAcceptInput = Schema.Struct({
  key: issueKeyField("accept out of triage"),
  status: Schema.String.annotate({ description: `Where it lands. ${STATUS_GRAMMAR}` }),
  project: clearableName("Project to file it under. Omitted, whatever intake tagged is kept."),
  priority: Schema.optional(IssuePriority.annotate({ description: "Priority to set on accept." })),
  assignee: clearableName(ASSIGNEE_GRAMMAR),
  investigate: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "Also start Pathway's read-only investigation of the project's repository, as the Accept and investigate button does.",
    }),
  ),
});

export const IssuesMcpTriageAcceptResult = Schema.Struct({
  issue: IssuesMcpRow,
  /** Only when an investigation was asked for: "started", or why it could not start. */
  investigation: Schema.NullOr(Schema.String),
});

export const IssuesMcpTriageRejectInput = Schema.Struct({
  key: issueKeyField("reject from triage"),
});

export const IssuesMcpIssueResult = Schema.Struct({
  issue: IssuesMcpRow,
});
export type IssuesMcpIssueResult = typeof IssuesMcpIssueResult.Type;

const trackerTool = <T extends Tool.Any>(tool: T): T =>
  tool.annotate(Tool.OpenWorld, false).annotate(Tool.Destructive, false) as T;

const readonlyTrackerTool = <T extends Tool.Any>(tool: T): T =>
  trackerTool(tool).annotate(Tool.Readonly, true).annotate(Tool.Idempotent, true) as T;

const writeTrackerTool = <T extends Tool.Any>(tool: T): T =>
  trackerTool(tool).annotate(Tool.Readonly, false).annotate(Tool.Idempotent, false) as T;

export const IssuesListTool = readonlyTrackerTool(
  Tool.make("issues_list", {
    description:
      "Search this environment's task tracker. Filters combine with AND; every filter names things the way a person does — a status name or category, a project name, a label name. Returns compact rows newest-updated first, and reports how many matched so a truncated answer is never mistaken for the whole tracker. Read-only.",
    parameters: IssuesMcpListInput,
    success: IssuesMcpListResult,
    failure: IssueTrackerError,
    dependencies,
  }).annotate(Tool.Title, "List tasks"),
);

export const IssuesGetTool = readonlyTrackerTool(
  Tool.make("issues_get", {
    description:
      "Read one task in full by key: description, labels, milestone and cycle, subtask keys, checklist todos, relations, comments, and attachments. Each comment includes its attachment ids; the task-level attachment list includes the source comment body and author. Available images are returned directly as MCP image content, within a bounded eager-load budget; use issues_get_attachment for any listed image that was not included. Read-only. Works on soft-deleted tasks too.",
    parameters: IssuesMcpGetInput,
    success: IssuesMcpDetail,
    failure: IssueTrackerError,
    dependencies,
  }).annotate(Tool.Title, "Get task detail"),
);

export const IssuesGetAttachmentTool = readonlyTrackerTool(
  Tool.make("issues_get_attachment", {
    description:
      "Read one attachment listed by issues_get together with its source comment body, author, and timestamp. Images are returned directly as MCP image content. Video metadata is returned as text because MCP has no inline video content block; the video remains playable on the Pathway task. The attachment must belong to the named task. Read-only.",
    parameters: IssuesMcpGetAttachmentInput,
    success: IssuesMcpGetAttachmentResult,
    failure: IssueTrackerError,
    dependencies,
  }).annotate(Tool.Title, "Get task attachment"),
);

export const IssuesMilestonesListTool = readonlyTrackerTool(
  Tool.make("issues_milestones_list", {
    description:
      "List milestones in this environment, optionally within one project. Returns project-scoped names, descriptions, and dates that can be passed to the milestone write tools. Read-only.",
    parameters: IssuesMcpMilestonesListInput,
    success: IssuesMcpMilestonesListResult,
    failure: IssueTrackerError,
    dependencies,
  }).annotate(Tool.Title, "List milestones"),
);

export const IssuesMilestoneCreateTool = writeTrackerTool(
  Tool.make("issues_milestone_create", {
    description:
      "Create a milestone inside an existing project. This writes to the tracker and is visible to everyone immediately; milestone names only need to be unique within their project.",
    parameters: IssuesMcpMilestoneCreateInput,
    success: IssuesMcpMilestoneResult,
    failure: IssueTrackerError,
    dependencies,
  }).annotate(Tool.Title, "Create milestone"),
);

export const IssuesMilestoneUpdateTool = writeTrackerTool(
  Tool.make("issues_milestone_update", {
    description:
      "Rename, describe, reschedule, or move a milestone. Omitted fields stay unchanged and explicit null clears a description or date. This writes to the tracker and is visible to everyone immediately.",
    parameters: IssuesMcpMilestoneUpdateInput,
    success: IssuesMcpMilestoneResult,
    failure: IssueTrackerError,
    dependencies,
  })
    .annotate(Tool.Title, "Update milestone")
    .annotate(Tool.Idempotent, true),
);

export const IssuesMilestoneDeleteTool = writeTrackerTool(
  Tool.make("issues_milestone_delete", {
    description:
      "Permanently delete a milestone. Tasks on it stay in their project and become unassigned from any milestone. This writes to the tracker and is visible to everyone immediately.",
    parameters: IssuesMcpMilestoneDeleteInput,
    success: IssuesMcpMilestoneDeleteResult,
    failure: IssueTrackerError,
    dependencies,
  }).annotate(Tool.Title, "Delete milestone"),
).annotate(Tool.Destructive, true);

export const IssuesCreateTool = writeTrackerTool(
  Tool.make("issues_create", {
    description:
      "File a new task and return it, including the key it was given. This writes to the tracker and shows up immediately in everyone's list view, attributed to you in the task's change log. Labels are created when missing. A missing milestone is also created when the project field names where it belongs; projects and cycles must already exist. If an earlier attempt remains queued, reuse the idempotencyKey named in its error instead of filing another task.",
    parameters: IssuesMcpCreateInput,
    success: IssuesMcpIssueResult,
    failure: IssueTrackerError,
    dependencies,
  }).annotate(Tool.Title, "Create task"),
);

export const IssuesUpdateTool = writeTrackerTool(
  Tool.make("issues_update", {
    description:
      "Change fields on one task. Patch semantics: an omitted field is left alone and an explicit null clears it. This writes to the tracker, is visible to everyone immediately, and every field change is recorded against your name in the task's change log. Setting a status in the completed category is how you mark work done.",
    parameters: IssuesMcpUpdateInput,
    success: IssuesMcpIssueResult,
    failure: IssueTrackerError,
    dependencies,
  })
    .annotate(Tool.Title, "Update task")
    .annotate(Tool.Idempotent, true),
);

export const IssuesCommentTool = writeTrackerTool(
  Tool.make("issues_comment", {
    description:
      "Post a markdown comment on a task, attributed to you, optionally attaching files from this computer such as screenshots. This is visible to everyone reading the task and cannot be posted silently — use it to report what you found or did, not to talk to yourself.",
    parameters: IssuesMcpCommentInput,
    success: IssuesMcpCommentResult,
    failure: IssueTrackerError,
    dependencies: fileDependencies,
  }).annotate(Tool.Title, "Comment on task"),
);

export const IssuesCommentEvidenceTool = writeTrackerTool(
  Tool.make("issues_comment_evidence", {
    description:
      "Capture browser proof and post it to a task as an attributed markdown comment with an inline attachment. For a screenshot, this captures the current Preview tab. For video, call preview_recording_start and preview_recording_stop first, then pass the returned artifact unchanged. The evidence is copied into the task so it remains reviewable from other devices. This is visible to everyone reading the task.",
    parameters: IssuesMcpCommentEvidenceInput,
    success: IssuesMcpCommentResult,
    failure: IssueTrackerError,
    dependencies: evidenceDependencies,
  }).annotate(Tool.Title, "Attach browser evidence to task"),
).annotate(Tool.OpenWorld, true);

export const IssuesDeleteTool = writeTrackerTool(
  Tool.make("issues_delete", {
    description:
      "Delete a task. The delete is soft — the row keeps its key and its history, disappears from the list view, and is recoverable with issues_restore — but it is not a draft operation: everyone stops seeing the task, and the deletion is recorded against your name. Subtasks are not deleted with it.",
    parameters: IssuesMcpDeleteInput,
    success: IssuesMcpIssueResult,
    failure: IssueTrackerError,
    dependencies,
  }).annotate(Tool.Title, "Delete task"),
)
  // Annotated outside the wrapper: `writeTrackerTool` clears the destructive hint for the rest of
  // the toolkit, and this is the one tool that earns it back.
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true);

export const IssuesRestoreTool = writeTrackerTool(
  Tool.make("issues_restore", {
    description:
      "Take a soft-deleted task back out of the bin and return it to the list view, recorded against your name. Use this to undo an issues_delete, yours or anyone's.",
    parameters: IssuesMcpRestoreInput,
    success: IssuesMcpIssueResult,
    failure: IssueTrackerError,
    dependencies,
  })
    .annotate(Tool.Title, "Restore task")
    .annotate(Tool.Idempotent, true),
);

export const IssuesLinkThreadTool = writeTrackerTool(
  Tool.make("issues_link_thread", {
    description:
      "Record that a thread is working this task, so the task shows the conversation and the conversation shows the task. Defaults to your own thread. Linking is a record only: it starts nothing, and it is idempotent per task and thread.",
    parameters: IssuesMcpLinkThreadInput,
    success: IssuesMcpThreadLinksResult,
    failure: IssueTrackerError,
    dependencies,
  })
    .annotate(Tool.Title, "Link thread to task")
    .annotate(Tool.Idempotent, true),
);

export const IssuesCommentUpdateTool = writeTrackerTool(
  Tool.make("issues_comment_update", {
    description:
      "Rewrite the body of a comment you wrote. The change is visible to everyone and the comment shows as edited.",
    parameters: IssuesMcpCommentUpdateInput,
    success: IssuesMcpCommentResult,
    failure: IssueTrackerError,
    dependencies,
  })
    .annotate(Tool.Title, "Edit task comment")
    .annotate(Tool.Idempotent, true),
);

export const IssuesCommentDeleteTool = writeTrackerTool(
  Tool.make("issues_comment_delete", {
    description:
      "Delete a comment and its attachments from a task. Visible to everyone and recorded against your name.",
    parameters: IssuesMcpCommentDeleteInput,
    success: IssuesMcpCommentsResult,
    failure: IssueTrackerError,
    dependencies,
  }).annotate(Tool.Title, "Delete task comment"),
).annotate(Tool.Destructive, true);

export const IssuesTodoCreateTool = writeTrackerTool(
  Tool.make("issues_todo_create", {
    description:
      "Add an item to the end of a task's checklist; this writes to the tracker. Checklist items are small steps without their own status; use a subtask (issues_create with parentKey) for work that needs one.",
    parameters: IssuesMcpTodoCreateInput,
    success: IssuesMcpTodosResult,
    failure: IssueTrackerError,
    dependencies,
  }).annotate(Tool.Title, "Add checklist item"),
);

export const IssuesTodoUpdateTool = writeTrackerTool(
  Tool.make("issues_todo_update", {
    description:
      "Tick, untick, or reword one checklist item on a task. This writes to the tracker.",
    parameters: IssuesMcpTodoUpdateInput,
    success: IssuesMcpTodosResult,
    failure: IssueTrackerError,
    dependencies,
  })
    .annotate(Tool.Title, "Update checklist item")
    .annotate(Tool.Idempotent, true),
);

export const IssuesTodoDeleteTool = writeTrackerTool(
  Tool.make("issues_todo_delete", {
    description:
      "Remove one checklist item from a task; the rest keep their order. This writes to the tracker.",
    parameters: IssuesMcpTodoDeleteInput,
    success: IssuesMcpTodosResult,
    failure: IssueTrackerError,
    dependencies,
  }).annotate(Tool.Title, "Remove checklist item"),
).annotate(Tool.Destructive, true);

export const IssuesTodosReorderTool = writeTrackerTool(
  Tool.make("issues_todos_reorder", {
    description: "Put a task's checklist items in a new order. This writes to the tracker.",
    parameters: IssuesMcpTodosReorderInput,
    success: IssuesMcpTodosResult,
    failure: IssueTrackerError,
    dependencies,
  })
    .annotate(Tool.Title, "Reorder checklist")
    .annotate(Tool.Idempotent, true),
);

export const IssuesRelationCreateTool = writeTrackerTool(
  Tool.make("issues_relation_create", {
    description:
      'Link two tasks: "PAT-3 blocks PAT-9", "relates to", or "duplicates". Both tasks show the link, each from its own side, and the link is recorded against your name in both change logs.',
    parameters: IssuesMcpRelationInput,
    success: IssuesMcpRelationsResult,
    failure: IssueTrackerError,
    dependencies,
  }).annotate(Tool.Title, "Link tasks"),
);

export const IssuesRelationDeleteTool = writeTrackerTool(
  Tool.make("issues_relation_delete", {
    description:
      "Remove a link between two tasks, named the same way it was created or the way issues_get shows it. Recorded against your name.",
    parameters: IssuesMcpRelationInput,
    success: IssuesMcpRelationsResult,
    failure: IssueTrackerError,
    dependencies,
  })
    .annotate(Tool.Title, "Unlink tasks")
    .annotate(Tool.Idempotent, true),
);

export const IssuesUnlinkThreadTool = writeTrackerTool(
  Tool.make("issues_unlink_thread", {
    description:
      "Remove the record that a thread works a task, recorded against your name. Defaults to your own thread. Stops nothing that is running.",
    parameters: IssuesMcpUnlinkThreadInput,
    success: IssuesMcpThreadLinksResult,
    failure: IssueTrackerError,
    dependencies,
  })
    .annotate(Tool.Title, "Unlink thread from task")
    .annotate(Tool.Idempotent, true),
);

export const IssuesHistoryTool = readonlyTrackerTool(
  Tool.make("issues_history", {
    description:
      "Read a task's change log: who changed which field from what to what, and when. Read-only.",
    parameters: IssuesMcpGetInput,
    success: IssuesMcpHistoryResult,
    failure: IssueTrackerError,
    dependencies,
  }).annotate(Tool.Title, "Get task history"),
);

export const IssuesTriageAcceptTool = writeTrackerTool(
  Tool.make("issues_triage_accept", {
    description:
      "Accept a triage item into the workflow with a status, optionally setting its project, priority, and assignee and starting an investigation. Recorded against your name.",
    parameters: IssuesMcpTriageAcceptInput,
    success: IssuesMcpTriageAcceptResult,
    failure: IssueTrackerError,
    dependencies,
  }).annotate(Tool.Title, "Accept triage item"),
);

export const IssuesTriageRejectTool = writeTrackerTool(
  Tool.make("issues_triage_reject", {
    description:
      "Turn a triage item down. It leaves the queue and is recorded as rejected rather than deleted; it stays recoverable, and issues_restore puts it back in triage.",
    parameters: IssuesMcpTriageRejectInput,
    success: IssuesMcpIssueResult,
    failure: IssueTrackerError,
    dependencies,
  }).annotate(Tool.Title, "Reject triage item"),
).annotate(Tool.Destructive, true);

export const IssuesCyclesListTool = readonlyTrackerTool(
  Tool.make("issues_cycles_list", {
    description:
      "List cycles (time-boxed sprints spanning every project) with their dates. Read-only.",
    success: IssuesMcpCyclesListResult,
    failure: IssueTrackerError,
    dependencies,
  }).annotate(Tool.Title, "List cycles"),
);

export const IssuesCycleCreateTool = writeTrackerTool(
  Tool.make("issues_cycle_create", {
    description:
      "Create a cycle with a start and end day. Visible to everyone immediately; assign tasks to it with issues_update.",
    parameters: IssuesMcpCycleCreateInput,
    success: IssuesMcpCycleResult,
    failure: IssueTrackerError,
    dependencies,
  }).annotate(Tool.Title, "Create cycle"),
);

export const IssuesCycleUpdateTool = writeTrackerTool(
  Tool.make("issues_cycle_update", {
    description:
      "Rename a cycle or move its dates. Omitted fields stay unchanged. Visible to everyone immediately.",
    parameters: IssuesMcpCycleUpdateInput,
    success: IssuesMcpCycleResult,
    failure: IssueTrackerError,
    dependencies,
  })
    .annotate(Tool.Title, "Update cycle")
    .annotate(Tool.Idempotent, true),
);

export const IssuesCycleDeleteTool = writeTrackerTool(
  Tool.make("issues_cycle_delete", {
    description:
      "Delete a cycle. Its tasks stay where they are and leave the cycle. Visible to everyone.",
    parameters: IssuesMcpCycleDeleteInput,
    success: IssuesMcpCyclesListResult,
    failure: IssueTrackerError,
    dependencies,
  }).annotate(Tool.Title, "Delete cycle"),
).annotate(Tool.Destructive, true);

export const IssuesMilestonesReorderTool = writeTrackerTool(
  Tool.make("issues_milestones_reorder", {
    description: "Put a project's milestones in a new order. Visible to everyone immediately.",
    parameters: IssuesMcpMilestonesReorderInput,
    success: IssuesMcpMilestonesListResult,
    failure: IssueTrackerError,
    dependencies,
  })
    .annotate(Tool.Title, "Reorder milestones")
    .annotate(Tool.Idempotent, true),
);

export const IssuesMilestoneHistoryTool = readonlyTrackerTool(
  Tool.make("issues_milestone_history", {
    description:
      "Read a milestone's burn-up: per day, how many tasks were in scope, started, and completed. Read-only.",
    parameters: IssuesMcpMilestoneHistoryInput,
    success: IssuesMcpMilestoneHistoryResult,
    failure: IssueTrackerError,
    dependencies,
  }).annotate(Tool.Title, "Get milestone burn-up"),
);

export const IssuesLabelsListTool = readonlyTrackerTool(
  Tool.make("issues_labels_list", {
    description: "List task labels with their colours. Read-only.",
    success: IssuesMcpLabelsListResult,
    failure: IssueTrackerError,
    dependencies,
  }).annotate(Tool.Title, "List labels"),
);

export const IssuesLabelCreateTool = writeTrackerTool(
  Tool.make("issues_label_create", {
    description:
      "Create a label, visible to everyone immediately. issues_create and issues_update also create missing labels, so use this to choose a colour.",
    parameters: IssuesMcpLabelCreateInput,
    success: IssuesMcpLabelResult,
    failure: IssueTrackerError,
    dependencies,
  }).annotate(Tool.Title, "Create label"),
);

export const IssuesLabelUpdateTool = writeTrackerTool(
  Tool.make("issues_label_update", {
    description:
      "Rename a label or change its colour on every task that carries it. Visible to everyone immediately.",
    parameters: IssuesMcpLabelUpdateInput,
    success: IssuesMcpLabelResult,
    failure: IssueTrackerError,
    dependencies,
  })
    .annotate(Tool.Title, "Update label")
    .annotate(Tool.Idempotent, true),
);

export const IssuesLabelDeleteTool = writeTrackerTool(
  Tool.make("issues_label_delete", {
    description:
      "Delete a label. It disappears from every task that carried it; visible to everyone immediately.",
    parameters: IssuesMcpLabelDeleteInput,
    success: IssuesMcpLabelsListResult,
    failure: IssueTrackerError,
    dependencies,
  }).annotate(Tool.Title, "Delete label"),
).annotate(Tool.Destructive, true);

export const IssuesStatusesListTool = readonlyTrackerTool(
  Tool.make("issues_statuses_list", {
    description:
      "List workflow statuses (board columns) in order, with their categories. Read-only.",
    parameters: IssuesMcpStatusesListInput,
    success: IssuesMcpStatusesListResult,
    failure: IssueTrackerError,
    dependencies,
  }).annotate(Tool.Title, "List statuses"),
);

export const IssuesStatusCreateTool = writeTrackerTool(
  Tool.make("issues_status_create", {
    description: "Add a workflow status (a board column). The new column is visible to everyone.",
    parameters: IssuesMcpStatusCreateInput,
    success: IssuesMcpStatusResult,
    failure: IssueTrackerError,
    dependencies,
  }).annotate(Tool.Title, "Create status"),
);

export const IssuesStatusUpdateTool = writeTrackerTool(
  Tool.make("issues_status_update", {
    description:
      "Rename a workflow status, change its colour, or move it to another category. Visible to everyone immediately.",
    parameters: IssuesMcpStatusUpdateInput,
    success: IssuesMcpStatusResult,
    failure: IssueTrackerError,
    dependencies,
  })
    .annotate(Tool.Title, "Update status")
    .annotate(Tool.Idempotent, true),
);

export const IssuesStatusDeleteTool = writeTrackerTool(
  Tool.make("issues_status_delete", {
    description:
      "Delete a workflow status, moving its tasks to another status, recorded against your name. Visible to everyone.",
    parameters: IssuesMcpStatusDeleteInput,
    success: IssuesMcpStatusesListResult,
    failure: IssueTrackerError,
    dependencies,
  }).annotate(Tool.Title, "Delete status"),
).annotate(Tool.Destructive, true);

export const IssuesStatusesReorderTool = writeTrackerTool(
  Tool.make("issues_statuses_reorder", {
    description: "Put the workflow statuses (board columns) in a new order, visible to everyone.",
    parameters: IssuesMcpStatusesReorderInput,
    success: IssuesMcpStatusesListResult,
    failure: IssueTrackerError,
    dependencies,
  })
    .annotate(Tool.Title, "Reorder statuses")
    .annotate(Tool.Idempotent, true),
);

export const IssuesToolkit = Toolkit.make(
  IssuesListTool,
  IssuesGetTool,
  IssuesGetAttachmentTool,
  IssuesMilestonesListTool,
  IssuesMilestoneCreateTool,
  IssuesMilestoneUpdateTool,
  IssuesMilestoneDeleteTool,
  IssuesCreateTool,
  IssuesUpdateTool,
  IssuesCommentTool,
  IssuesCommentEvidenceTool,
  IssuesDeleteTool,
  IssuesRestoreTool,
  IssuesLinkThreadTool,
  IssuesCommentUpdateTool,
  IssuesCommentDeleteTool,
  IssuesTodoCreateTool,
  IssuesTodoUpdateTool,
  IssuesTodoDeleteTool,
  IssuesTodosReorderTool,
  IssuesRelationCreateTool,
  IssuesRelationDeleteTool,
  IssuesUnlinkThreadTool,
  IssuesHistoryTool,
  IssuesTriageAcceptTool,
  IssuesTriageRejectTool,
  IssuesCyclesListTool,
  IssuesCycleCreateTool,
  IssuesCycleUpdateTool,
  IssuesCycleDeleteTool,
  IssuesMilestonesReorderTool,
  IssuesMilestoneHistoryTool,
  IssuesLabelsListTool,
  IssuesLabelCreateTool,
  IssuesLabelUpdateTool,
  IssuesLabelDeleteTool,
  IssuesStatusesListTool,
  IssuesStatusCreateTool,
  IssuesStatusUpdateTool,
  IssuesStatusDeleteTool,
  IssuesStatusesReorderTool,
);
