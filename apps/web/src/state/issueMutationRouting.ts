/** Shared AtomCommand router for issue writes that have crossed to the cloud replica. */
import {
  settleAsyncResult,
  type AtomCommand,
  type AtomCommandConcurrency,
  type AtomCommandScheduler,
} from "@spiritdevs/client-runtime/state/runtime";
import type { IssueSyncOperation, SyncEnqueueReceipt } from "@spiritdevs/client-runtime/sync";
import type { EnvironmentId } from "@spiritdevs/contracts";
import * as Effect from "effect/Effect";
import type { AtomRegistry } from "effect/unstable/reactivity";

import { activeCompanyReplicaRoutingAtom } from "../cloud/activeCompany";
import {
  enqueueIssueOperation,
  type IssueDomainMutationError,
} from "../cloud/issueDomainMutations";

export interface IssueMutationSyncPlan<A> {
  readonly operations: ReadonlyArray<IssueSyncOperation>;
  readonly result: (receipts: ReadonlyArray<SyncEnqueueReceipt>) => A;
}

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
  { readonly environmentId: EnvironmentId; readonly input: I },
  A,
  E | IssueDomainMutationError
> {
  return {
    label: legacy.label,
    run: (registry, target) => {
      const companyId = registry.get(activeCompanyReplicaRoutingAtom);
      if (companyId === null || options.useLegacy?.(target.input) === true) {
        return legacy.run(registry, target);
      }

      return options.scheduler.schedule(registry, options.concurrency, target, () => {
        const plan = options.plan(target.input, registry);
        return settleAsyncResult(() =>
          Effect.runPromiseExit(
            Effect.forEach(
              plan.operations,
              (operation) => enqueueIssueOperation({ companyId, operation }, registry),
              { concurrency: 1 },
            ).pipe(Effect.map(plan.result)),
          ),
        );
      });
    },
  };
}

/** Most routed consumers only inspect success/failure; preserve the type while returning evidence. */
export const receiptMappedResult = <A>(receipts: ReadonlyArray<SyncEnqueueReceipt>): A =>
  (receipts.length === 1 ? receipts[0] : receipts) as A;
