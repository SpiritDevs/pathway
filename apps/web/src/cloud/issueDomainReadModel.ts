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
  type CloudSyncEntity,
  type CloudProjectSyncEntity,
  type EnvironmentBindingEntity,
  syncedIssueDetailById,
  syncedIssueDomainFromEntities,
  syncedIssueDomainFromReplica,
  type SyncedIssueDomainReadModel,
} from "@spiritdevs/client-runtime/sync";
import type { EnvironmentId, IssueId } from "@spiritdevs/contracts";
import type { SyncEntityKind } from "@spiritdevs/contracts/cloudSync";
import type { CompanyId } from "@spiritdevs/contracts/company";
import * as Option from "effect/Option";
import { Atom } from "effect/unstable/reactivity";

import { activeCompanyIdAtom, companyReplicasForSelection } from "./activeCompany";
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
  if (replicas.size === 1) return syncedIssueDomainFromReplica(replicas.values().next().value!);
  return syncedIssueDomainFromEntities(
    [...replicas.values()].flatMap((replica) => [...replica.view.values()] as CloudSyncEntity[]),
  );
}

const issueDomainsByCompanyAtom = Atom.make((get) => {
  const previous = Option.getOrUndefined(
    get.self<ReadonlyMap<CompanyId, SyncedIssueDomainReadModel>>(),
  );
  const domains = new Map<CompanyId, SyncedIssueDomainReadModel>();
  for (const [companyId, replica] of get(companyRegistryReplicasAtom)) {
    domains.set(companyId, syncedIssueDomainFromReplica(replica, previous?.get(companyId)));
  }
  return retainCompanyMap(previous, domains);
});

const scopedIssueDomainsByCompanyAtom = Atom.make((get) => {
  const domains = get(issueDomainsByCompanyAtom);
  const previous = Option.getOrUndefined(
    get.self<ReadonlyMap<CompanyId, SyncedIssueDomainReadModel>>(),
  );
  return retainCompanyMap(previous, companyReplicasForSelection(domains, get(activeCompanyIdAtom)));
}).pipe(Atom.withLabel("cloud-sync:issue-domains-by-company"));

export const syncedIssueDomainForCompanyAtomFamily = Atom.family((companyId: CompanyId) =>
  Atom.make(
    (get): SyncedIssueDomainReadModel | null =>
      get(issueDomainsByCompanyAtom).get(companyId) ?? null,
  ).pipe(Atom.withLabel(`cloud-sync:issue-domain:${companyId}`)),
);

export interface IssueProjectReplicaProjection {
  readonly cloudProjects: ReadonlyArray<CloudProjectSyncEntity>;
  readonly environmentBindings: ReadonlyArray<EnvironmentBindingEntity>;
  readonly caseInsensitiveEnvironmentIds: ReadonlySet<EnvironmentId>;
}

function retainCompanyMap<A>(
  previous: ReadonlyMap<CompanyId, A> | undefined,
  next: ReadonlyMap<CompanyId, A>,
) {
  return previous?.size === next.size &&
    [...next].every(([id, value]) => previous.get(id) === value)
    ? previous
    : next;
}

export const issueProjectProjectionsByCompanyAtom = Atom.make((get) => {
  const domains = get(issueDomainsByCompanyAtom);
  const previous = Option.getOrUndefined(
    get.self<ReadonlyMap<CompanyId, IssueProjectReplicaProjection>>(),
  );
  const projects = new Map<CompanyId, IssueProjectReplicaProjection>();
  for (const [companyId, replica] of get(companyRegistryReplicasAtom)) {
    // Sibling derivations of the replica map recompute one at a time, so a newly published
    // company can be missing here for a moment. The domains map re-runs this when it lands.
    const domain = domains.get(companyId);
    if (domain === undefined) continue;
    const caseInsensitiveEnvironmentIds = new Set<EnvironmentId>();
    for (const entity of replica.view.values() as Iterable<CloudSyncEntity>) {
      if (
        entity.entityKind === "environmentRegistration" &&
        (entity.descriptor.platform.os === "darwin" || entity.descriptor.platform.os === "windows")
      ) {
        caseInsensitiveEnvironmentIds.add(entity.environmentId);
      }
    }
    const before = previous?.get(companyId);
    const unchanged =
      before !== undefined &&
      before.cloudProjects === domain.cloudProjects &&
      before.environmentBindings === domain.environmentBindings &&
      before.caseInsensitiveEnvironmentIds.size === caseInsensitiveEnvironmentIds.size &&
      [...caseInsensitiveEnvironmentIds].every((id) =>
        before.caseInsensitiveEnvironmentIds.has(id),
      );
    projects.set(
      companyId,
      unchanged
        ? before
        : {
            cloudProjects: domain.cloudProjects,
            environmentBindings: domain.environmentBindings,
            caseInsensitiveEnvironmentIds,
          },
    );
  }
  return retainCompanyMap(previous, projects);
});

export const scopedIssueProjectProjectionsByCompanyAtom = Atom.make((get) => {
  const projects = get(issueProjectProjectionsByCompanyAtom);
  const previous = Option.getOrUndefined(
    get.self<ReadonlyMap<CompanyId, IssueProjectReplicaProjection>>(),
  );
  return retainCompanyMap(
    previous,
    companyReplicasForSelection(projects, get(activeCompanyIdAtom)),
  );
});

const EMPTY_COMPANY_ISSUE_DOMAIN_ATOM = Atom.make<SyncedIssueDomainReadModel | null>(null).pipe(
  Atom.withLabel("cloud-sync:issue-domain-empty"),
);

/** Includes every loaded replica so an existing entity remains routable during a scope switch. */
export const issueDomainEntityCompanyIdsAtom = Atom.make((get) =>
  issueDomainEntityCompanyIdsFromReplicas(get(companyRegistryReplicasAtom)),
).pipe(Atom.withLabel("cloud-sync:issue-domain-entity-company-ids"));

export const syncedIssueDomainAtom = Atom.make((get): SyncedIssueDomainReadModel => {
  const domains = [...get(scopedIssueDomainsByCompanyAtom).values()];
  const previous = Option.getOrUndefined(get.self<SyncedIssueDomainReadModel>());
  return domains.length === 1
    ? domains[0]!
    : syncedIssueDomainFromEntities(
        // Each company's collections are already decoded and ordered; one merge keeps All deterministic.
        domains.flatMap((domain) => Object.values(domain).flat()) as CloudSyncEntity[],
        previous,
      );
}).pipe(Atom.withLabel("cloud-sync:issue-domain"));

export const cloudProjectsAtom = Atom.make((get) => get(syncedIssueDomainAtom).cloudProjects).pipe(
  Atom.withLabel("cloud-sync:cloud-projects"),
);
export const environmentBindingsAtom = Atom.make(
  (get) => get(syncedIssueDomainAtom).environmentBindings,
).pipe(Atom.withLabel("cloud-sync:environment-bindings"));
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
