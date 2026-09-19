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
import {
  IssueTrackerError,
  type EnvironmentId,
  type IssueMemberActor,
  type ProjectId,
} from "@spiritdevs/contracts";
import { CloudProjectId } from "@spiritdevs/contracts/cloudProject";
import { MembershipId, type CompanyId } from "@spiritdevs/contracts/company";
import type { SyncActor } from "@spiritdevs/contracts/cloudSync";
import * as Effect from "effect/Effect";

import type {
  CloudSyncEngineRegistryShape,
  CloudSyncIssueEngineHandle,
  CloudSyncIssueProjectBinding,
} from "../cloud/CloudSyncEngineRegistry.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";

export interface IssueReplicaRoute {
  readonly localProjectId?: ProjectId;
  readonly companyId: CompanyId;
  readonly engine: CloudSyncIssueEngineHandle;
  readonly actor: SyncActor;
  readonly readModel: SyncedIssueDomainReadModel;
  readonly read: Effect.Effect<SyncedIssueDomainReadModel, IssueTrackerError>;
  readonly memberActorForCloudUserId: (cloudUserId: string) => IssueMemberActor | null;
  readonly cloudProjectIdForLocal: (localProjectId: string) => CloudProjectId | null;
}

export interface IssueReplicaReader {
  /** Resolves one stable company route for the full lifetime of a write. */
  readonly resolve: Effect.Effect<IssueReplicaRoute | null, IssueTrackerError>;
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
  resolve: Effect.succeed(null),
  companyId: Effect.succeed(null),
  read: Effect.succeed(null),
  memberActorForCloudUserId: () => Effect.succeed(null),
};

const routingFailure = (message: string) =>
  new IssueTrackerError({
    reason: "storage",
    message: `Cloud task routing failed: ${message}`,
  });

function translateProjectIds(
  readModel: SyncedIssueDomainReadModel,
  projectBindings: ReadonlyArray<CloudSyncIssueProjectBinding>,
  preferredLocalProjectId: string | undefined,
): SyncedIssueDomainReadModel {
  const localByCloud = new Map<CloudProjectId, ProjectId>();
  for (const { cloudProjectId, localProjectId } of projectBindings) {
    if (!localByCloud.has(cloudProjectId)) localByCloud.set(cloudProjectId, localProjectId);
  }
  const preferred = projectBindings.find(
    ({ localProjectId }) => localProjectId === preferredLocalProjectId,
  );
  if (preferred !== undefined) {
    localByCloud.set(preferred.cloudProjectId, preferred.localProjectId);
  }
  const localProjectId = (cloudProjectId: CloudProjectId) => {
    const local = localByCloud.get(cloudProjectId);
    return local === undefined ? cloudProjectId : CloudProjectId.make(local);
  };
  return {
    ...readModel,
    cloudProjects: readModel.cloudProjects.map((project) => ({
      ...project,
      id: localProjectId(project.id),
    })),
    issues: readModel.issues.map((issue) => ({
      ...issue,
      projectId: issue.projectId === null ? null : localProjectId(issue.projectId),
    })),
    issueMilestones: readModel.issueMilestones.map((milestone) => ({
      ...milestone,
      cloudProjectId: localProjectId(milestone.cloudProjectId),
    })),
  };
}

/** A client pins its company and checkout; the server supplies environment and account identity. */
export const resolveClientIssueRoute = Effect.fn("issues.resolveClientRoute")(function* (
  registry: CloudSyncEngineRegistryShape,
  input: {
    companyId: CompanyId;
    localProjectId: ProjectId;
    environmentId: EnvironmentId;
    userId: string;
  },
) {
  const engine = yield* registry.issueEngine(input.companyId);
  if (engine === null || engine.environmentId !== input.environmentId) {
    return yield* routingFailure("This company is not connected to this environment.");
  }
  const snapshot = yield* engine.readIssueSnapshot;
  if (!snapshot.bootstrapped || snapshot.quarantined !== 0) {
    return yield* routingFailure(
      "The company replica is not ready. Retry when synchronization completes.",
    );
  }
  const member = issueMemberActorFromEntities(snapshot.readModel.memberships, input.userId);
  if (member === null)
    return yield* routingFailure("This account cannot access the report's company.");
  const latest = new Map<ProjectId, (typeof snapshot.readModel.environmentBindings)[number]>();
  for (const binding of snapshot.readModel.environmentBindings) {
    if (binding.environmentId !== input.environmentId) continue;
    const previous = latest.get(binding.localProjectId);
    if (previous === undefined || previous.updatedAt < binding.updatedAt)
      latest.set(binding.localProjectId, binding);
  }
  const bindings = [...latest.values()].filter((binding) => binding.status === "active");
  if (!bindings.some((binding) => binding.localProjectId === input.localProjectId)) {
    return yield* routingFailure(
      "The report's project has no active checkout on this environment.",
    );
  }
  const translate = (model: SyncedIssueDomainReadModel) =>
    translateProjectIds(model, bindings, input.localProjectId);
  const read = engine.readIssueSnapshot.pipe(
    Effect.flatMap((next) => {
      if (
        !next.bootstrapped ||
        next.quarantined !== 0 ||
        issueMemberActorFromEntities(next.readModel.memberships, input.userId) === null
      ) {
        return Effect.fail(
          routingFailure("The report's company is unavailable or access was revoked."),
        );
      }
      const binding = next.readModel.environmentBindings
        .filter(
          (candidate) =>
            candidate.environmentId === input.environmentId &&
            candidate.localProjectId === input.localProjectId,
        )
        .sort((a, b) => b.updatedAt - a.updatedAt)[0];
      if (
        binding?.status !== "active" ||
        binding.cloudProjectId !==
          bindings.find((candidate) => candidate.localProjectId === input.localProjectId)
            ?.cloudProjectId
      ) {
        return Effect.fail(
          routingFailure("The report's project binding changed. Reopen the investigation."),
        );
      }
      return Effect.succeed(translate(next.readModel));
    }),
  );
  return {
    companyId: input.companyId,
    localProjectId: input.localProjectId,
    engine,
    actor: member,
    readModel: translate(snapshot.readModel),
    read,
    memberActorForCloudUserId: (userId) =>
      issueMemberActorFromEntities(snapshot.readModel.memberships, userId),
    cloudProjectIdForLocal: (id) =>
      bindings.find((binding) => binding.localProjectId === id)?.cloudProjectId ?? null,
  } satisfies IssueReplicaRoute;
});

/**
 * Builds a reader whose route is resolved when the operation runs, after MCP authentication has
 * installed the invocation scope. Non-MCP server automation keeps its existing legacy route.
 */
export const makeIssueReplicaReader = (
  registry: CloudSyncEngineRegistryShape | null = null,
): Effect.Effect<IssueReplicaReader> => {
  if (registry === null) return Effect.succeed(unavailableReader);

  const resolve: IssueReplicaReader["resolve"] = Effect.gen(function* () {
    const invocation = yield* Effect.serviceOption(McpInvocationContext.McpInvocationContext);
    if (invocation._tag === "None") return null;
    const route = yield* registry.issueEngineForProject({
      environmentId: invocation.value.environmentId,
      ...(invocation.value.projectId === undefined
        ? {}
        : { localProjectId: invocation.value.projectId }),
    });
    if (route._tag === "Legacy") return null;
    if (route._tag === "Unavailable") {
      return yield* routingFailure(
        `cloud sync is configured for environment ${invocation.value.environmentId}, but no complete company replica is available${route.companyIds.length === 0 ? "" : ` (${route.companyIds.join(", ")})`}; refusing to use the legacy tracker`,
      );
    }
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
    const cloudByLocal = new Map<string, CloudProjectId>(
      route.projectBindings.map(({ localProjectId, cloudProjectId }) => [
        localProjectId,
        cloudProjectId,
      ]),
    );
    let translatedSource: SyncedIssueDomainReadModel | undefined;
    let translatedReadModel: SyncedIssueDomainReadModel | undefined;
    const translate = (readModel: SyncedIssueDomainReadModel) => {
      if (translatedReadModel === undefined || translatedSource !== readModel) {
        translatedSource = readModel;
        translatedReadModel = translateProjectIds(
          readModel,
          route.projectBindings,
          invocation.value.projectId,
        );
      }
      return translatedReadModel;
    };
    const read = route.engine.readIssueSnapshot.pipe(
      Effect.flatMap((snapshot) =>
        !snapshot.bootstrapped || snapshot.quarantined > 0
          ? Effect.fail(
              routingFailure(
                `company replica ${route.engine.companyId} became incomplete during the operation`,
              ),
            )
          : Effect.succeed(translate(snapshot.readModel)),
      ),
    );
    return {
      companyId: route.engine.companyId,
      engine: route.engine,
      actor: {
        kind: "agent",
        provider: invocation.value.providerDriverKind,
        onBehalfOfMembershipId: null,
      },
      readModel: translate(route.readModel),
      read,
      memberActorForCloudUserId: (cloudUserId) =>
        issueMemberActorFromEntities(route.readModel.memberships, cloudUserId),
      cloudProjectIdForLocal: (localProjectId) => cloudByLocal.get(localProjectId) ?? null,
    };
  });

  return Effect.succeed({
    resolve,
    companyId: resolve.pipe(Effect.map((route) => route?.companyId ?? null)),
    read: resolve.pipe(Effect.map((route) => route?.readModel ?? null)),
    memberActorForCloudUserId: (cloudUserId) =>
      resolve.pipe(
        Effect.map((route) =>
          route === null
            ? null
            : issueMemberActorFromEntities(route.readModel.memberships, cloudUserId),
        ),
      ),
  });
};
