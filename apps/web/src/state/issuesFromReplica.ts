/** Web adapter from the shared legacy projection into the unchanged IssuesStore seam. */
import {
  issueCollectionProjectionFromReplica,
  type IssueCollectionProjection,
} from "@spiritdevs/backend/sync/issueLegacyProjection";
import type { SyncedIssueDomainReadModel } from "@spiritdevs/client-runtime/sync";

import type { IssuesStore } from "./issues";

export {
  effectiveIssueStatusesFromReplica,
  isoTimestampFromReplica,
  issueActorFromReplica,
  issueCollectionProjectionFromReplica,
  issueDetailProjectionFromReplica,
  issueFromReplica,
  issueThreadLinksFromReplica,
  selectReplicaRoutedIssueRead,
  type IssueCollectionProjection,
  type IssueDetailProjection,
} from "@spiritdevs/backend/sync/issueLegacyProjection";

/**
 * Builds the exact legacy list-store surface while retaining stream-owned local configuration.
 *
 * An archived project takes its tasks and milestones out of the tracker with it: they stay in the
 * replica untouched, so restoring the project brings every one of them back as it was.
 */
export function issuesStoreFromReplica(
  readModel: SyncedIssueDomainReadModel,
  legacyStore: IssuesStore,
): IssuesStore {
  const projected: IssueCollectionProjection = issueCollectionProjectionFromReplica(readModel);
  const archivedProjectIds = new Set<string>(
    readModel.cloudProjects
      .filter((project) => project.archivedAt !== null)
      .map((project) => project.id),
  );
  const archived = (projectId: string | null) =>
    projectId !== null && archivedProjectIds.has(projectId);
  return {
    issuesById: new Map(
      projected.issues
        .filter((issue) => !archived(issue.projectId))
        .map((issue) => [issue.id, issue]),
    ),
    statuses: projected.statuses,
    labels: projected.labels,
    milestones:
      archivedProjectIds.size === 0
        ? projected.milestones
        : projected.milestones.filter((milestone) => !archived(milestone.projectId)),
    cycles: projected.cycles,
    views: projected.views,
    config: legacyStore.config,
    slackWatches: legacyStore.slackWatches,
    slackStatus: legacyStore.slackStatus,
  };
}
