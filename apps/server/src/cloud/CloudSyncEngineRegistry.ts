/**
 * Process-local access to the company-indexed cloud-sync engines owned by the daemon.
 *
 * The registry is deliberately only a handle. It never constructs an engine, opens a store, or
 * starts a driver, so server-side issue writers cannot accidentally compete with the daemon for
 * the same company replica.
 *
 * @module cloud/CloudSyncEngineRegistry
 */
import type {
  CloudSyncEntity,
  IssueSyncOperation,
  SyncedIssueDomainReadModel,
  SyncCycleReceipt,
  SyncEngine,
  SyncEnqueueReceipt,
  SyncStoreError,
} from "@spiritdevs/client-runtime/sync";
import { syncedIssueDomainFromEntities } from "@spiritdevs/client-runtime/sync";
import type { EnvironmentId, ProjectId } from "@spiritdevs/contracts";
import type { CompanyId } from "@spiritdevs/contracts/company";
import type { SyncOperationId } from "@spiritdevs/contracts/cloudSync";
import type { SyncActor } from "@spiritdevs/contracts/cloudSync";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as SubscriptionRef from "effect/SubscriptionRef";

export type CloudSyncOperationDisposition =
  | { readonly _tag: "Pending" }
  | { readonly _tag: "Rejected"; readonly code: string; readonly message: string }
  | { readonly _tag: "Settled" };

export interface CloudSyncIssueEngineHandle {
  readonly companyId: CompanyId;
  readonly environmentId: EnvironmentId;
  readonly enqueue: (input: {
    readonly operationId: SyncOperationId;
    readonly operation: IssueSyncOperation;
    readonly dependsOn?: ReadonlyArray<SyncOperationId>;
    readonly actor?: SyncActor;
  }) => Effect.Effect<SyncEnqueueReceipt, SyncStoreError>;
  readonly sync: Effect.Effect<SyncCycleReceipt, SyncStoreError>;
  readonly operationDisposition: (
    operationId: SyncOperationId,
  ) => Effect.Effect<CloudSyncOperationDisposition>;
  /** Current optimistic issue model for this company. */
  readonly readIssueDomain: Effect.Effect<SyncedIssueDomainReadModel>;
  /** Current optimistic entity map, used for company membership resolution. */
  readonly readEntities: Effect.Effect<ReadonlyMap<string, CloudSyncEntity>>;
}

export type CloudSyncIssueEngineRoute =
  | { readonly _tag: "Legacy" }
  | { readonly _tag: "Unbound"; readonly companyIds: ReadonlyArray<CompanyId> }
  | { readonly _tag: "Ambiguous"; readonly companyIds: ReadonlyArray<CompanyId> }
  | { readonly _tag: "Ready"; readonly engine: CloudSyncIssueEngineHandle };

export interface CloudSyncEngineRegistryShape {
  readonly registerIssueEngine: (input: {
    readonly environmentId: EnvironmentId;
    readonly engine: SyncEngine<CloudSyncEntity, IssueSyncOperation>;
  }) => Effect.Effect<void>;
  /**
   * Removes this exact engine registration. The identity check prevents an older stopping daemon
   * from deleting the replacement that was installed for the same company in the meantime.
   */
  readonly unregisterIssueEngine: (input: {
    readonly engine: SyncEngine<CloudSyncEntity, IssueSyncOperation>;
  }) => Effect.Effect<void>;
  /** Installs an engine for exactly the lifetime of `use`, without an interruption gap. */
  readonly withIssueEngine: <A, E, R>(
    input: {
      readonly environmentId: EnvironmentId;
      readonly engine: SyncEngine<CloudSyncEntity, IssueSyncOperation>;
    },
    use: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  readonly issueEngine: (companyId: CompanyId) => Effect.Effect<CloudSyncIssueEngineHandle | null>;
  /**
   * Resolves the company that owns one local project on this environment.
   *
   * No registered company engines means the legacy tracker is still authoritative. Once any
   * company engine exists for the environment, a missing or ambiguous binding is reported rather
   * than guessed so an MCP write cannot disappear into the environment-local tracker.
   */
  readonly issueEngineForProject: (input: {
    readonly environmentId: EnvironmentId;
    readonly localProjectId?: ProjectId | undefined;
  }) => Effect.Effect<CloudSyncIssueEngineRoute>;
}

export class CloudSyncEngineRegistry extends Context.Service<
  CloudSyncEngineRegistry,
  CloudSyncEngineRegistryShape
>()("@spiritdevs/pathway/cloud/CloudSyncEngineRegistry") {}

export const makeCloudSyncEngineRegistry = Effect.gen(function* () {
  interface RegisteredIssueEngine {
    readonly engine: SyncEngine<CloudSyncEntity, IssueSyncOperation>;
    readonly handle: CloudSyncIssueEngineHandle;
  }

  const current = yield* Ref.make<ReadonlyMap<CompanyId, RegisteredIssueEngine>>(new Map());

  const registerIssueEngine: CloudSyncEngineRegistryShape["registerIssueEngine"] = (input) =>
    Ref.update(current, (registered) => {
      const handle: CloudSyncIssueEngineHandle = {
        companyId: input.engine.companyId,
        environmentId: input.environmentId,
        enqueue: input.engine.enqueue,
        sync: input.engine.sync,
        operationDisposition: (operationId) =>
          SubscriptionRef.get(input.engine.state).pipe(
            Effect.map((state): CloudSyncOperationDisposition => {
              const rejection = state.rejected.find(
                (entry) => entry.operation.operationId === operationId,
              );
              if (rejection !== undefined) {
                return {
                  _tag: "Rejected",
                  code: rejection.code,
                  message: rejection.message,
                };
              }
              return state.pending.some((entry) => entry.operation.operationId === operationId)
                ? { _tag: "Pending" }
                : { _tag: "Settled" };
            }),
          ),
        readIssueDomain: SubscriptionRef.get(input.engine.state).pipe(
          Effect.map((state) => syncedIssueDomainFromEntities(state.view.values())),
        ),
        readEntities: SubscriptionRef.get(input.engine.state).pipe(
          Effect.map((state) => state.view),
        ),
      };
      return new Map(registered).set(input.engine.companyId, { engine: input.engine, handle });
    });

  const unregisterIssueEngine: CloudSyncEngineRegistryShape["unregisterIssueEngine"] = (input) =>
    Ref.update(current, (registered) => {
      const held = registered.get(input.engine.companyId);
      if (held?.engine !== input.engine) return registered;
      const next = new Map(registered);
      next.delete(input.engine.companyId);
      return next;
    });

  const issueEngine: CloudSyncEngineRegistryShape["issueEngine"] = (companyId) =>
    Ref.get(current).pipe(Effect.map((registered) => registered.get(companyId)?.handle ?? null));

  const issueEngineForProject: CloudSyncEngineRegistryShape["issueEngineForProject"] = (input) =>
    Effect.gen(function* () {
      const registered = [...(yield* Ref.get(current)).values()].filter(
        ({ handle }) => handle.environmentId === input.environmentId,
      );
      if (registered.length === 0) return { _tag: "Legacy" } as const;
      if (input.localProjectId === undefined) {
        return {
          _tag: "Unbound",
          companyIds: registered.map(({ handle }) => handle.companyId),
        } as const;
      }

      const matches: CloudSyncIssueEngineHandle[] = [];
      for (const { handle } of registered) {
        const entities = yield* handle.readEntities;
        const bound = [...entities.values()].some(
          (entity) =>
            entity.entityKind === "environmentBinding" &&
            entity.environmentId === input.environmentId &&
            entity.localProjectId === input.localProjectId &&
            entity.status === "active",
        );
        if (bound) matches.push(handle);
      }
      if (matches.length === 1) return { _tag: "Ready", engine: matches[0]! } as const;
      if (matches.length === 0) {
        return {
          _tag: "Unbound",
          companyIds: registered.map(({ handle }) => handle.companyId),
        } as const;
      }
      return {
        _tag: "Ambiguous",
        companyIds: matches.map((handle) => handle.companyId),
      } as const;
    });

  const withIssueEngine: CloudSyncEngineRegistryShape["withIssueEngine"] = (input, use) =>
    Effect.acquireUseRelease(
      registerIssueEngine(input),
      () => use,
      () => unregisterIssueEngine({ engine: input.engine }),
    );

  return CloudSyncEngineRegistry.of({
    registerIssueEngine,
    unregisterIssueEngine,
    withIssueEngine,
    issueEngine,
    issueEngineForProject,
  });
});

export const cloudSyncEngineRegistryLayer = Layer.effect(
  CloudSyncEngineRegistry,
  makeCloudSyncEngineRegistry,
);
