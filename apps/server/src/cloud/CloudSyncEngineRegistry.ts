/**
 * Process-local access to the one cloud-sync engine owned by the daemon.
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
  readonly issueEngine: (companyId: CompanyId) => Effect.Effect<CloudSyncIssueEngineHandle | null>;
}

export class CloudSyncEngineRegistry extends Context.Service<
  CloudSyncEngineRegistry,
  CloudSyncEngineRegistryShape
>()("@spiritdevs/pathway/cloud/CloudSyncEngineRegistry") {}

export const makeCloudSyncEngineRegistry = Effect.gen(function* () {
  const current = yield* Ref.make<CloudSyncIssueEngineHandle | null>(null);

  const registerIssueEngine: CloudSyncEngineRegistryShape["registerIssueEngine"] = (input) =>
    Ref.set(current, {
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
    });

  const issueEngine: CloudSyncEngineRegistryShape["issueEngine"] = (companyId) =>
    Ref.get(current).pipe(
      Effect.map((handle) => (handle?.companyId === companyId ? handle : null)),
    );

  return CloudSyncEngineRegistry.of({ registerIssueEngine, issueEngine });
});

export const cloudSyncEngineRegistryLayer = Layer.effect(
  CloudSyncEngineRegistry,
  makeCloudSyncEngineRegistry,
);
