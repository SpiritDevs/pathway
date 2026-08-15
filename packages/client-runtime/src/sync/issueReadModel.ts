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

import { CloudProjectSyncEntity } from "./companyDomain.ts";
import {
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
  type CloudSyncEntity,
} from "./issueDomain.ts";

const isCloudProject = Schema.is(CloudProjectSyncEntity);
const isIssue = Schema.is(IssueEntity);
const isIssueStatus = Schema.is(IssueStatusEntity);
const isIssueLabel = Schema.is(IssueLabelEntity);
const isIssueMilestone = Schema.is(IssueMilestoneEntity);
const isIssueCycle = Schema.is(IssueCycleEntity);
const isIssueView = Schema.is(IssueViewEntity);
const isIssueTodo = Schema.is(IssueTodoEntity);
const isIssueRelation = Schema.is(IssueRelationEntity);
const isIssueComment = Schema.is(IssueCommentEntity);
const isIssueAttachment = Schema.is(IssueAttachmentEntity);
const isIssueAuditEvent = Schema.is(IssueAuditEventEntity);
const isIssueThreadLink = Schema.is(IssueThreadLinkEntity);

/** All synced rows needed by issue list screens and per-issue detail composition. */
export interface SyncedIssueDomainReadModel {
  readonly cloudProjects: ReadonlyArray<CloudProjectSyncEntity>;
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

/** Narrows and deterministically orders the heterogeneous values from one company replica. */
export function syncedIssueDomainFromEntities(
  values: Iterable<unknown>,
): SyncedIssueDomainReadModel {
  const cloudProjects: CloudProjectSyncEntity[] = [];
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
    if (isCloudProject(value)) cloudProjects.push(value);
    else if (isIssue(value)) issues.push(value);
    else if (isIssueStatus(value)) issueStatuses.push(value);
    else if (isIssueLabel(value)) issueLabels.push(value);
    else if (isIssueMilestone(value)) issueMilestones.push(value);
    else if (isIssueCycle(value)) issueCycles.push(value);
    else if (isIssueView(value)) issueViews.push(value);
    else if (isIssueTodo(value)) issueTodos.push(value);
    else if (isIssueRelation(value)) issueRelations.push(value);
    else if (isIssueComment(value)) issueComments.push(value);
    else if (isIssueAttachment(value)) issueAttachments.push(value);
    else if (isIssueAuditEvent(value)) issueAuditEvents.push(value);
    else if (isIssueThreadLink(value)) issueThreadLinks.push(value);
  }

  cloudProjects.sort(
    (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
  );
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
  issueAuditEvents.sort((left, right) => left.createdAt - right.createdAt || byId(left, right));
  issueThreadLinks.sort((left, right) => left.createdAt - right.createdAt || byId(left, right));

  return {
    cloudProjects,
    issues,
    issueStatuses,
    issueLabels,
    issueMilestones,
    issueCycles,
    issueViews,
    issueComments,
    issueTodos,
    issueRelations,
    issueAttachments,
    issueAuditEvents,
    issueThreadLinks,
  };
}

/** Compatibility wrapper for callers whose absence signal is a nullable replica object. */
export function syncedIssueDomainFromReplica(
  replica: { readonly view: ReadonlyMap<string, unknown> } | null,
): SyncedIssueDomainReadModel {
  return replica === null
    ? EMPTY_SYNCED_ISSUE_DOMAIN
    : syncedIssueDomainFromEntities(replica.view.values());
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
