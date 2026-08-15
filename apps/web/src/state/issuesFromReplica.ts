/**
 * Compatibility projection from the company replica into the environment-era issue list store.
 *
 * The list UI still speaks {@link IssuesStore}; keeping the conversion here lets every existing
 * derived atom and component move to synced reads together without teaching them cloud entities.
 * Detail reads and every mutation deliberately remain on their existing RPC paths.
 *
 * @module state/issuesFromReplica
 */
import { mergeEffectiveWorkflow, type EffectiveStatus } from "@spiritdevs/backend/sync/workflow";
import type {
  IssueCycleEntity,
  IssueEntity,
  IssueLabelEntity,
  IssueMilestoneEntity,
  IssueStatusEntity,
  IssueViewEntity,
} from "@spiritdevs/client-runtime/sync";
import {
  ProjectId,
  type Issue,
  type IssueCycle,
  type IssueLabel,
  type IssueMilestone,
  type IssueStatus,
  type IssueView,
} from "@spiritdevs/contracts";

import type { SyncedIssueDomainReadModel } from "../cloud/issueDomainReadModel";
import type { IssuesStore } from "./issues";

const isoTimestamp = (timestamp: number) => new Date(timestamp).toISOString();

function issueFromReplica(entity: IssueEntity): Issue {
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
    createdAt: isoTimestamp(entity.createdAt),
    updatedAt: isoTimestamp(entity.updatedAt),
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
      createdAt: isoTimestamp(source.createdAt),
      updatedAt: isoTimestamp(source.updatedAt),
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
    createdAt: isoTimestamp(entity.createdAt),
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
    createdAt: isoTimestamp(entity.createdAt),
    updatedAt: isoTimestamp(entity.updatedAt),
  };
}

function cycleFromReplica(entity: IssueCycleEntity): IssueCycle {
  return {
    id: entity.id,
    name: entity.name,
    startDate: entity.startDate,
    endDate: entity.endDate,
    completedAt: entity.completedAt === null ? null : isoTimestamp(entity.completedAt),
    createdAt: isoTimestamp(entity.createdAt),
    updatedAt: isoTimestamp(entity.updatedAt),
  };
}

function viewFromReplica(entity: IssueViewEntity): IssueView {
  return {
    id: entity.id,
    name: entity.name,
    position: entity.position,
    config: entity.config,
    createdAt: isoTimestamp(entity.createdAt),
    updatedAt: isoTimestamp(entity.updatedAt),
  };
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
