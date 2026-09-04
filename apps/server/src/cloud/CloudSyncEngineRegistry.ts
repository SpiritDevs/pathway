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
import type { CloudProjectId } from "@spiritdevs/contracts/cloudProject";
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

export interface CloudIssueAttachmentUrl {
  readonly attachmentId: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly url: string;
}

export interface CloudIssueAttachmentResolver {
  readonly resolveIssueAttachmentUrls: (input: {
    readonly companyId: string;
    readonly issueId: string;
    readonly attachmentIds: ReadonlyArray<string>;
  }) => Effect.Effect<ReadonlyArray<CloudIssueAttachmentUrl>, { readonly message: string }>;
}

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
  /** One atomic view of the current optimistic issue model and its completeness gates. */
  readonly readIssueSnapshot: Effect.Effect<{
    readonly readModel: SyncedIssueDomainReadModel;
    readonly bootstrapped: boolean;
    readonly quarantined: number;
  }>;
  readonly resolveIssueAttachmentUrls?:
    | CloudIssueAttachmentResolver["resolveIssueAttachmentUrls"]
    | undefined;
}

export interface CloudSyncIssueProjectBinding {
  readonly localProjectId: ProjectId;
  readonly cloudProjectId: CloudProjectId;
}

export type CloudSyncIssueEngineRoute =
  | { readonly _tag: "Legacy" }
  | { readonly _tag: "Unbound"; readonly companyIds: ReadonlyArray<CompanyId> }
  | { readonly _tag: "Ambiguous"; readonly companyIds: ReadonlyArray<CompanyId> }
  | { readonly _tag: "Unavailable"; readonly companyIds: ReadonlyArray<CompanyId> }
  | {
      readonly _tag: "Ready";
      readonly engine: CloudSyncIssueEngineHandle;
      readonly readModel: SyncedIssueDomainReadModel;
      readonly projectBindings: ReadonlyArray<CloudSyncIssueProjectBinding>;
    };

export interface CloudSyncEngineRegistryShape {
  /** Records that this environment is configured for cloud sync, even before an engine starts. */
  readonly expectIssueRouting: (environmentId: EnvironmentId) => Effect.Effect<void>;
  readonly registerIssueEngine: (input: {
    readonly environmentId: EnvironmentId;
    readonly engine: SyncEngine<CloudSyncEntity, IssueSyncOperation>;
    readonly resolveIssueAttachmentUrls?:
      | CloudIssueAttachmentResolver["resolveIssueAttachmentUrls"]
      | undefined;
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
      readonly resolveIssueAttachmentUrls?:
        | CloudIssueAttachmentResolver["resolveIssueAttachmentUrls"]
        | undefined;
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
  const expectedEnvironments = yield* Ref.make<ReadonlySet<EnvironmentId>>(new Set());

  const expectIssueRouting: CloudSyncEngineRegistryShape["expectIssueRouting"] = (environmentId) =>
    Ref.update(expectedEnvironments, (expected) => new Set(expected).add(environmentId));

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
        readIssueSnapshot: SubscriptionRef.get(input.engine.state).pipe(
          Effect.map((state) => ({
            readModel: syncedIssueDomainFromEntities(state.view.values()),
            bootstrapped: state.bootstrapped,
            quarantined: state.quarantined.length,
          })),
        ),
        ...(input.resolveIssueAttachmentUrls === undefined
          ? {}
          : { resolveIssueAttachmentUrls: input.resolveIssueAttachmentUrls }),
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
      if (registered.length === 0) {
        const expected = yield* Ref.get(expectedEnvironments);
        return expected.has(input.environmentId)
          ? ({ _tag: "Unavailable", companyIds: [] } as const)
          : ({ _tag: "Legacy" } as const);
      }

      const matches: Array<Extract<CloudSyncIssueEngineRoute, { readonly _tag: "Ready" }>> = [];
      const unavailable: CompanyId[] = [];
      for (const { handle } of registered) {
        const snapshot = yield* handle.readIssueSnapshot;
        if (!snapshot.bootstrapped || snapshot.quarantined > 0) {
          unavailable.push(handle.companyId);
          continue;
        }
        const latestByLocalProject = new Map<
          ProjectId,
          (typeof snapshot.readModel.environmentBindings)[number]
        >();
        for (const binding of snapshot.readModel.environmentBindings) {
          if (binding.environmentId !== input.environmentId) continue;
          const existing = latestByLocalProject.get(binding.localProjectId);
          if (existing === undefined || binding.updatedAt > existing.updatedAt) {
            latestByLocalProject.set(binding.localProjectId, binding);
          }
        }
        const projectBindings = [...latestByLocalProject.values()]
          .filter((binding) => binding.status === "active")
          .map(
            (binding): CloudSyncIssueProjectBinding => ({
              localProjectId: binding.localProjectId,
              cloudProjectId: binding.cloudProjectId,
            }),
          );
        const bound = projectBindings.some(
          (binding) => binding.localProjectId === input.localProjectId,
        );
        if (bound) {
          matches.push({
            _tag: "Ready",
            engine: handle,
            readModel: snapshot.readModel,
            projectBindings,
          });
        }
      }
      if (unavailable.length > 0) {
        return { _tag: "Unavailable", companyIds: unavailable } as const;
      }
      if (matches.length === 1) return matches[0]!;
      if (matches.length === 0) {
        return {
          _tag: "Unbound",
          companyIds: registered.map(({ handle }) => handle.companyId),
        } as const;
      }
      return {
        _tag: "Ambiguous",
        companyIds: matches.map(({ engine }) => engine.companyId),
      } as const;
    });

  const withIssueEngine: CloudSyncEngineRegistryShape["withIssueEngine"] = (input, use) =>
    Effect.acquireUseRelease(
      registerIssueEngine(input),
      () => use,
      () => unregisterIssueEngine({ engine: input.engine }),
    );

  return CloudSyncEngineRegistry.of({
    expectIssueRouting,
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
