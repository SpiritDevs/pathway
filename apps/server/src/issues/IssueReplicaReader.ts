/**
 * Read-only access to the configured company's durable issue replica.
 *
 * The sync daemon owns transport and writes, but it does not publish a process-wide store handle.
 * Both it and this reader open the same idempotent `cloud_sync_*` store over the ambient server
 * SqlClient. A replica becomes routable only after the exact bootstrap generation completes.
 *
 * @module issues/IssueReplicaReader
 */
import {
  decodeConfirmedEntities,
  issueSyncDomainAdapter,
  makeSqliteSyncStore,
  syncedIssueDomainFromEntities,
  SYNC_BOOTSTRAP_GENERATION,
  type StoredSyncState,
  type SyncedIssueDomainReadModel,
} from "@spiritdevs/client-runtime/sync";
import type { CompanyId } from "@spiritdevs/contracts/company";
import * as Effect from "effect/Effect";

import { resolveCloudSyncConfig } from "../cloud/syncDaemon.ts";
import { makeSyncSqliteExecutor } from "../cloud/syncSqliteExecutor.ts";

export interface IssueReplicaReader {
  /** Null when this environment has no configured company route. */
  readonly companyId: CompanyId | null;
  /** Null means legacy fallback; a ready replica may legitimately project to an empty domain. */
  readonly read: Effect.Effect<SyncedIssueDomainReadModel | null>;
}

/**
 * Decodes one durable snapshot through the production sync codec.
 *
 * A partial/old bootstrap or any undecodable confirmed row is not a safe authority boundary, so
 * it returns null and lets the caller preserve the legacy read path unchanged.
 */
export function issueReadModelFromStoredReplica(
  stored: StoredSyncState,
): SyncedIssueDomainReadModel | null {
  const checkpoint = stored.checkpoint;
  if (
    checkpoint === null ||
    !checkpoint.bootstrapped ||
    checkpoint.bootstrapGeneration !== SYNC_BOOTSTRAP_GENERATION
  ) {
    return null;
  }

  const decoded = decodeConfirmedEntities({
    adapter: issueSyncDomainAdapter,
    rows: stored.entities,
    cursor: checkpoint.cursor,
    authorizationEpoch: checkpoint.authorizationEpoch,
  });
  if (decoded.quarantined !== 0) return null;
  return syncedIssueDomainFromEntities(
    [...decoded.replica.entities.values()].map((entity) => entity.entity),
  );
}

/** Chooses one source once; entity absence inside a ready replica never falls through to legacy. */
export function routeReplicaIssueRead<A, E, R>(input: {
  readonly replica: Effect.Effect<SyncedIssueDomainReadModel | null>;
  readonly fromReplica: (readModel: SyncedIssueDomainReadModel) => Effect.Effect<A, E, R>;
  readonly fromLegacy: Effect.Effect<A, E, R>;
}): Effect.Effect<A, E, R> {
  return input.replica.pipe(
    Effect.flatMap((readModel) =>
      readModel === null ? input.fromLegacy : input.fromReplica(readModel),
    ),
  );
}

const unavailableReader: IssueReplicaReader = {
  companyId: null,
  read: Effect.succeed(null),
};

/**
 * Opens the same durable store as the daemon when a company route is configured.
 *
 * Read failures degrade to legacy with one warning. That matches the bootstrap rule: until the
 * local replica is complete and readable, it is not a source at all.
 */
export const makeIssueReplicaReader = Effect.gen(function* () {
  const configured = yield* resolveCloudSyncConfig;
  if (configured._tag !== "Configured") return unavailableReader;

  const store = yield* makeSqliteSyncStore(yield* makeSyncSqliteExecutor);
  const companyId = configured.settings.companyId;
  const read = store.service.read(companyId).pipe(
    Effect.map(issueReadModelFromStoredReplica),
    Effect.catchCause((cause) =>
      Effect.logWarning("Failed to read the company issue replica; using legacy issue reads", {
        companyId,
        cause,
      }).pipe(Effect.as(null)),
    ),
  );
  return { companyId, read };
}).pipe(
  Effect.catchCause((cause) =>
    Effect.logWarning("Failed to open the company issue replica; using legacy issue reads", {
      cause,
    }).pipe(Effect.as(unavailableReader)),
  ),
);
