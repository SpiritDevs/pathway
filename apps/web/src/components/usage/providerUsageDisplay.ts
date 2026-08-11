import type { ServerProviderUsageLimit, ServerProviderUsageSnapshot } from "@t3tools/contracts";

export interface ProviderUsageDisplayLimit extends ServerProviderUsageLimit {
  readonly remainingPercent: number;
  readonly remainingLabel: string;
  readonly resetLabel: string | null;
  readonly tone: "healthy" | "warning" | "danger";
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function formatDuration(milliseconds: number): string {
  const minutes = Math.max(1, Math.ceil(milliseconds / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.ceil(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.ceil(hours / 24)}d`;
}

export function formatProviderUsageReset(resetsAt: string, nowMs = Date.now()): string | null {
  const resetMs = Date.parse(resetsAt);
  if (!Number.isFinite(resetMs)) return null;
  if (resetMs <= nowMs) return "Resetting now";
  return `Resets in ${formatDuration(resetMs - nowMs)}`;
}

export function deriveProviderUsageLimits(
  limits: ReadonlyArray<ServerProviderUsageLimit>,
  nowMs = Date.now(),
): ReadonlyArray<ProviderUsageDisplayLimit> {
  return limits.flatMap((limit) => {
    if (limit.usedPercent === undefined) return [];
    const remainingPercent = clampPercent(100 - limit.usedPercent);
    return [
      {
        ...limit,
        remainingPercent,
        remainingLabel: `${Math.round(remainingPercent)}% left`,
        resetLabel: limit.resetsAt ? formatProviderUsageReset(limit.resetsAt, nowMs) : null,
        tone:
          remainingPercent <= 10
            ? ("danger" as const)
            : remainingPercent <= 25
              ? ("warning" as const)
              : ("healthy" as const),
      },
    ];
  });
}

export function selectPrimaryProviderUsageLimit(
  snapshot: ServerProviderUsageSnapshot | null,
): ProviderUsageDisplayLimit | null {
  const limits = snapshot ? deriveProviderUsageLimits(snapshot.limits) : [];
  return limits.reduce<ProviderUsageDisplayLimit | null>(
    (selected, limit) =>
      selected === null || limit.remainingPercent < selected.remainingPercent ? limit : selected,
    null,
  );
}

export function shouldCollapseProviderUsage(
  limits: ReadonlyArray<ProviderUsageDisplayLimit>,
): boolean {
  return limits.length > 1;
}
