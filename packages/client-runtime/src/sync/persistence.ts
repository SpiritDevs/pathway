/**
 * Storage port for the sync engine.
 *
 * The engine reads one company's replica once at start and writes atomic batches after that, so
 * an adapter needs exactly two operations plus a wipe. Web and Electron back this with the
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
  operation: Schema.Literals(["read", "commit", "clear"]),
  message: Schema.String,
}) {}

export class SyncStore extends Context.Service<
  SyncStore,
  {
    readonly read: (companyId: CompanyId) => Effect.Effect<StoredSyncState, SyncStoreError>;
    /** Applies the batch atomically; see `applySyncStoreBatch` for the required semantics. */
    readonly commit: (
      companyId: CompanyId,
      batch: SyncStoreBatch,
    ) => Effect.Effect<void, SyncStoreError>;
    /** Sign-out and company removal. Drops confirmed rows, outbox, rejections, and cursor. */
    readonly clear: (companyId: CompanyId) => Effect.Effect<void, SyncStoreError>;
  }
>()("@spiritdevs/client-runtime/sync/persistence/SyncStore") {}
