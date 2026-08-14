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
  ISSUE_COMMENT_MAX_CHARS,
  ISSUE_DESCRIPTION_MAX_CHARS,
  ISSUE_LABELS_MAX_PER_ISSUE,
  ISSUE_TITLE_MAX_CHARS,
  IssuePriority,
  IssueRelationDirection,
  IssueRelationKind,
  IssueStatusCategory,
  IssueThreadLinkOrigin,
  IssueTrackerError,
  PreviewAutomationRecordingArtifact,
  PreviewTabId,
} from "@spiritdevs/contracts";
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

const ASSIGNEE_GRAMMAR =
  'Who owns the issue: "user" for the human on this environment, "agent" for you (the calling agent), or "agent:<driver>" for a specific provider such as "agent:codex".';

const STATUS_GRAMMAR =
  'Status name such as "In Progress" (case-insensitive), or one of the six categories — backlog, unstarted, started, review, completed, canceled — which resolves to the first status in that category. Use "review" for pre-completion checks and "completed" rather than guessing the name of the done column.';

const issueKeyField = (verb: string) =>
  Schema.String.annotate({
    description: `Issue key to ${verb}, such as "PAT-12". Case-insensitive.`,
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
    "Case-insensitive substring matched against the issue key and title. Not a full-text search of descriptions or comments.",
  ),
  status: optionalName("Only issues in this status, by name (case-insensitive)."),
  statusCategory: Schema.optional(
    IssueStatusCategory.annotate({
      description:
        "Only issues whose status is in this category. Use completed to find finished work regardless of what the column is called.",
    }),
  ),
  project: optionalName("Only issues in this project, by project name (case-insensitive)."),
  label: optionalName("Only issues carrying this label, by name (case-insensitive)."),
  assignee: optionalName(`${ASSIGNEE_GRAMMAR} Pass "none" for unassigned issues.`),
  priority: Schema.optional(
    IssuePriority.annotate({ description: "Only issues at this priority." }),
  ),
  triage: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "true for triage items only, false to exclude them. Omitted, both are returned — triage items are issues with no status assigned yet.",
    }),
  ),
  includeDeleted: Schema.optional(
    Schema.Boolean.annotate({
      description: "Include soft-deleted issues. Defaults to false.",
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
      "Attachment id returned by issues_get. The attachment must belong to a comment on this issue.",
  }),
});

export const IssuesMcpGetAttachmentResult = Schema.Struct({
  key: Schema.String,
  attachment: IssuesMcpAttachment,
});
export type IssuesMcpGetAttachmentResult = typeof IssuesMcpGetAttachmentResult.Type;

export const IssuesMcpCreateInput = Schema.Struct({
  title: Schema.String.check(Schema.isMaxLength(ISSUE_TITLE_MAX_CHARS)).annotate({
    description: "One-line summary. Required.",
  }),
  description: Schema.optional(
    Schema.String.check(Schema.isMaxLength(ISSUE_DESCRIPTION_MAX_CHARS)).annotate({
      description: "Markdown body. Whitespace is significant and is not trimmed.",
    }),
  ),
  status: optionalName(
    `${STATUS_GRAMMAR} Omitted, the issue takes the first configured status — or none at all when triage is true.`,
  ),
  priority: Schema.optional(IssuePriority.annotate({ description: 'Defaults to "none".' })),
  project: optionalName("Project name. Must already exist; this tool does not create projects."),
  milestone: optionalName("Milestone name. Requires the issue to be in the milestone's project."),
  cycle: optionalName("Cycle name. Cycles span every project."),
  labels: labelNames(
    "Label names. A label that does not exist yet is created with a colour from the tracker's palette.",
  ),
  assignee: optionalName(ASSIGNEE_GRAMMAR),
  dueDate: optionalDate("Calendar day the issue is due."),
  parentKey: optionalName(
    'Key of the parent issue, making this a sub-issue, such as "PAT-4". Nesting is capped at three levels.',
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
        "Replacement markdown body. This overwrites the whole description, including any Investigation block already there — read the issue first if you mean to append.",
    }),
  ),
  status: optionalName(STATUS_GRAMMAR),
  priority: Schema.optional(IssuePriority.annotate({ description: "Replacement priority." })),
  assignee: clearableName(ASSIGNEE_GRAMMAR),
  project: clearableName("Project name."),
  milestone: clearableName(
    "Milestone name. Cleared automatically when the issue leaves the milestone's project.",
  ),
  cycle: clearableName("Cycle name."),
  labels: labelNames(
    "Replace the label set outright with these names. Names that do not exist yet are created. Prefer addLabels/removeLabels unless you mean to drop the rest.",
  ),
  addLabels: labelNames("Label names to add, keeping the ones already there. Created if missing."),
  removeLabels: labelNames(
    "Label names to take off this issue. The label itself survives on other issues.",
  ),
  dueDate: Schema.optional(
    Schema.NullOr(Schema.String).annotate({
      description: "Calendar day the issue is due, YYYY-MM-DD. Pass null to clear it.",
    }),
  ),
  parentKey: clearableName('Key of the parent issue, such as "PAT-4".'),
  triage: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "Move the issue in or out of triage. Setting it false without a status leaves the issue where it is.",
    }),
  ),
});
export type IssuesMcpUpdateInput = typeof IssuesMcpUpdateInput.Type;

export const IssuesMcpCommentInput = Schema.Struct({
  key: issueKeyField("comment on"),
  body: Schema.String.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(ISSUE_COMMENT_MAX_CHARS),
  ).annotate({
    description: "Markdown comment body. Whitespace is significant and is not trimmed.",
  }),
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
      "Search this environment's issue tracker. Filters combine with AND; every filter names things the way a person does — a status name or category, a project name, a label name. Returns compact rows newest-updated first, and reports how many matched so a truncated answer is never mistaken for the whole tracker. Read-only.",
    parameters: IssuesMcpListInput,
    success: IssuesMcpListResult,
    failure: IssueTrackerError,
    dependencies,
  }).annotate(Tool.Title, "List issues"),
);

export const IssuesGetTool = readonlyTrackerTool(
  Tool.make("issues_get", {
    description:
      "Read one issue in full by key: description, labels, milestone and cycle, sub-issue keys, checklist todos, relations, comments, and attachments. Each comment includes its attachment ids; the issue-level attachment list includes the source comment body and author. Available images are returned directly as MCP image content, within a bounded eager-load budget; use issues_get_attachment for any listed image that was not included. Read-only. Works on soft-deleted issues too.",
    parameters: IssuesMcpGetInput,
    success: IssuesMcpDetail,
    failure: IssueTrackerError,
    dependencies,
  }).annotate(Tool.Title, "Get issue detail"),
);

export const IssuesGetAttachmentTool = readonlyTrackerTool(
  Tool.make("issues_get_attachment", {
    description:
      "Read one attachment listed by issues_get together with its source comment body, author, and timestamp. Images are returned directly as MCP image content. Video metadata is returned as text because MCP has no inline video content block; the video remains playable on the Pathway issue. The attachment must belong to the named issue. Read-only.",
    parameters: IssuesMcpGetAttachmentInput,
    success: IssuesMcpGetAttachmentResult,
    failure: IssueTrackerError,
    dependencies,
  }).annotate(Tool.Title, "Get issue attachment"),
);

export const IssuesCreateTool = writeTrackerTool(
  Tool.make("issues_create", {
    description:
      "File a new issue and return it, including the key it was given. This writes to the tracker and shows up immediately in everyone's list view, attributed to you in the issue's change log. Labels named here are created if they do not exist yet; projects, milestones, and cycles are not.",
    parameters: IssuesMcpCreateInput,
    success: IssuesMcpIssueResult,
    failure: IssueTrackerError,
    dependencies,
  }).annotate(Tool.Title, "Create issue"),
);

export const IssuesUpdateTool = writeTrackerTool(
  Tool.make("issues_update", {
    description:
      "Change fields on one issue. Patch semantics: an omitted field is left alone and an explicit null clears it. This writes to the tracker, is visible to everyone immediately, and every field change is recorded against your name in the issue's change log. Setting a status in the completed category is how you mark work done.",
    parameters: IssuesMcpUpdateInput,
    success: IssuesMcpIssueResult,
    failure: IssueTrackerError,
    dependencies,
  })
    .annotate(Tool.Title, "Update issue")
    .annotate(Tool.Idempotent, true),
);

export const IssuesCommentTool = writeTrackerTool(
  Tool.make("issues_comment", {
    description:
      "Post a markdown comment on an issue, attributed to you. This is visible to everyone reading the issue and cannot be posted silently — use it to report what you found or did, not to talk to yourself.",
    parameters: IssuesMcpCommentInput,
    success: IssuesMcpCommentResult,
    failure: IssueTrackerError,
    dependencies,
  }).annotate(Tool.Title, "Comment on issue"),
);

export const IssuesCommentEvidenceTool = writeTrackerTool(
  Tool.make("issues_comment_evidence", {
    description:
      "Capture browser proof and post it to an issue as an attributed markdown comment with an inline attachment. For a screenshot, this captures the current Preview tab. For video, call preview_recording_start and preview_recording_stop first, then pass the returned artifact unchanged. The evidence is copied into the issue so it remains reviewable from other devices. This is visible to everyone reading the issue.",
    parameters: IssuesMcpCommentEvidenceInput,
    success: IssuesMcpCommentResult,
    failure: IssueTrackerError,
    dependencies: evidenceDependencies,
  }).annotate(Tool.Title, "Attach browser evidence to issue"),
).annotate(Tool.OpenWorld, true);

export const IssuesDeleteTool = writeTrackerTool(
  Tool.make("issues_delete", {
    description:
      "Delete an issue. The delete is soft — the row keeps its key and its history, disappears from the list view, and is recoverable with issues_restore — but it is not a draft operation: everyone stops seeing the issue, and the deletion is recorded against your name. Sub-issues are not deleted with it.",
    parameters: IssuesMcpDeleteInput,
    success: IssuesMcpIssueResult,
    failure: IssueTrackerError,
    dependencies,
  }).annotate(Tool.Title, "Delete issue"),
)
  // Annotated outside the wrapper: `writeTrackerTool` clears the destructive hint for the rest of
  // the toolkit, and this is the one tool that earns it back.
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true);

export const IssuesRestoreTool = writeTrackerTool(
  Tool.make("issues_restore", {
    description:
      "Take a soft-deleted issue back out of the bin and return it to the list view, recorded against your name. Use this to undo an issues_delete, yours or anyone's.",
    parameters: IssuesMcpRestoreInput,
    success: IssuesMcpIssueResult,
    failure: IssueTrackerError,
    dependencies,
  })
    .annotate(Tool.Title, "Restore issue")
    .annotate(Tool.Idempotent, true),
);

export const IssuesLinkThreadTool = writeTrackerTool(
  Tool.make("issues_link_thread", {
    description:
      "Record that a thread is working this issue, so the issue shows the conversation and the conversation shows the issue. Defaults to your own thread. Linking is a record only: it starts nothing, and it is idempotent per issue and thread.",
    parameters: IssuesMcpLinkThreadInput,
    success: IssuesMcpThreadLinksResult,
    failure: IssueTrackerError,
    dependencies,
  })
    .annotate(Tool.Title, "Link thread to issue")
    .annotate(Tool.Idempotent, true),
);

export const IssuesToolkit = Toolkit.make(
  IssuesListTool,
  IssuesGetTool,
  IssuesGetAttachmentTool,
  IssuesCreateTool,
  IssuesUpdateTool,
  IssuesCommentTool,
  IssuesCommentEvidenceTool,
  IssuesDeleteTool,
  IssuesRestoreTool,
  IssuesLinkThreadTool,
);
