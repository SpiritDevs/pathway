/**
 * Compatibility projection from the company replica into the environment-era issue list store.
 *
 * The list UI still speaks {@link IssuesStore}; keeping the conversion here lets every existing
 * derived atom and component move to synced reads together without teaching them cloud entities.
 * The same boundary projects the replica-owned detail tails; environment-owned detail reads stay
 * on RPC, and mutations are routed separately by `issues.ts`.
 *
 * @module state/issuesFromReplica
 */
import { mergeEffectiveWorkflow, type EffectiveStatus } from "@spiritdevs/backend/sync/workflow";
import type {
  IssueAuditEventEntity,
  IssueCommentEntity,
  IssueCycleEntity,
  IssueEntity,
  IssueLabelEntity,
  IssueMilestoneEntity,
  IssueRelationEntity,
  IssueStatusEntity,
  IssueThreadLinkEntity,
  IssueTodoEntity,
  IssueViewEntity,
} from "@spiritdevs/client-runtime/sync";
import {
  IssueEventId,
  ProjectId,
  ThreadId,
  type Issue,
  type IssueActor,
  type IssueComment,
  type IssueCycle,
  type IssueDetail,
  type IssueEvent,
  type IssueLabel,
  type IssueMilestone,
  type IssueRelationEdge,
  type IssueStatus,
  type IssueThreadLink,
  type IssueTodo,
  type IssueView,
} from "@spiritdevs/contracts";
import type { CompanyId } from "@spiritdevs/contracts/company";

import type { SyncedIssueDetail, SyncedIssueDomainReadModel } from "../cloud/issueDomainReadModel";
import type { IssuesStore } from "./issues";

export const isoTimestampFromReplica = (timestamp: number) => new Date(timestamp).toISOString();

export function issueFromReplica(entity: IssueEntity): Issue {
  return {
    id: entity.id,
    // "Draft" and the triage empty-status sentinel are intentional optimistic UI values. The
    // legacy codecs cannot decode them, but consumers already treat both fields as display keys.
    key: entity.key as Issue["key"],
    title: entity.title,
    description: entity.description,
    statusId: entity.statusId as Issue["statusId"],
    priority: entity.priority,
    assignee: entity.assignee,
    workModelSelection: entity.workModelSelection,
    automationAssignment: entity.automationAssignment,
    pullRequest: entity.pullRequest,
    // Phase-one import preserves local project ids as cloud project ids. A cloud-only project can
    // still occupy this slot, but environment-local project lookup will correctly find no match.
    projectId: entity.projectId === null ? null : ProjectId.make(entity.projectId),
    milestoneId: entity.milestoneId,
    cycleId: entity.cycleId,
    parentId: entity.parentId,
    sortOrder: entity.sortOrder,
    labelIds: entity.labelIds,
    dueDate: entity.dueDate,
    triage: entity.triage,
    slackSource: entity.slackSource,
    createdAt: isoTimestampFromReplica(entity.createdAt),
    updatedAt: isoTimestampFromReplica(entity.updatedAt),
    // Live replica maps contain upserts only; a synced delete removes/tombstones the entity.
    deletedAt: null,
  };
}

function completeEffectiveStatus(status: EffectiveStatus): status is EffectiveStatus & {
  readonly name: string;
  readonly color: string;
  readonly category: string;
  readonly position: number;
} {
  return (
    status.name !== null &&
    status.color !== null &&
    status.category !== null &&
    status.position !== null
  );
}

/**
 * Flattens every effective workflow into the old global status catalog.
 *
 * Company bases appear once. Each team's overrides appear under their own ids with inherited
 * fields resolved, and team-only statuses appear as ordinary rows. Hidden cannot be represented by
 * the legacy contract, so hidden rows remain present: an issue may still name one and list helpers
 * need a total id-to-status lookup. Replica authorization has already limited which team rows this
 * client can see.
 */
export function effectiveIssueStatusesFromReplica(
  stored: ReadonlyArray<IssueStatusEntity>,
): ReadonlyArray<IssueStatus> {
  const companyBases = stored.filter((status) => status.scope === "company");
  const teamRows = new Map<string, IssueStatusEntity[]>();
  for (const status of stored) {
    if (status.scope !== "team" || status.teamId === null) continue;
    const rows = teamRows.get(status.teamId) ?? [];
    rows.push(status);
    teamRows.set(status.teamId, rows);
  }

  const sourceById = new Map(stored.map((status) => [status.id, status]));
  const effective = [
    ...mergeEffectiveWorkflow(companyBases, []),
    ...[...teamRows.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .flatMap(([, rows]) => mergeEffectiveWorkflow(companyBases, rows)),
  ];
  const flattened = new Map<IssueStatus["id"], IssueStatus>();

  for (const status of effective) {
    if (!completeEffectiveStatus(status)) continue;
    const id = status.id as IssueStatus["id"];
    const source = sourceById.get(id);
    if (source === undefined) continue;
    if (flattened.has(id)) continue;
    flattened.set(id, {
      id,
      name: status.name,
      color: status.color as IssueStatus["color"],
      category: status.category as IssueStatus["category"],
      position: status.position,
      createdAt: isoTimestampFromReplica(source.createdAt),
      updatedAt: isoTimestampFromReplica(source.updatedAt),
    });
  }

  return [...flattened.values()].sort(
    (left, right) => left.position - right.position || left.id.localeCompare(right.id),
  );
}

function labelFromReplica(entity: IssueLabelEntity): IssueLabel {
  return {
    id: entity.id,
    name: entity.name,
    color: entity.color,
    createdAt: isoTimestampFromReplica(entity.createdAt),
  };
}

function milestoneFromReplica(entity: IssueMilestoneEntity): IssueMilestone {
  return {
    id: entity.id,
    projectId: ProjectId.make(entity.cloudProjectId),
    name: entity.name,
    description: entity.description,
    startDate: entity.startDate,
    targetDate: entity.targetDate,
    position: entity.position,
    createdAt: isoTimestampFromReplica(entity.createdAt),
    updatedAt: isoTimestampFromReplica(entity.updatedAt),
  };
}

function cycleFromReplica(entity: IssueCycleEntity): IssueCycle {
  return {
    id: entity.id,
    name: entity.name,
    startDate: entity.startDate,
    endDate: entity.endDate,
    completedAt: entity.completedAt === null ? null : isoTimestampFromReplica(entity.completedAt),
    createdAt: isoTimestampFromReplica(entity.createdAt),
    updatedAt: isoTimestampFromReplica(entity.updatedAt),
  };
}

function viewFromReplica(entity: IssueViewEntity): IssueView {
  return {
    id: entity.id,
    name: entity.name,
    position: entity.position,
    config: entity.config,
    createdAt: isoTimestampFromReplica(entity.createdAt),
    updatedAt: isoTimestampFromReplica(entity.updatedAt),
  };
}

/**
 * Narrows cloud attribution to the environment-era actor union.
 *
 * Member and system attribution is exact. A cloud agent keeps its provider but loses
 * `onBehalfOfMembershipId`, which the legacy actor has nowhere to carry. An environment service
 * actor is represented as the closest legacy service identity (`system:automation`). The null
 * author only exists on an optimistic comment produced without an actor and falls back to the
 * legacy anonymous user.
 */
export function issueActorFromReplica(
  actor: IssueCommentEntity["author"] | IssueAuditEventEntity["actor"],
): IssueActor {
  if (actor === null) return { kind: "user" };
  switch (actor.kind) {
    case "member":
      return actor;
    case "agent":
      return { kind: "agent", provider: actor.provider };
    case "system":
      return actor;
    case "environment":
      return { kind: "system", source: "automation" };
  }
}

function commentFromReplica(entity: IssueCommentEntity): IssueComment {
  return {
    id: entity.id,
    issueId: entity.issueId,
    author: issueActorFromReplica(entity.author),
    body: entity.body,
    attachmentIds: entity.attachmentIds,
    // Mention metadata is synced, but the environment-owned agent-run transcript is not. Null is
    // the legacy representation of a comment without that environment-local execution state.
    agentRun: null,
    createdAt: isoTimestampFromReplica(entity.createdAt),
    editedAt:
      entity.updatedAt > entity.createdAt ? isoTimestampFromReplica(entity.updatedAt) : null,
  };
}

function commentsFromReplica(
  entities: ReadonlyArray<IssueCommentEntity>,
): ReadonlyArray<IssueComment> {
  return entities
    .map(commentFromReplica)
    .sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
    );
}

function todosFromReplica(entities: ReadonlyArray<IssueTodoEntity>): ReadonlyArray<IssueTodo> {
  return [...entities]
    .sort(
      (left, right) =>
        left.sortOrder.localeCompare(right.sortOrder) || left.id.localeCompare(right.id),
    )
    .map((entity, position) => ({
      id: entity.id,
      issueId: entity.issueId,
      text: entity.text,
      done: entity.done,
      // The legacy contract stores dense numeric positions; the replica stores convergent
      // fractional keys. Only their total order is representable, so project it to a zero-based
      // rank. Reordering still writes the original fractional-key model through C4.
      position,
    }));
}

function relationEdgeFromReplica(
  entity: IssueRelationEntity,
  issueId: Issue["id"],
): IssueRelationEdge {
  return {
    relation: {
      id: entity.id,
      issueId: entity.issueId,
      relatedIssueId: entity.relatedIssueId,
      kind: entity.kind,
    },
    direction: entity.issueId === issueId ? "outgoing" : "incoming",
  };
}

/** Matches the legacy repository: all outgoing edges first, then all incoming edges. */
function relationEdgesFromReplica(
  entities: ReadonlyArray<IssueRelationEntity>,
  issueId: Issue["id"],
): ReadonlyArray<IssueRelationEdge> {
  const compare = (left: IssueRelationEntity, right: IssueRelationEntity) =>
    left.kind.localeCompare(right.kind) ||
    (left.issueId === issueId ? left.relatedIssueId : left.issueId).localeCompare(
      right.issueId === issueId ? right.relatedIssueId : right.issueId,
    ) ||
    left.id.localeCompare(right.id);
  return [
    ...entities.filter((entity) => entity.issueId === issueId).sort(compare),
    ...entities.filter((entity) => entity.issueId !== issueId).sort(compare),
  ].map((entity) => relationEdgeFromReplica(entity, issueId));
}

const LEGACY_EVENT_KINDS: ReadonlySet<string> = new Set([
  "created",
  "field_changed",
  "deleted",
  "restored",
  "imported",
  "triage_rejected",
]);

const LEGACY_EVENT_FIELD_BY_CLOUD_FIELD: Readonly<Record<string, string | undefined>> = {
  statusId: "status",
  workModelSelection: "work model",
  automationAssignment: "automation assignment",
  projectId: "project",
  milestoneId: "milestone",
  cycleId: "cycle",
  parentId: "parent",
  labelIds: "labels",
  teamIds: "teams",
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function assigneeEventValue(value: unknown): string | null {
  if (!isRecord(value) || typeof value["kind"] !== "string") return eventValue(value, "");
  switch (value["kind"]) {
    case "user":
      return "user";
    case "member":
      return typeof value["membershipId"] === "string"
        ? `member:${value["membershipId"]}`
        : "member";
    case "agent":
      return typeof value["provider"] === "string" ? `agent:${value["provider"]}` : "agent";
    default:
      return eventValue(value, "");
  }
}

/**
 * Converts an open cloud audit value into the legacy display string.
 *
 * Cloud audit rows retain domain ids and structured values, while the old log retained resolved
 * display names. IDs therefore remain IDs for statuses/projects/milestones/cycles/labels, and
 * arbitrary objects fall back to JSON. That is intentionally honest and recoverable, but less
 * friendly than the historical environment log.
 */
function eventValue(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (field === "assignee") return assigneeEventValue(value);
  if (field === "triage" && typeof value === "boolean") return value ? "yes" : "no";
  if (field === "workModelSelection" && isRecord(value) && typeof value["model"] === "string")
    return value["model"];
  if (
    field === "automationAssignment" &&
    isRecord(value) &&
    typeof value["routingRuleId"] === "string"
  )
    return value["routingRuleId"];
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map((item) => eventValue(item, "") ?? "").join(", ");
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

interface LegacyAuditChange {
  readonly field: string | null;
  readonly before: string | null;
  readonly after: string | null;
}

function auditChanges(entity: IssueAuditEventEntity): ReadonlyArray<LegacyAuditChange> {
  if (entity.kind !== "field_changed") return [{ field: null, before: null, after: null }];
  if (!isRecord(entity.payload)) return [{ field: null, before: null, after: null }];

  // Imported environment events already carry the legacy single-change payload verbatim.
  if (typeof entity.payload["field"] === "string" || entity.payload["field"] === null) {
    const field = entity.payload["field"];
    return [
      {
        field,
        before: eventValue(entity.payload["before"], field ?? ""),
        after: eventValue(entity.payload["after"], field ?? ""),
      },
    ];
  }

  // Native cloud updates batch every changed field into one retained audit row. Expand the batch
  // back to the one-row-per-field legacy view, preserving the payload's insertion order.
  const changes = entity.payload["changes"];
  if (!isRecord(changes)) return [{ field: null, before: null, after: null }];
  const projected = Object.entries(changes).flatMap(([cloudField, value]) => {
    if (!isRecord(value)) return [];
    return [
      {
        field: LEGACY_EVENT_FIELD_BY_CLOUD_FIELD[cloudField] ?? cloudField,
        before: eventValue(value["before"], cloudField),
        after: eventValue(value["after"], cloudField),
      },
    ];
  });
  return projected.length === 0 ? [{ field: null, before: null, after: null }] : projected;
}

function eventsFromReplica(
  entities: ReadonlyArray<IssueAuditEventEntity>,
): ReadonlyArray<IssueEvent> {
  return [...entities]
    .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
    .flatMap((entity) => {
      // The synced kind is deliberately open for rolling upgrades. The legacy union is closed, so
      // a future kind must be omitted instead of mislabeled as a different historical action.
      if (!LEGACY_EVENT_KINDS.has(entity.kind)) return [];
      const changes = auditChanges(entity);
      return changes.map(
        (change, index): IssueEvent => ({
          id:
            changes.length === 1
              ? entity.id
              : IssueEventId.make(`${entity.id}:legacy-field:${index}`),
          issueId: entity.issueId,
          actor: issueActorFromReplica(entity.actor),
          kind: entity.kind as IssueEvent["kind"],
          field: change.field,
          before: change.before,
          after: change.after,
          createdAt: isoTimestampFromReplica(entity.createdAt),
        }),
      );
    });
}

function threadLinksFromReplica(
  entities: ReadonlyArray<IssueThreadLinkEntity>,
): ReadonlyArray<IssueThreadLink> {
  return entities
    .map(
      (entity): IssueThreadLink => ({
        issueId: entity.issueId,
        threadId: ThreadId.make(entity.threadId),
        origin: entity.origin,
        createdAt: isoTimestampFromReplica(entity.createdAt),
        // The legacy view has no link id, source environment, or creator fields. Those stay in the
        // replica and are deliberately not smuggled into another field.
      }),
    )
    .sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) ||
        left.threadId.localeCompare(right.threadId),
    );
}

/** The four replica-owned detail reads in their unchanged legacy consumer shapes. */
export interface IssueDetailProjection {
  readonly detail: IssueDetail | null;
  readonly comments: ReadonlyArray<IssueComment>;
  readonly events: ReadonlyArray<IssueEvent>;
  readonly threadLinks: ReadonlyArray<IssueThreadLink>;
}

const EMPTY_ISSUE_DETAIL_PROJECTION: IssueDetailProjection = Object.freeze({
  detail: null,
  comments: Object.freeze([]),
  events: Object.freeze([]),
  threadLinks: Object.freeze([]),
});

/**
 * Projects one synced composition without applying the legacy stream overlay.
 *
 * `detail.issue` is the existence anchor but is absent from the legacy `IssueDetail` contract.
 * Attachment metadata likewise has no legacy detail slot: comment attachment ids survive, while
 * file name/type/size/checksum/state do not. Attachment byte/download behavior remains RPC-owned.
 */
export function issueDetailProjectionFromReplica(
  synced: SyncedIssueDetail | null,
): IssueDetailProjection {
  if (synced === null) return EMPTY_ISSUE_DETAIL_PROJECTION;
  const comments = commentsFromReplica(synced.comments);
  return {
    detail: {
      todos: todosFromReplica(synced.todos),
      relations: relationEdgesFromReplica(synced.relations, synced.issue.id),
      comments,
    },
    comments,
    events: eventsFromReplica(synced.auditEvents),
    threadLinks: threadLinksFromReplica(synced.threadLinks),
  };
}

/**
 * The route signal, not entity presence, chooses the source. A not-yet-replicated issue therefore
 * stays a successful replica `null` rather than falling through to an environment RPC.
 */
export function selectReplicaRoutedIssueRead<T>(
  replicaCompanyId: CompanyId | null,
  replicaValue: T,
  legacyValue: T,
): T {
  return replicaCompanyId === null ? legacyValue : replicaValue;
}

/** Builds the exact legacy list-store surface while retaining its unsynced stream-owned corners. */
export function issuesStoreFromReplica(
  readModel: SyncedIssueDomainReadModel,
  legacyStore: IssuesStore,
): IssuesStore {
  const issues = readModel.issues.map(issueFromReplica);
  return {
    issuesById: new Map(issues.map((issue) => [issue.id, issue])),
    statuses: effectiveIssueStatusesFromReplica(readModel.issueStatuses),
    labels: readModel.issueLabels
      .map(labelFromReplica)
      .sort(
        (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
      ),
    milestones: readModel.issueMilestones
      .map(milestoneFromReplica)
      .sort(
        (left, right) =>
          left.projectId.localeCompare(right.projectId) ||
          left.position - right.position ||
          left.id.localeCompare(right.id),
      ),
    cycles: readModel.issueCycles
      .map(cycleFromReplica)
      .sort(
        (left, right) =>
          left.startDate.localeCompare(right.startDate) ||
          left.endDate.localeCompare(right.endDate) ||
          left.id.localeCompare(right.id),
      ),
    views: readModel.issueViews
      .map(viewFromReplica)
      .sort((left, right) => left.position - right.position || left.id.localeCompare(right.id)),
    config: legacyStore.config,
    slackWatches: legacyStore.slackWatches,
    slackStatus: legacyStore.slackStatus,
  };
}
