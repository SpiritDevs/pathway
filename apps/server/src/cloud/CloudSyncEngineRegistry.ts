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
  SyncCycleReceipt,
  SyncEngine,
  SyncEnqueueReceipt,
  SyncStoreError,
} from "@spiritdevs/client-runtime/sync";
import type { EnvironmentId } from "@spiritdevs/contracts";
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
}

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
  });
});

export const cloudSyncEngineRegistryLayer = Layer.effect(
  CloudSyncEngineRegistry,
  makeCloudSyncEngineRegistry,
);
