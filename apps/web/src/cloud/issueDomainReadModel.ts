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
  EnvironmentBindingEntity,
  syncedIssueDetailById,
  syncedIssueDomainFromEntities,
  syncedIssueDomainFromReplica,
  type SyncedIssueDomainReadModel,
} from "@spiritdevs/client-runtime/sync";
import type { IssueId } from "@spiritdevs/contracts";
import type { SyncEntityKind } from "@spiritdevs/contracts/cloudSync";
import type { CompanyId } from "@spiritdevs/contracts/company";
import * as Schema from "effect/Schema";
import { Atom } from "effect/unstable/reactivity";

import { scopedCompanyRegistryReplicasAtom } from "./activeCompany";
import { companyRegistryReplicasAtom } from "./companyRegistryReplica";

export {
  EMPTY_SYNCED_ISSUE_DOMAIN,
  syncedIssueDetailById,
  syncedIssueDomainFromEntities,
  syncedIssueDomainFromReplica,
  type SyncedIssueDetail,
  type SyncedIssueDomainReadModel,
} from "@spiritdevs/client-runtime/sync";

export type IssueDomainEntityCompanyIds = ReadonlyMap<string, ReadonlySet<CompanyId>>;

export function issueDomainEntityCompanyKey(entityKind: SyncEntityKind, entityId: string): string {
  return `${entityKind}:${entityId}`;
}

function hasEntityIdentity(value: unknown): value is {
  readonly entityKind: SyncEntityKind;
  readonly id: string;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    "entityKind" in value &&
    typeof value.entityKind === "string" &&
    "id" in value &&
    typeof value.id === "string"
  );
}

/** The owning company is carried by the replica boundary, not duplicated in each entity payload. */
export function issueDomainEntityCompanyIdsFromReplicas(
  replicas: ReadonlyMap<CompanyId, CompanyRegistryReplicaState>,
): IssueDomainEntityCompanyIds {
  const companyIds = new Map<string, Set<CompanyId>>();
  for (const [companyId, replica] of replicas) {
    for (const entity of replica.view.values()) {
      if (!hasEntityIdentity(entity)) continue;
      const key = issueDomainEntityCompanyKey(entity.entityKind, entity.id);
      const owners = companyIds.get(key) ?? new Set<CompanyId>();
      owners.add(companyId);
      companyIds.set(key, owners);
    }
  }
  return companyIds;
}

export function issueDomainEntityCompanyId(
  companyIds: IssueDomainEntityCompanyIds,
  entityKind: SyncEntityKind,
  entityId: string,
  preferredCompanyId: CompanyId | null = null,
): CompanyId | null {
  const owners = companyIds.get(issueDomainEntityCompanyKey(entityKind, entityId));
  if (owners === undefined || owners.size === 0) return null;
  if (preferredCompanyId !== null && owners.has(preferredCompanyId)) return preferredCompanyId;
  return owners.size === 1 ? (owners.values().next().value ?? null) : null;
}

export function syncedIssueDomainFromReplicas(
  replicas: ReadonlyMap<CompanyId, CompanyRegistryReplicaState>,
): SyncedIssueDomainReadModel {
  return syncedIssueDomainFromEntities(
    [...replicas.values()].flatMap((replica) => [...replica.view.values()]),
  );
}

const scopedIssueDomainsByCompanyAtom = Atom.make((get) => {
  const domains = new Map<CompanyId, SyncedIssueDomainReadModel>();
  for (const [companyId, replica] of get(scopedCompanyRegistryReplicasAtom)) {
    domains.set(companyId, syncedIssueDomainFromReplica(replica));
  }
  return domains;
}).pipe(Atom.withLabel("cloud-sync:issue-domains-by-company"));

export const syncedIssueDomainForCompanyAtomFamily = Atom.family((companyId: CompanyId) =>
  Atom.make((get): SyncedIssueDomainReadModel | null => {
    const replica = get(companyRegistryReplicasAtom).get(companyId);
    return replica === undefined ? null : syncedIssueDomainFromReplica(replica);
  }).pipe(Atom.withLabel(`cloud-sync:issue-domain:${companyId}`)),
);

const EMPTY_COMPANY_ISSUE_DOMAIN_ATOM = Atom.make<SyncedIssueDomainReadModel | null>(null).pipe(
  Atom.withLabel("cloud-sync:issue-domain-empty"),
);

/** Includes every loaded replica so an existing entity remains routable during a scope switch. */
export const issueDomainEntityCompanyIdsAtom = Atom.make((get) =>
  issueDomainEntityCompanyIdsFromReplicas(get(companyRegistryReplicasAtom)),
).pipe(Atom.withLabel("cloud-sync:issue-domain-entity-company-ids"));

export const syncedIssueDomainAtom = Atom.make(
  (get): SyncedIssueDomainReadModel =>
    syncedIssueDomainFromReplicas(get(scopedCompanyRegistryReplicasAtom)),
).pipe(Atom.withLabel("cloud-sync:issue-domain"));

export const cloudProjectsAtom = Atom.make((get) => get(syncedIssueDomainAtom).cloudProjects).pipe(
  Atom.withLabel("cloud-sync:cloud-projects"),
);
const isEnvironmentBinding = Schema.is(EnvironmentBindingEntity);
export const environmentBindingsAtom = Atom.make((get) => {
  const bindings = [];
  for (const replica of get(scopedCompanyRegistryReplicasAtom).values()) {
    bindings.push(...[...replica.view.values()].filter(isEnvironmentBinding));
  }
  return bindings;
}).pipe(Atom.withLabel("cloud-sync:environment-bindings"));
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
  Atom.make((get) => {
    const companyId = issueDomainEntityCompanyId(
      get(issueDomainEntityCompanyIdsAtom),
      "issue",
      issueId,
    );
    if (companyId === null) return null;
    const domain = get(scopedIssueDomainsByCompanyAtom).get(companyId);
    return domain === undefined ? null : syncedIssueDetailById(domain, issueId);
  }).pipe(Atom.withLabel(`cloud-sync:issue-detail:${issueId}`)),
);

export function useSyncedCloudProjects() {
  return useAtomValue(cloudProjectsAtom);
}

export function useSyncedEnvironmentBindings() {
  return useAtomValue(environmentBindingsAtom);
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

export function useSyncedIssueDomainForCompany(companyId: CompanyId | null) {
  return useAtomValue(
    companyId === null
      ? EMPTY_COMPANY_ISSUE_DOMAIN_ATOM
      : syncedIssueDomainForCompanyAtomFamily(companyId),
  );
}
