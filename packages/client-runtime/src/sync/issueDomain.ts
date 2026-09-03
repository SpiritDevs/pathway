/**
 * The issue domain on the sync engine — the client half of `convex/lib/issueApply.ts`.
 *
 * This module is what makes the tracker work offline: it declares the twelve entity shapes the
 * change feed delivers, the thirty-three operations the outbox ships, and the pure reducer that
 * replays those operations over confirmed state to produce the view the UI renders. The reducer
 * mirrors the Convex handlers field for field, which is what lets an optimistic edit and the
 * accepted result agree — two writes to different fields merge, two to the same field resolve to
 * whichever Convex accepted last, and a delete tombstones the row so a later edit blocks instead
 * of resurrecting it.
 *
 * Three deliberate differences from the server:
 *
 * - **No authorization.** Convex is the authority on who may write what. The client applies
 *   optimistically and lets a rejection flow back through the outbox, so `apply` only enforces
 *   structural validity: the target exists locally, is not tombstoned, and the arguments decode.
 * - **No cross-entity effects.** `apply` sees exactly one entity, so a status delete cannot
 *   reassign the issues that pointed at it and a team change cannot drop the team-scoped labels it
 *   invalidates. Those land when the server's changes do; each case below says so.
 * - **No clock and no company scope.** Timestamps come from the stamp the engine took when the
 *   operation was enqueued (falling back to an injected `now`), so replaying the overlay is
 *   deterministic however many times it runs, and payload `companyId` is dropped because one
 *   engine is one company — an optimistic row would otherwise have to invent it.
 *
 * @module sync/issueDomain
 */
import {
  ISSUE_KEY_DRAFT_PLACEHOLDER,
  IssueViewVisibility,
  IssueWorkflowOwner,
  SyncActor,
  SyncEntityId,
  SyncIssueCommentCreateArgs,
  SyncIssueCommentPatchArgs,
  SyncIssueCreateArgs,
  SyncIssueCycleCreateArgs,
  SyncIssueCyclePatchArgs,
  SyncIssueLabelCreateArgs,
  SyncIssueMilestoneCreateArgs,
  SyncIssueMilestonePatchArgs,
  SyncIssuePatchArgs,
  SyncIssueRelationCreateArgs,
  SyncIssueSetSortOrderArgs,
  SyncIssueSetTeamsArgs,
  SyncIssueSetWorkflowOwnerArgs,
  SyncIssueStatusCreateArgs,
  SyncIssueStatusDeleteArgs,
  SyncIssueStatusPatchArgs,
  SyncIssueStatusesReorderArgs,
  SyncIssueThreadLinkCreateArgs,
  SyncIssueTodoCreateArgs,
  SyncIssueTodoPatchArgs,
  SyncIssueViewCreateArgs,
  SyncIssueViewPatchArgs,
  SyncOperationId,
  isSyncOperationKind,
  type SyncEntityKind,
  type SyncOperationEnvelope,
  type SyncOperationKind,
} from "@spiritdevs/contracts/cloudSync";
import { CloudProjectId } from "@spiritdevs/contracts/cloudProject";
import { MembershipId, TeamId } from "@spiritdevs/contracts/company";
import {
  ChatAttachmentId,
  EnvironmentId,
  IssueAssignee,
  IssueAutomationAssignment,
  IssueColor,
  IssueCommentId,
  IssueCommentMention,
  IssueCycleId,
  IssueDate,
  IssueEventId,
  IssueId,
  IssueKey,
  IssueLabelId,
  IssueLabelPatch,
  IssueMilestoneId,
  IssuePriority,
  IssuePullRequest,
  IssueRelationId,
  IssueRelationKind,
  IssueSlackSource,
  IssueStatusCategory,
  IssueStatusId,
  IssueThreadLinkOrigin,
  IssueTodoId,
  IssueViewConfig,
  IssueViewId,
  ModelSelection,
} from "@spiritdevs/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  applied,
  blocked,
  deleted,
  type SyncApplyOutcome,
  type SyncDomainAdapter,
} from "./adapter.ts";
import {
  CALENDAR_ENTITY_CODECS,
  CALENDAR_SYNC_ENTITY_KINDS,
  calendarSyncTombstoneCascade,
  type CalendarSyncEntity,
} from "./calendarDomain.ts";
import type { SyncCodec } from "./codec.ts";
import {
  COMPANY_ENTITY_CODECS,
  COMPANY_SYNC_ENTITY_KINDS,
  type CompanySyncEntity,
} from "./companyDomain.ts";
import type { SyncEntityKey } from "./model.ts";
import { syncOrderKeyAfter } from "./orderKey.ts";

// ---------------------------------------------------------------------------
// Entity kinds
// ---------------------------------------------------------------------------

/**
 * The tables this domain replicates. The protocol's entity kinds also cover company
 * administration, which this domain does not own: {@link issueEntityCodec} answers `null` for
 * those, and {@link module:sync/companyDomain} supplies their codecs to the widened adapter.
 */
export const ISSUE_SYNC_ENTITY_KINDS = [
  "issue",
  "issueStatus",
  "issueLabel",
  "issueMilestone",
  "issueCycle",
  "issueTodo",
  "issueRelation",
  "issueComment",
  "issueAttachment",
  "issueView",
  "issueAuditEvent",
  "issueThreadLink",
] as const satisfies ReadonlyArray<SyncEntityKind>;
export type IssueSyncEntityKind = (typeof ISSUE_SYNC_ENTITY_KINDS)[number];

const ISSUE_SYNC_ENTITY_KIND_SET: ReadonlySet<string> = new Set<string>(ISSUE_SYNC_ENTITY_KINDS);

export function isIssueSyncEntityKind(value: string): value is IssueSyncEntityKind {
  return ISSUE_SYNC_ENTITY_KIND_SET.has(value);
}

// ---------------------------------------------------------------------------
// Entity payloads
// ---------------------------------------------------------------------------

// Every field below mirrors one encoder in `convex/lib/issueApply.ts`. Timestamps are epoch
// milliseconds because that is what Convex stores; ids are the client-generated domain ids, never
// a Convex `_id`. `companyId` rides the wire but is dropped here: the replica is company-scoped by
// construction. `version` never appears. Issue payloads retain `deletedAt` so the bin works from
// the replica; hard removals and deleted rows from other domains arrive as payloadless tombstones.

/**
 * `key` is the human identifier, or the local {@link ISSUE_KEY_DRAFT_PLACEHOLDER} for an issue
 * created after the client's leased block ran dry. Convex assigns the real key before accepting
 * the create; the domain id never changes.
 */
const issueEntityFields = {
  id: IssueId,
  key: Schema.Union([IssueKey, Schema.Literal(ISSUE_KEY_DRAFT_PLACEHOLDER)]),
  keyNumber: Schema.Number,
  title: Schema.String,
  description: Schema.String,
  /** Empty string is the server's "triage item, no status yet" sentinel, not a missing value. */
  statusId: Schema.String,
  priority: IssuePriority,
  assignee: Schema.NullOr(IssueAssignee),
  projectId: Schema.NullOr(CloudProjectId),
  milestoneId: Schema.NullOr(IssueMilestoneId),
  cycleId: Schema.NullOr(IssueCycleId),
  parentId: Schema.NullOr(IssueId),
  sortOrder: Schema.String,
  labelIds: Schema.Array(IssueLabelId),
  dueDate: Schema.NullOr(IssueDate),
  triage: Schema.Boolean,
  slackSource: Schema.NullOr(IssueSlackSource),
  /** Empty means company-wide; any listed team exposes the complete issue. */
  teamIds: Schema.Array(TeamId),
  workflowOwner: IssueWorkflowOwner,
  workModelSelection: Schema.NullOr(ModelSelection),
  automationAssignment: Schema.NullOr(IssueAutomationAssignment),
  pullRequest: Schema.NullOr(IssuePullRequest),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
  /** Missing only in replicas written before soft-deleted issues became readable offline. */
  deletedAt: Schema.optional(Schema.NullOr(Schema.Number)),
};
export const IssueEntity = Schema.Struct({
  entityKind: Schema.Literal("issue"),
  ...issueEntityFields,
});
export type IssueEntity = typeof IssueEntity.Type;

/** A company base status, a team's override of one, or a team-only status. */
const issueStatusEntityFields = {
  id: IssueStatusId,
  scope: Schema.Literals(["company", "team"]),
  teamId: Schema.NullOr(TeamId),
  /** Set when this row overrides an inherited company status; the base supplies the null fields. */
  baseStatusId: Schema.NullOr(IssueStatusId),
  name: Schema.NullOr(Schema.String),
  color: Schema.NullOr(IssueColor),
  category: Schema.NullOr(IssueStatusCategory),
  position: Schema.NullOr(Schema.Number),
  hidden: Schema.Boolean,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
};
export const IssueStatusEntity = Schema.Struct({
  entityKind: Schema.Literal("issueStatus"),
  ...issueStatusEntityFields,
});
export type IssueStatusEntity = typeof IssueStatusEntity.Type;

const issueLabelEntityFields = {
  id: IssueLabelId,
  /** `null` is a company label, usable by every issue. */
  teamId: Schema.NullOr(TeamId),
  name: Schema.String,
  color: IssueColor,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
};
export const IssueLabelEntity = Schema.Struct({
  entityKind: Schema.Literal("issueLabel"),
  ...issueLabelEntityFields,
});
export type IssueLabelEntity = typeof IssueLabelEntity.Type;

const issueMilestoneEntityFields = {
  id: IssueMilestoneId,
  cloudProjectId: CloudProjectId,
  name: Schema.String,
  description: Schema.NullOr(Schema.String),
  startDate: Schema.NullOr(IssueDate),
  targetDate: Schema.NullOr(IssueDate),
  position: Schema.Number,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
};
export const IssueMilestoneEntity = Schema.Struct({
  entityKind: Schema.Literal("issueMilestone"),
  ...issueMilestoneEntityFields,
});
export type IssueMilestoneEntity = typeof IssueMilestoneEntity.Type;

const issueCycleEntityFields = {
  id: IssueCycleId,
  teamId: Schema.NullOr(TeamId),
  name: Schema.String,
  startDate: IssueDate,
  endDate: IssueDate,
  /** Set once the cycle has been finalised; finalisation is lazy and server-side. */
  completedAt: Schema.NullOr(Schema.Number),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
};
export const IssueCycleEntity = Schema.Struct({
  entityKind: Schema.Literal("issueCycle"),
  ...issueCycleEntityFields,
});
export type IssueCycleEntity = typeof IssueCycleEntity.Type;

const issueTodoEntityFields = {
  id: IssueTodoId,
  issueId: IssueId,
  text: Schema.String,
  done: Schema.Boolean,
  sortOrder: Schema.String,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
};
export const IssueTodoEntity = Schema.Struct({
  entityKind: Schema.Literal("issueTodo"),
  ...issueTodoEntityFields,
});
export type IssueTodoEntity = typeof IssueTodoEntity.Type;

/** The canonical directed pair; the inverse is never materialised. */
const issueRelationEntityFields = {
  id: IssueRelationId,
  issueId: IssueId,
  relatedIssueId: IssueId,
  kind: IssueRelationKind,
  createdAt: Schema.Number,
};
export const IssueRelationEntity = Schema.Struct({
  entityKind: Schema.Literal("issueRelation"),
  ...issueRelationEntityFields,
});
export type IssueRelationEntity = typeof IssueRelationEntity.Type;

/**
 * `author` is null only on an optimistic comment created by an adapter built without an actor —
 * every server row carries one, because a cloud write always has an authenticated identity.
 */
const issueCommentEntityFields = {
  id: IssueCommentId,
  issueId: IssueId,
  body: Schema.String,
  author: Schema.NullOr(SyncActor),
  attachmentIds: Schema.Array(ChatAttachmentId),
  mentions: Schema.Array(IssueCommentMention),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
};
export const IssueCommentEntity = Schema.Struct({
  entityKind: Schema.Literal("issueComment"),
  ...issueCommentEntityFields,
});
export type IssueCommentEntity = typeof IssueCommentEntity.Type;

/**
 * Metadata only — new bytes live in UploadThing. No operation writes this table: an
 * attachment row is bound as a side effect of the comment that carries its id, so it only ever
 * arrives through the feed.
 */
const issueAttachmentEntityFields = {
  id: ChatAttachmentId,
  issueId: IssueId,
  commentId: Schema.NullOr(IssueCommentId),
  fileName: Schema.String,
  mimeType: Schema.String,
  byteSize: Schema.Number,
  checksum: Schema.String,
  uploadedByMembershipId: Schema.NullOr(MembershipId),
  /** `finalized` remains decodable for pre-cutover Convex-storage imports. */
  state: Schema.Literals(["pending", "finalized", "ready"]),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
};
export const IssueAttachmentEntity = Schema.Struct({
  entityKind: Schema.Literal("issueAttachment"),
  ...issueAttachmentEntityFields,
});
export type IssueAttachmentEntity = typeof IssueAttachmentEntity.Type;

const issueViewEntityFields = {
  id: IssueViewId,
  /** Null when the owning membership is gone; a shared view outlives its author. */
  ownerMembershipId: Schema.NullOr(MembershipId),
  visibility: IssueViewVisibility,
  teamIds: Schema.Array(TeamId),
  name: Schema.String,
  config: IssueViewConfig,
  position: Schema.Number,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
};
export const IssueViewEntity = Schema.Struct({
  entityKind: Schema.Literal("issueView"),
  ...issueViewEntityFields,
});
export type IssueViewEntity = typeof IssueViewEntity.Type;

/**
 * Append-only issue history. No operation writes it — Convex records one event per accepted
 * operation — so it arrives through the feed and is never part of the optimistic overlay.
 */
const issueAuditEventEntityFields = {
  id: IssueEventId,
  issueId: IssueId,
  /** An `IssueEventKind` value, left open so a newer server kind does not quarantine history. */
  kind: Schema.String,
  actor: SyncActor,
  /** Includes before/after values, which is how a stale-base overwrite stays recoverable. */
  payload: Schema.Unknown,
  operationId: Schema.NullOr(SyncOperationId),
  createdAt: Schema.Number,
};
export const IssueAuditEventEntity = Schema.Struct({
  entityKind: Schema.Literal("issueAuditEvent"),
  ...issueAuditEventEntityFields,
});
export type IssueAuditEventEntity = typeof IssueAuditEventEntity.Type;

/** The link is cloud-owned; the thread stays environment-owned, so both ids travel. */
const issueThreadLinkEntityFields = {
  id: SyncEntityId,
  issueId: IssueId,
  environmentId: EnvironmentId,
  threadId: Schema.String,
  origin: IssueThreadLinkOrigin,
  createdByMembershipId: Schema.NullOr(MembershipId),
  createdAt: Schema.Number,
};
export const IssueThreadLinkEntity = Schema.Struct({
  entityKind: Schema.Literal("issueThreadLink"),
  ...issueThreadLinkEntityFields,
});
export type IssueThreadLinkEntity = typeof IssueThreadLinkEntity.Type;

/**
 * One replicated issue-domain row, tagged with the kind that selected its shape.
 *
 * The tag is local: the wire payload carries no `entityKind` (the change envelope does), so the
 * codecs below attach it on decode and strip it on encode. Without it the engine's single
 * `ReadonlyMap<string, Entity>` view would be untyped at every read site.
 */
export const IssueSyncEntity = Schema.Union([
  IssueEntity,
  IssueStatusEntity,
  IssueLabelEntity,
  IssueMilestoneEntity,
  IssueCycleEntity,
  IssueTodoEntity,
  IssueRelationEntity,
  IssueCommentEntity,
  IssueAttachmentEntity,
  IssueViewEntity,
  IssueAuditEventEntity,
  IssueThreadLinkEntity,
]);
export type IssueSyncEntity = typeof IssueSyncEntity.Type;

/** The member of {@link IssueSyncEntity} carrying one entity kind. */
export type IssueSyncEntityOf<K extends IssueSyncEntityKind> = Extract<
  IssueSyncEntity,
  { readonly entityKind: K }
>;

function taggedEntityCodec<A, I>(
  entityKind: IssueSyncEntityKind,
  payload: Schema.Codec<A, I>,
): SyncCodec<IssueSyncEntity> {
  const decode = Schema.decodeUnknownOption(payload);
  const encode = Schema.encodeSync(payload);
  return {
    decode: (input) =>
      Option.map(
        decode(input),
        (value) => ({ entityKind, ...(value as object) }) as IssueSyncEntity,
      ),
    encode: (value) => {
      const { entityKind: _entityKind, ...rest } = value;
      return encode(rest as unknown as A) as unknown;
    },
  };
}

const ENTITY_CODECS: Record<IssueSyncEntityKind, SyncCodec<IssueSyncEntity>> = {
  issue: taggedEntityCodec("issue", Schema.Struct(issueEntityFields)),
  issueStatus: taggedEntityCodec("issueStatus", Schema.Struct(issueStatusEntityFields)),
  issueLabel: taggedEntityCodec("issueLabel", Schema.Struct(issueLabelEntityFields)),
  issueMilestone: taggedEntityCodec("issueMilestone", Schema.Struct(issueMilestoneEntityFields)),
  issueCycle: taggedEntityCodec("issueCycle", Schema.Struct(issueCycleEntityFields)),
  issueTodo: taggedEntityCodec("issueTodo", Schema.Struct(issueTodoEntityFields)),
  issueRelation: taggedEntityCodec("issueRelation", Schema.Struct(issueRelationEntityFields)),
  issueComment: taggedEntityCodec("issueComment", Schema.Struct(issueCommentEntityFields)),
  issueAttachment: taggedEntityCodec("issueAttachment", Schema.Struct(issueAttachmentEntityFields)),
  issueView: taggedEntityCodec("issueView", Schema.Struct(issueViewEntityFields)),
  issueAuditEvent: taggedEntityCodec("issueAuditEvent", Schema.Struct(issueAuditEventEntityFields)),
  issueThreadLink: taggedEntityCodec("issueThreadLink", Schema.Struct(issueThreadLinkEntityFields)),
};

/** Codec for one entity kind, or `null` for a kind this domain does not replicate. */
export function issueEntityCodec(entityKind: SyncEntityKind): SyncCodec<IssueSyncEntity> | null {
  return isIssueSyncEntityKind(entityKind) ? ENTITY_CODECS[entityKind] : null;
}

/**
 * Everything one replica holds: the issue domain's twelve tables, the company read domain, and the
 * calendar read domain.
 *
 * They share an engine rather than getting one each because a replica has exactly one checkpoint
 * and one outbox per company — a second engine would fight the first over both. So the replicated
 * *entity* type is a union while the *operation* type stays issues-only, which is precisely the
 * shape of the rule: issues are edited offline, company administration and calendars are not.
 */
export type CloudSyncEntity = IssueSyncEntity | CompanySyncEntity | CalendarSyncEntity;

/**
 * Widens one domain's codec to the union the engine holds.
 *
 * `SyncCodec` is invariant — `encode` takes the entity — so a per-domain codec cannot simply be
 * handed over. Only `encode` needs the narrowing, and it is sound for the reason the dispatch
 * exists at all: the engine encodes an entity through the codec its own `entityKind` selected,
 * which is the codec that decoded it in the first place.
 */
function widenEntityCodec<Narrow extends CloudSyncEntity>(
  codec: SyncCodec<Narrow>,
): SyncCodec<CloudSyncEntity> {
  return {
    decode: (input) => codec.decode(input),
    encode: (value) => codec.encode(value as Narrow),
  };
}

/**
 * Built once rather than per lookup: the confirmed fold asks for a codec on every row of every
 * page, and a wrapper allocated there would be one object per change.
 */
const CLOUD_ENTITY_CODECS: ReadonlyMap<string, SyncCodec<CloudSyncEntity>> = new Map<
  string,
  SyncCodec<CloudSyncEntity>
>([
  ...ISSUE_SYNC_ENTITY_KINDS.map((kind) => [kind, widenEntityCodec(ENTITY_CODECS[kind])] as const),
  ...COMPANY_SYNC_ENTITY_KINDS.map(
    (kind) => [kind, widenEntityCodec(COMPANY_ENTITY_CODECS[kind])] as const,
  ),
  ...CALENDAR_SYNC_ENTITY_KINDS.map(
    (kind) => [kind, widenEntityCodec(CALENDAR_ENTITY_CODECS[kind])] as const,
  ),
]);

/**
 * Codec for one entity kind across all three domains, or `null` for a kind this build cannot read.
 *
 * The three kind sets are disjoint by construction, so the dispatch cannot be ambiguous: a kind is
 * an issue table, a company table, a calendar table, or unknown to this build and quarantined.
 */
export function cloudEntityCodec(entityKind: SyncEntityKind): SyncCodec<CloudSyncEntity> | null {
  return CLOUD_ENTITY_CODECS.get(entityKind) ?? null;
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/** Operations whose whole request is "this entity, this verb"; the envelope's id says which. */
const NoArgs = Schema.Struct({});

/**
 * Every protocol operation kind and the argument schema that goes with it. The `satisfies` is the
 * exhaustiveness check: adding a kind to the contract without handling it here fails to compile.
 */
const ISSUE_SYNC_OPERATION_ARGS = {
  "issue.create": SyncIssueCreateArgs,
  "issue.update": SyncIssuePatchArgs,
  "issue.delete": NoArgs,
  "issue.triageReject": NoArgs,
  "issue.restore": NoArgs,
  "issue.setSortOrder": SyncIssueSetSortOrderArgs,
  "issue.setWorkflowOwner": SyncIssueSetWorkflowOwnerArgs,
  "issue.setTeams": SyncIssueSetTeamsArgs,
  "issueStatus.create": SyncIssueStatusCreateArgs,
  "issueStatus.update": SyncIssueStatusPatchArgs,
  "issueStatus.delete": SyncIssueStatusDeleteArgs,
  "issueStatus.reorder": SyncIssueStatusesReorderArgs,
  "issueLabel.create": SyncIssueLabelCreateArgs,
  "issueLabel.update": IssueLabelPatch,
  "issueLabel.delete": NoArgs,
  "issueMilestone.create": SyncIssueMilestoneCreateArgs,
  "issueMilestone.update": SyncIssueMilestonePatchArgs,
  "issueMilestone.delete": NoArgs,
  "issueCycle.create": SyncIssueCycleCreateArgs,
  "issueCycle.update": SyncIssueCyclePatchArgs,
  "issueCycle.delete": NoArgs,
  "issueTodo.create": SyncIssueTodoCreateArgs,
  "issueTodo.update": SyncIssueTodoPatchArgs,
  "issueTodo.delete": NoArgs,
  "issueRelation.create": SyncIssueRelationCreateArgs,
  "issueRelation.delete": NoArgs,
  "issueComment.create": SyncIssueCommentCreateArgs,
  "issueComment.update": SyncIssueCommentPatchArgs,
  "issueComment.delete": NoArgs,
  "issueView.create": SyncIssueViewCreateArgs,
  "issueView.update": SyncIssueViewPatchArgs,
  "issueView.delete": NoArgs,
  "issueThreadLink.create": SyncIssueThreadLinkCreateArgs,
  "issueThreadLink.delete": NoArgs,
} as const satisfies Record<SyncOperationKind, Schema.Top>;

/** Every protocol operation is an issue-domain operation; company administration is online-only. */
export type IssueSyncOperationKind = SyncOperationKind;

/** Decoded arguments per kind, e.g. `IssueSyncOperationArgs["issue.update"]`. */
export type IssueSyncOperationArgs = {
  readonly [K in IssueSyncOperationKind]: (typeof ISSUE_SYNC_OPERATION_ARGS)[K]["Type"];
};

/**
 * One optimistic write.
 *
 * `kind` is the discriminant, exactly as it is on the envelope — the protocol keeps it out of the
 * arguments (Convex refuses arguments it did not declare), so the arguments alone cannot say what
 * an operation is: nine deletes and a restore all encode to `{}`. That is why the adapter decodes
 * from the whole envelope; see {@link issueSyncDomainAdapter.decodeOperation}.
 */
export type IssueSyncOperation = {
  readonly [K in IssueSyncOperationKind]: {
    readonly kind: K;
    /** The row this writes. Domain ids are client-generated, so it exists before Convex sees it. */
    readonly entityId: SyncEntityId;
    readonly args: IssueSyncOperationArgs[K];
    /** Operations that must be accepted first; a rejected dependency blocks this one. */
    readonly dependsOn?: ReadonlyArray<SyncOperationId> | undefined;
  };
}[IssueSyncOperationKind];

/** The member of {@link IssueSyncOperation} carrying one operation kind. */
export type IssueSyncOperationOf<K extends IssueSyncOperationKind> = Extract<
  IssueSyncOperation,
  { readonly kind: K }
>;

/** Builds one operation with its arguments typed by kind. */
export function issueSyncOperation<K extends IssueSyncOperationKind>(input: {
  readonly kind: K;
  readonly entityId: SyncEntityId;
  readonly args: IssueSyncOperationArgs[K];
  readonly dependsOn?: ReadonlyArray<SyncOperationId>;
}): IssueSyncOperationOf<K> {
  return {
    kind: input.kind,
    entityId: input.entityId,
    args: input.args,
    ...(input.dependsOn === undefined ? {} : { dependsOn: input.dependsOn }),
  } as IssueSyncOperationOf<K>;
}

interface ArgsCodec {
  readonly decode: (input: unknown) => Option.Option<unknown>;
  readonly encode: (value: unknown) => unknown;
}

function makeArgsCodec<A, I>(schema: Schema.Codec<A, I>): ArgsCodec {
  const decode = Schema.decodeUnknownOption(schema);
  const encode = Schema.encodeSync(schema);
  return { decode, encode: (value) => encode(value as A) as unknown };
}

const ARGS_CODECS: Record<IssueSyncOperationKind, ArgsCodec> = Object.fromEntries(
  Object.entries(ISSUE_SYNC_OPERATION_ARGS).map(([kind, schema]) => [kind, makeArgsCodec(schema)]),
) as Record<IssueSyncOperationKind, ArgsCodec>;

/**
 * Protocol operation kinds are `<entityKind>.<verb>`, so the target table is the prefix. The
 * mapping is checked by test rather than restated as a table nobody would keep in step.
 */
export function issueSyncOperationEntityKind(kind: IssueSyncOperationKind): IssueSyncEntityKind {
  return kind.slice(0, kind.indexOf(".")) as IssueSyncEntityKind;
}

export function issueSyncOperationTarget(operation: IssueSyncOperation): SyncEntityKey {
  return {
    entityKind: issueSyncOperationEntityKind(operation.kind),
    entityId: operation.entityId,
  };
}

/**
 * Arguments-only codec, as the engine ships and stores them.
 *
 * `decode` answers `none` on purpose: `envelope.args` cannot name its own kind, and guessing one
 * would replay a delete as an update. The adapter's `decodeOperation` reads the envelope instead,
 * which is the path both the outbox and the rejection list take.
 */
const issueOperationCodec: SyncCodec<IssueSyncOperation> = {
  encode: (operation) => ARGS_CODECS[operation.kind].encode(operation.args),
  decode: () => Option.none(),
};

/**
 * Recovers a stored or rejected operation from its envelope, kind included.
 *
 * This is also where a company-kind envelope dies. `SYNC_OPERATION_KINDS` contains no company verb
 * — administration is online-only and never enters an outbox — so `membership.setState` and its
 * neighbours are not operation kinds at all and answer `none`, which the engine quarantines. The
 * company domain therefore reaches the replica only through the change feed, never through
 * {@link IssueSyncAdapter.apply}.
 */
export function decodeIssueSyncOperation(
  envelope: SyncOperationEnvelope,
): Option.Option<IssueSyncOperation> {
  if (!isSyncOperationKind(envelope.kind)) return Option.none();
  const kind = envelope.kind;
  return Option.map(
    ARGS_CODECS[kind].decode(envelope.args),
    (args) =>
      ({
        kind,
        entityId: envelope.entityId,
        args,
        ...(envelope.dependsOn.length === 0 ? {} : { dependsOn: envelope.dependsOn }),
      }) as IssueSyncOperation,
  );
}

// ---------------------------------------------------------------------------
// Sort keys
// ---------------------------------------------------------------------------

/** The trailing number of `PAT-221`; `0` for a draft key or anything unparseable. */
export function issueKeyNumber(key: string): number {
  const digits = key.slice(key.lastIndexOf("-") + 1);
  const parsed = Number.parseInt(digits, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * The order key Convex gives a new issue: newest-last within the key sequence. Mirrored from
 * `packages/backend/src/sync/issueOps.ts` so an optimistic create lands where the accepted one
 * will, and duplicated rather than imported because the client cannot depend on the backend.
 */
export function defaultIssueSortOrder(keyNumber: number): string {
  return `i${String(keyNumber).padStart(10, "0")}`;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/**
 * Timestamp an optimistic row carries when neither the outbox nor the host supplied one.
 *
 * The engine stamps every operation it enqueues and hands that value back as `occurredAt` on each
 * recompute, so the clock below is only reached by an operation that never went through an outbox
 * this build wrote: a row persisted before the stamp existed, or a direct `apply` call. Whatever
 * it produces, the row converges on the server's value as soon as the operation is accepted.
 */
export const ISSUE_SYNC_PENDING_TIMESTAMP = 0;

/**
 * Position an optimistic row carries when the operation left the slot to the server.
 *
 * A create that names no position appends after the last row of its group, and finding that row
 * takes a scan of the whole group — `apply` sees one entity, so the true index is not knowable
 * locally. Sorting the pending row last is the choice that converges: the server appends too, so
 * the accepted position replaces the sentinel without the card moving. Two unsent creates tie here
 * and separate as each is accepted. `issueStatus` says the same thing with `null`, which its
 * server row allows and which sorts last by the same rule; a milestone's position never is null.
 */
export const ISSUE_SYNC_APPEND_POSITION = Number.MAX_SAFE_INTEGER;

export interface IssueSyncAdapterOptions {
  /**
   * Who is writing. Used only for optimistic attribution — comment authorship and saved-view
   * ownership — which Convex re-derives from the token before it accepts anything.
   */
  readonly actor?: SyncActor | null;
  /**
   * Epoch-millisecond fallback clock, read only when the engine supplied no enqueue-time stamp;
   * see {@link ISSUE_SYNC_PENDING_TIMESTAMP}.
   */
  readonly now?: () => number;
}

/**
 * The one adapter an application wires into the engine: both domains' entities, the issue domain's
 * operations.
 *
 * {@link IssueSyncAdapter} is kept as the name because the *operation* half is still issues-only —
 * `apply`, `operationKind`, `operationTarget`, and `operationCodec` all speak
 * {@link IssueSyncOperation} and nothing else. Only the replicated entity type widened.
 */
export type IssueSyncAdapter = SyncDomainAdapter<CloudSyncEntity, IssueSyncOperation>;

function entityOf<K extends IssueSyncEntityKind>(
  current: CloudSyncEntity | null,
  entityKind: K,
): IssueSyncEntityOf<K> | null {
  return current !== null && current.entityKind === entityKind
    ? (current as IssueSyncEntityOf<K>)
    : null;
}

const missing = (label: string): SyncApplyOutcome<IssueSyncEntity> =>
  blocked(`This ${label} was deleted before the change applied.`);

/**
 * Builds the adapter: the issue reducer, over both domains' entities.
 *
 * The reducer is total over the thirty-three operation kinds and structural only: it never asks
 * whether the actor may write, because the server answers that and a rejection returns through
 * the outbox. Creates are idempotent (re-applying one over the confirmed row is a no-op, which is
 * what an acknowledged create replays as), updates against a missing or hard-tombstoned row block
 * with a visible reason, and soft issue deletes retain their payload for the bin.
 *
 * The company kinds it now decodes never reach the reducer. They have no operation kind, so no
 * envelope naming one survives {@link decodeIssueSyncOperation}; a forged one is quarantined by the
 * engine instead of applied. That is the plan's rule — company administration is online-only —
 * enforced at the one boundary an operation can enter through.
 */
export function makeIssueSyncAdapter(options?: IssueSyncAdapterOptions): IssueSyncAdapter {
  const defaultActor = options?.actor ?? null;
  const clock = options?.now ?? (() => ISSUE_SYNC_PENDING_TIMESTAMP);

  const apply = (input: {
    readonly current: CloudSyncEntity | null;
    readonly operation: IssueSyncOperation;
    readonly occurredAt?: number | undefined;
    readonly actor?: SyncActor | undefined;
  }): SyncApplyOutcome<CloudSyncEntity> => {
    const { current, operation } = input;
    const actor = input.actor ?? defaultActor;
    const authoringMembershipId =
      actor !== null && actor.kind === "member" ? MembershipId.make(actor.membershipId) : null;
    // The engine's enqueue-time stamp wins over the clock: this reducer runs on every overlay
    // recompute, and a fresh reading would move a pending row's timestamps under the user.
    const now = input.occurredAt ?? clock();
    switch (operation.kind) {
      // --- issues ---------------------------------------------------------
      case "issue.create": {
        const existing = entityOf(current, "issue");
        if (existing !== null) return applied(existing);
        const args = operation.args;
        const key = args.key ?? ISSUE_KEY_DRAFT_PLACEHOLDER;
        const keyNumber = issueKeyNumber(key);
        return applied({
          entityKind: "issue",
          id: IssueId.make(operation.entityId),
          key,
          keyNumber,
          title: args.title,
          description: args.description ?? "",
          // Absent takes the workflow's first status, which only the server's catalog knows; the
          // empty sentinel is what a triage item keeps permanently.
          statusId: args.statusId ?? "",
          priority: args.priority ?? "none",
          assignee: args.assignee ?? null,
          projectId: args.projectId ?? null,
          milestoneId: args.milestoneId ?? null,
          cycleId: args.cycleId ?? null,
          parentId: args.parentId ?? null,
          sortOrder: args.sortOrder ?? defaultIssueSortOrder(keyNumber),
          labelIds: [...(args.labelIds ?? [])],
          dueDate: args.dueDate ?? null,
          triage: args.triage ?? false,
          slackSource: args.slackSource ?? null,
          teamIds: [...(args.teamIds ?? [])],
          // The server may instead take the cloud project's default owner; that arrives with the
          // accepted change.
          workflowOwner: args.workflowOwner ?? { kind: "company" },
          workModelSelection: args.workModelSelection ?? null,
          automationAssignment: null,
          pullRequest: null,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
        });
      }
      case "issue.update": {
        const existing = entityOf(current, "issue");
        if (existing === null || existing.deletedAt != null) return missing("issue");
        const args = operation.args;
        // Absent leaves a field alone and explicit null clears it — the distinction that makes two
        // offline edits to different fields merge.
        return applied({
          ...existing,
          title: args.title ?? existing.title,
          description: args.description ?? existing.description,
          statusId: args.statusId ?? existing.statusId,
          priority: args.priority ?? existing.priority,
          assignee: args.assignee === undefined ? existing.assignee : args.assignee,
          workModelSelection:
            args.workModelSelection === undefined
              ? existing.workModelSelection
              : args.workModelSelection,
          projectId: args.projectId === undefined ? existing.projectId : args.projectId,
          milestoneId: args.milestoneId === undefined ? existing.milestoneId : args.milestoneId,
          cycleId: args.cycleId === undefined ? existing.cycleId : args.cycleId,
          parentId: args.parentId === undefined ? existing.parentId : args.parentId,
          labelIds: args.labelIds === undefined ? existing.labelIds : [...args.labelIds],
          dueDate: args.dueDate === undefined ? existing.dueDate : args.dueDate,
          triage: args.triage ?? existing.triage,
          updatedAt: now,
        });
      }
      case "issue.delete":
      case "issue.triageReject": {
        const existing = entityOf(current, "issue");
        return existing === null
          ? deleted()
          : applied({ ...existing, deletedAt: now, updatedAt: now });
      }
      case "issue.restore": {
        const existing = entityOf(current, "issue");
        // A hard tombstone still has no payload to restore optimistically. The server owns that
        // answer, so the operation must remain sendable rather than becoming blocked.
        return existing === null
          ? deleted()
          : applied({ ...existing, deletedAt: null, updatedAt: now });
      }
      case "issue.setSortOrder": {
        const existing = entityOf(current, "issue");
        if (existing === null || existing.deletedAt != null) return missing("issue");
        // The key is used as given: a fractional key is chosen against the neighbours the mover
        // saw, so rewriting it here would undo the convergence it exists for.
        return applied({
          ...existing,
          sortOrder: operation.args.sortOrder,
          statusId: operation.args.statusId ?? existing.statusId,
          updatedAt: now,
        });
      }
      case "issue.setWorkflowOwner": {
        const existing = entityOf(current, "issue");
        if (existing === null || existing.deletedAt != null) return missing("issue");
        // Without the status catalog the client cannot pick the matching status in the target
        // workflow; an explicit `statusId` is honoured and otherwise the server's choice lands
        // with the accepted change.
        return applied({
          ...existing,
          workflowOwner: operation.args.workflowOwner,
          statusId: operation.args.statusId ?? existing.statusId,
          updatedAt: now,
        });
      }
      case "issue.setTeams": {
        const existing = entityOf(current, "issue");
        if (existing === null || existing.deletedAt != null) return missing("issue");
        const teamIds = [...operation.args.teamIds];
        // Detaching the owning team drops workflow ownership back to the company chain. The rest
        // of the server's scope migration — team labels, team cycles, project references — needs
        // rows this reducer cannot see and arrives with the accepted change.
        const owner = existing.workflowOwner;
        return applied({
          ...existing,
          teamIds,
          workflowOwner:
            owner.kind === "team" && !teamIds.includes(owner.teamId) ? { kind: "company" } : owner,
          updatedAt: now,
        });
      }

      // --- statuses -------------------------------------------------------
      case "issueStatus.create": {
        const existing = entityOf(current, "issueStatus");
        if (existing !== null) return applied(existing);
        const args = operation.args;
        return applied({
          entityKind: "issueStatus",
          id: IssueStatusId.make(operation.entityId),
          scope: args.scope,
          teamId: args.teamId ?? null,
          baseStatusId: args.baseStatusId ?? null,
          name: args.name ?? null,
          color: args.color ?? null,
          category: args.category ?? null,
          // Absent appends after the last status in the workflow, which needs the whole chain;
          // null is "unpositioned" until the accepted change says where it landed.
          position: args.position ?? null,
          hidden: args.hidden ?? false,
          createdAt: now,
          updatedAt: now,
        });
      }
      case "issueStatus.update": {
        const existing = entityOf(current, "issueStatus");
        if (existing === null) return missing("status");
        const args = operation.args;
        return applied({
          ...existing,
          name: args.name === undefined ? existing.name : args.name,
          color: args.color === undefined ? existing.color : args.color,
          category: args.category === undefined ? existing.category : args.category,
          position: args.position === undefined ? existing.position : args.position,
          hidden: args.hidden ?? existing.hidden,
          updatedAt: now,
        });
      }
      case "issueStatus.delete":
        // The issues that pointed here move to `reassignToStatusId` server-side; the reducer sees
        // one entity, so the board shows them under the old column until that change arrives.
        return deleted();
      case "issueStatus.reorder": {
        const existing = entityOf(current, "issueStatus");
        if (existing === null) return missing("status");
        // The operation carries the whole order but writes one row at a time. The targeted status
        // takes its index in the list; its neighbours settle when the server's changes land.
        const index = operation.args.statusIds.indexOf(existing.id);
        return applied({
          ...existing,
          position: index < 0 ? existing.position : index,
          updatedAt: now,
        });
      }

      // --- labels ---------------------------------------------------------
      case "issueLabel.create": {
        const existing = entityOf(current, "issueLabel");
        if (existing !== null) return applied(existing);
        const args = operation.args;
        return applied({
          entityKind: "issueLabel",
          id: IssueLabelId.make(operation.entityId),
          teamId: args.teamId ?? null,
          name: args.name,
          color: args.color,
          createdAt: now,
          updatedAt: now,
        });
      }
      case "issueLabel.update": {
        const existing = entityOf(current, "issueLabel");
        if (existing === null) return missing("label");
        return applied({
          ...existing,
          name: operation.args.name ?? existing.name,
          color: operation.args.color ?? existing.color,
          updatedAt: now,
        });
      }
      case "issueLabel.delete":
        return deleted();

      // --- milestones -----------------------------------------------------
      case "issueMilestone.create": {
        const existing = entityOf(current, "issueMilestone");
        if (existing !== null) return applied(existing);
        const args = operation.args;
        return applied({
          entityKind: "issueMilestone",
          id: IssueMilestoneId.make(operation.entityId),
          cloudProjectId: args.cloudProjectId,
          name: args.name,
          description: args.description ?? null,
          startDate: args.startDate ?? null,
          targetDate: args.targetDate ?? null,
          // Absent appends after the project's last milestone; the server owns that scan, so the
          // pending row sorts last until the accepted change says which index it took.
          position: args.position ?? ISSUE_SYNC_APPEND_POSITION,
          createdAt: now,
          updatedAt: now,
        });
      }
      case "issueMilestone.update": {
        const existing = entityOf(current, "issueMilestone");
        if (existing === null) return missing("milestone");
        const args = operation.args;
        // Moving a milestone also clears `milestoneId` on the issues left behind in the old
        // project — rows this reducer cannot reach, so they clear when the change arrives.
        return applied({
          ...existing,
          cloudProjectId: args.cloudProjectId ?? existing.cloudProjectId,
          name: args.name ?? existing.name,
          description: args.description === undefined ? existing.description : args.description,
          startDate: args.startDate === undefined ? existing.startDate : args.startDate,
          targetDate: args.targetDate === undefined ? existing.targetDate : args.targetDate,
          position: args.position ?? existing.position,
          updatedAt: now,
        });
      }
      case "issueMilestone.delete":
        return deleted();

      // --- cycles ---------------------------------------------------------
      case "issueCycle.create": {
        const existing = entityOf(current, "issueCycle");
        if (existing !== null) return applied(existing);
        const args = operation.args;
        return applied({
          entityKind: "issueCycle",
          id: IssueCycleId.make(operation.entityId),
          teamId: args.teamId ?? null,
          name: args.name,
          startDate: args.startDate,
          endDate: args.endDate,
          completedAt: null,
          createdAt: now,
          updatedAt: now,
        });
      }
      case "issueCycle.update": {
        const existing = entityOf(current, "issueCycle");
        if (existing === null) return missing("cycle");
        const args = operation.args;
        return applied({
          ...existing,
          name: args.name ?? existing.name,
          startDate: args.startDate ?? existing.startDate,
          endDate: args.endDate ?? existing.endDate,
          completedAt: args.finalize === true ? now : existing.completedAt,
          updatedAt: now,
        });
      }
      case "issueCycle.delete":
        return deleted();

      // --- todos ----------------------------------------------------------
      case "issueTodo.create": {
        const existing = entityOf(current, "issueTodo");
        if (existing !== null) return applied(existing);
        const args = operation.args;
        return applied({
          entityKind: "issueTodo",
          id: IssueTodoId.make(operation.entityId),
          issueId: args.issueId,
          text: args.text,
          done: false,
          // A caller that knows the checklist passes the key it computed against the neighbours;
          // this fallback only has to sort after nothing in particular.
          sortOrder: args.sortOrder ?? syncOrderKeyAfter(null),
          createdAt: now,
          updatedAt: now,
        });
      }
      case "issueTodo.update": {
        const existing = entityOf(current, "issueTodo");
        if (existing === null) return missing("checklist item");
        const args = operation.args;
        return applied({
          ...existing,
          text: args.text ?? existing.text,
          done: args.done ?? existing.done,
          sortOrder: args.sortOrder ?? existing.sortOrder,
          updatedAt: now,
        });
      }
      case "issueTodo.delete":
        return deleted();

      // --- relations ------------------------------------------------------
      case "issueRelation.create": {
        const existing = entityOf(current, "issueRelation");
        if (existing !== null) return applied(existing);
        const args = operation.args;
        return applied({
          entityKind: "issueRelation",
          id: IssueRelationId.make(operation.entityId),
          issueId: args.issueId,
          relatedIssueId: args.relatedIssueId,
          kind: args.kind,
          createdAt: now,
        });
      }
      case "issueRelation.delete":
        return deleted();

      // --- comments -------------------------------------------------------
      case "issueComment.create": {
        const existing = entityOf(current, "issueComment");
        if (existing !== null) return applied(existing);
        const args = operation.args;
        return applied({
          entityKind: "issueComment",
          id: IssueCommentId.make(operation.entityId),
          issueId: args.issueId,
          body: args.body,
          author: actor,
          attachmentIds: [...(args.attachmentIds ?? [])],
          // Mention extraction is a server-side pass; the body renders its own mentions until the
          // accepted comment arrives with them pinned.
          mentions: [],
          createdAt: now,
          updatedAt: now,
        });
      }
      case "issueComment.update": {
        const existing = entityOf(current, "issueComment");
        if (existing === null) return missing("comment");
        const args = operation.args;
        return applied({
          ...existing,
          body: args.body ?? existing.body,
          attachmentIds:
            args.attachmentIds === undefined ? existing.attachmentIds : [...args.attachmentIds],
          updatedAt: now,
        });
      }
      case "issueComment.delete":
        return deleted();

      // --- saved views ----------------------------------------------------
      case "issueView.create": {
        const existing = entityOf(current, "issueView");
        if (existing !== null) return applied(existing);
        const args = operation.args;
        const visibility = args.visibility ?? "private";
        return applied({
          entityKind: "issueView",
          id: IssueViewId.make(operation.entityId),
          ownerMembershipId: authoringMembershipId,
          visibility,
          teamIds: visibility === "teams" ? [...(args.teamIds ?? [])] : [],
          name: args.name,
          config: args.config,
          position: args.position ?? 0,
          createdAt: now,
          updatedAt: now,
        });
      }
      case "issueView.update": {
        const existing = entityOf(current, "issueView");
        if (existing === null) return missing("view");
        const args = operation.args;
        const visibility = args.visibility ?? existing.visibility;
        const audienceTouched = args.visibility !== undefined || args.teamIds !== undefined;
        return applied({
          ...existing,
          name: args.name ?? existing.name,
          config: args.config ?? existing.config,
          visibility,
          // Leaving `teams` visibility drops the audience; an untouched audience stays as it was.
          teamIds:
            visibility === "teams"
              ? [...(args.teamIds ?? existing.teamIds)]
              : audienceTouched
                ? []
                : existing.teamIds,
          position: args.position ?? existing.position,
          updatedAt: now,
        });
      }
      case "issueView.delete":
        return deleted();

      // --- thread links ---------------------------------------------------
      case "issueThreadLink.create": {
        const existing = entityOf(current, "issueThreadLink");
        if (existing !== null) return applied(existing);
        const args = operation.args;
        return applied({
          entityKind: "issueThreadLink",
          id: operation.entityId,
          issueId: args.issueId,
          environmentId: args.environmentId,
          threadId: args.threadId,
          origin: args.origin,
          createdByMembershipId: authoringMembershipId,
          createdAt: now,
        });
      }
      case "issueThreadLink.delete":
        return deleted();
    }
  };

  return {
    domain: "issues",
    entityCodec: cloudEntityCodec,
    operationCodec: issueOperationCodec,
    operationKind: (operation) => operation.kind,
    operationTarget: issueSyncOperationTarget,
    operationDependencies: (operation) => operation.dependsOn ?? [],
    decodeOperation: decodeIssueSyncOperation,
    apply,
    // The only cross-entity effect the client is asked to compute. Everything else in `apply` sees
    // one entity, but un-sharing a calendar arrives as a single row and means "and its events too".
    cascadeTombstone: calendarSyncTombstoneCascade,
  };
}

/**
 * The adapter an application wires into {@link module:sync/engine}. Attribution and the clock are
 * unset: a host that renders optimistic comment authors or timestamps builds its own with
 * {@link makeIssueSyncAdapter}.
 */
export const issueSyncDomainAdapter: IssueSyncAdapter = makeIssueSyncAdapter();
