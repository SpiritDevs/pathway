import { managedRelaySessionAtom } from "@spiritdevs/client-runtime/relay";
import type { CompanyId } from "@spiritdevs/contracts/company";
import * as Effect from "effect/Effect";
import { Atom } from "effect/unstable/reactivity";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { hasCloudSyncPublicConfig } from "./publicConfig";
import type { CompanySyncStatus } from "./syncStatus.logic";

export const companySyncStatusesAtom = Atom.make<ReadonlyMap<CompanyId, CompanySyncStatus>>(
  new Map(),
).pipe(Atom.keepAlive, Atom.withLabel("cloud-sync:company-statuses"));

export interface CloudSyncTabState {
  readonly role: "inactive" | "follower" | "leader";
  readonly crossContext: boolean;
}

const INACTIVE_TAB_STATE: CloudSyncTabState = { role: "inactive", crossContext: true };

export const cloudSyncTabStateAtom = Atom.make<CloudSyncTabState>(INACTIVE_TAB_STATE).pipe(
  Atom.keepAlive,
  Atom.withLabel("cloud-sync:tab-state"),
);

export type CloudSyncAvailability =
  | { readonly phase: "disabled" | "signed-out" }
  | { readonly phase: null; readonly tab: CloudSyncTabState };

export const cloudSyncAvailabilityAtom = Atom.make((get): CloudSyncAvailability => {
  if (!hasCloudSyncPublicConfig()) return { phase: "disabled" };
  const accountId = get(managedRelaySessionAtom)?.accountId.trim();
  if (!accountId) return { phase: "signed-out" };
  return { phase: null, tab: get(cloudSyncTabStateAtom) };
}).pipe(Atom.withLabel("cloud-sync:availability"));

/** Publishes one compact engine snapshot into the app registry consumed by sync UI. */
export function publishCompanySyncStatus(
  companyId: CompanyId,
  status: CompanySyncStatus | null,
): Effect.Effect<void> {
  return Effect.sync(() => {
    appAtomRegistry.update(companySyncStatusesAtom, (current) => {
      const next = new Map(current);
      if (status === null) next.delete(companyId);
      else next.set(companyId, status);
      return next;
    });
  });
}

/** Publishes whether this tab owns the engine lock; `null` resets after runtime teardown. */
export function publishCloudSyncTabState(state: CloudSyncTabState | null): Effect.Effect<void> {
  return Effect.sync(() => {
    appAtomRegistry.set(cloudSyncTabStateAtom, state ?? INACTIVE_TAB_STATE);
  });
}
