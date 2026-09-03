/**
 * Pure decoders for one company's durable issue replica plus the MCP company-route reader.
 *
 * The sync daemon may own several company replicas. An MCP credential carries the calling thread's
 * environment and local project, which identifies its company through an active environment
 * binding. Callers without that scope keep the legacy behavior; scoped callers never guess.
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
  type CloudSyncEntity,
  type StoredSyncState,
  type SyncedIssueDomainReadModel,
} from "@spiritdevs/client-runtime/sync";
import { IssueTrackerError, type IssueMemberActor } from "@spiritdevs/contracts";
import { MembershipId, type CompanyId } from "@spiritdevs/contracts/company";
import * as Effect from "effect/Effect";

import type { CloudSyncEngineRegistryShape } from "../cloud/CloudSyncEngineRegistry.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";

export interface IssueReplicaReader {
  /** Null when this environment has no configured company route. */
  readonly companyId: Effect.Effect<CompanyId | null, IssueTrackerError>;
  /** Null means legacy fallback; a ready replica may legitimately project to an empty domain. */
  readonly read: Effect.Effect<SyncedIssueDomainReadModel | null, IssueTrackerError>;
  /** Resolves an active cloud user without guessing when the replica is absent or incomplete. */
  readonly memberActorForCloudUserId: (
    cloudUserId: string,
  ) => Effect.Effect<IssueMemberActor | null, IssueTrackerError>;
}

function issueMemberActorFromEntities(
  entities: Iterable<CloudSyncEntity>,
  cloudUserId: string,
): IssueMemberActor | null {
  for (const entity of entities) {
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
  return issueMemberActorFromEntities(
    [...decoded.replica.entities.values()].map(({ entity }) => entity),
    cloudUserId,
  );
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
  readonly replica: Effect.Effect<SyncedIssueDomainReadModel | null, E, R>;
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
  companyId: Effect.succeed(null),
  read: Effect.succeed(null),
  memberActorForCloudUserId: () => Effect.succeed(null),
};

const routingFailure = (message: string) =>
  new IssueTrackerError({
    reason: "storage",
    message: `Cloud issue routing failed: ${message}`,
  });

/**
 * Builds a reader whose route is resolved when the operation runs, after MCP authentication has
 * installed the invocation scope. Non-MCP server automation keeps its existing legacy route.
 */
export const makeIssueReplicaReader = (
  registry: CloudSyncEngineRegistryShape | null = null,
): Effect.Effect<IssueReplicaReader> => {
  if (registry === null) return Effect.succeed(unavailableReader);

  const resolve = Effect.gen(function* () {
    const invocation = yield* Effect.serviceOption(McpInvocationContext.McpInvocationContext);
    if (invocation._tag === "None") return null;
    const route = yield* registry.issueEngineForProject({
      environmentId: invocation.value.environmentId,
      ...(invocation.value.projectId === undefined
        ? {}
        : { localProjectId: invocation.value.projectId }),
    });
    if (route._tag === "Legacy") return null;
    if (route._tag === "Unbound") {
      return yield* routingFailure(
        `project ${invocation.value.projectId ?? "(missing)"} is not bound to a ready company replica on environment ${invocation.value.environmentId}; refusing to use the legacy tracker`,
      );
    }
    if (route._tag === "Ambiguous") {
      return yield* routingFailure(
        `project ${invocation.value.projectId ?? "(missing)"} is bound to more than one company replica (${route.companyIds.join(", ")}); refusing to guess`,
      );
    }
    return route.engine;
  });

  return Effect.succeed({
    companyId: resolve.pipe(Effect.map((engine) => engine?.companyId ?? null)),
    read: resolve.pipe(
      Effect.flatMap((engine) => (engine === null ? Effect.succeed(null) : engine.readIssueDomain)),
    ),
    memberActorForCloudUserId: (cloudUserId) =>
      resolve.pipe(
        Effect.flatMap((engine) =>
          engine === null
            ? Effect.succeed(null)
            : engine.readEntities.pipe(
                Effect.map((entities) =>
                  issueMemberActorFromEntities(entities.values(), cloudUserId),
                ),
              ),
        ),
      ),
  });
};
