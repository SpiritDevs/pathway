/**
 * Leader-tab mutation handles for the running company sync engines.
 *
 * The raw engine stays private to the runtime. Mutation callers can only enqueue issue-domain
 * operations or dismiss known rejections, and a company disappears from this registry before its
 * stopped engine can receive another write.
 *
 * @module cloud/companySyncEngines
 */
import {
  type IssueSyncOperation,
  type SyncEnqueueReceipt,
  type SyncStoreError,
} from "@spiritdevs/client-runtime/sync";
import type { SyncOperationId } from "@spiritdevs/contracts/cloudSync";
import type { CompanyId } from "@spiritdevs/contracts/company";
import * as Effect from "effect/Effect";
import { Atom } from "effect/unstable/reactivity";

import { appAtomRegistry } from "../rpc/atomRegistry";

export interface CompanySyncEngineMutationHandle {
  readonly enqueue: (input: {
    readonly operationId: SyncOperationId;
    readonly operation: IssueSyncOperation;
    readonly dependsOn?: ReadonlyArray<SyncOperationId>;
  }) => Effect.Effect<SyncEnqueueReceipt, SyncStoreError>;
  readonly discardRejected: (
    operationIds: ReadonlyArray<SyncOperationId>,
  ) => Effect.Effect<void, SyncStoreError>;
}

export const companySyncEngineHandlesAtom = Atom.make<
  ReadonlyMap<CompanyId, CompanySyncEngineMutationHandle>
>(new Map()).pipe(Atom.keepAlive, Atom.withLabel("cloud-sync:company-engine-handles"));

/** Publishes a live engine's narrow mutation surface, or retracts it when that engine stops. */
export function publishCompanySyncEngineHandle(
  companyId: CompanyId,
  handle: CompanySyncEngineMutationHandle | null,
): Effect.Effect<void> {
  return Effect.sync(() => {
    appAtomRegistry.update(companySyncEngineHandlesAtom, (current) => {
      const next = new Map(current);
      if (handle === null) next.delete(companyId);
      else next.set(companyId, handle);
      return next;
    });
  });
}
