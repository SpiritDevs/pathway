/**
 * IssueTrackerService - the issue tracker's write model and change feed.
 *
 * Environment-scoped plain state rather than an orchestration aggregate (decision 0006): issue
 * CRUD would drown the decider in commands. Every mutation writes an `issue_events` row and
 * publishes a diff, which is what makes the feed, the audit trail for agent writes, and the undo
 * substrate one thing instead of three.
 *
 * Every write takes an `actor`. Stage 1 only ever passes the human on this environment; the
 * parameter is here so the MCP toolkit in stage 4 can pass an agent without reshaping the service.
 *
 * @module issues/IssueTrackerService
 */
import {
  ISSUE_COMMENT_ATTACHMENT_MAX_BYTES,
  ISSUE_MAX_PARENT_DEPTH,
  ISSUE_TITLE_MAX_CHARS,
  SLACK_MAX_CHANNEL_WATCHES,
  isPlaceholderIssueTitle,
  type Issue,
  type IssueActor,
  type IssueBulkUpdateInput,
  type IssueComment,
  type IssueCommentAttachmentUploadInput,
  type IssueCommentAttachmentUploadResult,
  type IssueCommentCreateInput,
  type IssueCommentDeleteInput,
  IssueCommentId,
  type IssueCommentResult,
  type IssueCommentUpdateInput,
  type IssueCommentsResult,
  type IssueCreateInput,
  type IssueCycle,
  type IssueCycleCreateInput,
  type IssueCycleDeleteInput,
  IssueCycleId,
  type IssueCycleResult,
  type IssueCycleUpdateInput,
  type IssueCyclesResult,
  type IssueDetail,
  type IssueEnrichmentRun,
  IssueEnrichmentRunId,
  type IssueEnrichmentRunRefInput,
  type IssueEnrichmentRunResult,
  type IssueEnrichmentRunsResult,
  type IssueEnrichmentStartInput,
  IssueEventId,
  type IssueEvent,
  IssueId,
  type IssueLabel,
  IssueLabelId,
  type IssueLabelCreateInput,
  type IssueLabelDeleteInput,
  type IssueLabelResult,
  type IssueLabelUpdateInput,
  type IssueLabelsResult,
  type IssueKeyPrefixInput,
  type IssueMilestone,
  type IssueMilestoneCreateInput,
  type IssueMilestoneDeleteInput,
  IssueMilestoneId,
  type IssueMilestoneResult,
  type IssueMilestoneUpdateInput,
  type IssueMilestonesReorderInput,
  type IssueMilestonesResult,
  type IssuePatch,
  type IssueRefInput,
  type IssueRelation,
  type IssueRelationCreateInput,
  type IssueRelationDeleteInput,
  type IssueRelationDirection,
  IssueRelationId,
  type IssueRelationKind,
  type IssueRelationsResult,
  type IssueResult,
  type IssueSetSortOrderInput,
  type IssueSlackSource,
  type IssueStatus,
  type IssueStatusCategory,
  type IssueStatusCreateInput,
  type IssueStatusDeleteInput,
  IssueStatusId,
  type IssueStatusResult,
  type IssueStatusUpdateInput,
  type IssueStatusesReorderInput,
  type IssueStatusesResult,
  type IssueTodo,
  type IssueTodoCreateInput,
  type IssueTodoDeleteInput,
  IssueTodoId,
  type IssueTodoUpdateInput,
  type IssueTodosReorderInput,
  type IssueTodosResult,
  type IssueThreadLink,
  type IssueThreadLinkInput,
  type IssueThreadLinksResult,
  type IssueThreadUnlinkInput,
  type IssueTrackerConfigResult,
  IssueTrackerError,
  type IssueTriageAcceptInput,
  type IssueTriageAcceptResult,
  type IssueUpdateInput,
  type IssueView,
  type IssueViewCreateInput,
  type IssueViewDeleteInput,
  IssueViewId,
  type IssueViewResult,
  type IssueViewUpdateInput,
  type IssueViewsReorderInput,
  type IssueViewsResult,
  type IssuesGetEventsResult,
  type IssuesImportCsvInput,
  type IssuesImportCsvResult,
  type IssuesImportCsvSkip,
  type IssuesResult,
  type IssuesSnapshot,
  type IssuesStreamEvent,
  ProviderDriverKind,
  type ProjectId,
  type SlackChannelId,
  type SlackChannelWatch,
  SlackChannelWatchId,
  type SlackChannelsResult,
  type SlackIntakeStatus,
  type SlackIntakeStatusResult,
  type SlackIntakeTrigger,
  type SlackMessageTs,
  type SlackSetTokenInput,
  type SlackWatchCreateInput,
  type SlackWatchDeleteInput,
  type SlackWatchResult,
  type SlackWatchUpdateInput,
  type SlackWatchesResult,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import {
  createIssueAttachmentId,
  parseIssueSegmentFromAttachmentId,
  resolveAttachmentPath,
  toSafeIssueAttachmentSegment,
} from "../attachmentStore.ts";
import { ServerSecretStore, type SecretStoreError } from "../auth/ServerSecretStore.ts";
import { ServerConfig } from "../config.ts";
import { parseBase64DataUrl } from "../imageMime.ts";
import type { IssueTrackerRepositoryError } from "../persistence/Errors.ts";
import { IssueCommentRepository } from "../persistence/Services/IssueComments.ts";
import { IssueCycleRepository } from "../persistence/Services/IssueCycles.ts";
import { IssueEnrichmentRunRepository } from "../persistence/Services/IssueEnrichmentRuns.ts";
import { IssueEventRepository } from "../persistence/Services/IssueEvents.ts";
import { IssueLabelRepository } from "../persistence/Services/IssueLabels.ts";
import { IssueMilestoneRepository } from "../persistence/Services/IssueMilestones.ts";
import { IssueRelationRepository } from "../persistence/Services/IssueRelations.ts";
import { IssueRepository, type IssueRecord } from "../persistence/Services/Issues.ts";
import { IssueStatusRepository } from "../persistence/Services/IssueStatuses.ts";
import { IssueThreadLinkRepository } from "../persistence/Services/IssueThreadLinks.ts";
import { IssueTodoRepository } from "../persistence/Services/IssueTodos.ts";
import { IssueTrackerConfigRepository } from "../persistence/Services/IssueTrackerConfig.ts";
import { IssueViewRepository } from "../persistence/Services/IssueViews.ts";
import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import { SlackChannelWatchRepository } from "../persistence/Services/SlackChannelWatches.ts";
import { SlackIntakeLedgerRepository } from "../persistence/Services/SlackIntakeLedger.ts";
import { IssueEnrichmentEngine, type IssueEnrichmentRunRecorder } from "./IssueEnrichmentEngine.ts";
import { SlackIntakeEngine } from "./slack/SlackIntakeEngine.ts";
// The poller reads the same file at the top of every cycle; one name, so they cannot drift.
import { SLACK_BOT_TOKEN_SECRET } from "./slack/slackToken.ts";
import { buildInvestigationComment } from "./enrichment.ts";
import {
  guessIssueStatusCategory,
  importedKeyPrefix,
  importedMaxKeyNumber,
  planIssueCsvImport,
  type PlannedIssueImportRow,
} from "./csvImport.ts";
import { issueSortOrderAfter } from "./sortOrder.ts";

/** Seeded by migration 041. Only a tracker still wearing it adopts a prefix from an import. */
const DEFAULT_ISSUE_KEY_PREFIX = "ISS";
/** `IssueKeyPrefix` in the contracts caps a prefix at ten characters. */
const ISSUE_KEY_PREFIX_MAX_CHARS = 10;
/** The change log is a feed, not a diff viewer: a 100k-character body is stored, not replayed. */
const EVENT_VALUE_MAX_CHARS = 512;

/**
 * Why a cancelled run has no result. There is no `canceled` state — the panel has one place to
 * look for why a run came back empty, and this is one of the things it finds written there.
 */
const ENRICHMENT_CANCELED_REASON = "Canceled.";
/** A run is a live process: nothing that was in flight when this server stopped is still alive. */
const ENRICHMENT_SERVER_RESTARTED_REASON = "The server restarted while this run was in flight.";

const CATEGORY_ORDER: ReadonlyArray<IssueStatusCategory> = [
  "backlog",
  "unstarted",
  "started",
  "review",
  "completed",
  "canceled",
];

/** A new issue starts in the first column that means "not begun", which is where a list opens. */
const DEFAULT_STATUS_CATEGORIES: ReadonlySet<IssueStatusCategory> = new Set([
  "backlog",
  "unstarted",
]);

const CATEGORY_COLORS: Readonly<Record<IssueStatusCategory, string>> = {
  backlog: "#95a2b3",
  unstarted: "#e2e2e2",
  started: "#f2c94c",
  review: "#26b5ce",
  completed: "#5e6ad2",
  canceled: "#95a2b3",
};

/** Every write intake makes is the tracker acting on somebody's behalf, never a person. */
const SLACK_ACTOR: IssueActor = { kind: "system", source: "slack" };

/** A watch created without one: configured, watched, and filing nothing until it is switched on. */
const PAUSED_SLACK_TRIGGER: SlackIntakeTrigger = {
  reactionRoutes: [],
  everyMessage: false,
  botMention: false,
};

const slackTriggersEqual = (left: SlackIntakeTrigger, right: SlackIntakeTrigger): boolean =>
  left.everyMessage === right.everyMessage &&
  left.botMention === right.botMention &&
  left.reactionRoutes.length === right.reactionRoutes.length &&
  left.reactionRoutes.every((route, index) => {
    const other = right.reactionRoutes[index];
    return (
      other !== undefined &&
      route.emoji === other.emoji &&
      route.projectId === other.projectId &&
      route.autoInvestigate === other.autoInvestigate
    );
  });

/**
 * What a filed message is called when it had no text — an image, a file, a bare reaction target.
 * Refusing to file it would be worse: somebody reacted to it on purpose.
 *
 * Exported for the coupling rather than for use: this string has to stay inside
 * `isPlaceholderIssueTitle`, or an image-only Slack report becomes the one issue an investigation
 * is forbidden to name. A test asserts exactly that.
 */
export const SLACK_UNTITLED_ISSUE_TITLE = "Slack message";

const textEncoder = new TextEncoder();

/** Imported labels arrive with a name and nothing else; these are the colours they land in. */
const IMPORTED_LABEL_COLORS: ReadonlyArray<string> = [
  "#eb5757",
  "#f2994a",
  "#f2c94c",
  "#4cb782",
  "#26b5ce",
  "#5e6ad2",
  "#bb87fc",
  "#95a2b3",
];

/**
 * What intake's transport hands over for one watched message.
 *
 * Plain interfaces rather than schemas, because none of this crosses a socket: the transport lives
 * in this process and these are the two calls it makes inward.
 */
export interface IssueIntakeCreateInput {
  readonly channelId: SlackChannelId;
  /** Slack's message identity, and the thread everything about this issue is posted back into. */
  readonly messageTs: SlackMessageTs;
  /** Normalised here rather than by the caller: a Slack message is not a title until it is cut. */
  readonly title: string;
  readonly description?: string | undefined;
  /** The channel's auto-tag target. Null files the issue under no project, which is allowed. */
  readonly projectId?: ProjectId | null | undefined;
  /** The channel's release-planning default. Null leaves the issue outside a cycle. */
  readonly cycleId?: IssueCycleId | null | undefined;
  readonly permalink?: string | null | undefined;
  readonly authorName?: string | null | undefined;
}

export interface IssueIntakeCreateResult {
  readonly issue: Issue;
  /** False when this message had already been filed, which an overlapping poll makes ordinary. */
  readonly created: boolean;
}

export interface IssueIntakeCommentInput {
  readonly channelId: SlackChannelId;
  /** The parent message's ts, which is the key the issue was filed under. */
  readonly threadTs: SlackMessageTs;
  /** The reply's own ts, which is what dedupes it. */
  readonly messageTs: SlackMessageTs;
  readonly authorName?: string | null | undefined;
  readonly body: string;
  /**
   * Images the transport already put in the store through
   * {@link IssueTrackerServiceShape.uploadCommentAttachment}, so they are namespaced to this issue
   * before they get here. Slack images cannot ride on the issue itself — an attachment is an id on
   * a comment row, and a description is Markdown with nowhere to hang one.
   */
  readonly attachmentIds?: ReadonlyArray<string> | undefined;
}

export interface IssueIntakeCommentResult {
  /** Null when the thread routes to no issue, or when this reply had already been attached. */
  readonly comment: IssueComment | null;
}

export interface IssueTrackerServiceShape {
  /**
   * Everything the list view needs. Reading it is also when an ended cycle gets carried over:
   * there is no scheduler here, so finalisation rides on the next read.
   */
  readonly getSnapshot: () => Effect.Effect<IssuesSnapshot, IssueTrackerError>;
  /**
   * The per-issue tail — todos, relations, comments — read when a detail sheet opens. These are
   * the three sets that grow with usage rather than configuration, which is why they are not in
   * the snapshot.
   */
  readonly getDetail: (input: IssueRefInput) => Effect.Effect<IssueDetail, IssueTrackerError>;
  readonly create: (
    input: IssueCreateInput,
    actor: IssueActor,
  ) => Effect.Effect<IssueResult, IssueTrackerError>;
  readonly update: (
    input: IssueUpdateInput,
    actor: IssueActor,
  ) => Effect.Effect<IssueResult, IssueTrackerError>;
  readonly remove: (
    input: IssueRefInput,
    actor: IssueActor,
  ) => Effect.Effect<IssueResult, IssueTrackerError>;
  readonly restore: (
    input: IssueRefInput,
    actor: IssueActor,
  ) => Effect.Effect<IssueResult, IssueTrackerError>;
  readonly bulkUpdate: (
    input: IssueBulkUpdateInput,
    actor: IssueActor,
  ) => Effect.Effect<IssuesResult, IssueTrackerError>;
  readonly setSortOrder: (
    input: IssueSetSortOrderInput,
    actor: IssueActor,
  ) => Effect.Effect<IssueResult, IssueTrackerError>;
  readonly createStatus: (
    input: IssueStatusCreateInput,
  ) => Effect.Effect<IssueStatusResult, IssueTrackerError>;
  readonly updateStatus: (
    input: IssueStatusUpdateInput,
  ) => Effect.Effect<IssueStatusResult, IssueTrackerError>;
  readonly deleteStatus: (
    input: IssueStatusDeleteInput,
    actor: IssueActor,
  ) => Effect.Effect<IssueStatusesResult, IssueTrackerError>;
  readonly reorderStatuses: (
    input: IssueStatusesReorderInput,
  ) => Effect.Effect<IssueStatusesResult, IssueTrackerError>;
  readonly createLabel: (
    input: IssueLabelCreateInput,
  ) => Effect.Effect<IssueLabelResult, IssueTrackerError>;
  readonly updateLabel: (
    input: IssueLabelUpdateInput,
  ) => Effect.Effect<IssueLabelResult, IssueTrackerError>;
  readonly deleteLabel: (
    input: IssueLabelDeleteInput,
  ) => Effect.Effect<IssueLabelsResult, IssueTrackerError>;
  readonly milestoneCreate: (
    input: IssueMilestoneCreateInput,
  ) => Effect.Effect<IssueMilestoneResult, IssueTrackerError>;
  /**
   * Moving a milestone between projects takes its planning context with it, so any issue left
   * behind in the old project loses the milestone and says so in its change log.
   */
  readonly milestoneUpdate: (
    input: IssueMilestoneUpdateInput,
    actor: IssueActor,
  ) => Effect.Effect<IssueMilestoneResult, IssueTrackerError>;
  /**
   * Unlike a status, a milestone has an empty value, so a delete does not ask where its issues go:
   * they land unassigned and stay in the project.
   */
  readonly milestoneDelete: (
    input: IssueMilestoneDeleteInput,
    actor: IssueActor,
  ) => Effect.Effect<IssueMilestonesResult, IssueTrackerError>;
  readonly milestonesReorder: (
    input: IssueMilestonesReorderInput,
  ) => Effect.Effect<IssueMilestonesResult, IssueTrackerError>;
  readonly cycleCreate: (
    input: IssueCycleCreateInput,
  ) => Effect.Effect<IssueCycleResult, IssueTrackerError>;
  readonly cycleUpdate: (
    input: IssueCycleUpdateInput,
  ) => Effect.Effect<IssueCycleResult, IssueTrackerError>;
  readonly cycleDelete: (
    input: IssueCycleDeleteInput,
    actor: IssueActor,
  ) => Effect.Effect<IssueCyclesResult, IssueTrackerError>;
  /**
   * Todos write no `issue_events` rows, unlike every other mutation here. A checklist is ticked
   * and re-ticked a dozen times an issue, and logging that churn would bury the feed the log
   * exists to be.
   */
  readonly todoCreate: (
    input: IssueTodoCreateInput,
  ) => Effect.Effect<IssueTodosResult, IssueTrackerError>;
  readonly todoUpdate: (
    input: IssueTodoUpdateInput,
  ) => Effect.Effect<IssueTodosResult, IssueTrackerError>;
  readonly todoDelete: (
    input: IssueTodoDeleteInput,
  ) => Effect.Effect<IssueTodosResult, IssueTrackerError>;
  readonly todosReorder: (
    input: IssueTodosReorderInput,
  ) => Effect.Effect<IssueTodosResult, IssueTrackerError>;
  /**
   * One row, read from both ends. The change log gets a row on each issue, phrased from that
   * issue's side: "blocks PAT-12" on one and "blocked by PAT-9" on the other.
   */
  readonly relationCreate: (
    input: IssueRelationCreateInput,
    actor: IssueActor,
  ) => Effect.Effect<IssueRelationsResult, IssueTrackerError>;
  readonly relationDelete: (
    input: IssueRelationDeleteInput,
    actor: IssueActor,
  ) => Effect.Effect<IssueRelationsResult, IssueTrackerError>;
  /**
   * Comments write no `issue_events` rows either, for the opposite reason to todos: a comment is
   * already its own visible record, and logging it would print every one of them twice.
   */
  readonly commentCreate: (
    input: IssueCommentCreateInput,
    actor: IssueActor,
  ) => Effect.Effect<IssueCommentResult, IssueTrackerError>;
  readonly commentUpdate: (
    input: IssueCommentUpdateInput,
    actor: IssueActor,
  ) => Effect.Effect<IssueCommentResult, IssueTrackerError>;
  readonly commentDelete: (
    input: IssueCommentDeleteInput,
    actor: IssueActor,
  ) => Effect.Effect<IssueCommentsResult, IssueTrackerError>;
  readonly commentsList: (
    input: IssueRefInput,
  ) => Effect.Effect<IssueCommentsResult, IssueTrackerError>;
  /**
   * Decode one base64 image data URL into the attachment store under the issue's own namespace,
   * and answer with the id a comment can then carry. The bytes are served by the assets route, so
   * this is the only time an image crosses the socket.
   */
  readonly uploadCommentAttachment: (
    input: IssueCommentAttachmentUploadInput,
  ) => Effect.Effect<IssueCommentAttachmentUploadResult, IssueTrackerError>;
  /**
   * Saved views: a named filter, grouping, sort, and layout. They write no `issue_events` rows —
   * a view is a lens on the tracker, and nothing about an issue moved when one was renamed.
   */
  readonly viewCreate: (
    input: IssueViewCreateInput,
  ) => Effect.Effect<IssueViewResult, IssueTrackerError>;
  readonly viewUpdate: (
    input: IssueViewUpdateInput,
  ) => Effect.Effect<IssueViewResult, IssueTrackerError>;
  readonly viewDelete: (
    input: IssueViewDeleteInput,
  ) => Effect.Effect<IssueViewsResult, IssueTrackerError>;
  readonly viewsReorder: (
    input: IssueViewsReorderInput,
  ) => Effect.Effect<IssueViewsResult, IssueTrackerError>;
  /**
   * Rename the prefix new keys are minted with. Issued keys are left alone, so this is the one
   * config write that changes nothing already on screen.
   */
  readonly setKeyPrefix: (
    input: IssueKeyPrefixInput,
  ) => Effect.Effect<IssueTrackerConfigResult, IssueTrackerError>;
  readonly importCsv: (
    input: IssuesImportCsvInput,
    actor: IssueActor,
  ) => Effect.Effect<IssuesImportCsvResult, IssueTrackerError>;
  readonly getEvents: (
    input: IssueRefInput,
  ) => Effect.Effect<IssuesGetEventsResult, IssueTrackerError>;
  /**
   * Fire a read-only investigation of the issue's repository by hand.
   *
   * Refused as `invalid` when one is already queued or running for this issue, and when the
   * issue's project is rootless or absent: enrichment reads a directory, and there is nothing to
   * read. This writes the queued record and hands it to {@link IssueEnrichmentEngine}; the record
   * and the change feed are this service's, the process is the engine's.
   */
  readonly startEnrichment: (
    input: IssueEnrichmentStartInput,
  ) => Effect.Effect<IssueEnrichmentRunResult, IssueTrackerError>;
  /**
   * Stop a run and land it in `failed`. There is no `canceled` state: the panel has one place to
   * look for why a run has no result, and "canceled" is one of the reasons it finds there.
   */
  readonly cancelEnrichment: (
    input: IssueEnrichmentRunRefInput,
  ) => Effect.Effect<IssueEnrichmentRunResult, IssueTrackerError>;
  /** One issue's runs, newest first. */
  readonly getEnrichmentRuns: (
    input: IssueRefInput,
  ) => Effect.Effect<IssueEnrichmentRunsResult, IssueTrackerError>;
  /**
   * Record that a thread is working this issue. Linking is the only thing that happens here:
   * seeding and opening the thread is the client's, which is why a stray kanban drag cannot start
   * three agents. Idempotent per pair, and written to the change log as a `thread` field change.
   */
  readonly linkThread: (
    input: IssueThreadLinkInput,
    actor: IssueActor,
  ) => Effect.Effect<IssueThreadLinksResult, IssueTrackerError>;
  readonly unlinkThread: (
    input: IssueThreadUnlinkInput,
    actor: IssueActor,
  ) => Effect.Effect<IssueThreadLinksResult, IssueTrackerError>;
  readonly getThreadLinks: (
    input: IssueRefInput,
  ) => Effect.Effect<IssueThreadLinksResult, IssueTrackerError>;
  /**
   * Store the Slack bot token, or clear it with an empty string.
   *
   * The token is tried against Slack before it is written, so `configured` never means
   * "configured with something broken". A token that does not work is refused and the failure is
   * left on the status for the settings page to show.
   */
  readonly slackSetToken: (
    input: SlackSetTokenInput,
  ) => Effect.Effect<SlackIntakeStatusResult, IssueTrackerError>;
  readonly slackGetStatus: () => Effect.Effect<SlackIntakeStatusResult, IssueTrackerError>;
  /** Asked of Slack, not of the database: the picker lists what the bot can actually see. */
  readonly slackListChannels: () => Effect.Effect<SlackChannelsResult, IssueTrackerError>;
  /**
   * Watch a channel. Refused as `conflict` when the channel is already watched: two watches would
   * poll it twice and file everything twice.
   */
  readonly slackWatchCreate: (
    input: SlackWatchCreateInput,
  ) => Effect.Effect<SlackWatchResult, IssueTrackerError>;
  readonly slackWatchUpdate: (
    input: SlackWatchUpdateInput,
  ) => Effect.Effect<SlackWatchResult, IssueTrackerError>;
  /**
   * Stop watching a channel. Its cursor and its processed messages stay: unwatching is usually a
   * pause, and re-watching a swept channel would refile everything still in Slack's history.
   */
  readonly slackWatchDelete: (
    input: SlackWatchDeleteInput,
  ) => Effect.Effect<SlackWatchesResult, IssueTrackerError>;
  /**
   * Accept a triage item: status, project, and priority in one write, and optionally the
   * investigation.
   *
   * One action rather than three, because a triage item has no status — applying them separately
   * would put a half-triaged issue on the board, which is the state triage exists to prevent.
   * Enrichment refusing (a rootless project, a run already in flight) does not undo the accept;
   * it comes back as `enrichmentRefusal` beside the accepted issue.
   */
  readonly triageAccept: (
    input: IssueTriageAcceptInput,
    actor: IssueActor,
  ) => Effect.Effect<IssueTriageAcceptResult, IssueTrackerError>;
  /**
   * Turn a triage item down. A soft delete underneath, logged as `triage_rejected` rather than
   * `deleted`: "this never was an issue" and "somebody deleted this issue" are different stories,
   * and rejecting is the ordinary outcome of intake. `triage` is left set, so restoring the row
   * puts it back in the queue rather than loose in the backlog.
   */
  readonly triageReject: (
    input: IssueRefInput,
    actor: IssueActor,
  ) => Effect.Effect<IssueResult, IssueTrackerError>;
  /**
   * File a watched channel's message as a triage item. Not an RPC: intake's transport calls this,
   * and nothing else should.
   *
   * Deduped on `(channelId, messageTs)` through the processed-message ledger, because a poll
   * window overlaps the last one by design — a cursor is a floor, not a fence. A message already
   * filed comes back with `created: false` and the issue it became.
   */
  readonly intakeCreateIssue: (
    input: IssueIntakeCreateInput,
  ) => Effect.Effect<IssueIntakeCreateResult, IssueTrackerError>;
  /**
   * Attach a Slack thread reply to the issue its parent message became. Not an RPC, for the same
   * reason.
   *
   * Answers with a null comment rather than failing when the thread routes nowhere: most replies
   * in a watched channel are on threads that never became issues, and that is not an error.
   */
  readonly intakeAddComment: (
    input: IssueIntakeCommentInput,
  ) => Effect.Effect<IssueIntakeCommentResult, IssueTrackerError>;
  /**
   * Report the outcome of one poll. Not an RPC: this is how the transport keeps the status the
   * settings page reads honest, and `null` is the error being cleared by a pass that worked.
   */
  readonly slackRecordPoll: (input: {
    readonly error: string | null;
  }) => Effect.Effect<SlackIntakeStatus, IssueTrackerError>;
  /**
   * Remember that the bot posted this message, so the next poll does not read it back.
   *
   * Not an RPC. This registry is the entire echo-suppression story: without it, a status change
   * posted into a thread comes back as a message in a watched channel and becomes an issue.
   */
  readonly slackRecordOutboundPost: (input: {
    readonly channelId: SlackChannelId;
    readonly messageTs: SlackMessageTs;
  }) => Effect.Effect<void, IssueTrackerError>;
  /**
   * The whole tracker as diffs, then every later diff. Subscribing happens before the read, so a
   * write that lands mid-read is repeated rather than lost — every event on this stream is an
   * upsert or a removal, so seeing one twice costs nothing.
   */
  readonly stream: Stream.Stream<IssuesStreamEvent, IssueTrackerError>;
}

export class IssueTrackerService extends Context.Service<
  IssueTrackerService,
  IssueTrackerServiceShape
>()("t3/issues/IssueTrackerService") {}

const notFound = (subject: string, message: string) =>
  new IssueTrackerError({ reason: "not-found", message, subject });

const conflict = (message: string, subject?: string) =>
  new IssueTrackerError({
    reason: "conflict",
    message,
    ...(subject === undefined ? {} : { subject }),
  });

const invalid = (message: string, subject?: string) =>
  new IssueTrackerError({
    reason: "invalid",
    message,
    ...(subject === undefined ? {} : { subject }),
  });

const storage = (operation: string) => (cause: IssueTrackerRepositoryError) =>
  new IssueTrackerError({ reason: "storage", message: `${operation}: ${cause.message}` });

const categoryRank = (category: IssueStatusCategory) => CATEGORY_ORDER.indexOf(category);

/** Trim to null, so "" and "   " off a Slack payload mean absent rather than a blank field. */
const nullableTrimmed = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim() ?? "";
  return trimmed.length === 0 ? null : trimmed;
};

/**
 * A Slack message is not a title until it is cut down to one.
 *
 * Newlines collapse because a title is one line, and the whole thing is capped at the schema's
 * ceiling — the body keeps the full text, so nothing is lost by cutting here. An empty result is
 * named rather than refused: a message that is only an image is still worth filing when somebody
 * has deliberately reacted to it.
 */
const normalizeSlackTitle = (title: string): string => {
  const collapsed = title.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return SLACK_UNTITLED_ISSUE_TITLE;
  return collapsed.length <= ISSUE_TITLE_MAX_CHARS
    ? collapsed
    : `${collapsed.slice(0, ISSUE_TITLE_MAX_CHARS - 1)}…`;
};

const truncateEventValue = (value: string) =>
  value.length <= EVENT_VALUE_MAX_CHARS ? value : `${value.slice(0, EVENT_VALUE_MAX_CHARS)}…`;

const describeAssignee = (assignee: Issue["assignee"]) =>
  assignee === null ? null : assignee.kind === "user" ? "user" : `agent:${assignee.provider}`;

interface IssueFieldChange {
  /** Null on the kinds that are not `field_changed`: a create, a delete, an import. */
  readonly field: string | null;
  readonly before: string | null;
  readonly after: string | null;
}

/** The single log row a create, delete, restore, or import writes. */
const WHOLE_ISSUE_CHANGE: ReadonlyArray<IssueFieldChange> = [
  { field: null, before: null, after: null },
];

/**
 * The actor that last chose an issue's title. A field change wins; otherwise creation/import is
 * the provenance of the initial title. Missing history is treated conservatively by callers.
 */
export function latestIssueTitleActor(events: ReadonlyArray<IssueEvent>): IssueActor | null {
  const changed = events.findLast((event) => event.field === "title");
  if (changed !== undefined) return changed.actor;
  return (
    events.find((event) => event.kind === "created" || event.kind === "imported")?.actor ?? null
  );
}

/**
 * Fields an investigation may write without asking. Priority is the investigation's direct
 * classification. Description only fills a body that is still empty. A title is automatic only
 * while it is still a generic intake title and its latest writer was not the user; a user-created
 * or user-edited title remains a reviewable suggestion in the client.
 */
export function issueEnrichmentAutomaticPatch(input: {
  readonly issue: Pick<Issue, "title" | "description" | "priority">;
  readonly result: NonNullable<IssueEnrichmentRun["result"]>;
  readonly titleActor: IssueActor | null;
}): IssuePatch {
  const title = input.result.suggestedTitle?.trim();
  const description = input.result.suggestedDescription;
  const applyTitle =
    title !== undefined &&
    title.length > 0 &&
    title !== input.issue.title.trim() &&
    isPlaceholderIssueTitle(input.issue.title) &&
    input.titleActor !== null &&
    input.titleActor.kind !== "user";
  const applyDescription =
    description !== undefined &&
    description.trim().length > 0 &&
    input.issue.description.trim().length === 0;
  const applyPriority =
    input.result.suggestedPriority !== null &&
    input.result.suggestedPriority !== input.issue.priority;
  return {
    ...(applyTitle ? { title } : {}),
    ...(applyDescription ? { description } : {}),
    ...(applyPriority ? { priority: input.result.suggestedPriority } : {}),
  };
}

interface IssueNaming {
  readonly statusNames: ReadonlyMap<string, string>;
  readonly labelNames: ReadonlyMap<string, string>;
  readonly milestoneNames: ReadonlyMap<string, string>;
  readonly cycleNames: ReadonlyMap<string, string>;
}

const nameStatus = (naming: IssueNaming, statusId: string) =>
  naming.statusNames.get(statusId) ?? statusId;

const nameLabels = (naming: IssueNaming, labelIds: ReadonlyArray<IssueLabelId>) =>
  labelIds.map((labelId) => naming.labelNames.get(labelId) ?? labelId).join(", ");

const nameMilestone = (naming: IssueNaming, milestoneId: string | null) =>
  milestoneId === null ? null : (naming.milestoneNames.get(milestoneId) ?? milestoneId);

const nameCycle = (naming: IssueNaming, cycleId: string | null) =>
  cycleId === null ? null : (naming.cycleNames.get(cycleId) ?? cycleId);

/**
 * How a relation reads from one end. `blocks` is directed and stored once, so the inverse is a
 * phrase rather than a row; `relates` says the same thing from either side.
 */
const RELATION_PHRASES: Readonly<
  Record<IssueRelationKind, Readonly<Record<IssueRelationDirection, string>>>
> = {
  blocks: { outgoing: "blocks", incoming: "blocked by" },
  relates: { outgoing: "relates to", incoming: "relates to" },
  duplicate: { outgoing: "duplicate of", incoming: "duplicated by" },
};

/** Only `relates` reads the same from both ends, so only it has a mirrored row to refuse. */
const SYMMETRIC_RELATION_KINDS: ReadonlySet<IssueRelationKind> = new Set(["relates"]);

const describeRelation = (
  kind: IssueRelationKind,
  direction: IssueRelationDirection,
  key: string,
) => `${RELATION_PHRASES[kind][direction]} ${key}`;

/**
 * Whether two actors are the same writer. Kind alone would let a Codex agent rewrite what Claude
 * said, and the feed names the provider, so the provider is part of the identity.
 */
const isSameActor = (left: IssueActor, right: IssueActor): boolean => {
  if (left.kind !== right.kind) return false;
  if (left.kind === "agent" && right.kind === "agent") return left.provider === right.provider;
  if (left.kind === "system" && right.kind === "system") return left.source === right.source;
  return true;
};

/** Parent and child lookups built once per write, because the depth cap walks them per issue. */
interface IssueTree {
  readonly byId: ReadonlyMap<string, IssueRecord>;
  readonly childrenByParent: ReadonlyMap<string, ReadonlyArray<IssueRecord>>;
}

const buildIssueTree = (records: ReadonlyArray<IssueRecord>): IssueTree => {
  const byId = new Map<string, IssueRecord>();
  const childrenByParent = new Map<string, Array<IssueRecord>>();
  for (const record of records) {
    byId.set(record.id, record);
    if (record.parentId === null) continue;
    const siblings = childrenByParent.get(record.parentId);
    if (siblings === undefined) childrenByParent.set(record.parentId, [record]);
    else siblings.push(record);
  }
  return { byId, childrenByParent };
};

/**
 * How many ancestors an issue has: a root sits at 0. The walk carries its own visited set because
 * a row written before this cap existed could still hold a loop, and a hang is a worse answer than
 * a wrong number.
 */
const ancestorDepth = (tree: IssueTree, issueId: string): number => {
  const seen = new Set<string>();
  let current = tree.byId.get(issueId);
  let depth = 0;
  while (current !== undefined && current.parentId !== null && !seen.has(current.id)) {
    seen.add(current.id);
    depth += 1;
    current = tree.byId.get(current.parentId);
  }
  return depth;
};

/** How far the tree under an issue reaches. A leaf is 0, so a parent of leaves is 1. */
const subtreeHeight = (tree: IssueTree, issueId: string, seen = new Set<string>()): number => {
  if (seen.has(issueId)) return 0;
  seen.add(issueId);
  const children = tree.childrenByParent.get(issueId) ?? [];
  let height = 0;
  for (const child of children) {
    height = Math.max(height, 1 + subtreeHeight(tree, child.id, seen));
  }
  return height;
};

/** Whether `candidateId` sits under `issueId`, which is the parent cycle a reparent can create. */
const isDescendantOf = (tree: IssueTree, candidateId: string, issueId: string): boolean => {
  const seen = new Set<string>();
  let current = tree.byId.get(candidateId);
  while (current !== undefined && current.parentId !== null && !seen.has(current.id)) {
    if (current.parentId === issueId) return true;
    seen.add(current.id);
    current = tree.byId.get(current.parentId);
  }
  return false;
};

/**
 * Apply a patch to one issue, reporting what actually moved. An absent key leaves the field
 * alone and an explicit null clears it, so "unassign" and "do not touch the assignee" produce
 * different rows here.
 */
function applyIssuePatch(input: {
  readonly record: IssueRecord;
  readonly labelIds: ReadonlyArray<IssueLabelId>;
  readonly patch: IssuePatch;
  readonly updatedAt: string;
  readonly naming: IssueNaming;
}): {
  readonly record: IssueRecord;
  readonly labelIds: ReadonlyArray<IssueLabelId>;
  readonly changes: ReadonlyArray<IssueFieldChange>;
} {
  const { patch, naming } = input;
  const changes: Array<IssueFieldChange> = [];
  let record = input.record;
  let labelIds = input.labelIds;

  if (patch.title !== undefined && patch.title !== record.title) {
    changes.push({ field: "title", before: record.title, after: patch.title });
    record = { ...record, title: patch.title };
  }
  if (patch.description !== undefined && patch.description !== record.description) {
    changes.push({
      field: "description",
      before: truncateEventValue(record.description),
      after: truncateEventValue(patch.description),
    });
    record = { ...record, description: patch.description };
  }
  if (patch.statusId !== undefined && patch.statusId !== record.statusId) {
    changes.push({
      field: "status",
      before: nameStatus(naming, record.statusId),
      after: nameStatus(naming, patch.statusId),
    });
    record = { ...record, statusId: patch.statusId };
  }
  if (patch.priority !== undefined && patch.priority !== record.priority) {
    changes.push({ field: "priority", before: record.priority, after: patch.priority });
    record = { ...record, priority: patch.priority };
  }
  if (
    patch.assignee !== undefined &&
    describeAssignee(patch.assignee) !== describeAssignee(record.assignee)
  ) {
    changes.push({
      field: "assignee",
      before: describeAssignee(record.assignee),
      after: describeAssignee(patch.assignee),
    });
    record = { ...record, assignee: patch.assignee };
  }
  if (
    patch.workModelSelection !== undefined &&
    JSON.stringify(patch.workModelSelection) !== JSON.stringify(record.workModelSelection ?? null)
  ) {
    changes.push({
      field: "work model",
      before: record.workModelSelection?.model ?? null,
      after: patch.workModelSelection?.model ?? null,
    });
    record = { ...record, workModelSelection: patch.workModelSelection };
  }
  if (
    patch.automationAssignment !== undefined &&
    JSON.stringify(patch.automationAssignment) !==
      JSON.stringify(record.automationAssignment ?? null)
  ) {
    changes.push({
      field: "automation assignment",
      before: record.automationAssignment?.routingRuleId ?? null,
      after: patch.automationAssignment?.routingRuleId ?? null,
    });
    record = { ...record, automationAssignment: patch.automationAssignment };
  }
  if (patch.projectId !== undefined && patch.projectId !== record.projectId) {
    changes.push({ field: "project", before: record.projectId, after: patch.projectId });
    record = { ...record, projectId: patch.projectId };
    // A milestone belongs to a project, so leaving the project leaves the milestone behind. The
    // caller does not have to send `milestoneId: null` alongside, and could not sensibly refuse.
    if (patch.milestoneId === undefined && record.milestoneId !== null) {
      changes.push({
        field: "milestone",
        before: nameMilestone(naming, record.milestoneId),
        after: null,
      });
      record = { ...record, milestoneId: null };
    }
  }
  if (patch.milestoneId !== undefined && patch.milestoneId !== record.milestoneId) {
    changes.push({
      field: "milestone",
      before: nameMilestone(naming, record.milestoneId),
      after: nameMilestone(naming, patch.milestoneId),
    });
    record = { ...record, milestoneId: patch.milestoneId };
  }
  if (patch.cycleId !== undefined && patch.cycleId !== record.cycleId) {
    changes.push({
      field: "cycle",
      before: nameCycle(naming, record.cycleId),
      after: nameCycle(naming, patch.cycleId),
    });
    record = { ...record, cycleId: patch.cycleId };
  }
  if (patch.parentId !== undefined && patch.parentId !== record.parentId) {
    changes.push({ field: "parent", before: record.parentId, after: patch.parentId });
    record = { ...record, parentId: patch.parentId };
  }
  if (patch.dueDate !== undefined && patch.dueDate !== record.dueDate) {
    changes.push({ field: "dueDate", before: record.dueDate, after: patch.dueDate });
    record = { ...record, dueDate: patch.dueDate };
  }
  if (patch.triage !== undefined && patch.triage !== record.triage) {
    changes.push({
      field: "triage",
      before: record.triage ? "yes" : "no",
      after: patch.triage ? "yes" : "no",
    });
    record = { ...record, triage: patch.triage };
  }
  if (patch.labelIds !== undefined) {
    const next = [...new Set(patch.labelIds)];
    const changed =
      next.length !== labelIds.length || next.some((labelId) => !labelIds.includes(labelId));
    if (changed) {
      changes.push({
        field: "labels",
        before: nameLabels(naming, labelIds),
        after: nameLabels(naming, next),
      });
      labelIds = next;
    }
  }

  return {
    record: changes.length === 0 ? record : { ...record, updatedAt: input.updatedAt },
    labelIds,
    changes,
  };
}

export const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const issueRepository = yield* IssueRepository;
  const statusRepository = yield* IssueStatusRepository;
  const labelRepository = yield* IssueLabelRepository;
  const eventRepository = yield* IssueEventRepository;
  const configRepository = yield* IssueTrackerConfigRepository;
  const milestoneRepository = yield* IssueMilestoneRepository;
  const cycleRepository = yield* IssueCycleRepository;
  const todoRepository = yield* IssueTodoRepository;
  const relationRepository = yield* IssueRelationRepository;
  const commentRepository = yield* IssueCommentRepository;
  const viewRepository = yield* IssueViewRepository;
  const enrichmentRunRepository = yield* IssueEnrichmentRunRepository;
  const threadLinkRepository = yield* IssueThreadLinkRepository;
  const slackWatchRepository = yield* SlackChannelWatchRepository;
  const slackLedgerRepository = yield* SlackIntakeLedgerRepository;
  // Read-only, and the only table outside the tracker this service touches: an enrichment run
  // needs the project's directory, and a rootless project is the case that has none.
  const projectRepository = yield* ProjectionProjectRepository;
  const enrichmentEngine = yield* IssueEnrichmentEngine;
  const slackEngine = yield* SlackIntakeEngine;
  // The bot token is a secret like any other on this server, so it goes through the same store:
  // `<secretsDir>/slack-bot-token.bin`, 0600, written through a temp file and a rename.
  const secretStore = yield* ServerSecretStore;
  const serverConfig = yield* ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const changes = yield* PubSub.unbounded<IssuesStreamEvent>();

  /**
   * Intake's health, held in memory rather than in a table.
   *
   * `configured` is whether a token is on disk, read once here. The rest is what the poller has
   * managed *since this server woke up*: a laptop that has been shut for a week reports no poll
   * and no error, which is the truth, whereas a stored `lastPollAt` from last Tuesday would read
   * as a working connection.
   */
  const slackTokenPresent = yield* secretStore.get(SLACK_BOT_TOKEN_SECRET).pipe(
    Effect.map(Option.isSome),
    Effect.catchCause((cause) =>
      Effect.logWarning("Failed to read the Slack bot token at startup.", { cause }).pipe(
        Effect.as(false),
      ),
    ),
  );
  const slackStatus = yield* Ref.make<SlackIntakeStatus>({
    configured: slackTokenPresent,
    lastPollAt: null,
    lastError: null,
    workspaceName: null,
  });

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  /**
   * The calendar day where this server is, not in UTC. A cycle ends on a day, and "Friday" is a
   * local word: finalising against UTC would end a Friday cycle on Thursday evening in Auckland.
   */
  const todayLocal = Effect.map(DateTime.now, (instant) =>
    DateTime.formatIsoDate(DateTime.setZone(instant, DateTime.zoneMakeLocal())),
  );
  const newId = crypto.randomUUIDv4.pipe(
    Effect.mapError(
      (cause) =>
        new IssueTrackerError({
          reason: "storage",
          message: `Failed to generate an identifier: ${cause.message}`,
        }),
    ),
  );

  const publish = (event: IssuesStreamEvent) => PubSub.publish(changes, event);
  const publishAll = (events: ReadonlyArray<IssuesStreamEvent>) =>
    Effect.forEach(events, publish, { discard: true });

  const listStatuses = () =>
    statusRepository.listAll().pipe(Effect.mapError(storage("Failed to read issue statuses")));
  const listLabels = () =>
    labelRepository.listAll().pipe(Effect.mapError(storage("Failed to read issue labels")));
  const listRecords = () =>
    issueRepository.listAll().pipe(Effect.mapError(storage("Failed to read issues")));
  const readConfig = () =>
    configRepository.get().pipe(Effect.mapError(storage("Failed to read the tracker config")));
  const listMilestones = () =>
    milestoneRepository
      .listAll()
      .pipe(Effect.mapError(storage("Failed to read the issue milestones")));
  const listCycles = () =>
    cycleRepository.listAll().pipe(Effect.mapError(storage("Failed to read the issue cycles")));
  const listViews = () =>
    viewRepository.listAll().pipe(Effect.mapError(storage("Failed to read the issue views")));
  const listTodos = (issueId: IssueId) =>
    todoRepository
      .listByIssue({ issueId })
      .pipe(Effect.mapError(storage("Failed to read the issue checklist")));
  const listRelations = (issueId: IssueId) =>
    relationRepository
      .listByIssue({ issueId })
      .pipe(Effect.mapError(storage("Failed to read the issue relations")));
  const listComments = (issueId: IssueId) =>
    commentRepository
      .listByIssue({ issueId })
      .pipe(Effect.mapError(storage("Failed to read the issue comments")));

  const namingOf = (
    statuses: ReadonlyArray<IssueStatus>,
    labels: ReadonlyArray<IssueLabel>,
    milestones: ReadonlyArray<IssueMilestone> = [],
    cycles: ReadonlyArray<IssueCycle> = [],
  ): IssueNaming => ({
    statusNames: new Map(statuses.map((status) => [status.id, status.name])),
    labelNames: new Map(labels.map((label) => [label.id, label.name])),
    milestoneNames: new Map(milestones.map((milestone) => [milestone.id, milestone.name])),
    cycleNames: new Map(cycles.map((cycle) => [cycle.id, cycle.name])),
  });

  const groupLabelAssignments = () =>
    labelRepository.listAssignments().pipe(
      Effect.mapError(storage("Failed to read issue label assignments")),
      // One query grouped in memory, not one query per issue: the snapshot reads every row.
      Effect.map((assignments) => {
        const byIssue = new Map<string, Array<IssueLabelId>>();
        for (const assignment of assignments) {
          const existing = byIssue.get(assignment.issueId);
          if (existing === undefined) byIssue.set(assignment.issueId, [assignment.labelId]);
          else existing.push(assignment.labelId);
        }
        return byIssue;
      }),
    );

  const listIssues = () =>
    Effect.all([listRecords(), groupLabelAssignments()]).pipe(
      Effect.map(([records, byIssue]) =>
        records.map((record): Issue => ({ ...record, labelIds: byIssue.get(record.id) ?? [] })),
      ),
    );

  const labelsOf = (issueId: IssueId) =>
    labelRepository
      .listAssignmentsByIssue({ issueId })
      .pipe(Effect.mapError(storage("Failed to read issue label assignments")));

  const listSlackWatches = () =>
    slackWatchRepository
      .listAll()
      .pipe(Effect.mapError(storage("Failed to read the Slack channel watches")));

  /** Publish the complete watch set and wake intake so configuration changes apply immediately. */
  const publishSlackWatches = () =>
    listSlackWatches().pipe(
      Effect.tap((watches) => publish({ _tag: "SlackWatchesChanged", watches })),
      Effect.tap(() => slackEngine.notifyWatchesChanged),
    );

  const readSnapshot = () =>
    Effect.all([
      listIssues(),
      listStatuses(),
      listLabels(),
      listMilestones(),
      listCycles(),
      listViews(),
      listSlackWatches(),
      Ref.get(slackStatus),
      readConfig(),
    ]).pipe(
      Effect.map(
        ([issues, statuses, labels, milestones, cycles, views, slackWatches, status, config]) => ({
          issues,
          statuses,
          labels,
          milestones,
          cycles,
          views,
          slackWatches,
          slackStatus: status,
          config,
        }),
      ),
    );

  const getSnapshot: IssueTrackerServiceShape["getSnapshot"] = () =>
    finalizeEndedCycles().pipe(Effect.andThen(readSnapshot()));

  const appendChangeLog = (input: {
    readonly issueId: IssueId;
    readonly actor: IssueActor;
    readonly createdAt: string;
    readonly kind: IssueEvent["kind"];
    readonly changes: ReadonlyArray<IssueFieldChange>;
  }) =>
    Effect.forEach(input.changes, (change) =>
      Effect.map(
        newId,
        (id): IssueEvent => ({
          id: IssueEventId.make(id),
          issueId: input.issueId,
          actor: input.actor,
          kind: input.kind,
          field: change.field,
          before: change.before,
          after: change.after,
          createdAt: input.createdAt,
        }),
      ),
    ).pipe(
      Effect.flatMap((rows) =>
        eventRepository
          .appendMany(rows)
          .pipe(Effect.mapError(storage("Failed to append the issue change log"))),
      ),
    );

  const requireRecord = (records: ReadonlyArray<IssueRecord>, issueId: IssueId) => {
    const record = records.find((candidate) => candidate.id === issueId);
    return record === undefined
      ? Effect.fail(notFound(issueId, `No issue with id ${issueId}.`))
      : Effect.succeed(record);
  };

  /** Every reference a patch can carry has to exist before any of it is written. */
  const validatePatch = (input: {
    readonly patch: IssuePatch;
    readonly statuses: ReadonlyArray<IssueStatus>;
    readonly labels: ReadonlyArray<IssueLabel>;
    readonly milestones: ReadonlyArray<IssueMilestone>;
    readonly cycles: ReadonlyArray<IssueCycle>;
    readonly records: ReadonlyArray<IssueRecord>;
    readonly issueIds: ReadonlyArray<IssueId>;
  }) =>
    Effect.gen(function* () {
      const { patch } = input;
      if (
        patch.statusId !== undefined &&
        !input.statuses.some((status) => status.id === patch.statusId)
      ) {
        return yield* notFound(patch.statusId, `No issue status with id ${patch.statusId}.`);
      }
      if (
        patch.milestoneId !== undefined &&
        patch.milestoneId !== null &&
        !input.milestones.some((milestone) => milestone.id === patch.milestoneId)
      ) {
        return yield* notFound(
          patch.milestoneId,
          `No issue milestone with id ${patch.milestoneId}.`,
        );
      }
      if (
        patch.cycleId !== undefined &&
        patch.cycleId !== null &&
        !input.cycles.some((cycle) => cycle.id === patch.cycleId)
      ) {
        return yield* notFound(patch.cycleId, `No issue cycle with id ${patch.cycleId}.`);
      }
      if (patch.parentId !== undefined && patch.parentId !== null) {
        if (input.issueIds.includes(patch.parentId)) {
          return yield* invalid("An issue cannot be its own parent.", patch.parentId);
        }
        if (!input.records.some((record) => record.id === patch.parentId)) {
          return yield* notFound(patch.parentId, `No issue with id ${patch.parentId}.`);
        }
      }
      if (patch.labelIds !== undefined) {
        const missing = patch.labelIds.find(
          (labelId) => !input.labels.some((label) => label.id === labelId),
        );
        if (missing !== undefined) {
          return yield* notFound(missing, `No issue label with id ${missing}.`);
        }
      }
    });

  /**
   * The rules that depend on the issue itself rather than on the patch alone, checked against the
   * row the write would produce: a milestone belongs to one project, and the hierarchy is capped.
   *
   * Only the fields the patch touched are checked. A tracker can already hold a chain deeper than
   * the cap — an import wrote it, or the cap moved — and refusing to retitle those issues would be
   * a worse answer than leaving the shape they are already in alone.
   */
  const validatePlacement = (input: {
    readonly issue: IssueRecord;
    readonly checkMilestone: boolean;
    readonly checkParent: boolean;
    readonly tree: IssueTree;
    readonly milestones: ReadonlyArray<IssueMilestone>;
  }) =>
    Effect.gen(function* () {
      const { issue } = input;
      if (input.checkMilestone && issue.milestoneId !== null) {
        const milestone = input.milestones.find((candidate) => candidate.id === issue.milestoneId);
        if (milestone === undefined) {
          return yield* notFound(
            issue.milestoneId,
            `No issue milestone with id ${issue.milestoneId}.`,
          );
        }
        if (milestone.projectId !== issue.projectId) {
          return yield* invalid(
            `Milestone ${milestone.name} belongs to another project.`,
            milestone.name,
          );
        }
      }
      if (!input.checkParent || issue.parentId === null) return;

      if (issue.parentId === issue.id) {
        return yield* invalid("An issue cannot be its own parent.", issue.key);
      }
      if (isDescendantOf(input.tree, issue.parentId, issue.id)) {
        return yield* invalid("An issue cannot be moved under its own sub-issue.", issue.key);
      }
      // Counted in ancestors: a root sits at 0, so a parent three levels up is the last accepted.
      // The subtree comes along, so a shallow move of a deep branch is refused the same way.
      const depth =
        ancestorDepth(input.tree, issue.parentId) + 1 + subtreeHeight(input.tree, issue.id);
      if (depth > ISSUE_MAX_PARENT_DEPTH) {
        return yield* invalid(`Sub-issues nest at most ${ISSUE_MAX_PARENT_DEPTH} deep.`, issue.key);
      }
    });

  /**
   * The body of `create`, with one thing the wire cannot ask for: where the issue came in from.
   *
   * `slackOrigin` is the source minus its `issueId`, because the id is minted in here. Intake is
   * the only caller that passes one, and keeping it off `IssueCreateInput` is deliberate — a
   * client that could claim a Slack origin could point an issue at a thread the bot then posts
   * into.
   */
  const createIssue = Effect.fn("IssueTrackerService.create")(function* (
    input: IssueCreateInput,
    actor: IssueActor,
    slackOrigin: Omit<IssueSlackSource, "issueId"> | null,
  ) {
    const [statuses, labels, records, milestones, cycles] = yield* Effect.all([
      listStatuses(),
      listLabels(),
      listRecords(),
      listMilestones(),
      listCycles(),
    ]);

    const status =
      input.statusId === undefined
        ? (statuses.find((candidate) => DEFAULT_STATUS_CATEGORIES.has(candidate.category)) ??
          statuses[0])
        : statuses.find((candidate) => candidate.id === input.statusId);
    if (status === undefined) {
      return yield* input.statusId === undefined
        ? conflict("The tracker has no statuses, so an issue has nowhere to land.")
        : notFound(input.statusId, `No issue status with id ${input.statusId}.`);
    }

    yield* validatePatch({
      patch: {
        ...(input.parentId === undefined ? {} : { parentId: input.parentId }),
        ...(input.milestoneId === undefined ? {} : { milestoneId: input.milestoneId }),
        ...(input.cycleId === undefined ? {} : { cycleId: input.cycleId }),
        ...(input.labelIds === undefined ? {} : { labelIds: input.labelIds }),
      },
      statuses,
      labels,
      milestones,
      cycles,
      records,
      issueIds: [],
    });

    const key = yield* configRepository
      .allocateKey()
      .pipe(Effect.mapError(storage("Failed to allocate an issue key")));
    const id = IssueId.make(yield* newId);
    const createdAt = yield* nowIso;
    // Appended after the last issue in its own column, not the tracker's last row.
    const last = records.findLast((record) => record.statusId === status.id);
    const labelIds = input.labelIds === undefined ? [] : [...new Set(input.labelIds)];

    const record: IssueRecord = {
      id,
      key,
      title: input.title,
      description: input.description ?? "",
      statusId: status.id,
      priority: input.priority ?? "none",
      assignee: input.assignee ?? null,
      workModelSelection: null,
      automationAssignment: null,
      projectId: input.projectId ?? null,
      milestoneId: input.milestoneId ?? null,
      cycleId: input.cycleId ?? null,
      parentId: input.parentId ?? null,
      sortOrder: issueSortOrderAfter(last?.sortOrder ?? null),
      dueDate: input.dueDate ?? null,
      triage: input.triage ?? false,
      slackSource: slackOrigin === null ? null : { ...slackOrigin, issueId: id },
      createdAt,
      updatedAt: createdAt,
      deletedAt: null,
    };

    // A new issue has no subtree, so this only ever measures the parent's own depth.
    yield* validatePlacement({
      issue: record,
      checkMilestone: true,
      checkParent: true,
      tree: buildIssueTree(records),
      milestones,
    });

    yield* issueRepository
      .upsert(record)
      .pipe(Effect.mapError(storage("Failed to write the issue")));
    if (labelIds.length > 0) {
      yield* labelRepository
        .setAssignments({ issueId: id, labelIds })
        .pipe(Effect.mapError(storage("Failed to write the issue labels")));
    }
    yield* appendChangeLog({
      issueId: id,
      actor,
      createdAt,
      kind: "created",
      changes: WHOLE_ISSUE_CHANGE,
    });

    const issue: Issue = { ...record, labelIds };
    const config = yield* readConfig();
    yield* publishAll([
      { _tag: "IssueUpserted", issue },
      // The key allocation moved the counter, and the counter is on screen in settings.
      { _tag: "ConfigChanged", config },
    ]);
    return { issue };
  });

  const create: IssueTrackerServiceShape["create"] = (input, actor) =>
    createIssue(input, actor, null);

  /**
   * Placement is checked for every target before the first one is written, for the same reason
   * the reference checks are: a selection is applied whole or refused, and a half-applied bulk
   * reparent leaves a tree nobody asked for.
   */
  const validatePlacements = (input: {
    readonly targets: ReadonlyArray<IssueRecord>;
    readonly labelIdsOf: (record: IssueRecord) => ReadonlyArray<IssueLabelId>;
    readonly patch: IssuePatch;
    readonly naming: IssueNaming;
    readonly tree: IssueTree;
    readonly milestones: ReadonlyArray<IssueMilestone>;
  }) =>
    Effect.forEach(
      input.targets,
      (record) =>
        validatePlacement({
          issue: applyIssuePatch({
            record,
            labelIds: input.labelIdsOf(record),
            patch: input.patch,
            updatedAt: record.updatedAt,
            naming: input.naming,
          }).record,
          checkMilestone:
            input.patch.milestoneId !== undefined || input.patch.projectId !== undefined,
          checkParent: input.patch.parentId !== undefined,
          tree: input.tree,
          milestones: input.milestones,
        }),
      { discard: true },
    );

  /** The shared body of update and bulkUpdate: one issue, one patch, one batch of log rows. */
  const patchOne = (input: {
    readonly record: IssueRecord;
    readonly labelIds: ReadonlyArray<IssueLabelId>;
    readonly patch: IssuePatch;
    readonly naming: IssueNaming;
    readonly actor: IssueActor;
    readonly updatedAt: string;
  }) =>
    Effect.gen(function* () {
      const applied = applyIssuePatch({
        record: input.record,
        labelIds: input.labelIds,
        patch: input.patch,
        updatedAt: input.updatedAt,
        naming: input.naming,
      });
      const issue: Issue = { ...applied.record, labelIds: applied.labelIds };
      if (applied.changes.length === 0) return issue;

      yield* issueRepository
        .upsert(applied.record)
        .pipe(Effect.mapError(storage("Failed to write the issue")));
      if (applied.changes.some((change) => change.field === "labels")) {
        yield* labelRepository
          .setAssignments({ issueId: applied.record.id, labelIds: applied.labelIds })
          .pipe(Effect.mapError(storage("Failed to write the issue labels")));
      }
      yield* appendChangeLog({
        issueId: applied.record.id,
        actor: input.actor,
        createdAt: input.updatedAt,
        kind: "field_changed",
        changes: applied.changes,
      });
      yield* publish({ _tag: "IssueUpserted", issue });
      return issue;
    });

  const update: IssueTrackerServiceShape["update"] = Effect.fn("IssueTrackerService.update")(
    function* (input, actor) {
      const [statuses, labels, records, milestones, cycles] = yield* Effect.all([
        listStatuses(),
        listLabels(),
        listRecords(),
        listMilestones(),
        listCycles(),
      ]);
      const record = yield* requireRecord(records, input.issueId);
      yield* validatePatch({
        patch: input.patch,
        statuses,
        labels,
        milestones,
        cycles,
        records,
        issueIds: [input.issueId],
      });

      const labelIds = yield* labelsOf(input.issueId);
      const naming = namingOf(statuses, labels, milestones, cycles);
      yield* validatePlacements({
        targets: [record],
        labelIdsOf: () => labelIds,
        patch: input.patch,
        naming,
        tree: buildIssueTree(records),
        milestones,
      });

      const issue = yield* patchOne({
        record,
        labelIds,
        patch: input.patch,
        naming,
        actor,
        updatedAt: yield* nowIso,
      });
      return { issue };
    },
  );

  const bulkUpdate: IssueTrackerServiceShape["bulkUpdate"] = Effect.fn(
    "IssueTrackerService.bulkUpdate",
  )(function* (input, actor) {
    const [statuses, labels, records, byIssue, milestones, cycles] = yield* Effect.all([
      listStatuses(),
      listLabels(),
      listRecords(),
      groupLabelAssignments(),
      listMilestones(),
      listCycles(),
    ]);
    // Every id resolves and the patch validates before anything is written: a selection is
    // applied whole or refused, because a half-applied bulk edit is worse than a rejected one.
    const targets = yield* Effect.forEach(input.issueIds, (issueId) =>
      requireRecord(records, issueId),
    );
    yield* validatePatch({
      patch: input.patch,
      statuses,
      labels,
      milestones,
      cycles,
      records,
      issueIds: input.issueIds,
    });

    const naming = namingOf(statuses, labels, milestones, cycles);
    yield* validatePlacements({
      targets,
      labelIdsOf: (record) => byIssue.get(record.id) ?? [],
      patch: input.patch,
      naming,
      tree: buildIssueTree(records),
      milestones,
    });
    const updatedAt = yield* nowIso;
    const issues = yield* Effect.forEach(targets, (record) =>
      patchOne({
        record,
        labelIds: byIssue.get(record.id) ?? [],
        patch: input.patch,
        naming,
        actor,
        updatedAt,
      }),
    );
    return { issues };
  });

  const setSortOrder: IssueTrackerServiceShape["setSortOrder"] = Effect.fn(
    "IssueTrackerService.setSortOrder",
  )(function* (input, actor) {
    const [statuses, records] = yield* Effect.all([listStatuses(), listRecords()]);
    const record = yield* requireRecord(records, input.issueId);
    if (input.statusId !== undefined && !statuses.some((status) => status.id === input.statusId)) {
      return yield* notFound(input.statusId, `No issue status with id ${input.statusId}.`);
    }

    const updatedAt = yield* nowIso;
    yield* issueRepository
      .setSortOrder({
        issueId: input.issueId,
        sortOrder: input.sortOrder,
        statusId: input.statusId ?? null,
        updatedAt,
      })
      .pipe(Effect.mapError(storage("Failed to write the issue order")));

    // A drag is a view concern and stays out of the feed; the column it lands in does not.
    const movedTo = input.statusId !== record.statusId ? input.statusId : undefined;
    if (movedTo !== undefined) {
      const naming = namingOf(statuses, []);
      yield* appendChangeLog({
        issueId: input.issueId,
        actor,
        createdAt: updatedAt,
        kind: "field_changed",
        changes: [
          {
            field: "status",
            before: nameStatus(naming, record.statusId),
            after: nameStatus(naming, movedTo),
          },
        ],
      });
    }

    const issue: Issue = {
      ...record,
      sortOrder: input.sortOrder,
      statusId: input.statusId ?? record.statusId,
      updatedAt,
      labelIds: yield* labelsOf(input.issueId),
    };
    yield* publish({ _tag: "IssueUpserted", issue });
    return { issue };
  });

  const remove: IssueTrackerServiceShape["remove"] = Effect.fn("IssueTrackerService.remove")(
    function* (input, actor) {
      const records = yield* listRecords();
      const record = yield* requireRecord(records, input.issueId);
      const labelIds = yield* labelsOf(input.issueId);
      if (record.deletedAt !== null) return { issue: { ...record, labelIds } };

      const deletedAt = yield* nowIso;
      yield* issueRepository
        .softDelete({ issueId: input.issueId, deletedAt })
        .pipe(Effect.mapError(storage("Failed to delete the issue")));
      yield* appendChangeLog({
        issueId: input.issueId,
        actor,
        createdAt: deletedAt,
        kind: "deleted",
        changes: WHOLE_ISSUE_CHANGE,
      });

      // An upsert carrying `deletedAt`, not `IssueDeleted`. A soft-deleted row still holds its
      // `parentId` and the depth cap still counts it as an ancestor, so a client that dropped the
      // row would offer parents this service refuses. `IssueDeleted` is reserved for a hard purge.
      const issue: Issue = { ...record, labelIds, deletedAt, updatedAt: deletedAt };
      yield* publish({ _tag: "IssueUpserted", issue });
      return { issue };
    },
  );

  const restore: IssueTrackerServiceShape["restore"] = Effect.fn("IssueTrackerService.restore")(
    function* (input, actor) {
      const records = yield* listRecords();
      const record = yield* requireRecord(records, input.issueId);
      const labelIds = yield* labelsOf(input.issueId);
      if (record.deletedAt === null) return { issue: { ...record, labelIds } };

      const updatedAt = yield* nowIso;
      yield* issueRepository
        .restore({ issueId: input.issueId, updatedAt })
        .pipe(Effect.mapError(storage("Failed to restore the issue")));
      yield* appendChangeLog({
        issueId: input.issueId,
        actor,
        createdAt: updatedAt,
        kind: "restored",
        changes: WHOLE_ISSUE_CHANGE,
      });

      const issue: Issue = { ...record, labelIds, deletedAt: null, updatedAt };
      yield* publish({ _tag: "IssueUpserted", issue });
      return { issue };
    },
  );

  const publishStatuses = () =>
    listStatuses().pipe(
      Effect.tap((statuses) => publish({ _tag: "StatusesChanged", statuses })),
      Effect.map((statuses) => ({ statuses })),
    );

  const createStatus: IssueTrackerServiceShape["createStatus"] = Effect.fn(
    "IssueTrackerService.createStatus",
  )(function* (input) {
    const statuses = yield* listStatuses();
    if (statuses.some((status) => status.name.toLowerCase() === input.name.toLowerCase())) {
      return yield* conflict(`A status named ${input.name} already exists.`, input.name);
    }

    const createdAt = yield* nowIso;
    const status: IssueStatus = {
      id: IssueStatusId.make(yield* newId),
      name: input.name,
      color: input.color,
      category: input.category,
      position: input.position ?? nextPositionForCategory(statuses, input.category),
      createdAt,
      updatedAt: createdAt,
    };
    yield* statusRepository
      .upsert(status)
      .pipe(Effect.mapError(storage("Failed to write the issue status")));

    const { statuses: next } = yield* publishStatuses();
    return { status, statuses: next };
  });

  const updateStatus: IssueTrackerServiceShape["updateStatus"] = Effect.fn(
    "IssueTrackerService.updateStatus",
  )(function* (input) {
    const statuses = yield* listStatuses();
    const current = statuses.find((status) => status.id === input.statusId);
    if (current === undefined) {
      return yield* notFound(input.statusId, `No issue status with id ${input.statusId}.`);
    }
    const { patch } = input;
    const renamedTo = patch.name;
    if (
      renamedTo !== undefined &&
      statuses.some(
        (status) =>
          status.id !== input.statusId && status.name.toLowerCase() === renamedTo.toLowerCase(),
      )
    ) {
      return yield* conflict(`A status named ${renamedTo} already exists.`, renamedTo);
    }

    const status: IssueStatus = {
      ...current,
      ...(patch.name === undefined ? {} : { name: patch.name }),
      ...(patch.color === undefined ? {} : { color: patch.color }),
      ...(patch.category === undefined ? {} : { category: patch.category }),
      ...(patch.position === undefined ? {} : { position: patch.position }),
      updatedAt: yield* nowIso,
    };
    yield* statusRepository
      .upsert(status)
      .pipe(Effect.mapError(storage("Failed to write the issue status")));

    const { statuses: next } = yield* publishStatuses();
    return { status, statuses: next };
  });

  const deleteStatus: IssueTrackerServiceShape["deleteStatus"] = Effect.fn(
    "IssueTrackerService.deleteStatus",
  )(function* (input, actor) {
    const [statuses, records, byIssue] = yield* Effect.all([
      listStatuses(),
      listRecords(),
      groupLabelAssignments(),
    ]);
    const status = statuses.find((candidate) => candidate.id === input.statusId);
    if (status === undefined) {
      return yield* notFound(input.statusId, `No issue status with id ${input.statusId}.`);
    }
    const target = statuses.find((candidate) => candidate.id === input.reassignToStatusId);
    if (target === undefined) {
      return yield* notFound(
        input.reassignToStatusId,
        `No issue status with id ${input.reassignToStatusId} to reassign to.`,
      );
    }
    if (status.id === target.id) {
      return yield* invalid("A status cannot be reassigned to itself.", status.name);
    }
    // A tracker with no unstarted column has nowhere to put a new issue, so the last one stays.
    if (
      status.category === "unstarted" &&
      statuses.filter((candidate) => candidate.category === "unstarted").length === 1
    ) {
      return yield* conflict("The last unstarted status cannot be deleted.", status.name);
    }

    const updatedAt = yield* nowIso;
    const moved = records.filter((record) => record.statusId === status.id);
    yield* issueRepository
      .reassignStatus({ fromStatusId: status.id, toStatusId: target.id, updatedAt })
      .pipe(Effect.mapError(storage("Failed to reassign the issues on the status")));
    yield* statusRepository
      .deleteById({ statusId: status.id })
      .pipe(Effect.mapError(storage("Failed to delete the issue status")));

    yield* Effect.forEach(
      moved,
      (record) =>
        appendChangeLog({
          issueId: record.id,
          actor,
          createdAt: updatedAt,
          kind: "field_changed",
          changes: [{ field: "status", before: status.name, after: target.name }],
        }),
      { discard: true },
    );

    const result = yield* publishStatuses();
    yield* publishAll(
      moved.map((record) => ({
        _tag: "IssueUpserted" as const,
        issue: {
          ...record,
          statusId: target.id,
          updatedAt,
          labelIds: byIssue.get(record.id) ?? [],
        },
      })),
    );
    return result;
  });

  const reorderStatuses: IssueTrackerServiceShape["reorderStatuses"] = Effect.fn(
    "IssueTrackerService.reorderStatuses",
  )(function* (input) {
    const statuses = yield* listStatuses();
    const requested = new Set(input.statusIds);
    if (requested.size !== input.statusIds.length) {
      return yield* invalid("The requested order repeats a status.");
    }
    const unknown = input.statusIds.find(
      (statusId) => !statuses.some((status) => status.id === statusId),
    );
    if (unknown !== undefined) {
      return yield* notFound(unknown, `No issue status with id ${unknown}.`);
    }
    // The payload is the complete order, so a status missing from it would get no position.
    const omitted = statuses.find((status) => !requested.has(status.id));
    if (omitted !== undefined) {
      return yield* invalid("The requested order leaves out a status.", omitted.name);
    }

    yield* statusRepository
      .setPositions({
        positions: input.statusIds.map((statusId, index) => ({ statusId, position: index + 1 })),
        updatedAt: yield* nowIso,
      })
      .pipe(Effect.mapError(storage("Failed to reorder the issue statuses")));

    return yield* publishStatuses();
  });

  const publishLabels = () =>
    listLabels().pipe(
      Effect.tap((labels) => publish({ _tag: "LabelsChanged", labels })),
      Effect.map((labels) => ({ labels })),
    );

  const createLabel: IssueTrackerServiceShape["createLabel"] = Effect.fn(
    "IssueTrackerService.createLabel",
  )(function* (input) {
    const labels = yield* listLabels();
    if (labels.some((label) => label.name.toLowerCase() === input.name.toLowerCase())) {
      return yield* conflict(`A label named ${input.name} already exists.`, input.name);
    }

    const label: IssueLabel = {
      id: IssueLabelId.make(yield* newId),
      name: input.name,
      color: input.color,
      createdAt: yield* nowIso,
    };
    yield* labelRepository
      .upsert(label)
      .pipe(Effect.mapError(storage("Failed to write the issue label")));

    const { labels: next } = yield* publishLabels();
    return { label, labels: next };
  });

  const updateLabel: IssueTrackerServiceShape["updateLabel"] = Effect.fn(
    "IssueTrackerService.updateLabel",
  )(function* (input) {
    const labels = yield* listLabels();
    const current = labels.find((label) => label.id === input.labelId);
    if (current === undefined) {
      return yield* notFound(input.labelId, `No issue label with id ${input.labelId}.`);
    }
    const { patch } = input;
    const renamedTo = patch.name;
    if (
      renamedTo !== undefined &&
      labels.some(
        (label) =>
          label.id !== input.labelId && label.name.toLowerCase() === renamedTo.toLowerCase(),
      )
    ) {
      return yield* conflict(`A label named ${renamedTo} already exists.`, renamedTo);
    }

    const label: IssueLabel = {
      ...current,
      ...(patch.name === undefined ? {} : { name: patch.name }),
      ...(patch.color === undefined ? {} : { color: patch.color }),
    };
    yield* labelRepository
      .upsert(label)
      .pipe(Effect.mapError(storage("Failed to write the issue label")));

    const { labels: next } = yield* publishLabels();
    return { label, labels: next };
  });

  const deleteLabel: IssueTrackerServiceShape["deleteLabel"] = Effect.fn(
    "IssueTrackerService.deleteLabel",
  )(function* (input) {
    const [labels, records, byIssue] = yield* Effect.all([
      listLabels(),
      listRecords(),
      groupLabelAssignments(),
    ]);
    if (!labels.some((label) => label.id === input.labelId)) {
      return yield* notFound(input.labelId, `No issue label with id ${input.labelId}.`);
    }

    yield* labelRepository
      .deleteById({ labelId: input.labelId })
      .pipe(Effect.mapError(storage("Failed to delete the issue label")));

    const result = yield* publishLabels();
    // Deleting a label edits every issue that wore it, so those rows have to be resent.
    yield* publishAll(
      records
        .filter((record) => (byIssue.get(record.id) ?? []).includes(input.labelId))
        .map((record) => ({
          _tag: "IssueUpserted" as const,
          issue: {
            ...record,
            labelIds: (byIssue.get(record.id) ?? []).filter((labelId) => labelId !== input.labelId),
          },
        })),
    );
    return result;
  });

  const requireIssueRecord = (issueId: IssueId) =>
    issueRepository.getById({ issueId }).pipe(
      Effect.mapError(storage("Failed to read the issue")),
      Effect.flatMap((record) =>
        Option.isNone(record)
          ? Effect.fail(notFound(issueId, `No issue with id ${issueId}.`))
          : Effect.succeed(record.value),
      ),
    );

  const getDetail: IssueTrackerServiceShape["getDetail"] = Effect.fn(
    "IssueTrackerService.getDetail",
  )(function* (input) {
    yield* requireIssueRecord(input.issueId);
    const [todos, relations, comments] = yield* Effect.all([
      listTodos(input.issueId),
      listRelations(input.issueId),
      listComments(input.issueId),
    ]);
    return { todos, relations, comments };
  });

  const publishMilestones = () =>
    listMilestones().pipe(
      Effect.tap((milestones) => publish({ _tag: "MilestonesChanged", milestones })),
      Effect.map((milestones) => ({ milestones })),
    );

  const milestoneCreate: IssueTrackerServiceShape["milestoneCreate"] = Effect.fn(
    "IssueTrackerService.milestoneCreate",
  )(function* (input) {
    const milestones = yield* listMilestones();
    const inProject = milestones.filter((candidate) => candidate.projectId === input.projectId);
    if (inProject.some((candidate) => candidate.name.toLowerCase() === input.name.toLowerCase())) {
      return yield* conflict(
        `A milestone named ${input.name} already exists in this project.`,
        input.name,
      );
    }

    const createdAt = yield* nowIso;
    const milestone: IssueMilestone = {
      id: IssueMilestoneId.make(yield* newId),
      projectId: input.projectId,
      name: input.name,
      description: input.description ?? null,
      targetDate: input.targetDate ?? null,
      // Appended after the last milestone in its own project, not the last one anywhere.
      position: input.position ?? (inProject.at(-1)?.position ?? 0) + 1,
      createdAt,
      updatedAt: createdAt,
    };
    yield* milestoneRepository
      .upsert(milestone)
      .pipe(Effect.mapError(storage("Failed to write the issue milestone")));

    const { milestones: next } = yield* publishMilestones();
    return { milestone, milestones: next };
  });

  const milestoneUpdate: IssueTrackerServiceShape["milestoneUpdate"] = Effect.fn(
    "IssueTrackerService.milestoneUpdate",
  )(function* (input, actor) {
    const milestones = yield* listMilestones();
    const current = milestones.find((candidate) => candidate.id === input.milestoneId);
    if (current === undefined) {
      return yield* notFound(input.milestoneId, `No issue milestone with id ${input.milestoneId}.`);
    }
    const { patch } = input;
    const projectId = patch.projectId ?? current.projectId;
    const renamedTo = patch.name;
    if (
      renamedTo !== undefined &&
      milestones.some(
        (candidate) =>
          candidate.id !== current.id &&
          candidate.projectId === projectId &&
          candidate.name.toLowerCase() === renamedTo.toLowerCase(),
      )
    ) {
      return yield* conflict(
        `A milestone named ${renamedTo} already exists in this project.`,
        renamedTo,
      );
    }

    const updatedAt = yield* nowIso;
    const milestone: IssueMilestone = {
      ...current,
      ...(patch.name === undefined ? {} : { name: patch.name }),
      ...(patch.description === undefined ? {} : { description: patch.description }),
      ...(patch.targetDate === undefined ? {} : { targetDate: patch.targetDate }),
      ...(patch.position === undefined ? {} : { position: patch.position }),
      projectId,
      updatedAt,
    };
    yield* milestoneRepository
      .upsert(milestone)
      .pipe(Effect.mapError(storage("Failed to write the issue milestone")));

    // Moving a milestone between projects takes its planning context with it. An issue that did
    // not move loses the milestone rather than wearing one from a project it is not in.
    const [records, byIssue] = yield* Effect.all([listRecords(), groupLabelAssignments()]);
    const orphaned =
      projectId === current.projectId
        ? []
        : records.filter(
            (record) => record.milestoneId === current.id && record.projectId !== projectId,
          );
    if (orphaned.length > 0) {
      yield* issueRepository
        .setMilestone({
          issueIds: orphaned.map((record) => record.id),
          milestoneId: null,
          updatedAt,
        })
        .pipe(Effect.mapError(storage("Failed to clear the milestone on its issues")));
      yield* Effect.forEach(
        orphaned,
        (record) =>
          appendChangeLog({
            issueId: record.id,
            actor,
            createdAt: updatedAt,
            kind: "field_changed",
            changes: [{ field: "milestone", before: current.name, after: null }],
          }),
        { discard: true },
      );
    }

    const { milestones: next } = yield* publishMilestones();
    yield* publishAll(
      orphaned.map((record) => ({
        _tag: "IssueUpserted" as const,
        issue: {
          ...record,
          milestoneId: null,
          updatedAt,
          labelIds: byIssue.get(record.id) ?? [],
        },
      })),
    );
    return { milestone, milestones: next };
  });

  const milestoneDelete: IssueTrackerServiceShape["milestoneDelete"] = Effect.fn(
    "IssueTrackerService.milestoneDelete",
  )(function* (input, actor) {
    const [milestones, records, byIssue] = yield* Effect.all([
      listMilestones(),
      listRecords(),
      groupLabelAssignments(),
    ]);
    const milestone = milestones.find((candidate) => candidate.id === input.milestoneId);
    if (milestone === undefined) {
      return yield* notFound(input.milestoneId, `No issue milestone with id ${input.milestoneId}.`);
    }

    const updatedAt = yield* nowIso;
    const cleared = records.filter((record) => record.milestoneId === milestone.id);
    if (cleared.length > 0) {
      yield* issueRepository
        .setMilestone({
          issueIds: cleared.map((record) => record.id),
          milestoneId: null,
          updatedAt,
        })
        .pipe(Effect.mapError(storage("Failed to clear the milestone on its issues")));
    }
    yield* milestoneRepository
      .deleteById({ milestoneId: milestone.id })
      .pipe(Effect.mapError(storage("Failed to delete the issue milestone")));

    yield* Effect.forEach(
      cleared,
      (record) =>
        appendChangeLog({
          issueId: record.id,
          actor,
          createdAt: updatedAt,
          kind: "field_changed",
          changes: [{ field: "milestone", before: milestone.name, after: null }],
        }),
      { discard: true },
    );

    const result = yield* publishMilestones();
    yield* publishAll(
      cleared.map((record) => ({
        _tag: "IssueUpserted" as const,
        issue: {
          ...record,
          milestoneId: null,
          updatedAt,
          labelIds: byIssue.get(record.id) ?? [],
        },
      })),
    );
    return result;
  });

  const milestonesReorder: IssueTrackerServiceShape["milestonesReorder"] = Effect.fn(
    "IssueTrackerService.milestonesReorder",
  )(function* (input) {
    const milestones = yield* listMilestones();
    const requested = new Set(input.milestoneIds);
    if (requested.size !== input.milestoneIds.length) {
      return yield* invalid("The requested order repeats a milestone.");
    }
    const inProject = milestones.filter((candidate) => candidate.projectId === input.projectId);
    const foreign = input.milestoneIds.find(
      (milestoneId) => !inProject.some((candidate) => candidate.id === milestoneId),
    );
    if (foreign !== undefined) {
      return yield* notFound(foreign, `No issue milestone with id ${foreign} in this project.`);
    }
    // The payload is the complete order for one project, so an omission would leave a position
    // nobody wrote — the same rule statuses follow, scoped to the project the sidebar shows.
    const omitted = inProject.find((candidate) => !requested.has(candidate.id));
    if (omitted !== undefined) {
      return yield* invalid("The requested order leaves out a milestone.", omitted.name);
    }

    yield* milestoneRepository
      .setPositions({
        positions: input.milestoneIds.map((milestoneId, index) => ({
          milestoneId,
          position: index + 1,
        })),
        updatedAt: yield* nowIso,
      })
      .pipe(Effect.mapError(storage("Failed to reorder the issue milestones")));

    return yield* publishMilestones();
  });

  const publishCycles = () =>
    listCycles().pipe(
      Effect.tap((cycles) => publish({ _tag: "CyclesChanged", cycles })),
      Effect.map((cycles) => ({ cycles })),
    );

  const cycleCreate: IssueTrackerServiceShape["cycleCreate"] = Effect.fn(
    "IssueTrackerService.cycleCreate",
  )(function* (input) {
    if (input.endDate < input.startDate) {
      return yield* invalid("A cycle cannot end before it starts.", input.name);
    }
    const createdAt = yield* nowIso;
    const cycle: IssueCycle = {
      id: IssueCycleId.make(yield* newId),
      name: input.name,
      startDate: input.startDate,
      endDate: input.endDate,
      completedAt: null,
      createdAt,
      updatedAt: createdAt,
    };
    yield* cycleRepository
      .upsert(cycle)
      .pipe(Effect.mapError(storage("Failed to write the issue cycle")));

    const { cycles } = yield* publishCycles();
    return { cycle, cycles };
  });

  const cycleUpdate: IssueTrackerServiceShape["cycleUpdate"] = Effect.fn(
    "IssueTrackerService.cycleUpdate",
  )(function* (input) {
    const cycles = yield* listCycles();
    const current = cycles.find((candidate) => candidate.id === input.cycleId);
    if (current === undefined) {
      return yield* notFound(input.cycleId, `No issue cycle with id ${input.cycleId}.`);
    }
    const { patch } = input;
    const startDate = patch.startDate ?? current.startDate;
    const endDate = patch.endDate ?? current.endDate;
    if (endDate < startDate) {
      return yield* invalid("A cycle cannot end before it starts.", current.name);
    }

    const cycle: IssueCycle = {
      ...current,
      ...(patch.name === undefined ? {} : { name: patch.name }),
      startDate,
      endDate,
      updatedAt: yield* nowIso,
    };
    yield* cycleRepository
      .upsert(cycle)
      .pipe(Effect.mapError(storage("Failed to write the issue cycle")));

    const { cycles: next } = yield* publishCycles();
    return { cycle, cycles: next };
  });

  const cycleDelete: IssueTrackerServiceShape["cycleDelete"] = Effect.fn(
    "IssueTrackerService.cycleDelete",
  )(function* (input, actor) {
    const [cycles, records, byIssue, watches] = yield* Effect.all([
      listCycles(),
      listRecords(),
      groupLabelAssignments(),
      listSlackWatches(),
    ]);
    const cycle = cycles.find((candidate) => candidate.id === input.cycleId);
    if (cycle === undefined) {
      return yield* notFound(input.cycleId, `No issue cycle with id ${input.cycleId}.`);
    }

    const updatedAt = yield* nowIso;
    const cleared = records.filter((record) => record.cycleId === cycle.id);
    if (cleared.length > 0) {
      yield* issueRepository
        .setCycle({ issueIds: cleared.map((record) => record.id), cycleId: null, updatedAt })
        .pipe(Effect.mapError(storage("Failed to clear the cycle on its issues")));
    }
    const clearedWatches = watches.filter((watch) => watch.cycleId === cycle.id);
    yield* Effect.forEach(
      clearedWatches,
      (watch) =>
        slackWatchRepository
          .upsert({ ...watch, cycleId: null, updatedAt })
          .pipe(Effect.mapError(storage("Failed to clear the cycle on Slack channel watches"))),
      { discard: true },
    );
    yield* cycleRepository
      .deleteById({ cycleId: cycle.id })
      .pipe(Effect.mapError(storage("Failed to delete the issue cycle")));

    yield* Effect.forEach(
      cleared,
      (record) =>
        appendChangeLog({
          issueId: record.id,
          actor,
          createdAt: updatedAt,
          kind: "field_changed",
          changes: [{ field: "cycle", before: cycle.name, after: null }],
        }),
      { discard: true },
    );

    const result = yield* publishCycles();
    if (clearedWatches.length > 0) yield* publishSlackWatches();
    yield* publishAll(
      cleared.map((record) => ({
        _tag: "IssueUpserted" as const,
        issue: { ...record, cycleId: null, updatedAt, labelIds: byIssue.get(record.id) ?? [] },
      })),
    );
    return result;
  });

  /**
   * Carry every ended cycle over, then freeze it.
   *
   * There is no scheduler in this server (decision 0006): it sleeps with the laptop, so nothing
   * would run at midnight on the last day of a cycle. Finalisation is lazy instead — it runs when
   * the service starts and again whenever the tracker is read — which means an ended cycle can sit
   * un-carried for weeks and still resolve correctly the moment somebody looks.
   *
   * Ended cycles are handled oldest first, so a chain of them left behind by a long sleep carries
   * its issues all the way forward rather than dropping them at the first gap.
   */
  const finalizeEndedCycles = Effect.fn("IssueTrackerService.finalizeEndedCycles")(function* () {
    const [cycles, today] = yield* Effect.all([listCycles(), todayLocal]);
    const ended = cycles
      .filter((cycle) => cycle.completedAt === null && cycle.endDate < today)
      .toSorted((left, right) => (left.endDate < right.endDate ? -1 : 1));
    if (ended.length === 0) return;

    const [statuses, records, byIssue] = yield* Effect.all([
      listStatuses(),
      listRecords(),
      groupLabelAssignments(),
    ]);
    // "Unfinished" is the category, not a list of status names: canceled work is as done with as
    // completed work, and carrying it forward would refill every new cycle with abandoned rows.
    const finished = new Set(
      statuses
        .filter((status) => status.category === "completed" || status.category === "canceled")
        .map((status) => status.id),
    );
    const carriedBy = new Map<string, IssueCycleId | null>();
    const cycleOf = (record: IssueRecord) =>
      carriedBy.has(record.id) ? (carriedBy.get(record.id) ?? null) : record.cycleId;

    const finalizedAt = yield* nowIso;
    // Not a person, and not the actor who happened to open the tracker: the tracker did this.
    const actor: IssueActor = { kind: "system", source: "cycles" };

    for (const cycle of ended) {
      const next =
        cycles.find(
          (candidate) => candidate.id !== cycle.id && candidate.startDate > cycle.startDate,
        ) ?? null;
      // A soft-deleted issue keeps pointing at the cycle it was deleted in, so restoring it lands
      // it back where it was rather than in whatever cycle is current by then.
      const carried = records.filter(
        (record) =>
          record.deletedAt === null &&
          cycleOf(record) === cycle.id &&
          !finished.has(record.statusId),
      );
      if (carried.length > 0) {
        yield* issueRepository
          .setCycle({
            issueIds: carried.map((record) => record.id),
            cycleId: next?.id ?? null,
            updatedAt: finalizedAt,
          })
          .pipe(Effect.mapError(storage("Failed to carry the cycle's issues over")));
        for (const record of carried) carriedBy.set(record.id, next?.id ?? null);
        yield* Effect.forEach(
          carried,
          (record) =>
            appendChangeLog({
              issueId: record.id,
              actor,
              createdAt: finalizedAt,
              kind: "field_changed",
              changes: [{ field: "cycle", before: cycle.name, after: next?.name ?? null }],
            }),
          { discard: true },
        );
      }
      yield* cycleRepository
        .complete({ cycleId: cycle.id, completedAt: finalizedAt })
        .pipe(Effect.mapError(storage("Failed to complete the issue cycle")));
    }

    yield* publishCycles();
    yield* publishAll(
      records
        .filter((record) => carriedBy.has(record.id))
        .map((record) => ({
          _tag: "IssueUpserted" as const,
          issue: {
            ...record,
            cycleId: cycleOf(record),
            updatedAt: finalizedAt,
            labelIds: byIssue.get(record.id) ?? [],
          },
        })),
    );
  });

  const publishTodos = (issueId: IssueId) =>
    listTodos(issueId).pipe(
      Effect.tap((todos) => publish({ _tag: "IssueTodosChanged", issueId, todos })),
      Effect.map((todos) => ({ issueId, todos })),
    );

  const requireTodo = (todoId: IssueTodo["id"]) =>
    todoRepository.getById({ todoId }).pipe(
      Effect.mapError(storage("Failed to read the issue checklist")),
      Effect.flatMap((todo) =>
        Option.isNone(todo)
          ? Effect.fail(notFound(todoId, `No issue todo with id ${todoId}.`))
          : Effect.succeed(todo.value),
      ),
    );

  const todoCreate: IssueTrackerServiceShape["todoCreate"] = Effect.fn(
    "IssueTrackerService.todoCreate",
  )(function* (input) {
    yield* requireIssueRecord(input.issueId);
    const todos = yield* listTodos(input.issueId);
    const todo: IssueTodo = {
      id: IssueTodoId.make(yield* newId),
      issueId: input.issueId,
      text: input.text,
      done: false,
      position: input.position ?? (todos.at(-1)?.position ?? 0) + 1,
    };
    yield* todoRepository
      .upsert(todo)
      .pipe(Effect.mapError(storage("Failed to write the issue todo")));
    return yield* publishTodos(input.issueId);
  });

  const todoUpdate: IssueTrackerServiceShape["todoUpdate"] = Effect.fn(
    "IssueTrackerService.todoUpdate",
  )(function* (input) {
    const current = yield* requireTodo(input.todoId);
    const { patch } = input;
    yield* todoRepository
      .upsert({
        ...current,
        ...(patch.text === undefined ? {} : { text: patch.text }),
        ...(patch.done === undefined ? {} : { done: patch.done }),
      })
      .pipe(Effect.mapError(storage("Failed to write the issue todo")));
    return yield* publishTodos(current.issueId);
  });

  const todoDelete: IssueTrackerServiceShape["todoDelete"] = Effect.fn(
    "IssueTrackerService.todoDelete",
  )(function* (input) {
    const current = yield* requireTodo(input.todoId);
    yield* todoRepository
      .deleteById({ todoId: input.todoId })
      .pipe(Effect.mapError(storage("Failed to delete the issue todo")));
    return yield* publishTodos(current.issueId);
  });

  const todosReorder: IssueTrackerServiceShape["todosReorder"] = Effect.fn(
    "IssueTrackerService.todosReorder",
  )(function* (input) {
    const todos = yield* listTodos(input.issueId);
    const requested = new Set(input.todoIds);
    if (requested.size !== input.todoIds.length) {
      return yield* invalid("The requested order repeats a todo.");
    }
    const foreign = input.todoIds.find((todoId) => !todos.some((todo) => todo.id === todoId));
    if (foreign !== undefined) {
      return yield* notFound(foreign, `No issue todo with id ${foreign} on this issue.`);
    }
    const omitted = todos.find((todo) => !requested.has(todo.id));
    if (omitted !== undefined) {
      return yield* invalid("The requested order leaves out a todo.", omitted.text);
    }

    yield* todoRepository
      .setPositions({
        positions: input.todoIds.map((todoId, index) => ({ todoId, position: index + 1 })),
      })
      .pipe(Effect.mapError(storage("Failed to reorder the issue todos")));
    return yield* publishTodos(input.issueId);
  });

  const publishRelations = (issueIds: ReadonlyArray<IssueId>) =>
    Effect.forEach(issueIds, (issueId) =>
      listRelations(issueId).pipe(
        Effect.tap((relations) => publish({ _tag: "IssueRelationsChanged", issueId, relations })),
        Effect.map((relations) => ({ issueId, relations })),
      ),
    ).pipe(Effect.map((affected) => ({ affected })));

  /** One row, two log entries: each issue's feed reads the relation from its own side. */
  const logRelation = (input: {
    readonly relation: IssueRelation;
    readonly issueKey: string;
    readonly relatedKey: string;
    readonly actor: IssueActor;
    readonly createdAt: string;
    readonly removed: boolean;
  }) => {
    const outgoing = describeRelation(input.relation.kind, "outgoing", input.relatedKey);
    const incoming = describeRelation(input.relation.kind, "incoming", input.issueKey);
    const change = (value: string) =>
      input.removed
        ? { field: "relation", before: value, after: null }
        : { field: "relation", before: null, after: value };
    return Effect.all([
      appendChangeLog({
        issueId: input.relation.issueId,
        actor: input.actor,
        createdAt: input.createdAt,
        kind: "field_changed",
        changes: [change(outgoing)],
      }),
      appendChangeLog({
        issueId: input.relation.relatedIssueId,
        actor: input.actor,
        createdAt: input.createdAt,
        kind: "field_changed",
        changes: [change(incoming)],
      }),
    ]);
  };

  const relationCreate: IssueTrackerServiceShape["relationCreate"] = Effect.fn(
    "IssueTrackerService.relationCreate",
  )(function* (input, actor) {
    if (input.issueId === input.relatedIssueId) {
      return yield* invalid("An issue cannot relate to itself.", input.issueId);
    }
    const [record, related] = yield* Effect.all([
      requireIssueRecord(input.issueId),
      requireIssueRecord(input.relatedIssueId),
    ]);

    const existing = yield* listRelations(input.issueId);
    const duplicate = existing.some(
      (edge) =>
        edge.relation.kind === input.kind &&
        (edge.direction === "outgoing"
          ? edge.relation.relatedIssueId === input.relatedIssueId
          : // A mirrored `relates` row is the same sentence read backwards, so it is a duplicate;
            // a mirrored `blocks` is a different claim and stands on its own.
            SYMMETRIC_RELATION_KINDS.has(input.kind) &&
            edge.relation.issueId === input.relatedIssueId),
    );
    if (duplicate) {
      return yield* invalid(
        `${record.key} already ${describeRelation(input.kind, "outgoing", related.key)}.`,
        record.key,
      );
    }

    const relation: IssueRelation = {
      id: IssueRelationId.make(yield* newId),
      issueId: input.issueId,
      relatedIssueId: input.relatedIssueId,
      kind: input.kind,
    };
    yield* relationRepository
      .insert(relation)
      .pipe(Effect.mapError(storage("Failed to write the issue relation")));
    yield* logRelation({
      relation,
      issueKey: record.key,
      relatedKey: related.key,
      actor,
      createdAt: yield* nowIso,
      removed: false,
    });

    return yield* publishRelations([input.issueId, input.relatedIssueId]);
  });

  const relationDelete: IssueTrackerServiceShape["relationDelete"] = Effect.fn(
    "IssueTrackerService.relationDelete",
  )(function* (input, actor) {
    const found = yield* relationRepository
      .getById({ relationId: input.relationId })
      .pipe(Effect.mapError(storage("Failed to read the issue relation")));
    if (Option.isNone(found)) {
      return yield* notFound(input.relationId, `No issue relation with id ${input.relationId}.`);
    }
    const relation = found.value;

    yield* relationRepository
      .deleteById({ relationId: relation.id })
      .pipe(Effect.mapError(storage("Failed to delete the issue relation")));

    // The keys are read after the delete on purpose: an issue on either end may already be gone,
    // and a missing key logs as the id rather than refusing to unlink the survivor.
    const records = yield* listRecords();
    const keyOf = (issueId: IssueId) =>
      records.find((record) => record.id === issueId)?.key ?? issueId;
    yield* logRelation({
      relation,
      issueKey: keyOf(relation.issueId),
      relatedKey: keyOf(relation.relatedIssueId),
      actor,
      createdAt: yield* nowIso,
      removed: true,
    });

    return yield* publishRelations([relation.issueId, relation.relatedIssueId]);
  });

  /**
   * Attachment ids are namespaced to the issue that owns them (`attachmentStore.ts`). A comment
   * pointing at a thread's image would break twice over: thread attachment cleanup sweeps by that
   * namespace and would delete the file, and an issue would be reading a turn's private upload.
   */
  const validateCommentAttachments = (issueId: IssueId, attachmentIds: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      if (attachmentIds.length === 0) return;
      const expected = toSafeIssueAttachmentSegment(issueId);
      const foreign = attachmentIds.find(
        (attachmentId) => parseIssueSegmentFromAttachmentId(attachmentId) !== expected,
      );
      if (foreign !== undefined) {
        return yield* invalid(`Attachment ${foreign} does not belong to this issue.`, foreign);
      }
    });

  const requireComment = (commentId: IssueComment["id"]) =>
    commentRepository.getById({ commentId }).pipe(
      Effect.mapError(storage("Failed to read the issue comment")),
      Effect.flatMap((comment) =>
        Option.isNone(comment)
          ? Effect.fail(notFound(commentId, `No issue comment with id ${commentId}.`))
          : Effect.succeed(comment.value),
      ),
    );

  const commentCreate: IssueTrackerServiceShape["commentCreate"] = Effect.fn(
    "IssueTrackerService.commentCreate",
  )(function* (input, actor) {
    yield* requireIssueRecord(input.issueId);
    const attachmentIds = input.attachmentIds ?? [];
    yield* validateCommentAttachments(input.issueId, attachmentIds);

    const comment: IssueComment = {
      id: IssueCommentId.make(yield* newId),
      issueId: input.issueId,
      author: actor,
      body: input.body,
      attachmentIds,
      createdAt: yield* nowIso,
      editedAt: null,
    };
    yield* commentRepository
      .upsert(comment)
      .pipe(Effect.mapError(storage("Failed to write the issue comment")));
    yield* publish({ _tag: "IssueCommentUpserted", comment });
    return { comment };
  });

  const commentUpdate: IssueTrackerServiceShape["commentUpdate"] = Effect.fn(
    "IssueTrackerService.commentUpdate",
  )(function* (input, actor) {
    const current = yield* requireComment(input.commentId);
    // Only the writer rewrites their own words. There is no editing on somebody else's behalf,
    // and an agent must not be able to rewrite what a person said it was asked to do.
    if (!isSameActor(actor, current.author)) {
      return yield* invalid("Only the author can edit a comment.", current.id);
    }
    const { patch } = input;
    const attachmentIds = patch.attachmentIds ?? current.attachmentIds;
    if (patch.attachmentIds !== undefined) {
      yield* validateCommentAttachments(current.issueId, attachmentIds);
    }

    const comment: IssueComment = {
      ...current,
      ...(patch.body === undefined ? {} : { body: patch.body }),
      attachmentIds,
      // `createdAt` does not move, so an edited comment keeps its place in the thread.
      editedAt: yield* nowIso,
    };
    yield* commentRepository
      .upsert(comment)
      .pipe(Effect.mapError(storage("Failed to write the issue comment")));
    yield* publish({ _tag: "IssueCommentUpserted", comment });
    return { comment };
  });

  const commentDelete: IssueTrackerServiceShape["commentDelete"] = Effect.fn(
    "IssueTrackerService.commentDelete",
  )(function* (input, actor) {
    const current = yield* requireComment(input.commentId);
    // The sole human on this environment can delete anybody's comment, including an agent's: this
    // is their tracker, and an agent that comments in a loop has to be stoppable by hand.
    if (actor.kind !== "user" && !isSameActor(actor, current.author)) {
      return yield* invalid("Only the author can delete a comment.", current.id);
    }

    yield* commentRepository
      .deleteById({ commentId: current.id })
      .pipe(Effect.mapError(storage("Failed to delete the issue comment")));
    yield* publish({
      _tag: "IssueCommentDeleted",
      issueId: current.issueId,
      commentId: current.id,
    });
    return { issueId: current.issueId, comments: yield* listComments(current.issueId) };
  });

  const commentsList: IssueTrackerServiceShape["commentsList"] = Effect.fn(
    "IssueTrackerService.commentsList",
  )(function* (input) {
    yield* requireIssueRecord(input.issueId);
    return { issueId: input.issueId, comments: yield* listComments(input.issueId) };
  });

  /**
   * The one write on this service that puts bytes on disk. It mirrors `thread.turn.start`'s
   * attachment normalisation (`orchestration/Normalizer.ts`) rather than inventing a second
   * decode: same data-URL parser, same images-only rule, same ceiling.
   */
  const uploadCommentAttachment: IssueTrackerServiceShape["uploadCommentAttachment"] = Effect.fn(
    "IssueTrackerService.uploadCommentAttachment",
  )(function* (input) {
    yield* requireIssueRecord(input.issueId);

    const parsed = parseBase64DataUrl(input.dataUrl);
    if (parsed === null || !parsed.mimeType.startsWith("image/")) {
      return yield* invalid("A comment attachment must be a base64 image data URL.", input.issueId);
    }

    const bytes = Buffer.from(parsed.base64, "base64");
    if (bytes.byteLength === 0 || bytes.byteLength > ISSUE_COMMENT_ATTACHMENT_MAX_BYTES) {
      return yield* invalid("The comment attachment is empty or too large.", input.issueId);
    }

    // The issue segment of the id is what `validateCommentAttachments` later checks a comment's
    // attachments against, and what keeps thread attachment cleanup from sweeping this file.
    const attachmentId = createIssueAttachmentId(input.issueId);
    if (attachmentId === null) {
      return yield* invalid("This issue cannot own an attachment.", input.issueId);
    }

    const attachmentPath = resolveAttachmentPath({
      attachmentsDir: serverConfig.attachmentsDir,
      attachment: {
        type: "image",
        id: attachmentId,
        name: attachmentId,
        mimeType: parsed.mimeType.toLowerCase(),
        sizeBytes: bytes.byteLength,
      },
    });
    if (attachmentPath === null) {
      return yield* new IssueTrackerError({
        reason: "storage",
        message: "Failed to resolve a path for the comment attachment.",
      });
    }

    yield* fileSystem.makeDirectory(path.dirname(attachmentPath), { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new IssueTrackerError({
            reason: "storage",
            message: `Failed to create the attachment directory: ${cause.message}`,
          }),
      ),
    );
    yield* fileSystem.writeFile(attachmentPath, bytes).pipe(
      Effect.mapError(
        (cause) =>
          new IssueTrackerError({
            reason: "storage",
            message: `Failed to write the comment attachment: ${cause.message}`,
          }),
      ),
    );

    return { attachmentId };
  });

  const publishViews = () =>
    listViews().pipe(
      Effect.tap((views) => publish({ _tag: "ViewsChanged", views })),
      Effect.map((views) => ({ views })),
    );

  const viewCreate: IssueTrackerServiceShape["viewCreate"] = Effect.fn(
    "IssueTrackerService.viewCreate",
  )(function* (input) {
    const views = yield* listViews();
    if (views.some((candidate) => candidate.name.toLowerCase() === input.name.toLowerCase())) {
      return yield* conflict(`A view named ${input.name} already exists.`, input.name);
    }

    const createdAt = yield* nowIso;
    const view: IssueView = {
      id: IssueViewId.make(yield* newId),
      name: input.name,
      position: input.position ?? (views.at(-1)?.position ?? 0) + 1,
      config: input.config,
      createdAt,
      updatedAt: createdAt,
    };
    yield* viewRepository
      .upsert(view)
      .pipe(Effect.mapError(storage("Failed to write the issue view")));

    const { views: next } = yield* publishViews();
    return { view, views: next };
  });

  const viewUpdate: IssueTrackerServiceShape["viewUpdate"] = Effect.fn(
    "IssueTrackerService.viewUpdate",
  )(function* (input) {
    const views = yield* listViews();
    const current = views.find((candidate) => candidate.id === input.viewId);
    if (current === undefined) {
      return yield* notFound(input.viewId, `No issue view with id ${input.viewId}.`);
    }
    const { patch } = input;
    if (
      patch.name !== undefined &&
      views.some(
        (candidate) =>
          candidate.id !== current.id && candidate.name.toLowerCase() === patch.name?.toLowerCase(),
      )
    ) {
      return yield* conflict(`A view named ${patch.name} already exists.`, patch.name);
    }

    const view: IssueView = {
      ...current,
      ...(patch.name === undefined ? {} : { name: patch.name }),
      ...(patch.position === undefined ? {} : { position: patch.position }),
      // Replaced wholesale: every filter on a chip bar is optional, so a merge could not clear one.
      ...(patch.config === undefined ? {} : { config: patch.config }),
      updatedAt: yield* nowIso,
    };
    yield* viewRepository
      .upsert(view)
      .pipe(Effect.mapError(storage("Failed to write the issue view")));

    const { views: next } = yield* publishViews();
    return { view, views: next };
  });

  const viewDelete: IssueTrackerServiceShape["viewDelete"] = Effect.fn(
    "IssueTrackerService.viewDelete",
  )(function* (input) {
    const views = yield* listViews();
    if (!views.some((candidate) => candidate.id === input.viewId)) {
      return yield* notFound(input.viewId, `No issue view with id ${input.viewId}.`);
    }
    // Hard, unlike an issue: a view holds no history, so there is nothing an undo would recover.
    yield* viewRepository
      .deleteById({ viewId: input.viewId })
      .pipe(Effect.mapError(storage("Failed to delete the issue view")));

    return yield* publishViews();
  });

  const viewsReorder: IssueTrackerServiceShape["viewsReorder"] = Effect.fn(
    "IssueTrackerService.viewsReorder",
  )(function* (input) {
    const views = yield* listViews();
    const requested = new Set(input.viewIds);
    if (requested.size !== input.viewIds.length) {
      return yield* invalid("The requested order repeats a view.");
    }
    const unknown = input.viewIds.find((viewId) => !views.some((view) => view.id === viewId));
    if (unknown !== undefined) {
      return yield* notFound(unknown, `No issue view with id ${unknown}.`);
    }
    // The payload is the complete order, so a view missing from it would get no position — the
    // same rule statuses follow.
    const omitted = views.find((view) => !requested.has(view.id));
    if (omitted !== undefined) {
      return yield* invalid("The requested order leaves out a view.", omitted.name);
    }

    yield* viewRepository
      .setPositions({
        positions: input.viewIds.map((viewId, index) => ({ viewId, position: index + 1 })),
        updatedAt: yield* nowIso,
      })
      .pipe(Effect.mapError(storage("Failed to reorder the issue views")));

    return yield* publishViews();
  });

  const setKeyPrefix: IssueTrackerServiceShape["setKeyPrefix"] = Effect.fn(
    "IssueTrackerService.setKeyPrefix",
  )(function* (input) {
    const current = yield* readConfig();
    // No change log row: the prefix belongs to the tracker, and `issue_events` rows hang off an
    // issue. Nothing that was already issued moved.
    if (current.keyPrefix === input.keyPrefix) return { config: current };

    const config = yield* configRepository
      .setPrefix({ keyPrefix: input.keyPrefix })
      .pipe(Effect.mapError(storage("Failed to rename the issue key prefix")));
    yield* publish({ _tag: "ConfigChanged", config });
    return { config };
  });

  const getEvents: IssueTrackerServiceShape["getEvents"] = Effect.fn(
    "IssueTrackerService.getEvents",
  )(function* (input) {
    const record = yield* issueRepository
      .getById({ issueId: input.issueId })
      .pipe(Effect.mapError(storage("Failed to read the issue")));
    if (Option.isNone(record)) {
      return yield* notFound(input.issueId, `No issue with id ${input.issueId}.`);
    }
    const events = yield* eventRepository
      .listByIssue({ issueId: input.issueId })
      .pipe(Effect.mapError(storage("Failed to read the issue change log")));
    return { events };
  });

  const listEnrichmentRuns = (issueId: IssueId) =>
    enrichmentRunRepository
      .listByIssue({ issueId })
      .pipe(Effect.mapError(storage("Failed to read the issue enrichment runs")));

  const requireEnrichmentRun = (runId: IssueEnrichmentRunId) =>
    enrichmentRunRepository.getById({ runId }).pipe(
      Effect.mapError(storage("Failed to read the enrichment run")),
      Effect.flatMap((run) =>
        Option.isNone(run)
          ? Effect.fail(notFound(runId, `No enrichment run with id ${runId}.`))
          : Effect.succeed(run.value),
      ),
    );

  /** Read the row back and send it whole, which is what the live panel renders. */
  const publishEnrichmentRun = (runId: IssueEnrichmentRunId) =>
    requireEnrichmentRun(runId).pipe(
      Effect.flatMap((run) => publish({ _tag: "EnrichmentRunChanged", run })),
    );

  /**
   * The one terminal write, and the reason it reads first: cancelling marks a run failed while
   * its process is still winding down, and the engine's own outcome must not overwrite that.
   */
  const finishEnrichmentRun = (
    runId: IssueEnrichmentRunId,
    state: "done" | "failed",
    result: IssueEnrichmentRun["result"],
    error: string | null,
  ) =>
    Effect.gen(function* () {
      const existing = yield* requireEnrichmentRun(runId);
      if (existing.state === "done" || existing.state === "failed") return;
      const finishedAt = yield* nowIso;
      yield* enrichmentRunRepository
        .finish({ runId, state, result, error, finishedAt })
        .pipe(Effect.mapError(storage("Failed to finish the enrichment run")));
      yield* publishEnrichmentRun(runId);

      // A result nobody can find is not a result. Landing it as a comment here, inside the guarded
      // terminal write, is what makes a cancelled run leave the issue thread alone: the
      // early return above has already fired by the time a late `succeed` arrives.
      if (state === "done" && result !== null) {
        yield* recordInvestigation({
          issueId: existing.issueId,
          modelSelection: existing.modelSelection,
          result,
          finishedAt,
        });
      }
    });

  /**
   * Leave a finished investigation as a comment from the agent that ran it.
   *
   * The run row remains the source for transcripts and suggestions; the comment is the durable,
   * human-readable handoff. Priority and safe missing-field rewrites land first as agent-authored
   * issue changes. Labels remain reviewable suggestions.
   */
  const recordInvestigation = (input: {
    readonly issueId: IssueId;
    readonly modelSelection: IssueEnrichmentRun["modelSelection"];
    readonly result: NonNullable<IssueEnrichmentRun["result"]>;
    readonly finishedAt: string;
  }) =>
    Effect.gen(function* () {
      const actor: IssueActor = {
        // The instance id doubles as the driver kind for every built-in provider, and names the
        // configured instance for the rest; either way the feed says which agent wrote this.
        kind: "agent",
        provider: ProviderDriverKind.make(input.modelSelection.instanceId),
      };
      // Read the row before its history: if a user title lands between the two reads, its event is
      // visible and closes the automatic-title path. Parallel reads could observe the inverse.
      const record = yield* requireIssueRecord(input.issueId);
      const events = yield* eventRepository
        .listByIssue({ issueId: input.issueId })
        .pipe(Effect.mapError(storage("Failed to read the issue change log")));
      const patch = issueEnrichmentAutomaticPatch({
        issue: record,
        result: input.result,
        titleActor: latestIssueTitleActor(events),
      });
      if (Object.keys(patch).length > 0) {
        yield* update({ issueId: input.issueId, patch }, actor);
      }

      const body = buildInvestigationComment({
        result: input.result,
        model: `${input.modelSelection.instanceId} / ${input.modelSelection.model}`,
        finishedAt: input.finishedAt,
      });
      yield* commentCreate(
        {
          issueId: input.issueId,
          body,
        },
        actor,
      );
    });

  /**
   * What the engine reports through. Every method writes the row and republishes the whole run,
   * so the engine never touches this service's tag and the two layers stay acyclic.
   */
  const makeEnrichmentRecorder = (runId: IssueEnrichmentRunId): IssueEnrichmentRunRecorder => ({
    markRunning: Effect.gen(function* () {
      const startedAt = yield* nowIso;
      yield* enrichmentRunRepository
        .start({ runId, startedAt })
        .pipe(Effect.mapError(storage("Failed to start the enrichment run")));
      yield* publishEnrichmentRun(runId);
    }),
    appendTranscript: (chunk) =>
      chunk.length === 0
        ? Effect.void
        : enrichmentRunRepository
            .appendTranscript({ runId, chunk })
            .pipe(
              Effect.mapError(storage("Failed to append to the enrichment transcript")),
              Effect.andThen(publishEnrichmentRun(runId)),
            ),
    succeed: (result) => finishEnrichmentRun(runId, "done", result, null),
    fail: (reason) => finishEnrichmentRun(runId, "failed", null, reason),
  });

  const startEnrichment: IssueTrackerServiceShape["startEnrichment"] = Effect.fn(
    "IssueTrackerService.startEnrichment",
  )(function* (input) {
    const record = yield* requireIssueRecord(input.issueId);

    // A second run is refused rather than queued: two investigations of the same tree answer the
    // same question and spend twice the tokens doing it.
    const unfinished = yield* enrichmentRunRepository
      .listUnfinished()
      .pipe(Effect.mapError(storage("Failed to read the issue enrichment runs")));
    if (unfinished.some((run) => run.issueId === record.id)) {
      return yield* invalid(
        `An enrichment run is already in flight for ${record.key}.`,
        record.key,
      );
    }

    // Enrichment is a read-only process in a directory. A rootless project has none, and neither
    // does an issue that belongs to no project at all.
    if (record.projectId === null) {
      return yield* invalid(
        `${record.key} has no project, so there is no repository to investigate.`,
        record.key,
      );
    }
    const project = yield* projectRepository
      .getById({ projectId: record.projectId })
      .pipe(Effect.mapError(storage("Failed to read the project")));
    const workspaceRoot =
      Option.isSome(project) && project.value.deletedAt === null
        ? project.value.workspaceRoot
        : null;
    if (workspaceRoot === null) {
      return yield* invalid(
        `The project on ${record.key} has no directory, so there is no repository to investigate.`,
        record.key,
      );
    }

    // Resolved before the row is written, so a refusal here leaves nothing behind and a later
    // settings change cannot relabel a finished run.
    const modelSelection = yield* enrichmentEngine.resolveModelSelection;
    const createdAt = yield* nowIso;
    const run: IssueEnrichmentRun = {
      id: IssueEnrichmentRunId.make(yield* newId),
      issueId: record.id,
      state: "queued",
      modelSelection,
      transcript: "",
      result: null,
      error: null,
      createdAt,
      startedAt: null,
      finishedAt: null,
    };
    yield* enrichmentRunRepository
      .create(run)
      .pipe(Effect.mapError(storage("Failed to record the enrichment run")));
    yield* publish({ _tag: "EnrichmentRunChanged", run });

    const labelIds = yield* labelsOf(record.id);
    const recorder = makeEnrichmentRecorder(run.id);
    // Detached from the request fiber: an investigation takes minutes, the button that asked for
    // it answers now, and the run must outlive the socket that started it. Anything escaping —
    // a failure or a defect — lands the run in `failed` rather than leaving it running forever.
    yield* Effect.forkDetach(
      enrichmentEngine.start({ run, issue: { ...record, labelIds }, workspaceRoot, recorder }).pipe(
        Effect.catchCause((cause) =>
          recorder.fail(`The enrichment run stopped unexpectedly: ${Cause.pretty(cause)}`),
        ),
        Effect.ignoreCause({ log: true }),
      ),
    );

    return { run };
  });

  const cancelEnrichment: IssueTrackerServiceShape["cancelEnrichment"] = Effect.fn(
    "IssueTrackerService.cancelEnrichment",
  )(function* (input) {
    const existing = yield* requireEnrichmentRun(input.runId);
    if (existing.state === "done" || existing.state === "failed") {
      return yield* conflict(`Enrichment run ${existing.id} has already finished.`, existing.id);
    }
    // The record is marked first and the process is stopped after: whatever the engine reports on
    // its way down finds a finished row and leaves the cancellation standing.
    yield* finishEnrichmentRun(existing.id, "failed", null, ENRICHMENT_CANCELED_REASON);
    yield* enrichmentEngine.cancel({ runId: existing.id });
    return { run: yield* requireEnrichmentRun(existing.id) };
  });

  const getEnrichmentRuns: IssueTrackerServiceShape["getEnrichmentRuns"] = Effect.fn(
    "IssueTrackerService.getEnrichmentRuns",
  )(function* (input) {
    yield* requireIssueRecord(input.issueId);
    return { issueId: input.issueId, runs: yield* listEnrichmentRuns(input.issueId) };
  });

  const readThreadLinks = (issueId: IssueId) =>
    threadLinkRepository
      .listByIssue({ issueId })
      .pipe(Effect.mapError(storage("Failed to read the issue thread links")));

  const publishThreadLinks = (issueId: IssueId, links: ReadonlyArray<IssueThreadLink>) =>
    publish({ _tag: "IssueThreadLinksChanged", issueId, links });

  const linkThread: IssueTrackerServiceShape["linkThread"] = Effect.fn(
    "IssueTrackerService.linkThread",
  )(function* (input, actor) {
    const record = yield* requireIssueRecord(input.issueId);
    const existing = yield* readThreadLinks(record.id);
    const already = existing.find((link) => link.threadId === input.threadId);
    const now = yield* nowIso;
    yield* threadLinkRepository
      .link({
        issueId: record.id,
        threadId: input.threadId,
        origin: input.origin,
        // The fact is when this thread started on this issue, not when somebody last said so.
        createdAt: already?.createdAt ?? now,
      })
      .pipe(Effect.mapError(storage("Failed to link the thread")));

    // Only the first link is logged: relinking restates the same fact, and the feed should not
    // print "linked thread …" twice for one thread.
    if (already === undefined) {
      yield* appendChangeLog({
        issueId: record.id,
        actor,
        createdAt: now,
        kind: "field_changed",
        changes: [{ field: "thread", before: null, after: input.threadId }],
      });
    }

    const links = yield* readThreadLinks(record.id);
    yield* publishThreadLinks(record.id, links);
    return { issueId: record.id, links };
  });

  const unlinkThread: IssueTrackerServiceShape["unlinkThread"] = Effect.fn(
    "IssueTrackerService.unlinkThread",
  )(function* (input, actor) {
    const record = yield* requireIssueRecord(input.issueId);
    const existing = yield* readThreadLinks(record.id);
    // Forgetting something already forgotten is not an error: two clients can press this at once,
    // and the answer either way is the list without that thread on it.
    if (!existing.some((link) => link.threadId === input.threadId)) {
      return { issueId: record.id, links: existing };
    }

    yield* threadLinkRepository
      .unlink({ issueId: record.id, threadId: input.threadId })
      .pipe(Effect.mapError(storage("Failed to unlink the thread")));
    yield* appendChangeLog({
      issueId: record.id,
      actor,
      createdAt: yield* nowIso,
      kind: "field_changed",
      changes: [{ field: "thread", before: input.threadId, after: null }],
    });

    const links = yield* readThreadLinks(record.id);
    yield* publishThreadLinks(record.id, links);
    return { issueId: record.id, links };
  });

  const getThreadLinks: IssueTrackerServiceShape["getThreadLinks"] = Effect.fn(
    "IssueTrackerService.getThreadLinks",
  )(function* (input) {
    yield* requireIssueRecord(input.issueId);
    return { issueId: input.issueId, links: yield* readThreadLinks(input.issueId) };
  });

  // ── Slack intake ─────────────────────────────────────────────────────

  const secretFailure = (operation: string) => (cause: SecretStoreError) =>
    new IssueTrackerError({ reason: "storage", message: `${operation}: ${cause.message}` });

  /** Every move of the status is published: four small fields, so there is nothing to diff. */
  const patchSlackStatus = (patch: Partial<SlackIntakeStatus>) =>
    Ref.updateAndGet(slackStatus, (current) => ({ ...current, ...patch })).pipe(
      Effect.tap((status) => publish({ _tag: "SlackStatusChanged", status })),
    );

  const slackGetStatus: IssueTrackerServiceShape["slackGetStatus"] = () =>
    Effect.map(Ref.get(slackStatus), (status) => ({ status }));

  const slackSetToken: IssueTrackerServiceShape["slackSetToken"] = Effect.fn(
    "IssueTrackerService.slackSetToken",
  )(function* (input) {
    const token = input.token.trim();
    if (token.length === 0) {
      yield* secretStore
        .remove(SLACK_BOT_TOKEN_SECRET)
        .pipe(Effect.mapError(secretFailure("Failed to clear the Slack bot token")));
      // Everything the old token told us goes with it, including the last error: a disconnected
      // integration reporting last week's failure reads as a broken one.
      const status = yield* patchSlackStatus({
        configured: false,
        workspaceName: null,
        lastError: null,
        lastPollAt: null,
      });
      yield* slackEngine.notifyWatchesChanged;
      return { status };
    }

    // Tried before it is written, so `configured` never means "configured with something broken".
    // The failure is left on the status as well as raised: the settings page reads the status.
    const connection = yield* slackEngine
      .testConnection({ token })
      .pipe(Effect.tapError((error) => patchSlackStatus({ lastError: error.message })));
    yield* secretStore
      .set(SLACK_BOT_TOKEN_SECRET, textEncoder.encode(token))
      .pipe(Effect.mapError(secretFailure("Failed to store the Slack bot token")));

    const workspaceName = connection.workspaceName.trim();
    const status = yield* patchSlackStatus({
      configured: true,
      workspaceName: workspaceName.length === 0 ? null : workspaceName,
      lastError: null,
      // A new token is a new connection, and the old token's last poll says nothing about it.
      lastPollAt: null,
    });
    yield* slackEngine.notifyWatchesChanged;
    return { status };
  });

  const slackListChannels: IssueTrackerServiceShape["slackListChannels"] = () =>
    Effect.map(slackEngine.listChannels, (channels) => ({ channels }));

  const requireSlackWatch = (watchId: SlackChannelWatch["id"]) =>
    slackWatchRepository.getById({ watchId }).pipe(
      Effect.mapError(storage("Failed to read the Slack channel watch")),
      Effect.flatMap((watch) =>
        Option.isNone(watch)
          ? Effect.fail(notFound(watchId, `No Slack channel watch with id ${watchId}.`))
          : Effect.succeed(watch.value),
      ),
    );

  const slackWatchCreate: IssueTrackerServiceShape["slackWatchCreate"] = Effect.fn(
    "IssueTrackerService.slackWatchCreate",
  )(function* (input) {
    const existing = yield* listSlackWatches();
    if (existing.some((watch) => watch.channelId === input.channelId)) {
      return yield* conflict(`#${input.channelName} is already watched.`, input.channelName);
    }
    // Every watch costs a history call per interval, forever, on a laptop.
    if (existing.length >= SLACK_MAX_CHANNEL_WATCHES) {
      return yield* conflict(
        `At most ${SLACK_MAX_CHANNEL_WATCHES} Slack channels can be watched at once.`,
      );
    }
    if (
      input.cycleId !== undefined &&
      input.cycleId !== null &&
      !(yield* listCycles()).some((cycle) => cycle.id === input.cycleId)
    ) {
      return yield* notFound(input.cycleId, `No issue cycle with id ${input.cycleId}.`);
    }

    const createdAt = yield* nowIso;
    const watch: SlackChannelWatch = {
      id: SlackChannelWatchId.make(yield* newId),
      channelId: input.channelId,
      channelName: input.channelName,
      projectId: input.projectId ?? null,
      cycleId: input.cycleId ?? null,
      autoInvestigate: input.autoInvestigate ?? false,
      autoAssign: input.autoAssign ?? false,
      trigger: input.trigger ?? PAUSED_SLACK_TRIGGER,
      createdAt,
      updatedAt: createdAt,
    };
    yield* slackWatchRepository
      .upsert(watch)
      .pipe(Effect.mapError(storage("Failed to write the Slack channel watch")));

    return { watch, watches: yield* publishSlackWatches() };
  });

  const slackWatchUpdate: IssueTrackerServiceShape["slackWatchUpdate"] = Effect.fn(
    "IssueTrackerService.slackWatchUpdate",
  )(function* (input) {
    const existing = yield* requireSlackWatch(input.watchId);
    const { patch } = input;
    if (
      patch.cycleId !== undefined &&
      patch.cycleId !== null &&
      !(yield* listCycles()).some((cycle) => cycle.id === patch.cycleId)
    ) {
      return yield* notFound(patch.cycleId, `No issue cycle with id ${patch.cycleId}.`);
    }
    const next: SlackChannelWatch = {
      ...existing,
      ...(patch.channelName === undefined ? {} : { channelName: patch.channelName }),
      ...(patch.projectId === undefined ? {} : { projectId: patch.projectId }),
      ...(patch.cycleId === undefined ? {} : { cycleId: patch.cycleId }),
      ...(patch.autoInvestigate === undefined ? {} : { autoInvestigate: patch.autoInvestigate }),
      ...(patch.autoAssign === undefined ? {} : { autoAssign: patch.autoAssign }),
      // Replaced wholesale rather than merged: the trigger is one set of switches, and a partial
      // patch could never say "no emoji".
      ...(patch.trigger === undefined ? {} : { trigger: patch.trigger }),
    };
    if (
      next.channelName === existing.channelName &&
      next.projectId === existing.projectId &&
      next.cycleId === existing.cycleId &&
      next.autoInvestigate === existing.autoInvestigate &&
      next.autoAssign === existing.autoAssign &&
      slackTriggersEqual(next.trigger, existing.trigger)
    ) {
      return { watch: existing, watches: yield* listSlackWatches() };
    }

    const updated: SlackChannelWatch = { ...next, updatedAt: yield* nowIso };
    yield* slackWatchRepository
      .upsert(updated)
      .pipe(Effect.mapError(storage("Failed to write the Slack channel watch")));

    return { watch: updated, watches: yield* publishSlackWatches() };
  });

  const slackWatchDelete: IssueTrackerServiceShape["slackWatchDelete"] = Effect.fn(
    "IssueTrackerService.slackWatchDelete",
  )(function* (input) {
    yield* requireSlackWatch(input.watchId);
    // The channel's cursor and its processed messages stay behind on purpose: unwatching is
    // usually a pause, and re-watching a swept channel would refile its whole history window.
    yield* slackWatchRepository
      .deleteById({ watchId: input.watchId })
      .pipe(Effect.mapError(storage("Failed to delete the Slack channel watch")));

    return { watches: yield* publishSlackWatches() };
  });

  const slackRecordPoll: IssueTrackerServiceShape["slackRecordPoll"] = Effect.fn(
    "IssueTrackerService.slackRecordPoll",
  )(function* (input) {
    return yield* patchSlackStatus({ lastPollAt: yield* nowIso, lastError: input.error });
  });

  const slackRecordOutboundPost: IssueTrackerServiceShape["slackRecordOutboundPost"] = Effect.fn(
    "IssueTrackerService.slackRecordOutboundPost",
  )(function* (input) {
    yield* slackLedgerRepository
      .recordOutbound({
        channelId: input.channelId,
        messageTs: input.messageTs,
        createdAt: yield* nowIso,
      })
      .pipe(Effect.mapError(storage("Failed to record the Slack outbound post")));
  });

  const readProcessedMessage = (channelId: SlackChannelId, messageTs: SlackMessageTs) =>
    slackLedgerRepository
      .getProcessed({ channelId, messageTs })
      .pipe(Effect.mapError(storage("Failed to read the Slack message ledger")));

  const recordProcessedMessage = (
    channelId: SlackChannelId,
    messageTs: SlackMessageTs,
    issueId: IssueId | null,
  ) =>
    Effect.flatMap(nowIso, (createdAt) =>
      slackLedgerRepository
        .recordProcessed({ channelId, messageTs, issueId, createdAt })
        .pipe(Effect.mapError(storage("Failed to record the Slack message ledger"))),
    );

  const intakeCreateIssue: IssueTrackerServiceShape["intakeCreateIssue"] = Effect.fn(
    "IssueTrackerService.intakeCreateIssue",
  )(function* (input) {
    // A poll window overlaps the last one by design — a cursor is a floor, not a fence — so the
    // ledger, not the cursor, is what stops a message from being filed twice.
    const processed = yield* readProcessedMessage(input.channelId, input.messageTs);
    if (Option.isSome(processed) && processed.value.issueId !== null) {
      const existing = yield* issueRepository
        .getById({ issueId: processed.value.issueId })
        .pipe(Effect.mapError(storage("Failed to read the issue")));
      if (Option.isSome(existing)) {
        const labelIds = yield* labelsOf(existing.value.id);
        return { issue: { ...existing.value, labelIds }, created: false };
      }
      // The row it named is gone for good, so the ledger is stale rather than authoritative and
      // this message deserves a second chance at being an issue.
    }

    const title = normalizeSlackTitle(input.title);
    const { issue } = yield* createIssue(
      {
        title,
        triage: true,
        ...(input.description === undefined ? {} : { description: input.description }),
        // The channel's auto-tag target, and `undefined` rather than `null` because
        // `IssueCreateInput` has no "explicitly no project" — absent already means that.
        ...(input.projectId === undefined || input.projectId === null
          ? {}
          : { projectId: input.projectId }),
        ...(input.cycleId === undefined || input.cycleId === null
          ? {}
          : { cycleId: input.cycleId }),
      },
      SLACK_ACTOR,
      {
        channelId: input.channelId,
        messageTs: input.messageTs,
        permalink: nullableTrimmed(input.permalink),
        authorName: nullableTrimmed(input.authorName),
      },
    );
    yield* recordProcessedMessage(input.channelId, input.messageTs, issue.id);
    return { issue, created: true };
  });

  const intakeAddComment: IssueTrackerServiceShape["intakeAddComment"] = Effect.fn(
    "IssueTrackerService.intakeAddComment",
  )(function* (input) {
    const already = yield* readProcessedMessage(input.channelId, input.messageTs);
    if (Option.isSome(already)) return { comment: null };

    const parent = yield* readProcessedMessage(input.channelId, input.threadTs);
    const issueId = Option.isSome(parent) ? parent.value.issueId : null;
    if (issueId === null) {
      // Most replies in a watched channel are on threads that never became issues. Remembering
      // that is what stops the next pass from reconsidering this one.
      yield* recordProcessedMessage(input.channelId, input.messageTs, null);
      return { comment: null };
    }

    const record = yield* issueRepository
      .getById({ issueId })
      .pipe(Effect.mapError(storage("Failed to read the issue")));
    if (Option.isNone(record) || record.value.deletedAt !== null) {
      yield* recordProcessedMessage(input.channelId, input.messageTs, null);
      return { comment: null };
    }

    // The author rides in the body rather than in `author`: the comment was written by a person
    // this environment has no account for, and `system:slack` is the honest actor for the write.
    const authorName = nullableTrimmed(input.authorName);
    const body = authorName === null ? input.body : `**${authorName}:** ${input.body}`;
    const attachmentIds = input.attachmentIds ?? [];
    const { comment } = yield* commentCreate(
      { issueId, body, ...(attachmentIds.length === 0 ? {} : { attachmentIds }) },
      SLACK_ACTOR,
    );
    yield* recordProcessedMessage(input.channelId, input.messageTs, issueId);
    return { comment };
  });

  // ── Triage ───────────────────────────────────────────────────────────

  const triageAccept: IssueTrackerServiceShape["triageAccept"] = Effect.fn(
    "IssueTrackerService.triageAccept",
  )(function* (input, actor) {
    const [statuses, labels, records, milestones, cycles] = yield* Effect.all([
      listStatuses(),
      listLabels(),
      listRecords(),
      listMilestones(),
      listCycles(),
    ]);
    const record = yield* requireRecord(records, input.issueId);
    if (record.deletedAt !== null) {
      return yield* conflict(`${record.key} has been deleted.`, record.key);
    }
    // Accepting something already accepted is a stale client, and answering "done" would hide a
    // second enrichment run behind a button that looked idempotent.
    if (!record.triage) {
      return yield* conflict(`${record.key} is not in triage.`, record.key);
    }

    // One patch, so `patchOne` writes one `issue_events` row per field that actually moved and
    // publishes one `IssueUpserted`. Three separate writes would put a half-triaged issue on the
    // board between them, which is the state triage exists to keep out of it.
    const patch: IssuePatch = {
      statusId: input.statusId,
      triage: false,
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
      ...(input.priority === undefined ? {} : { priority: input.priority }),
      ...(input.assignee === undefined ? {} : { assignee: input.assignee }),
    };
    yield* validatePatch({
      patch,
      statuses,
      labels,
      milestones,
      cycles,
      records,
      issueIds: [input.issueId],
    });

    const labelIds = yield* labelsOf(input.issueId);
    const naming = namingOf(statuses, labels, milestones, cycles);
    yield* validatePlacements({
      targets: [record],
      labelIdsOf: () => labelIds,
      patch,
      naming,
      tree: buildIssueTree(records),
      milestones,
    });

    const issue = yield* patchOne({
      record,
      labelIds,
      patch,
      naming,
      actor,
      updatedAt: yield* nowIso,
    });
    if (!input.runEnrichment) return { issue, enrichmentRun: null, enrichmentRefusal: null };

    // Tolerant on purpose. Enrichment refuses a rootless or absent project, a run already in
    // flight, and a server with no model configured — none of which is a reason to un-triage an
    // issue somebody just triaged. The refusal is reported beside the accepted issue instead.
    return yield* startEnrichment({ issueId: issue.id }).pipe(
      Effect.map(({ run }) => ({ issue, enrichmentRun: run, enrichmentRefusal: null })),
      Effect.catch((error) =>
        Effect.succeed({ issue, enrichmentRun: null, enrichmentRefusal: error.message }),
      ),
    );
  });

  const triageReject: IssueTrackerServiceShape["triageReject"] = Effect.fn(
    "IssueTrackerService.triageReject",
  )(function* (input, actor) {
    const records = yield* listRecords();
    const record = yield* requireRecord(records, input.issueId);
    const labelIds = yield* labelsOf(input.issueId);
    if (record.deletedAt !== null) return { issue: { ...record, labelIds } };

    const deletedAt = yield* nowIso;
    yield* issueRepository
      .softDelete({ issueId: input.issueId, deletedAt })
      .pipe(Effect.mapError(storage("Failed to reject the triage item")));
    // `triage_rejected` rather than `deleted`: "this never was an issue" is the ordinary outcome
    // of intake, and it should not read in the feed as somebody destroying work.
    yield* appendChangeLog({
      issueId: input.issueId,
      actor,
      createdAt: deletedAt,
      kind: "triage_rejected",
      changes: WHOLE_ISSUE_CHANGE,
    });

    // `triage` is left set: a deleted triage item is already out of every count, and keeping the
    // flag means restoring the row puts it back in the queue rather than loose in the backlog.
    const issue: Issue = { ...record, labelIds, deletedAt, updatedAt: deletedAt };
    yield* publish({ _tag: "IssueUpserted", issue });
    return { issue };
  });

  const importCsv: IssueTrackerServiceShape["importCsv"] = Effect.fn(
    "IssueTrackerService.importCsv",
  )(function* (input, actor) {
    const plan = planIssueCsvImport(input.csvText);
    if (plan.rows.length === 0) return { created: 0, skipped: plan.skipped };

    const [statuses, labels, records, config] = yield* Effect.all([
      listStatuses(),
      listLabels(),
      listRecords(),
      readConfig(),
    ]);
    const skipped: Array<IssuesImportCsvSkip> = [...plan.skipped];

    const workingStatuses = [...statuses];
    const createdStatuses: Array<IssueStatus> = [];
    const workingLabels = [...labels];
    const createdLabels: Array<IssueLabel> = [];
    const importedAt = yield* nowIso;

    const resolveStatus = (name: string | null) =>
      Effect.gen(function* () {
        if (name === null) {
          const fallback =
            workingStatuses.find((status) => DEFAULT_STATUS_CATEGORIES.has(status.category)) ??
            workingStatuses[0];
          if (fallback === undefined) {
            return yield* conflict("The tracker has no statuses, so an issue has nowhere to land.");
          }
          return fallback;
        }
        const existing = workingStatuses.find(
          (status) => status.name.toLowerCase() === name.toLowerCase(),
        );
        if (existing !== undefined) return existing;

        const category = guessIssueStatusCategory(name);
        const status: IssueStatus = {
          id: IssueStatusId.make(yield* newId),
          name,
          color: CATEGORY_COLORS[category],
          category,
          position: nextPositionForCategory(workingStatuses, category),
          createdAt: importedAt,
          updatedAt: importedAt,
        };
        yield* statusRepository
          .upsert(status)
          .pipe(Effect.mapError(storage("Failed to write an imported issue status")));
        workingStatuses.push(status);
        workingStatuses.sort((left, right) => left.position - right.position);
        createdStatuses.push(status);
        return status;
      });

    const resolveLabel = (name: string) =>
      Effect.gen(function* () {
        const existing = workingLabels.find(
          (label) => label.name.toLowerCase() === name.toLowerCase(),
        );
        if (existing !== undefined) return existing;

        const label: IssueLabel = {
          id: IssueLabelId.make(yield* newId),
          name,
          color: IMPORTED_LABEL_COLORS[workingLabels.length % IMPORTED_LABEL_COLORS.length]!,
          createdAt: importedAt,
        };
        yield* labelRepository
          .upsert(label)
          .pipe(Effect.mapError(storage("Failed to write an imported issue label")));
        workingLabels.push(label);
        createdLabels.push(label);
        return label;
      });

    // Adopt the export's prefix before allocating anything, so rows without a key get keys that
    // read like the rest of the import rather than like the tracker's default.
    const prefix = importedKeyPrefix(plan.rows);
    if (
      prefix !== null &&
      prefix !== config.keyPrefix &&
      // A tracker whose prefix somebody already chose keeps it; only the seeded default yields.
      config.keyPrefix === DEFAULT_ISSUE_KEY_PREFIX &&
      prefix.length <= ISSUE_KEY_PREFIX_MAX_CHARS
    ) {
      yield* configRepository
        .setPrefix({ keyPrefix: prefix })
        .pipe(Effect.mapError(storage("Failed to adopt the imported issue key prefix")));
    }
    const highestImported = importedMaxKeyNumber(plan.rows);
    if (highestImported > 0) {
      yield* configRepository
        .reserveKeyNumbers({ throughNumber: highestImported })
        .pipe(Effect.mapError(storage("Failed to reserve the imported issue key numbers")));
    }

    const existingKeys = new Set(records.map((record) => record.key));
    const sortOrderByStatus = new Map<string, string | null>();
    for (const record of records) sortOrderByStatus.set(record.statusId, record.sortOrder);

    interface StagedRow {
      readonly row: PlannedIssueImportRow;
      readonly record: IssueRecord;
      readonly labelIds: ReadonlyArray<IssueLabelId>;
    }
    const staged: Array<StagedRow> = [];
    const idByKey = new Map<string, IssueId>(records.map((record) => [record.key, record.id]));

    for (const row of plan.rows) {
      if (row.key !== null && existingKeys.has(row.key)) {
        skipped.push({ line: row.line, reason: `An issue with key ${row.key} already exists.` });
        continue;
      }

      const status = yield* resolveStatus(row.statusName);
      const labelIds = yield* Effect.forEach(row.labelNames, (name) =>
        Effect.map(resolveLabel(name), (label) => label.id),
      );
      const key =
        row.key ??
        (yield* configRepository
          .allocateKey()
          .pipe(Effect.mapError(storage("Failed to allocate an issue key"))));
      const sortOrder = issueSortOrderAfter(sortOrderByStatus.get(status.id) ?? null);
      sortOrderByStatus.set(status.id, sortOrder);
      const createdAt = row.createdAt ?? importedAt;
      const id = IssueId.make(yield* newId);

      existingKeys.add(key);
      idByKey.set(key, id);
      staged.push({
        row,
        labelIds,
        record: {
          id,
          key,
          title: row.title,
          description: row.description,
          statusId: status.id,
          priority: row.priority,
          assignee: null,
          projectId: null,
          // A CSV export names neither: an import lands issues unplanned, and the tracker's own
          // milestones and cycles are ids nothing in the file could refer to.
          milestoneId: null,
          cycleId: null,
          parentId: null,
          sortOrder,
          dueDate: row.dueDate,
          triage: false,
          // A CSV row cannot claim a Slack thread. Only intake writes this, and only for a
          // message it actually read.
          slackSource: null,
          createdAt,
          updatedAt: row.updatedAt ?? createdAt,
          deletedAt: null,
        },
      });
    }

    // Second pass: parents are named by key, and a child can appear above its parent in the file.
    const linked = staged.map(({ row, record, labelIds }) => ({
      labelIds,
      record:
        row.parentKey === null
          ? record
          : { ...record, parentId: idByKey.get(row.parentKey) ?? null },
    }));

    yield* issueRepository
      .upsertMany(linked.map(({ record }) => record))
      .pipe(Effect.mapError(storage("Failed to write the imported issues")));
    yield* Effect.forEach(
      linked.filter(({ labelIds }) => labelIds.length > 0),
      ({ record, labelIds }) =>
        labelRepository
          .setAssignments({ issueId: record.id, labelIds })
          .pipe(Effect.mapError(storage("Failed to write the imported issue labels"))),
      { discard: true },
    );
    yield* Effect.forEach(
      linked,
      ({ record }) =>
        appendChangeLog({
          issueId: record.id,
          actor,
          createdAt: importedAt,
          kind: "imported",
          changes: WHOLE_ISSUE_CHANGE,
        }),
      { discard: true },
    );

    yield* publishAll([
      ...(createdStatuses.length === 0
        ? []
        : [{ _tag: "StatusesChanged" as const, statuses: yield* listStatuses() }]),
      ...(createdLabels.length === 0
        ? []
        : [{ _tag: "LabelsChanged" as const, labels: yield* listLabels() }]),
      { _tag: "ConfigChanged" as const, config: yield* readConfig() },
      ...linked.map(({ record, labelIds }) => ({
        _tag: "IssueUpserted" as const,
        issue: { ...record, labelIds },
      })),
    ]);

    return { created: linked.length, skipped };
  });

  // Once at startup, before anybody can subscribe: a run is a live process, so whatever was
  // queued or running when this server stopped is dead. Leaving those rows in flight would block
  // every one of their issues from ever being investigated again.
  yield* enrichmentRunRepository.listUnfinished().pipe(
    Effect.flatMap((runs) =>
      Effect.forEach(
        runs,
        (run) =>
          Effect.flatMap(nowIso, (finishedAt) =>
            enrichmentRunRepository.finish({
              runId: run.id,
              state: "failed",
              result: null,
              error: ENRICHMENT_SERVER_RESTARTED_REASON,
              finishedAt,
            }),
          ),
        { discard: true },
      ),
    ),
    Effect.catchCause((cause) =>
      Effect.logWarning("Failed to fail the enrichment runs left over by a previous server.", {
        cause,
      }),
    ),
  );

  // Once at startup, so a cycle that ended while this laptop was shut does not wait for somebody
  // to open the tracker. A failure here is logged rather than fatal: the tracker still reads, and
  // the next snapshot tries again.
  yield* finalizeEndedCycles().pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Failed to finalise ended issue cycles at startup.", { cause }),
    ),
  );

  return {
    getSnapshot,
    getDetail,
    create,
    update,
    remove,
    restore,
    bulkUpdate,
    setSortOrder,
    createStatus,
    updateStatus,
    deleteStatus,
    reorderStatuses,
    createLabel,
    updateLabel,
    deleteLabel,
    milestoneCreate,
    milestoneUpdate,
    milestoneDelete,
    milestonesReorder,
    cycleCreate,
    cycleUpdate,
    cycleDelete,
    todoCreate,
    todoUpdate,
    todoDelete,
    todosReorder,
    relationCreate,
    relationDelete,
    commentCreate,
    commentUpdate,
    commentDelete,
    commentsList,
    uploadCommentAttachment,
    viewCreate,
    viewUpdate,
    viewDelete,
    viewsReorder,
    setKeyPrefix,
    importCsv,
    getEvents,
    startEnrichment,
    cancelEnrichment,
    getEnrichmentRuns,
    linkThread,
    unlinkThread,
    getThreadLinks,
    slackSetToken,
    slackGetStatus,
    slackListChannels,
    slackWatchCreate,
    slackWatchUpdate,
    slackWatchDelete,
    triageAccept,
    triageReject,
    intakeCreateIssue,
    intakeAddComment,
    slackRecordPoll,
    slackRecordOutboundPost,
    get stream() {
      return Stream.unwrap(
        Effect.gen(function* () {
          // Subscribe first: a write between the read and the subscription would otherwise never
          // reach this client, whereas a repeated upsert is a no-op. Opening the stream is also a
          // read of the tracker, so it carries any lazy cycle finalisation with it.
          const subscription = yield* PubSub.subscribe(changes);
          const snapshot = yield* getSnapshot();
          const initial: ReadonlyArray<IssuesStreamEvent> = [
            { _tag: "StatusesChanged", statuses: snapshot.statuses },
            { _tag: "LabelsChanged", labels: snapshot.labels },
            { _tag: "MilestonesChanged", milestones: snapshot.milestones },
            { _tag: "CyclesChanged", cycles: snapshot.cycles },
            { _tag: "ViewsChanged", views: snapshot.views },
            { _tag: "SlackWatchesChanged", watches: snapshot.slackWatches },
            { _tag: "SlackStatusChanged", status: snapshot.slackStatus },
            { _tag: "ConfigChanged", config: snapshot.config },
            ...snapshot.issues.map((issue) => ({ _tag: "IssueUpserted" as const, issue })),
          ];
          return Stream.concat(Stream.fromIterable(initial), Stream.fromSubscription(subscription));
        }),
      );
    },
  } satisfies IssueTrackerServiceShape;
});

/**
 * Where a new status lands when the caller did not say. Categories are the workflow's order, so a
 * new `started` column goes after the last started one rather than after `Canceled`.
 */
function nextPositionForCategory(
  statuses: ReadonlyArray<IssueStatus>,
  category: IssueStatusCategory,
): number {
  const ordered = [...statuses].sort((left, right) => left.position - right.position);
  const before = ordered.findLast(
    (status) => categoryRank(status.category) <= categoryRank(category),
  );
  const after = ordered.find((status) => categoryRank(status.category) > categoryRank(category));
  if (before === undefined) return after === undefined ? 1 : after.position - 1;
  return after === undefined ? before.position + 1 : (before.position + after.position) / 2;
}

export const layer = Layer.effect(IssueTrackerService, make);
