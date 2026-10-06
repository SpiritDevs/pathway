/**
 * Framework-neutral read model over the issue entities in one company replica.
 *
 * The sync engine publishes a heterogeneous entity map in memory and persists the same decoded
 * entity union in SQLite. Keeping the narrowing and stable ordering here gives web and server one
 * definition of the issue-domain replica surface.
 *
 * @module sync/issueReadModel
 */
import type { IssueId } from "@spiritdevs/contracts";
import * as Schema from "effect/Schema";

import type {
  CloudProjectSyncEntity,
  EnvironmentBindingEntity,
  MembershipEntity,
} from "./companyDomain.ts";
import type {
  IssueAttachmentEntity,
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
  CloudSyncEntity,
} from "./issueDomain.ts";
import * as Option from "effect/Option";
import { decodeIssueEntityPayload } from "./issueDomain.ts";

/** All synced rows needed by issue list screens and per-issue detail composition. */
export interface SyncedIssueDomainReadModel {
  readonly cloudProjects: ReadonlyArray<CloudProjectSyncEntity>;
  readonly environmentBindings: ReadonlyArray<EnvironmentBindingEntity>;
  readonly memberships: ReadonlyArray<MembershipEntity>;
  readonly issues: ReadonlyArray<IssueEntity>;
  readonly issueStatuses: ReadonlyArray<IssueStatusEntity>;
  readonly issueLabels: ReadonlyArray<IssueLabelEntity>;
  readonly issueMilestones: ReadonlyArray<IssueMilestoneEntity>;
  readonly issueCycles: ReadonlyArray<IssueCycleEntity>;
  readonly issueViews: ReadonlyArray<IssueViewEntity>;
  readonly issueComments: ReadonlyArray<IssueCommentEntity>;
  readonly issueTodos: ReadonlyArray<IssueTodoEntity>;
  readonly issueRelations: ReadonlyArray<IssueRelationEntity>;
  readonly issueAttachments: ReadonlyArray<IssueAttachmentEntity>;
  readonly issueAuditEvents: ReadonlyArray<IssueAuditEventEntity>;
  readonly issueThreadLinks: ReadonlyArray<IssueThreadLinkEntity>;
}

/** The issue row plus every synced tail row that belongs to it. */
export interface SyncedIssueDetail {
  readonly issue: IssueEntity;
  readonly comments: ReadonlyArray<IssueCommentEntity>;
  readonly todos: ReadonlyArray<IssueTodoEntity>;
  /** Includes both outgoing and incoming directed relations. */
  readonly relations: ReadonlyArray<IssueRelationEntity>;
  readonly attachments: ReadonlyArray<IssueAttachmentEntity>;
  readonly auditEvents: ReadonlyArray<IssueAuditEventEntity>;
  readonly threadLinks: ReadonlyArray<IssueThreadLinkEntity>;
}

export const EMPTY_SYNCED_ISSUE_DOMAIN: SyncedIssueDomainReadModel = Object.freeze({
  cloudProjects: Object.freeze([]),
  environmentBindings: Object.freeze([]),
  memberships: Object.freeze([]),
  issues: Object.freeze([]),
  issueStatuses: Object.freeze([]),
  issueLabels: Object.freeze([]),
  issueMilestones: Object.freeze([]),
  issueCycles: Object.freeze([]),
  issueViews: Object.freeze([]),
  issueComments: Object.freeze([]),
  issueTodos: Object.freeze([]),
  issueRelations: Object.freeze([]),
  issueAttachments: Object.freeze([]),
  issueAuditEvents: Object.freeze([]),
  issueThreadLinks: Object.freeze([]),
});

const byId = <T extends { readonly id: string }>(left: T, right: T) =>
  left.id.localeCompare(right.id);
const decodeDeletedIssueAuditPayload = Schema.decodeUnknownOption(
  Schema.Struct({ deletedIssue: Schema.Unknown }),
);

const deletedIssuesByEvent = new WeakMap<IssueAuditEventEntity, Option.Option<IssueEntity>>();

/** Orders decoded entities from one company replica; domain codecs own payload validation. */
export function syncedIssueDomainFromEntities(
  values: Iterable<CloudSyncEntity>,
  previous: SyncedIssueDomainReadModel = EMPTY_SYNCED_ISSUE_DOMAIN,
): SyncedIssueDomainReadModel {
  const cloudProjects: CloudProjectSyncEntity[] = [];
  const environmentBindings: EnvironmentBindingEntity[] = [];
  const memberships: MembershipEntity[] = [];
  const issues: IssueEntity[] = [];
  const issueStatuses: IssueStatusEntity[] = [];
  const issueLabels: IssueLabelEntity[] = [];
  const issueMilestones: IssueMilestoneEntity[] = [];
  const issueCycles: IssueCycleEntity[] = [];
  const issueViews: IssueViewEntity[] = [];
  const issueComments: IssueCommentEntity[] = [];
  const issueTodos: IssueTodoEntity[] = [];
  const issueRelations: IssueRelationEntity[] = [];
  const issueAttachments: IssueAttachmentEntity[] = [];
  const issueAuditEvents: IssueAuditEventEntity[] = [];
  const issueThreadLinks: IssueThreadLinkEntity[] = [];

  for (const value of values) {
    switch (value.entityKind) {
      case "cloudProject":
        cloudProjects.push(value);
        break;
      case "environmentBinding":
        environmentBindings.push(value);
        break;
      case "membership":
        memberships.push(value);
        break;
      case "issue":
        issues.push(value);
        break;
      case "issueStatus":
        issueStatuses.push(value);
        break;
      case "issueLabel":
        issueLabels.push(value);
        break;
      case "issueMilestone":
        issueMilestones.push(value);
        break;
      case "issueCycle":
        issueCycles.push(value);
        break;
      case "issueView":
        issueViews.push(value);
        break;
      case "issueTodo":
        issueTodos.push(value);
        break;
      case "issueRelation":
        issueRelations.push(value);
        break;
      case "issueComment":
        issueComments.push(value);
        break;
      case "issueAttachment":
        issueAttachments.push(value);
        break;
      case "issueAuditEvent":
        issueAuditEvents.push(value);
        break;
      case "issueThreadLink":
        issueThreadLinks.push(value);
        break;
    }
  }

  cloudProjects.sort(
    (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
  );
  environmentBindings.sort((left, right) => byId(left, right));
  memberships.sort((left, right) => byId(left, right));
  issueAuditEvents.sort((left, right) => left.createdAt - right.createdAt || byId(left, right));
  const latestDeletionSnapshotByIssue = new Map<string, IssueAuditEventEntity>();
  for (const event of issueAuditEvents) {
    if (event.kind === "deleted_snapshot") latestDeletionSnapshotByIssue.set(event.issueId, event);
  }
  const liveIssueIds = new Set(issues.map((issue) => issue.id));
  for (const event of latestDeletionSnapshotByIssue.values()) {
    if (liveIssueIds.has(event.issueId)) continue;
    let issue = deletedIssuesByEvent.get(event);
    if (issue === undefined) {
      const payload = decodeDeletedIssueAuditPayload(event.payload);
      issue = Option.isNone(payload)
        ? Option.none<IssueEntity>()
        : decodeIssueEntityPayload(payload.value.deletedIssue);
      deletedIssuesByEvent.set(event, issue);
    }
    if (Option.isSome(issue) && issue.value.id === event.issueId && issue.value.deletedAt != null) {
      issues.push(issue.value);
    }
  }
  issues.sort((left, right) => left.keyNumber - right.keyNumber || byId(left, right));
  issueStatuses.sort(
    (left, right) =>
      (left.position ?? Number.POSITIVE_INFINITY) - (right.position ?? Number.POSITIVE_INFINITY) ||
      byId(left, right),
  );
  issueLabels.sort(
    (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
  );
  issueMilestones.sort(
    (left, right) =>
      left.cloudProjectId.localeCompare(right.cloudProjectId) ||
      left.position - right.position ||
      byId(left, right),
  );
  issueCycles.sort(
    (left, right) =>
      left.startDate.localeCompare(right.startDate) ||
      left.endDate.localeCompare(right.endDate) ||
      byId(left, right),
  );
  issueViews.sort(
    (left, right) => left.position - right.position || left.id.localeCompare(right.id),
  );
  issueComments.sort((left, right) => left.createdAt - right.createdAt || byId(left, right));
  issueTodos.sort(
    (left, right) => left.sortOrder.localeCompare(right.sortOrder) || byId(left, right),
  );
  issueRelations.sort((left, right) => left.createdAt - right.createdAt || byId(left, right));
  issueAttachments.sort((left, right) => left.createdAt - right.createdAt || byId(left, right));
  issueThreadLinks.sort((left, right) => left.createdAt - right.createdAt || byId(left, right));

  const next: SyncedIssueDomainReadModel = {
    cloudProjects: retainCollection(previous.cloudProjects, cloudProjects),
    environmentBindings: retainCollection(previous.environmentBindings, environmentBindings),
    memberships: retainCollection(previous.memberships, memberships),
    issues: retainCollection(previous.issues, issues),
    issueStatuses: retainCollection(previous.issueStatuses, issueStatuses),
    issueLabels: retainCollection(previous.issueLabels, issueLabels),
    issueMilestones: retainCollection(previous.issueMilestones, issueMilestones),
    issueCycles: retainCollection(previous.issueCycles, issueCycles),
    issueViews: retainCollection(previous.issueViews, issueViews),
    issueTodos: retainCollection(previous.issueTodos, issueTodos),
    issueRelations: retainCollection(previous.issueRelations, issueRelations),
    issueComments: retainCollection(previous.issueComments, issueComments),
    issueAttachments: retainCollection(previous.issueAttachments, issueAttachments),
    issueAuditEvents: retainCollection(previous.issueAuditEvents, issueAuditEvents),
    issueThreadLinks: retainCollection(previous.issueThreadLinks, issueThreadLinks),
  };
  return (Object.keys(next) as Array<keyof SyncedIssueDomainReadModel>).every(
    (key) => next[key] === previous[key],
  )
    ? previous
    : next;
}

function retainCollection<T>(previous: ReadonlyArray<T>, next: ReadonlyArray<T>): ReadonlyArray<T> {
  return previous.length === next.length && next.every((value, index) => value === previous[index])
    ? previous
    : next;
}

const domainsByView = new WeakMap<ReadonlyMap<string, unknown>, SyncedIssueDomainReadModel>();

/** The catalog erases entity types; its engine views have already passed the domain codecs. */
export function syncedIssueDomainFromReplica(
  replica: { readonly view: ReadonlyMap<string, unknown> } | null,
  previous?: SyncedIssueDomainReadModel,
): SyncedIssueDomainReadModel {
  if (replica === null) return EMPTY_SYNCED_ISSUE_DOMAIN;
  const cached = domainsByView.get(replica.view);
  if (cached !== undefined) return cached;
  const domain = syncedIssueDomainFromEntities(
    replica.view.values() as Iterable<CloudSyncEntity>,
    previous,
  );
  domainsByView.set(replica.view, domain);
  return domain;
}

export function syncedIssueDetailById(
  readModel: SyncedIssueDomainReadModel,
  issueId: IssueId,
): SyncedIssueDetail | null {
  const issue = readModel.issues.find((candidate) => candidate.id === issueId);
  if (issue === undefined) return null;
  return {
    issue,
    comments: readModel.issueComments.filter((comment) => comment.issueId === issueId),
    todos: readModel.issueTodos.filter((todo) => todo.issueId === issueId),
    relations: readModel.issueRelations.filter(
      (relation) => relation.issueId === issueId || relation.relatedIssueId === issueId,
    ),
    attachments: readModel.issueAttachments.filter((attachment) => attachment.issueId === issueId),
    auditEvents: readModel.issueAuditEvents.filter((event) => event.issueId === issueId),
    threadLinks: readModel.issueThreadLinks.filter((link) => link.issueId === issueId),
  };
}

/** Narrows an already decoded confirmed replica without exposing its map-key implementation. */
export function syncedIssueDomainFromConfirmed(
  confirmed: ReadonlyMap<string, CloudSyncEntity>,
): SyncedIssueDomainReadModel {
  return syncedIssueDomainFromEntities(confirmed.values());
}
