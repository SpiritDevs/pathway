/**
 * Typed issue-domain writes into the leader tab's durable sync outbox.
 *
 * Callers build an operation with `issueSyncOperation`, then this layer chooses the active engine,
 * mints the protocol operation id, and returns the engine's accepted/deduplicated receipt. It does
 * not expose transport or engine lifecycle controls.
 *
 * @module cloud/issueDomainMutations
 */
import {
  type IssueSyncOperationKind,
  type IssueSyncOperationOf,
  type SyncEnqueueReceipt,
  type SyncStoreError,
} from "@spiritdevs/client-runtime/sync";
import { settleAsyncResult, type AtomCommand } from "@spiritdevs/client-runtime/state/runtime";
import { SyncOperationId } from "@spiritdevs/contracts/cloudSync";
import type { CompanyId } from "@spiritdevs/contracts/company";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { AtomRegistry } from "effect/unstable/reactivity";

import { randomUUID } from "../lib/utils";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useAtomCommand } from "../state/use-atom-command";
import { companySyncEngineHandlesAtom } from "./companySyncEngines";
import { cloudSyncTabStateAtom } from "./syncStatus";

export type IssueSyncUnavailableReason = "no-engine" | "not-leader";

export class IssueSyncUnavailableError extends Data.TaggedError("IssueSyncUnavailableError")<{
  readonly companyId: CompanyId;
  readonly reason: IssueSyncUnavailableReason;
  readonly message: string;
}> {}

export interface EnqueueIssueOperationInput<
  K extends IssueSyncOperationKind = IssueSyncOperationKind,
> {
  readonly companyId: CompanyId;
  readonly operation: IssueSyncOperationOf<K>;
  /** Keep this id when retrying the same user intent; omit it for a newly authored operation. */
  readonly operationId?: SyncOperationId;
}

export type IssueDomainMutationError = IssueSyncUnavailableError | SyncStoreError;

function unavailableError(
  registry: AtomRegistry.AtomRegistry,
  companyId: CompanyId,
): IssueSyncUnavailableError {
  const reason: IssueSyncUnavailableReason =
    registry.get(cloudSyncTabStateAtom).role === "follower" ? "not-leader" : "no-engine";
  return new IssueSyncUnavailableError({
    companyId,
    reason,
    message:
      reason === "not-leader"
        ? "This tab is not the cloud-sync leader, so it cannot enqueue issue changes."
        : "No running cloud-sync engine is available for this company.",
  });
}

/** Enqueues one typed operation in the named company's running leader-tab engine. */
export function enqueueIssueOperation<K extends IssueSyncOperationKind>(
  input: EnqueueIssueOperationInput<K>,
  registry: AtomRegistry.AtomRegistry = appAtomRegistry,
): Effect.Effect<SyncEnqueueReceipt, IssueDomainMutationError> {
  if (registry.get(cloudSyncTabStateAtom).role !== "leader") {
    return Effect.fail(unavailableError(registry, input.companyId));
  }
  const handle = registry.get(companySyncEngineHandlesAtom).get(input.companyId);
  if (handle === undefined) return Effect.fail(unavailableError(registry, input.companyId));

  const operationId = input.operationId ?? SyncOperationId.make(randomUUID());
  return handle.enqueue({
    operationId,
    operation: input.operation,
    ...(input.operation.dependsOn === undefined ? {} : { dependsOn: input.operation.dependsOn }),
  });
}

export const enqueueIssueOperationCommand: AtomCommand<
  EnqueueIssueOperationInput,
  SyncEnqueueReceipt,
  IssueDomainMutationError
> = {
  label: "cloud-sync:issue-domain:enqueue",
  run: (registry, input) =>
    settleAsyncResult(() => Effect.runPromiseExit(enqueueIssueOperation(input, registry))),
};

/** React command hook returning the usual settled `AsyncResult` promise. */
export const useEnqueueIssueOperation = () =>
  useAtomCommand(enqueueIssueOperationCommand, {
    reportFailure: false,
    reportDefect: true,
  });
