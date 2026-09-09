import type { StoragePolicy, StoragePressure } from "@spiritdevs/contracts";

export function storagePressure(
  available: number,
  total: number,
  policy: StoragePolicy,
): StoragePressure {
  if (!Number.isFinite(available) || !Number.isFinite(total) || total <= 0 || available < 0)
    return "unknown";
  const percent = (available / total) * 100;
  if (available <= policy.criticalBytes || percent <= policy.criticalPercent) return "critical";
  if (available <= policy.warningBytes || percent <= policy.warningPercent) return "warning";
  return "healthy";
}

export function validateStoragePolicy(policy: StoragePolicy): void {
  if (policy.criticalBytes > policy.warningBytes || policy.criticalPercent > policy.warningPercent)
    throw new Error("Critical limits must not exceed warning limits.");
}

export function eligibilityBlockers(input: {
  active: boolean;
  snoozed: boolean;
  temporary: boolean;
  pinned: boolean;
  keep: boolean;
  terminal: boolean;
  projectRoot: boolean;
  sharedActive: boolean;
  dirty: boolean;
  unpublished: boolean;
  mode: "manual" | "scheduled" | "emergency";
  eligibleSince: string | null;
  afterDays: number;
  now: number;
}): string[] {
  const reasons: string[] = [];
  if (input.projectRoot) reasons.push("Project root checkout");
  if (input.active || input.sharedActive)
    reasons.push("An attached thread is active or has pending work");
  if (input.snoozed) reasons.push("Snoozed thread");
  if (input.temporary) reasons.push("Temporary thread uses its existing retention policy");
  if (input.pinned || input.keep) reasons.push("Keep worktree or pinned thread");
  if (input.terminal) reasons.push("Open terminal in this workspace");
  if (input.dirty) reasons.push("Uncommitted or untracked files");
  if (input.unpublished) reasons.push("Unpublished commits");
  if (
    input.mode === "scheduled" &&
    (input.eligibleSince === null ||
      input.now - Date.parse(input.eligibleSince) < input.afterDays * 86_400_000)
  )
    reasons.push("Retention period has not elapsed");
  return reasons;
}
