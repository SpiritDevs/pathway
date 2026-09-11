import { Atom } from "effect/unstable/reactivity";
import type { CompanyId } from "@spiritdevs/contracts/company";
import { activeCompanyIdAtom } from "./activeCompany";
import { companyRegistryReplicasAtom } from "./companyRegistryReplica";
import { companySyncStatusesAtom } from "./syncStatus";
import type { CompanySyncStatus } from "./syncStatus.logic";

export type ThreadListReadiness = "ready" | "loading" | "error";

export function companyThreadReadiness(
  companyId: CompanyId | null,
  replicas: ReadonlyMap<CompanyId, unknown>,
  statuses: ReadonlyMap<CompanyId, CompanySyncStatus>,
): ThreadListReadiness {
  const ids =
    companyId === null ? [...new Set([...replicas.keys(), ...statuses.keys()])] : [companyId];
  if (ids.length === 0) return "loading";
  let readiness: ThreadListReadiness = "ready";
  for (const id of ids) {
    const status = statuses.get(id);
    if (replicas.has(id) && status?.bootstrapComplete) continue;
    if (status?.phase === "error" || status?.phase === "reconnecting") return "error";
    readiness = "loading";
  }
  return readiness;
}

// A live shell is not proof that its company ownership records have finished bootstrapping.
export const companyThreadReadinessAtom = Atom.make((get) =>
  companyThreadReadiness(
    get(activeCompanyIdAtom),
    get(companyRegistryReplicasAtom),
    get(companySyncStatusesAtom),
  ),
);
