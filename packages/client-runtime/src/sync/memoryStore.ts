/**
 * In-memory {@link SyncStore}.
 *
 * Tests use it as the durable store — restart is "build a second engine over the same instance" —
 * and platforms without persistence yet can run the engine against it, losing only the outbox.
 *
 * @module sync/memoryStore
 */
import type { CompanyId } from "@spiritdevs/contracts/company";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import {
  applySyncStoreBatch,
  EMPTY_STORED_SYNC_STATE,
  type StoredSyncState,
  type SyncStoreBatch,
} from "./document.ts";
import { SyncStore } from "./persistence.ts";

export interface MemorySyncStore {
  readonly service: SyncStore["Service"];
  /** Direct read for assertions; the engine only sees `service`. */
  readonly snapshot: (companyId: CompanyId) => Effect.Effect<StoredSyncState>;
}

export const makeMemorySyncStore = Effect.fn("makeMemorySyncStore")(function* () {
  const companies = yield* Ref.make(new Map<CompanyId, StoredSyncState>());

  const snapshot = (companyId: CompanyId) =>
    Ref.get(companies).pipe(Effect.map((state) => state.get(companyId) ?? EMPTY_STORED_SYNC_STATE));

  const service = SyncStore.of({
    read: (companyId) => snapshot(companyId),
    listCompanyIds: Ref.get(companies).pipe(Effect.map((state) => [...state.keys()])),
    commit: (companyId: CompanyId, batch: SyncStoreBatch) =>
      Ref.update(companies, (state) => {
        const next = new Map(state);
        next.set(
          companyId,
          applySyncStoreBatch(state.get(companyId) ?? EMPTY_STORED_SYNC_STATE, batch),
        );
        return next;
      }),
    clear: (companyId: CompanyId) =>
      Ref.update(companies, (state) => {
        const next = new Map(state);
        next.delete(companyId);
        return next;
      }),
  });

  return { service, snapshot } satisfies MemorySyncStore;
});

export const memorySyncStoreLayer = Layer.effect(
  SyncStore,
  makeMemorySyncStore().pipe(Effect.map((store) => store.service)),
);
