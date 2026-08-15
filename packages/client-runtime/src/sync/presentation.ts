/**
 * Sync status as the UI shows it.
 *
 * Pure, like `connection/presentation.ts`: the engine reports a phase and counts, this decides
 * which of the six user-visible statuses that is. Precedence is deliberate —
 * `initializing → error → offline → blocked → syncing → live` — because a user who is offline
 * with blocked work needs the actionable problem, not a spinner that lies.
 *
 * @module sync/presentation
 */
import type { SyncPresentation } from "@spiritdevs/contracts/cloudSync";

import type { PendingSyncOperation } from "./model.ts";
import type { SyncTransportError } from "./transport.ts";

/**
 * Where the engine is, mechanically. Not a wire shape: the contract's `SyncStatus` is what a user
 * sees, and this is the internal state it is derived from.
 */
export type SyncPhase = "initializing" | "ready" | "syncing" | "disconnected" | "failed";

export function presentSyncState(input: {
  readonly phase: SyncPhase;
  readonly pending: ReadonlyArray<PendingSyncOperation<unknown>>;
  readonly rejectedCount: number;
  readonly error: SyncTransportError | null;
}): SyncPresentation {
  const blocked = input.pending.filter((entry) => entry.status._tag === "Blocked");
  const counts = {
    pendingCount: input.pending.length,
    blockedCount: blocked.length,
    rejectedCount: input.rejectedCount,
  };
  const firstBlockedReason =
    blocked[0]?.status._tag === "Blocked" ? blocked[0].status.reason : null;

  if (input.phase === "initializing") {
    return { status: "initializing", ...counts, reason: null };
  }
  if (input.phase === "failed") {
    return { status: "error", ...counts, reason: input.error?.message ?? null };
  }
  if (input.phase === "disconnected") {
    return { status: "offline", ...counts, reason: input.error?.message ?? null };
  }
  if (blocked.length > 0) {
    return { status: "blocked", ...counts, reason: firstBlockedReason };
  }
  if (input.phase === "syncing" || counts.pendingCount > 0) {
    return { status: "syncing", ...counts, reason: null };
  }
  return { status: "live", ...counts, reason: null };
}

export function syncStatusText(presentation: SyncPresentation): string {
  switch (presentation.status) {
    case "initializing":
      return "Preparing local data...";
    case "live":
      return "Up to date";
    case "offline":
      return presentation.pendingCount > 0
        ? `Offline. ${presentation.pendingCount} change${presentation.pendingCount === 1 ? "" : "s"} waiting to sync`
        : "Offline";
    case "syncing":
      return presentation.pendingCount > 0
        ? `Syncing ${presentation.pendingCount} change${presentation.pendingCount === 1 ? "" : "s"}...`
        : "Syncing...";
    case "blocked":
      return presentation.reason ?? "Some changes cannot be applied";
    case "error":
      return presentation.reason ?? "Sync failed";
  }
}
