/**
 * Storage port for the sync engine.
 *
 * The engine reads one company's replica once at start and writes atomic batches after that. The
 * host also enumerates durable company ids before reconciling an authenticated membership list,
 * so revoked state can be found after a restart rather than only while its engine is running. Web
 * and Electron back this with the
 * `pathway:cloud-sync` IndexedDB database, mobile with its SQLite layer, and the Pathway server
 * with its own SQLite tables; `memoryStore.ts` backs tests.
 *
 * @module sync/persistence
 */
import type { CompanyId } from "@spiritdevs/contracts/company";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { SyncStoreBatch, StoredSyncState } from "./document.ts";

export class SyncStoreError extends Schema.TaggedErrorClass<SyncStoreError>()("SyncStoreError", {
  operation: Schema.Literals(["read", "commit", "clear", "list"]),
  message: Schema.String,
}) {}

export class SyncStore extends Context.Service<
  SyncStore,
  {
    readonly read: (companyId: CompanyId) => Effect.Effect<StoredSyncState, SyncStoreError>;
    /** Companies with any durable sync state, including an outbox without a checkpoint. */
    readonly listCompanyIds: Effect.Effect<ReadonlyArray<CompanyId>, SyncStoreError>;
    /** Applies the batch atomically; see `applySyncStoreBatch` for the required semantics. */
    readonly commit: (
      companyId: CompanyId,
      batch: SyncStoreBatch,
    ) => Effect.Effect<void, SyncStoreError>;
    /** Sign-out and company removal. Drops confirmed rows, outbox, rejections, and cursor. */
    readonly clear: (companyId: CompanyId) => Effect.Effect<void, SyncStoreError>;
  }
>()("@spiritdevs/client-runtime/sync/persistence/SyncStore") {}
