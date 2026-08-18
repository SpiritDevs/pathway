import {
  mergeEffectiveConnectionCatalog,
  RelayConnectionTarget,
  type CompanyRegistryReplicaState,
} from "@spiritdevs/client-runtime/connection";
import { EnvironmentRegistrationEntity } from "@spiritdevs/client-runtime/sync";
import {
  createEnvironmentCatalogAtoms,
  type EnvironmentCatalogState,
} from "@spiritdevs/client-runtime/state/connections";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import * as Schema from "effect/Schema";
import { Atom } from "effect/unstable/reactivity";

import { scopedCompanyRegistryReplicasAtom } from "../cloud/activeCompany";
import { companyRegistryReplicasAtom } from "../cloud/companyRegistryReplica";
import { connectionAtomRuntime } from "./runtime";

export const localEnvironmentCatalog = createEnvironmentCatalogAtoms(connectionAtomRuntime);

const isEnvironmentRegistration = Schema.is(EnvironmentRegistrationEntity);
const isRelayConnection = Schema.is(RelayConnectionTarget);

function registeredCompanyEnvironmentIds(
  replicas: ReadonlyMap<string, CompanyRegistryReplicaState>,
  activeOnly: boolean,
): ReadonlySet<string> {
  const environmentIds = new Set<string>();
  for (const replica of replicas.values()) {
    for (const entity of replica.view.values()) {
      if (isEnvironmentRegistration(entity) && (!activeOnly || entity.state === "active")) {
        environmentIds.add(entity.environmentId);
      }
    }
  }
  return environmentIds;
}

export function effectiveCatalogState(
  local: EnvironmentCatalogState,
  replicas: ReadonlyMap<string, CompanyRegistryReplicaState>,
  allReplicas: ReadonlyMap<string, CompanyRegistryReplicaState> = replicas,
): EnvironmentCatalogState {
  const view = new Map<string, unknown>();
  for (const [companyId, replica] of replicas) {
    for (const [key, entity] of replica.view) {
      view.set(`${companyId}\u0000${key}`, entity);
    }
  }
  const currentEnvironmentId = [...local.entries.values()].find(
    (entry) => entry.target._tag === "PrimaryConnectionTarget",
  )?.target.environmentId;
  const allCompanyEnvironmentIds = registeredCompanyEnvironmentIds(allReplicas, false);
  const visibleCompanyEnvironmentIds = registeredCompanyEnvironmentIds(replicas, true);
  const visibleLocalEntries = new Map(
    [...local.entries].filter(
      ([environmentId, entry]) =>
        !isRelayConnection(entry.target) ||
        !allCompanyEnvironmentIds.has(environmentId) ||
        visibleCompanyEnvironmentIds.has(environmentId),
    ),
  );
  return {
    ...local,
    entries: mergeEffectiveConnectionCatalog({
      localEntries: visibleLocalEntries,
      replica: replicas.size === 0 ? null : { view },
      ...(currentEnvironmentId === undefined ? {} : { currentEnvironmentId }),
    }),
  };
}

const catalogAtom = Atom.make((get) => {
  const replicas = get(scopedCompanyRegistryReplicasAtom);
  const allReplicas = get(companyRegistryReplicasAtom);
  return AsyncResult.map(get(localEnvironmentCatalog.catalogAtom), (local) =>
    effectiveCatalogState(local, replicas, allReplicas),
  );
}).pipe(Atom.withLabel("environment-catalog:company-registry"));

const catalogValueAtom = Atom.make((get) =>
  effectiveCatalogState(
    get(localEnvironmentCatalog.catalogValueAtom),
    get(scopedCompanyRegistryReplicasAtom),
    get(companyRegistryReplicasAtom),
  ),
).pipe(Atom.withLabel("environment-catalog-value:company-registry"));

export const environmentCatalog = {
  ...localEnvironmentCatalog,
  catalogAtom,
  catalogValueAtom,
};
