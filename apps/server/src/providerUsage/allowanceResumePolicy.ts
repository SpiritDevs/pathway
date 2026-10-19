import type { OrchestrationV2ThreadProjection, RunId } from "@spiritdevs/contracts";

/** A newer request, archive, snooze, or manual interruption supersedes this continuation. */
export function canResumeAllowance(projection: OrchestrationV2ThreadProjection, runId: RunId) {
  const latest = projection.runs.toSorted((a, b) => b.ordinal - a.ordinal)[0];
  return (
    projection.thread.deletedAt === null &&
    projection.thread.archivedAt === null &&
    projection.thread.snoozedUntil == null &&
    latest?.id === runId &&
    !!latest.allowanceHold &&
    ["interrupted", "completed"].includes(latest.status)
  );
}
