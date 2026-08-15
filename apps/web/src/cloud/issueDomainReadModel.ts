/**
 * Read-only web projection of the active company's cloud-synced issue domain.
 *
 * The sync engine already publishes its complete optimistic view into
 * {@link companyRegistryReplicasAtom}. This layer only narrows that generic entity map into typed
 * lists and per-issue detail; it owns no transport, persistence, or mutation path.
 *
 * @module cloud/issueDomainReadModel
 */
import { useAtomValue } from "@effect/atom-react";
import type { CompanyRegistryReplicaState } from "@spiritdevs/client-runtime/connection";
import {
  CloudProjectSyncEntity,
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
  type CloudProjectSyncEntity as CloudProjectSyncEntityType,
  type IssueAttachmentEntity as IssueAttachmentEntityType,
  type IssueAuditEventEntity as IssueAuditEventEntityType,
  type IssueCommentEntity as IssueCommentEntityType,
  type IssueCycleEntity as IssueCycleEntityType,
  type IssueEntity as IssueEntityType,
  type IssueLabelEntity as IssueLabelEntityType,
  type IssueMilestoneEntity as IssueMilestoneEntityType,
  type IssueRelationEntity as IssueRelationEntityType,
  type IssueStatusEntity as IssueStatusEntityType,
  type IssueThreadLinkEntity as IssueThreadLinkEntityType,
  type IssueTodoEntity as IssueTodoEntityType,
  type IssueViewEntity as IssueViewEntityType,
} from "@spiritdevs/client-runtime/sync";
import type { IssueId } from "@spiritdevs/contracts";
import * as Schema from "effect/Schema";
import { Atom } from "effect/unstable/reactivity";

import { activeCompanyIdAtom } from "./activeCompany";
import { companyRegistryReplicasAtom } from "./companyRegistryReplica";

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

/** All issue-domain rows needed by list screens and by the per-issue detail composition. */
export interface SyncedIssueDomainReadModel {
  readonly cloudProjects: ReadonlyArray<CloudProjectSyncEntityType>;
  readonly issues: ReadonlyArray<IssueEntityType>;
  readonly issueStatuses: ReadonlyArray<IssueStatusEntityType>;
  readonly issueLabels: ReadonlyArray<IssueLabelEntityType>;
  readonly issueMilestones: ReadonlyArray<IssueMilestoneEntityType>;
  readonly issueCycles: ReadonlyArray<IssueCycleEntityType>;
  readonly issueViews: ReadonlyArray<IssueViewEntityType>;
  readonly issueComments: ReadonlyArray<IssueCommentEntityType>;
  readonly issueTodos: ReadonlyArray<IssueTodoEntityType>;
  readonly issueRelations: ReadonlyArray<IssueRelationEntityType>;
  readonly issueAttachments: ReadonlyArray<IssueAttachmentEntityType>;
  readonly issueAuditEvents: ReadonlyArray<IssueAuditEventEntityType>;
  readonly issueThreadLinks: ReadonlyArray<IssueThreadLinkEntityType>;
}

/** The issue row plus every synced tail row that belongs to it. */
export interface SyncedIssueDetail {
  readonly issue: IssueEntityType;
  readonly comments: ReadonlyArray<IssueCommentEntityType>;
  readonly todos: ReadonlyArray<IssueTodoEntityType>;
  /** Includes both outgoing and incoming directed relations. */
  readonly relations: ReadonlyArray<IssueRelationEntityType>;
  readonly attachments: ReadonlyArray<IssueAttachmentEntityType>;
  readonly auditEvents: ReadonlyArray<IssueAuditEventEntityType>;
  readonly threadLinks: ReadonlyArray<IssueThreadLinkEntityType>;
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

/**
 * Narrows one company replica's generic values into the synced issue read model.
 *
 * Lists are sorted here rather than relying on bootstrap/map insertion order, which can differ
 * after an incremental update or an optimistic overlay replay.
 */
export function syncedIssueDomainFromReplica(
  replica: CompanyRegistryReplicaState | null,
): SyncedIssueDomainReadModel {
  if (replica === null) return EMPTY_SYNCED_ISSUE_DOMAIN;

  const cloudProjects: CloudProjectSyncEntityType[] = [];
  const issues: IssueEntityType[] = [];
  const issueStatuses: IssueStatusEntityType[] = [];
  const issueLabels: IssueLabelEntityType[] = [];
  const issueMilestones: IssueMilestoneEntityType[] = [];
  const issueCycles: IssueCycleEntityType[] = [];
  const issueViews: IssueViewEntityType[] = [];
  const issueComments: IssueCommentEntityType[] = [];
  const issueTodos: IssueTodoEntityType[] = [];
  const issueRelations: IssueRelationEntityType[] = [];
  const issueAttachments: IssueAttachmentEntityType[] = [];
  const issueAuditEvents: IssueAuditEventEntityType[] = [];
  const issueThreadLinks: IssueThreadLinkEntityType[] = [];

  for (const value of replica.view.values()) {
    if (isCloudProject(value)) cloudProjects.push(value);
    else if (isIssue(value)) issues.push(value);
    else if (isIssueStatus(value)) issueStatuses.push(value);
    else if (isIssueLabel(value)) issueLabels.push(value);
    else if (isIssueMilestone(value)) issueMilestones.push(value);
    else if (isIssueCycle(value)) issueCycles.push(value);
    else if (isIssueView(value)) issueViews.push(value);
    else if (isIssueComment(value)) issueComments.push(value);
    else if (isIssueTodo(value)) issueTodos.push(value);
    else if (isIssueRelation(value)) issueRelations.push(value);
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

const activeCompanyReplicaAtom = Atom.make((get): CompanyRegistryReplicaState | null => {
  const companyId = get(activeCompanyIdAtom);
  return companyId === null ? null : (get(companyRegistryReplicasAtom).get(companyId) ?? null);
}).pipe(Atom.withLabel("cloud-sync:active-company-replica"));

export const syncedIssueDomainAtom = Atom.make((get) =>
  syncedIssueDomainFromReplica(get(activeCompanyReplicaAtom)),
).pipe(Atom.withLabel("cloud-sync:issue-domain"));

export const cloudProjectsAtom = Atom.make((get) => get(syncedIssueDomainAtom).cloudProjects).pipe(
  Atom.withLabel("cloud-sync:cloud-projects"),
);
export const syncedIssuesAtom = Atom.make((get) => get(syncedIssueDomainAtom).issues).pipe(
  Atom.withLabel("cloud-sync:issues"),
);
export const syncedIssueStatusesAtom = Atom.make(
  (get) => get(syncedIssueDomainAtom).issueStatuses,
).pipe(Atom.withLabel("cloud-sync:issue-statuses"));
export const syncedIssueLabelsAtom = Atom.make(
  (get) => get(syncedIssueDomainAtom).issueLabels,
).pipe(Atom.withLabel("cloud-sync:issue-labels"));
export const syncedIssueMilestonesAtom = Atom.make(
  (get) => get(syncedIssueDomainAtom).issueMilestones,
).pipe(Atom.withLabel("cloud-sync:issue-milestones"));
export const syncedIssueCyclesAtom = Atom.make(
  (get) => get(syncedIssueDomainAtom).issueCycles,
).pipe(Atom.withLabel("cloud-sync:issue-cycles"));
export const syncedIssueViewsAtom = Atom.make((get) => get(syncedIssueDomainAtom).issueViews).pipe(
  Atom.withLabel("cloud-sync:issue-views"),
);

export const syncedIssueDetailAtomFamily = Atom.family((issueId: IssueId) =>
  Atom.make((get) => syncedIssueDetailById(get(syncedIssueDomainAtom), issueId)).pipe(
    Atom.withLabel(`cloud-sync:issue-detail:${issueId}`),
  ),
);

export function useSyncedCloudProjects() {
  return useAtomValue(cloudProjectsAtom);
}

export function useSyncedIssues() {
  return useAtomValue(syncedIssuesAtom);
}

export function useSyncedIssueStatuses() {
  return useAtomValue(syncedIssueStatusesAtom);
}

export function useSyncedIssueLabels() {
  return useAtomValue(syncedIssueLabelsAtom);
}

export function useSyncedIssueMilestones() {
  return useAtomValue(syncedIssueMilestonesAtom);
}

export function useSyncedIssueCycles() {
  return useAtomValue(syncedIssueCyclesAtom);
}

export function useSyncedIssueViews() {
  return useAtomValue(syncedIssueViewsAtom);
}

export function useSyncedIssueDetail(issueId: IssueId) {
  return useAtomValue(syncedIssueDetailAtomFamily(issueId));
}
