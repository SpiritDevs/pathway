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
  selectReplicaRoutedIssueRead,
  type IssueCollectionProjection,
  type IssueDetailProjection,
} from "@spiritdevs/backend/sync/issueLegacyProjection";

/** Builds the exact legacy list-store surface while retaining stream-owned local configuration. */
export function issuesStoreFromReplica(
  readModel: SyncedIssueDomainReadModel,
  legacyStore: IssuesStore,
): IssuesStore {
  const projected: IssueCollectionProjection = issueCollectionProjectionFromReplica(readModel);
  return {
    issuesById: new Map(projected.issues.map((issue) => [issue.id, issue])),
    statuses: projected.statuses,
    labels: projected.labels,
    milestones: projected.milestones,
    cycles: projected.cycles,
    views: projected.views,
    config: legacyStore.config,
    slackWatches: legacyStore.slackWatches,
    slackStatus: legacyStore.slackStatus,
  };
}
