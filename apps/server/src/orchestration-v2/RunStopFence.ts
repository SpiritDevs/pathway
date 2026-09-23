import type { RunId, ThreadId } from "@spiritdevs/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

/**
 * Work a run started outside its provider, which must end with the run — today
 * its Computer calls. The orchestrator calls `stopRun` on Stop before it writes
 * the run interrupted, and again when any run ends. The owner fences the run at
 * once, so nothing new dispatches for it, and returns once the run's work has
 * drained, bounded. The default owns no such work.
 */
export class RunStopFence extends Context.Reference<{
  readonly stopRun: (input: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
  }) => Effect.Effect<void>;
}>("@spiritdevs/pathway/orchestration-v2/RunStopFence", {
  defaultValue: () => ({ stopRun: () => Effect.void }),
}) {}
