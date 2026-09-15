import type { OrchestratorAssignmentOrigin } from "@spiritdevs/contracts/aiOrchestrator";
import { type ThreadId, type OrchestrationV2ThreadProjection } from "@spiritdevs/contracts";
import * as Effect from "effect/Effect";

/** Carry the parent run that owns a child, rather than a different run now active on its parent. */
export function executionOrigin<E, R>(
  get: (threadId: ThreadId) => Effect.Effect<OrchestrationV2ThreadProjection | null, E, R>,
  threadId: ThreadId,
  origin: OrchestratorAssignmentOrigin,
) {
  return Effect.gen(function* () {
    let projection = yield* get(threadId);
    let runId =
      projection?.runs.find((run) =>
        ["preparing", "starting", "running", "waiting"].includes(run.status),
      )?.id ?? projection?.runs.find((run) => run.status === "queued")?.id;
    const seen = new Set<string>();
    while (projection && !seen.has(projection.thread.id) && seen.size < 32) {
      seen.add(projection.thread.id);
      if (projection.thread.lineage.parentThreadId) {
        const parent = yield* get(projection.thread.lineage.parentThreadId);
        const task = parent?.subagents.find((task) => task.childThreadId === projection!.thread.id);
        if (!task?.runId || !parent) return origin;
        runId = task.runId;
        projection = parent;
        continue;
      }
      let message = projection.messages.find(
        (message) => message.runId === runId && message.role === "user",
      );
      const wakes = new Set<string>();
      while (message?.delegatedCompletion && !wakes.has(message.id)) {
        wakes.add(message.id);
        runId = message.delegatedCompletion.parentRunId;
        message = projection.messages.find(
          (message) => message.runId === runId && message.role === "user",
        );
      }
      if (!runId || !message) return origin;
      return {
        ...origin,
        execution: { threadId: projection.thread.id, runId, messageId: message.id },
      };
    }
    return origin;
  });
}
