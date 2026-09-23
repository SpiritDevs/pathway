import type {
  OrchestrationV2Run,
  OrchestrationV2Subagent,
  OrchestrationV2ThreadProjection,
  RunId,
  ThreadId,
} from "@spiritdevs/contracts";
import { isUsageLimitFailure, parseUsageLimitResetAt } from "@spiritdevs/shared/usageLimitRecovery";
import * as DateTime from "effect/DateTime";

export const RECOVERY_DELAY_MS = 60_000;
export const RECOVERY_MAX_ATTEMPTS = 3;
export const recoveryLatestRun = (projection: OrchestrationV2ThreadProjection) =>
  projection.runs.toSorted((a, b) => b.ordinal - a.ordinal)[0];

export function usageFailureForRun(projection: OrchestrationV2ThreadProjection, runId: RunId) {
  return projection.turnItems.findLast(
    (item) => item.type === "error" && item.runId === runId && isUsageLimitFailure(item.failure),
  );
}

export function isUsageLimitText(message: string) {
  return isUsageLimitFailure({ class: "provider_error", code: null, message, retryable: null });
}

/** Checked inside the thread's dispatch lock as well as by the scheduler. */
export function canResumeUsageRecovery(projection: OrchestrationV2ThreadProjection, runId: RunId) {
  const latest = recoveryLatestRun(projection);
  return (
    projection.thread.deletedAt === null &&
    projection.thread.archivedAt === null &&
    projection.thread.snoozedUntil == null &&
    latest?.id === runId &&
    (latest.status === "failed" || latest.status === "completed") &&
    !projection.runs.some((run) =>
      ["queued", "preparing", "starting", "running", "waiting"].includes(run.status),
    )
  );
}

export function recoveryRetryAt(
  messages: ReadonlyArray<{ text: string; at: number }>,
  now: number,
) {
  // Relative resets and clock dates are anchored to the error, never to the time a client opens it.
  const reported = messages.flatMap(({ text, at }) => {
    const reset = parseUsageLimitResetAt(text, at);
    return reset === null ? [] : [Date.parse(reset) + RECOVERY_DELAY_MS];
  });
  return DateTime.formatIso(DateTime.makeUnsafe(Math.max(now + RECOVERY_DELAY_MS, ...reported)));
}

/** When a child's usage-limit failure happened; later bookkeeping can bump `updatedAt`. */
export function childFailedAt(task: OrchestrationV2Subagent) {
  return DateTime.toEpochMillis(task.completedAt ?? task.updatedAt);
}

/**
 * Delegated tasks track only their spawn run. When a child thread is resumed in place,
 * its newest run is the child's real state, so a stale failure no longer blocks recovery.
 */
export function resumedChildTask(
  task: OrchestrationV2Subagent,
  child: OrchestrationV2ThreadProjection,
): OrchestrationV2Subagent {
  const run = recoveryLatestRun(child);
  if (
    !run ||
    task.completedAt === null ||
    DateTime.toEpochMillis(run.requestedAt) <= DateTime.toEpochMillis(task.completedAt)
  )
    return task;
  const error = child.turnItems.findLast((item) => item.type === "error" && item.runId === run.id);
  const working = runIsWorking(run);
  return {
    ...task,
    status:
      run.status === "completed" || run.status === "failed" || run.status === "interrupted"
        ? run.status
        : working
          ? "running"
          : "cancelled",
    result: error?.type === "error" ? error.failure.message : null,
    completedAt: working ? null : run.completedAt,
    updatedAt: run.completedAt ?? run.requestedAt,
  };
}

export type RecoveryChild = {
  readonly ownerThreadId: ThreadId;
  readonly task: OrchestrationV2Subagent;
  readonly nativeThreadId?: string | null;
};

export function recoveryMarker(recoveryId: string, taskId: string) {
  return `[usage-recovery:${recoveryId}:${taskId}]`;
}

export function recoveryPrompt(input: {
  readonly recoveryId: string;
  readonly attempt: number;
  readonly children: ReadonlyArray<RecoveryChild>;
}) {
  const manifest = input.children.map(({ ownerThreadId, task, nativeThreadId }) => ({
    parentThreadId: ownerThreadId,
    taskId: task.id,
    nativeTaskId: task.driver === "claudeAgent" ? (task.nativeTaskRef?.nativeId ?? null) : null,
    nativeThreadId: nativeThreadId ?? null,
    childThreadId: task.childThreadId,
    provider: task.driver,
    title: task.title,
    status: task.status,
    originalTask: task.prompt,
    lastResult: task.result,
    replacementMarker: recoveryMarker(input.recoveryId, task.id),
  }));
  return [
    `[Usage allowance recovery: attempt ${input.attempt} of ${RECOVERY_MAX_ATTEMPTS}]`,
    "The user scheduled this thread and its unfinished children to continue after the provider allowance reset.",
    "Continue the previous work, preserve completed changes, and avoid repeating completed steps.",
    "Recover ALL unfinished children listed below, including nested children. These are observed statuses, not a claim that the children have already restarted.",
    "Use the provider's resume or send-message tools to reactivate failed or interrupted children with their original task and context. Leave running/waiting children running and completed children complete. For nested children, instruct their immediate parent to resume them.",
    "If an old child cannot resume, launch a replacement with its original task and available progress. Include that child's replacementMarker verbatim in the replacement's task prompt so Pathway can track its recovery. Do not launch a replacement while the original is running.",
    "Check each child's actual activation and result, report which children restarted, and handle their failures. If usage is still exhausted, stop and let the recovery timer retry; do not repeatedly call the exhausted provider. Otherwise resume or replace failed children as needed and continue coordinating until the work is complete.",
    "Child recovery manifest:",
    JSON.stringify(manifest, null, 2),
  ].join("\n\n");
}

export function runIsWorking(run: OrchestrationV2Run) {
  return ["queued", "preparing", "starting", "running", "waiting"].includes(run.status);
}
