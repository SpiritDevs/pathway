import type { CompanyRegistryReplicaState } from "@spiritdevs/client-runtime/connection";
import type { CompanyId, MembershipId } from "@spiritdevs/contracts/company";
import * as Effect from "effect/Effect";
import { Atom } from "effect/unstable/reactivity";

import { appAtomRegistry } from "../rpc/atomRegistry";

export const companyRegistryReplicasAtom = Atom.make<
  ReadonlyMap<CompanyId, CompanyRegistryReplicaState>
>(new Map()).pipe(Atom.keepAlive, Atom.withLabel("cloud-sync:company-registry-replicas"));

/** The signed-in person's membership for each live company engine. */
export const companyRegistryMembershipIdsAtom = Atom.make<ReadonlyMap<CompanyId, MembershipId>>(
  new Map(),
).pipe(Atom.keepAlive, Atom.withLabel("cloud-sync:company-registry-memberships"));

/** Publishes one engine's existing reactive view into the app registry consumed by the catalog. */
export function publishCompanyRegistryReplica(
  companyId: CompanyId,
  replica: CompanyRegistryReplicaState | null,
): Effect.Effect<void> {
  return Effect.sync(() => {
    appAtomRegistry.update(companyRegistryReplicasAtom, (current) => {
      const next = new Map(current);
      if (replica === null) {
        next.delete(companyId);
      } else {
        next.set(companyId, replica);
      }
      return next;
    });
  });
}

export function publishCompanyRegistryMembershipId(
  companyId: CompanyId,
  membershipId: MembershipId | null,
): Effect.Effect<void> {
  return Effect.sync(() => {
    appAtomRegistry.update(companyRegistryMembershipIdsAtom, (current) => {
      const next = new Map(current);
      if (membershipId === null) next.delete(companyId);
      else next.set(companyId, membershipId);
      return next;
    });
  });
}
