/**
 * Reactive web bindings for the framework-neutral synced issue read model.
 *
 * Entity narrowing and ordering live in client-runtime so the server's durable SQLite replica and
 * the browser's live engine view cannot disagree about what constitutes the issue domain.
 *
 * @module cloud/issueDomainReadModel
 */
import { useAtomValue } from "@effect/atom-react";
import type { CompanyRegistryReplicaState } from "@spiritdevs/client-runtime/connection";
import {
  syncedIssueDetailById,
  syncedIssueDomainFromReplica,
  type SyncedIssueDomainReadModel,
} from "@spiritdevs/client-runtime/sync";
import type { IssueId } from "@spiritdevs/contracts";
import { Atom } from "effect/unstable/reactivity";

import { activeCompanyReplicaRoutingAtom } from "./activeCompany";
import { companyRegistryReplicasAtom } from "./companyRegistryReplica";

export {
  EMPTY_SYNCED_ISSUE_DOMAIN,
  syncedIssueDetailById,
  syncedIssueDomainFromEntities,
  syncedIssueDomainFromReplica,
  type SyncedIssueDetail,
  type SyncedIssueDomainReadModel,
} from "@spiritdevs/client-runtime/sync";

const activeCompanyReplicaAtom = Atom.make((get): CompanyRegistryReplicaState | null => {
  const companyId = get(activeCompanyReplicaRoutingAtom);
  return companyId === null ? null : (get(companyRegistryReplicasAtom).get(companyId) ?? null);
}).pipe(Atom.withLabel("cloud-sync:active-company-replica"));

export const syncedIssueDomainAtom = Atom.make(
  (get): SyncedIssueDomainReadModel => syncedIssueDomainFromReplica(get(activeCompanyReplicaAtom)),
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
