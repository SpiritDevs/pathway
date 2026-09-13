import { CommandId, MessageId, ProviderDriverKind } from "@spiritdevs/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { ProjectionStoreV2 } from "../orchestration-v2/ProjectionStore.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import { forkParked } from "../serverActivation.ts";
import { ProviderAllowanceRuntime } from "./AllowanceRuntime.ts";
import { canResumeAllowance } from "./allowanceResumePolicy.ts";

export const reconcileAllowanceHolds = Effect.fn("AllowanceResume.reconcile")(function* () {
  const store = yield* ProjectionStoreV2;
  const threads = yield* ThreadManagementService;
  const allowance = yield* ProviderAllowanceRuntime;
  const instances = yield* (yield* ProviderInstanceRegistry).listInstances;
  for (const threadId of yield* store.getAllowanceHeldThreadIds()) {
    yield* Effect.gen(function* () {
      const projection = yield* store.getThreadProjection(threadId);
      const run = projection.runs.toSorted((a, b) => b.ordinal - a.ordinal)[0];
      if (!run || !canResumeAllowance(projection, run.id)) return;
      const instance = instances.find((item) => item.instanceId === run.modelSelection.instanceId);
      if (!instance) return;
      const state = yield* allowance.checkThread(
        threadId,
        instance.instanceId,
        ProviderDriverKind.make(instance.driverKind),
      );
      if (!state.canStart) return;
      // The command rechecks this candidate under the same lock as user messages, and its receipt is durable.
      yield* threads.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`allowance-resume:${run.id}`),
        threadId,
        messageId: MessageId.make(`allowance-resume:${run.id}`),
        allowanceResumeOfRunId: run.id,
        dispatchMode: { type: "start_immediately" },
        text: "Your provider allowance is available under the user's current allocation. Continue the unfinished assignment from retained progress and partial results. Check what already completed before doing more work. All existing instructions and limits still apply.",
        attachments: [],
        modelSelection: run.modelSelection,
        createdBy: "system",
        creationSource: "server",
      });
    }).pipe(Effect.catch(() => Effect.void));
  }
});

export const layer = Layer.effectDiscard(
  forkParked(
    reconcileAllowanceHolds().pipe(
      Effect.catch(() => Effect.void),
      Effect.repeat(Schedule.spaced("20 seconds")),
    ),
  ),
);
