import {
  CommandId,
  type OrchestrationV2ThreadProjection,
  type RunId,
  type ThreadId,
} from "@spiritdevs/contracts";
import * as Effect from "effect/Effect";
import type { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";

const terminal = (status: string) =>
  ["completed", "failed", "cancelled", "interrupted", "rolled_back"].includes(status);
export function ownedStopPlan(projection: OrchestrationV2ThreadProjection, runId: RunId) {
  const run = projection.runs.find((run) => run.id === runId);
  const children = projection.subagents.filter((task) => task.runId === runId);
  return {
    run,
    pending: !run || !terminal(run.status) || children.some((task) => !terminal(task.status)),
    children,
  };
}

/** Follow only subagent edges belonging to the addressed run, never every run in a reused thread. */
export const reconcileOwnedStop = Effect.fn("cloud.conversation.reconcileStop")(function* (
  threads: Pick<ThreadManagementService["Service"], "dispatch" | "getThreadProjection">,
  root: OrchestrationV2ThreadProjection,
  operationId: string,
  messageId?: string,
  knownRunId?: string,
) {
  const first = root.messages.find((message) => message.role === "user");
  const rootRun = knownRunId
    ? root.runs.find((run) => run.id === knownRunId)?.id
    : (messageId ? root.messages.find((message) => message.id === messageId) : first)?.runId;
  if (!rootRun)
    return {
      confirmed: false,
      detail: "Waiting to identify the assignment run; no unrelated run was interrupted.",
    };
  const pending: { thread: OrchestrationV2ThreadProjection; runId: RunId }[] = [
    { thread: root, runId: rootRun },
  ];
  const seen = new Set<string>();
  let confirmed = true;
  let nativePending = false;
  while (pending.length) {
    const next = pending.pop()!;
    const key = next.thread.thread.id + ":" + next.runId;
    if (seen.has(key)) {
      confirmed = false;
      continue;
    }
    seen.add(key);
    const plan = ownedStopPlan(next.thread, next.runId);
    if (plan.pending) confirmed = false;
    const openWake =
      plan.run &&
      (plan.run.delegatedCompletion?.disposition === "open" ||
        (!plan.run.delegatedCompletion &&
          plan.children.some((task) => task.origin === "app_owned")));
    if (openWake) confirmed = false;
    if (plan.run && (!terminal(plan.run.status) || openWake)) {
      yield* threads.dispatch({
        type: plan.run.status === "queued" ? "queued-run.cancel" : "run.interrupt",
        commandId: CommandId.make(operationId + ":" + key),
        threadId: next.thread.thread.id,
        runId: next.runId,
      });
    }
    for (const message of next.thread.messages) {
      if (
        message.delegatedCompletion?.parentRunId === next.runId &&
        message.runId &&
        message.runId !== next.runId
      )
        pending.push({ thread: next.thread, runId: message.runId });
    }
    for (const task of plan.children) {
      if (task.childThreadId) {
        const child = yield* threads.getThreadProjection(task.childThreadId as ThreadId);
        const childRun = child.messages.find((message) => message.role === "user")?.runId;
        if (child.thread.lineage.parentThreadId !== next.thread.thread.id || !childRun) {
          confirmed = false;
          continue;
        }
        pending.push({ thread: child, runId: childRun });
      } else if (task.origin === "provider_native" && task.status !== "completed") {
        // Interrupted task rows may be synthetic cascade projections, not provider receipts.
        nativePending = true;
        confirmed = false;
      } else if (!terminal(task.status)) {
        nativePending = true;
        confirmed = false;
      }
    }
  }
  return {
    confirmed,
    detail: confirmed
      ? "Owned runs and known descendants are terminal."
      : nativePending
        ? "Stop requested; waiting for provider-native subagent termination evidence."
        : "Stop requested; waiting for owned runs and descendants to become terminal.",
  };
});
