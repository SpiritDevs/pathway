import * as DateTime from "effect/DateTime";

import type { GitRunStackedActionResult } from "./git.ts";
import type { OrchestrationV2ThreadShell } from "./orchestrationV2.ts";

export const PUSH_AUTO_SETTLE_DELAY_MS = 10_000;

type PushAutoSettlementThread = Pick<
  OrchestrationV2ThreadShell,
  | "activeRunId"
  | "activityRunStatus"
  | "archivedAt"
  | "deletedAt"
  | "hasActionableProposedPlan"
  | "itemCount"
  | "latestRunCompletedAt"
  | "latestRunId"
  | "latestRunRequestedAt"
  | "latestRunStartedAt"
  | "latestUserMessageAt"
  | "latestVisibleMessage"
  | "pendingRuntimeRequest"
  | "pinnedAt"
  | "settledOverride"
  | "snoozedUntil"
  | "status"
  | "visibleItemCount"
>;

const instantMillis = (value: DateTime.Utc | null | undefined): number | null =>
  value === null || value === undefined ? null : DateTime.toEpochMillis(value);

/**
 * The thread state that counts as resumed work during the post-push grace
 * period. Deliberately excludes metadata and read-state fields: syncing the
 * branch or marking the open thread visited must not cancel settlement.
 */
export function pushAutoSettlementActivityKey(thread: PushAutoSettlementThread): string {
  return JSON.stringify({
    activeRunId: thread.activeRunId,
    activityRunStatus: thread.activityRunStatus ?? null,
    status: thread.status,
    latestRunId: thread.latestRunId,
    latestRunRequestedAt: instantMillis(thread.latestRunRequestedAt),
    latestRunStartedAt: instantMillis(thread.latestRunStartedAt),
    latestRunCompletedAt: instantMillis(thread.latestRunCompletedAt),
    latestUserMessageAt: instantMillis(thread.latestUserMessageAt),
    pendingRuntimeRequest:
      thread.pendingRuntimeRequest === null
        ? null
        : {
            id: thread.pendingRuntimeRequest.id,
            kind: thread.pendingRuntimeRequest.kind,
            createdAt: instantMillis(thread.pendingRuntimeRequest.createdAt),
          },
    latestVisibleMessage:
      thread.latestVisibleMessage === null
        ? null
        : {
            id: thread.latestVisibleMessage.id,
            role: thread.latestVisibleMessage.role,
            text: thread.latestVisibleMessage.text,
            updatedAt: instantMillis(thread.latestVisibleMessage.updatedAt),
          },
    itemCount: thread.itemCount,
    visibleItemCount: thread.visibleItemCount,
    hasActionableProposedPlan: thread.hasActionableProposedPlan,
    settledOverride: thread.settledOverride,
    snoozedUntil: instantMillis(thread.snoozedUntil),
    pinnedAt: instantMillis(thread.pinnedAt),
    archivedAt: instantMillis(thread.archivedAt),
    deletedAt: instantMillis(thread.deletedAt),
  });
}

export function canStartPushAutoSettlement(thread: PushAutoSettlementThread): boolean {
  return (
    thread.activeRunId === null &&
    thread.activityRunStatus == null &&
    thread.pendingRuntimeRequest === null &&
    thread.settledOverride === null &&
    thread.snoozedUntil == null &&
    thread.pinnedAt == null &&
    thread.archivedAt === null &&
    thread.deletedAt === null
  );
}

export function shouldStartPushAutoSettlement(result: GitRunStackedActionResult): boolean {
  return result.push.status === "pushed";
}

export function pushAutoSettlementStillEligible(
  activityKey: string,
  thread: PushAutoSettlementThread,
): boolean {
  return (
    canStartPushAutoSettlement(thread) && pushAutoSettlementActivityKey(thread) === activityKey
  );
}
