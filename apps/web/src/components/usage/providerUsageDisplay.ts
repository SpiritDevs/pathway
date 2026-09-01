import type { ServerProviderUsageLimit, ServerProviderUsageSnapshot } from "@spiritdevs/contracts";

export interface ProviderUsageDisplayLimit extends ServerProviderUsageLimit {
  readonly remainingPercent: number | null;
  readonly remainingLabel: string;
  readonly resetLabel: string | null;
  readonly tone: "healthy" | "warning" | "danger" | null;
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

export function formatDuration(milliseconds: number): string {
  const minutes = Math.max(1, Math.ceil(milliseconds / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const remainingMinutes = minutes % 60;
    return remainingMinutes === 0 ? `${hours}h` : `${hours}h ${remainingMinutes}m`;
  }
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return remainingHours === 0 ? `${days}d` : `${days}d ${remainingHours}h`;
}

export function formatProviderUsageReset(resetsAt: string, nowMs = Date.now()): string | null {
  const resetMs = Date.parse(resetsAt);
  if (!Number.isFinite(resetMs)) return null;
  if (resetMs <= nowMs) return "Resetting now";
  return `Resets in ${formatDuration(resetMs - nowMs)}`;
}

export function formatProviderUsageCaptureAge(
  fetchedAt: string,
  nowMs = Date.now(),
): string | null {
  const fetchedAtMs = Date.parse(fetchedAt);
  if (!Number.isFinite(fetchedAtMs)) return null;
  if (fetchedAtMs >= nowMs) return "as of now";
  return `as of ${formatDuration(nowMs - fetchedAtMs)} ago`;
}

export function formatProviderUsageRateLimit(
  providerName: string,
  rateLimitedUntil: string,
  nowMs = Date.now(),
): string | null {
  const untilMs = Date.parse(rateLimitedUntil);
  if (!Number.isFinite(untilMs)) return null;
  const remainingMs = Math.max(0, untilMs - nowMs);
  if (remainingMs === 0) {
    return `${providerName} usage is rate limited by the provider. Refreshes can resume now.`;
  }
  if (remainingMs < 60_000) {
    return `${providerName} usage is rate limited by the provider. Refreshes resume in less than a minute.`;
  }
  if (remainingMs < 2 * 60 * 60_000) {
    const minutes = Math.ceil(remainingMs / 60_000);
    return `${providerName} usage is rate limited by the provider. Refreshes resume in about ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`;
  }
  const hours = Math.ceil(remainingMs / (60 * 60_000));
  return `${providerName} usage is rate limited by the provider. Refreshes resume in about ${hours} ${hours === 1 ? "hour" : "hours"}.`;
}

export function deriveProviderUsageLimits(
  limits: ReadonlyArray<ServerProviderUsageLimit>,
  nowMs = Date.now(),
): ReadonlyArray<ProviderUsageDisplayLimit> {
  return limits.flatMap<ProviderUsageDisplayLimit>((limit) => {
    if (limit.usedPercent === undefined) {
      if (limit.resetsAt === undefined) return [];
      return [
        {
          ...limit,
          remainingPercent: null,
          remainingLabel: "No % reported",
          resetLabel: formatProviderUsageReset(limit.resetsAt, nowMs),
          tone: null,
        },
      ];
    }
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
  return limits.reduce<ProviderUsageDisplayLimit | null>((selected, limit) => {
    if (selected === null) return limit;
    if (limit.remainingPercent === null) return selected;
    return selected.remainingPercent === null || limit.remainingPercent < selected.remainingPercent
      ? limit
      : selected;
  }, null);
}

export function shouldCollapseProviderUsage(
  limits: ReadonlyArray<ProviderUsageDisplayLimit>,
): boolean {
  return limits.length > 1;
}
