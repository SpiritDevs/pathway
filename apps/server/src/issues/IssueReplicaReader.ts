/**
 * Pure decoders for one company's durable issue replica plus the legacy RPC's fail-closed reader.
 *
 * The sync daemon may own several company replicas. Decoding a caller-selected snapshot remains
 * useful, but the process-wide legacy issue RPC has no company dimension and therefore never
 * chooses one implicitly.
 *
 * @module issues/IssueReplicaReader
 */
import {
  decodeOutbox,
  decodeConfirmedEntities,
  makeIssueSyncAdapter,
  overlay,
  syncedIssueDomainFromEntities,
  SYNC_BOOTSTRAP_GENERATION,
  type StoredSyncState,
  type SyncedIssueDomainReadModel,
} from "@spiritdevs/client-runtime/sync";
import type { IssueMemberActor } from "@spiritdevs/contracts";
import { MembershipId, type CompanyId } from "@spiritdevs/contracts/company";
import * as Effect from "effect/Effect";

export interface IssueReplicaReader {
  /** Null when this environment has no configured company route. */
  readonly companyId: CompanyId | null;
  /** Null means legacy fallback; a ready replica may legitimately project to an empty domain. */
  readonly read: Effect.Effect<SyncedIssueDomainReadModel | null>;
  /** Resolves an active cloud user without guessing when the replica is absent or incomplete. */
  readonly memberActorForCloudUserId: (
    cloudUserId: string,
  ) => Effect.Effect<IssueMemberActor | null>;
}

export function issueMemberActorFromStoredReplica(
  stored: StoredSyncState,
  cloudUserId: string,
): IssueMemberActor | null {
  const checkpoint = stored.checkpoint;
  if (
    checkpoint === null ||
    !checkpoint.bootstrapped ||
    checkpoint.bootstrapGeneration !== SYNC_BOOTSTRAP_GENERATION ||
    stored.quarantined.length > 0
  ) {
    return null;
  }
  const decoded = decodeConfirmedEntities({
    adapter: makeIssueSyncAdapter(),
    rows: stored.entities,
    cursor: checkpoint.cursor,
    authorizationEpoch: checkpoint.authorizationEpoch,
  });
  if (decoded.quarantined !== 0) return null;
  for (const confirmed of decoded.replica.entities.values()) {
    const entity = confirmed.entity;
    if (
      entity.entityKind === "membership" &&
      entity.userId === cloudUserId &&
      entity.state === "active"
    ) {
      return { kind: "member", membershipId: MembershipId.make(entity.id) };
    }
  }
  return null;
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

  if (stored.quarantined.length > 0) return null;

  // Each outbox row carries its own actor: one environment engine may author ordinary service
  // writes and named system writes such as Slack intake in the same queue.
  const adapter = makeIssueSyncAdapter();
  const decoded = decodeConfirmedEntities({
    adapter,
    rows: stored.entities,
    cursor: checkpoint.cursor,
    authorizationEpoch: checkpoint.authorizationEpoch,
  });
  if (decoded.quarantined !== 0) return null;
  const decodedOutbox = decodeOutbox({ adapter, rows: stored.outbox });
  if (decodedOutbox.quarantined.length > 0) return null;
  const optimistic = overlay({
    replica: decoded.replica,
    entries: decodedOutbox.entries,
    adapter,
    rejected: stored.rejected,
  });
  return syncedIssueDomainFromEntities(optimistic.view.values());
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
  memberActorForCloudUserId: () => Effect.succeed(null),
};

/**
 * The legacy issue RPC has no company scope, so it must not guess among the environment's current
 * company replicas. Cloud issue reads and writes are routed explicitly by the client; this
 * process-wide service remains on the environment-local repository until its RPC boundary carries
 * a company id.
 */
export const makeIssueReplicaReader = Effect.succeed(unavailableReader);
