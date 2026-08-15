import {
  mergeEffectiveConnectionCatalog,
  type CompanyRegistryReplicaState,
} from "@spiritdevs/client-runtime/connection";
import {
  createEnvironmentCatalogAtoms,
  type EnvironmentCatalogState,
} from "@spiritdevs/client-runtime/state/connections";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { Atom } from "effect/unstable/reactivity";

import { companyRegistryReplicasAtom } from "../cloud/companyRegistryReplica";
import { connectionAtomRuntime } from "./runtime";

const localEnvironmentCatalog = createEnvironmentCatalogAtoms(connectionAtomRuntime);

function effectiveCatalogState(
  local: EnvironmentCatalogState,
  replicas: ReadonlyMap<string, CompanyRegistryReplicaState>,
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
  return {
    ...local,
    entries: mergeEffectiveConnectionCatalog({
      localEntries: local.entries,
      replica: replicas.size === 0 ? null : { view },
      ...(currentEnvironmentId === undefined ? {} : { currentEnvironmentId }),
    }),
  };
}

const catalogAtom = Atom.make((get) => {
  const replicas = get(companyRegistryReplicasAtom);
  return AsyncResult.map(get(localEnvironmentCatalog.catalogAtom), (local) =>
    effectiveCatalogState(local, replicas),
  );
}).pipe(Atom.withLabel("environment-catalog:company-registry"));

const catalogValueAtom = Atom.make((get) =>
  effectiveCatalogState(
    get(localEnvironmentCatalog.catalogValueAtom),
    get(companyRegistryReplicasAtom),
  ),
).pipe(Atom.withLabel("environment-catalog-value:company-registry"));

export const environmentCatalog = {
  ...localEnvironmentCatalog,
  catalogAtom,
  catalogValueAtom,
};
