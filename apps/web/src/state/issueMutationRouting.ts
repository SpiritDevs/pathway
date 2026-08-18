/** Shared AtomCommand router for issue writes that have crossed to the cloud replica. */
import {
  settleAsyncResult,
  type AtomCommand,
  type AtomCommandResult,
  type AtomCommandConcurrency,
  type AtomCommandScheduler,
} from "@spiritdevs/client-runtime/state/runtime";
import {
  issueSyncOperationTarget,
  type IssueSyncOperation,
  type SyncEnqueueReceipt,
} from "@spiritdevs/client-runtime/sync";
import type { EnvironmentId } from "@spiritdevs/contracts";
import type { SyncEntityKind } from "@spiritdevs/contracts/cloudSync";
import type { CompanyId } from "@spiritdevs/contracts/company";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type { AtomRegistry } from "effect/unstable/reactivity";

import { activeCompanyIdAtom } from "../cloud/activeCompany";
import { companyRegistryReplicasAtom } from "../cloud/companyRegistryReplica";
import {
  issueDomainEntityCompanyIdsAtom,
  issueDomainEntityCompanyKey,
} from "../cloud/issueDomainReadModel";
import {
  IssueSyncUnavailableError,
  enqueueIssueOperation,
  type IssueDomainMutationError,
} from "../cloud/issueDomainMutations";
import { companySyncEngineHandlesAtom } from "../cloud/companySyncEngines";
import { cloudSyncTabStateAtom } from "../cloud/syncStatus";

export interface IssueMutationSyncPlan<A> {
  readonly operations: ReadonlyArray<IssueSyncOperation>;
  readonly result: (receipts: ReadonlyArray<SyncEnqueueReceipt>) => A;
}

export type IssueMutationRoutingErrorReason =
  | "ambiguous-company"
  | "missing-owner"
  | "cross-company-reference";

export class IssueMutationRoutingError extends Data.TaggedError("IssueMutationRoutingError")<{
  readonly reason: IssueMutationRoutingErrorReason;
  readonly message: string;
}> {}

interface IssueMutationRoutingOptions<I, A> {
  readonly scheduler: AtomCommandScheduler;
  readonly concurrency: AtomCommandConcurrency<{
    readonly environmentId: EnvironmentId;
    readonly input: I;
  }>;
  readonly useLegacy?: (input: I) => boolean;
  readonly plan: (input: I, registry: AtomRegistry.AtomRegistry) => IssueMutationSyncPlan<A>;
}

/**
 * Keeps the public command shape stable while choosing the same replica-presence boundary as reads.
 * Legacy commands retain their own scheduler and RPC execution unchanged; only the sync branch is
 * scheduled here. Every Effect failure is settled into the ordinary AtomCommand failure channel.
 */
export function routeIssueMutationCommand<I, A, E>(
  legacy: AtomCommand<{ readonly environmentId: EnvironmentId; readonly input: I }, A, E>,
  options: IssueMutationRoutingOptions<I, A>,
): AtomCommand<
  {
    readonly environmentId: EnvironmentId;
    readonly input: I;
    readonly targetCompanyId?: CompanyId;
  },
  A,
  E | IssueDomainMutationError | IssueMutationRoutingError
> {
  const routingFailure = (
    error: IssueMutationRoutingError,
  ): Promise<AtomCommandResult<A, IssueDomainMutationError | IssueMutationRoutingError>> =>
    settleAsyncResult(() => Effect.runPromiseExit(Effect.fail(error)));

  return {
    label: legacy.label,
    run: (registry, target) => {
      if (registry.get(companyRegistryReplicasAtom).size === 0) {
        return legacy.run(registry, target);
      }
      if (options.useLegacy?.(target.input)) {
        return registry.get(activeCompanyIdAtom) === null
          ? routingFailure(
              new IssueMutationRoutingError({
                reason: "ambiguous-company",
                message: "Choose a company before changing environment-owned issue fields.",
              }),
            )
          : legacy.run(registry, target);
      }

      const runSync = (): Promise<
        AtomCommandResult<A, IssueDomainMutationError | IssueMutationRoutingError>
      > => {
        const plan = options.plan(target.input, registry);
        const routed = routeIssueSyncOperations(
          plan.operations,
          registry,
          target.targetCompanyId ?? null,
        );
        if (routed instanceof IssueMutationRoutingError) return routingFailure(routed);
        const unavailable = preflightIssueSyncCompanies(routed, registry);
        if (unavailable !== null) {
          return settleAsyncResult(() => Effect.runPromiseExit(Effect.fail(unavailable)));
        }
        return settleAsyncResult(() =>
          Effect.runPromiseExit(
            Effect.forEach(
              routed,
              ({ companyId, operation }) =>
                enqueueIssueOperation({ companyId, operation }, registry),
              { concurrency: 1 },
            ).pipe(Effect.map(plan.result)),
          ),
        );
      };
      return options.scheduler.schedule(registry, options.concurrency, target, runSync);
    },
  };
}

interface RoutedIssueSyncOperation {
  readonly companyId: CompanyId;
  readonly operation: IssueSyncOperation;
}

type EntityReference = readonly [entityKind: SyncEntityKind, entityId: string];

const TOP_LEVEL_CREATE_KINDS = new Set<IssueSyncOperation["kind"]>([
  "issue.create",
  "issueStatus.create",
  "issueLabel.create",
  "issueCycle.create",
  "issueView.create",
]);

function operationReferences(operation: IssueSyncOperation): ReadonlyArray<EntityReference> {
  switch (operation.kind) {
    case "issue.create":
    case "issue.update": {
      const references: EntityReference[] = [];
      const args = operation.args;
      if (typeof args.statusId === "string") references.push(["issueStatus", args.statusId]);
      if (typeof args.projectId === "string") references.push(["cloudProject", args.projectId]);
      if (typeof args.milestoneId === "string")
        references.push(["issueMilestone", args.milestoneId]);
      if (typeof args.cycleId === "string") references.push(["issueCycle", args.cycleId]);
      if (typeof args.parentId === "string") references.push(["issue", args.parentId]);
      if (Array.isArray(args.labelIds)) {
        for (const labelId of args.labelIds) references.push(["issueLabel", labelId]);
      }
      if (args.assignee?.kind === "member")
        references.push(["membership", args.assignee.membershipId]);
      return references;
    }
    case "issue.setSortOrder":
      return typeof operation.args.statusId === "string"
        ? [["issueStatus", operation.args.statusId]]
        : [];
    case "issueStatus.create": {
      const references: EntityReference[] = [];
      if (typeof operation.args.teamId === "string")
        references.push(["team", operation.args.teamId]);
      if (typeof operation.args.baseStatusId === "string")
        references.push(["issueStatus", operation.args.baseStatusId]);
      return references;
    }
    case "issueStatus.delete":
      return [["issueStatus", operation.args.reassignToStatusId]];
    case "issueStatus.reorder":
      return operation.args.statusIds.map((id) => ["issueStatus", id]);
    case "issueLabel.create":
      return typeof operation.args.teamId === "string" ? [["team", operation.args.teamId]] : [];
    case "issueMilestone.create":
      return [["cloudProject", operation.args.cloudProjectId]];
    case "issueMilestone.update":
      return typeof operation.args.cloudProjectId === "string"
        ? [["cloudProject", operation.args.cloudProjectId]]
        : [];
    case "issueCycle.create":
      return typeof operation.args.teamId === "string" ? [["team", operation.args.teamId]] : [];
    case "issueTodo.create":
      return [["issue", operation.args.issueId]];
    case "issueRelation.create":
      return [
        ["issue", operation.args.issueId],
        ["issue", operation.args.relatedIssueId],
      ];
    case "issueComment.create":
      return [["issue", operation.args.issueId]];
    case "issueThreadLink.create":
      return [["issue", operation.args.issueId]];
    default:
      return [];
  }
}

function ownerOf(
  owners: ReadonlyMap<string, ReadonlySet<CompanyId>>,
  [entityKind, entityId]: EntityReference,
  preferredCompanyId: CompanyId | null,
): CompanyId | undefined {
  const companyIds = owners.get(issueDomainEntityCompanyKey(entityKind, entityId));
  if (companyIds === undefined || companyIds.size === 0) return undefined;
  if (preferredCompanyId !== null && companyIds.has(preferredCompanyId)) {
    return preferredCompanyId;
  }
  return companyIds.size === 1 ? companyIds.values().next().value : undefined;
}

function routeIssueSyncOperations(
  operations: ReadonlyArray<IssueSyncOperation>,
  registry: AtomRegistry.AtomRegistry,
  targetCompanyId: CompanyId | null,
): ReadonlyArray<RoutedIssueSyncOperation> | IssueMutationRoutingError {
  const activeCompanyId = registry.get(activeCompanyIdAtom);
  const preferredCompanyId = targetCompanyId ?? activeCompanyId;
  const owners = registry.get(issueDomainEntityCompanyIdsAtom);
  const routed: RoutedIssueSyncOperation[] = [];

  for (const operation of operations) {
    const references = operationReferences(operation);
    let companyId: CompanyId | undefined;

    if (TOP_LEVEL_CREATE_KINDS.has(operation.kind)) {
      companyId = preferredCompanyId ?? undefined;
      if (companyId === undefined) {
        return new IssueMutationRoutingError({
          reason: "ambiguous-company",
          message: "Choose a company before creating this issue item.",
        });
      }
    } else if (
      operation.kind === "issueMilestone.create" ||
      operation.kind === "issueTodo.create" ||
      operation.kind === "issueRelation.create" ||
      operation.kind === "issueComment.create" ||
      operation.kind === "issueThreadLink.create"
    ) {
      companyId =
        references[0] === undefined
          ? undefined
          : ownerOf(owners, references[0], preferredCompanyId);
    } else {
      const target = issueSyncOperationTarget(operation);
      companyId = ownerOf(owners, [target.entityKind, target.entityId], preferredCompanyId);
    }

    if (companyId === undefined) {
      return new IssueMutationRoutingError({
        reason: "missing-owner",
        message: `The company that owns ${operation.kind} could not be resolved.`,
      });
    }

    if (targetCompanyId !== null && companyId !== targetCompanyId) {
      return new IssueMutationRoutingError({
        reason: "cross-company-reference",
        message: "This issue setting belongs to a different company.",
      });
    }

    for (const reference of references) {
      const referenceCompanyId = ownerOf(owners, reference, companyId);
      if (referenceCompanyId === undefined) {
        return new IssueMutationRoutingError({
          reason: "missing-owner",
          message: `The company that owns ${reference[0]} ${reference[1]} could not be resolved.`,
        });
      }
      if (referenceCompanyId !== companyId) {
        return new IssueMutationRoutingError({
          reason: "cross-company-reference",
          message: "Issue relationships and workflow values must belong to the same company.",
        });
      }
    }

    routed.push({ companyId, operation });
  }

  return routed;
}

/** Checks every destination before the first enqueue so predictable bulk failures stay atomic. */
function preflightIssueSyncCompanies(
  routed: ReadonlyArray<RoutedIssueSyncOperation>,
  registry: AtomRegistry.AtomRegistry,
): IssueSyncUnavailableError | null {
  const role = registry.get(cloudSyncTabStateAtom).role;
  const handles = registry.get(companySyncEngineHandlesAtom);
  for (const companyId of new Set(routed.map((item) => item.companyId))) {
    if (role !== "leader") {
      return new IssueSyncUnavailableError({
        companyId,
        reason: "not-leader",
        message: "This tab is not the cloud-sync leader, so it cannot enqueue issue changes.",
      });
    }
    if (!handles.has(companyId)) {
      return new IssueSyncUnavailableError({
        companyId,
        reason: "no-engine",
        message: "No running cloud-sync engine is available for this company.",
      });
    }
  }
  return null;
}

/** Most routed consumers only inspect success/failure; preserve the type while returning evidence. */
export const receiptMappedResult = <A>(receipts: ReadonlyArray<SyncEnqueueReceipt>): A =>
  (receipts.length === 1 ? receipts[0] : receipts) as A;
