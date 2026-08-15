export interface ActiveTimeEntry {
  readonly id: string;
  readonly description: string;
  readonly projectKey: string;
  readonly projectName: string;
  readonly startedAt: string;
}

export interface TimeEntry extends ActiveTimeEntry {
  readonly stoppedAt: string;
  readonly durationMs: number;
}

export function formatTrackedDuration(durationMs: number, showSeconds = false): string {
  const seconds = Math.max(0, Math.floor(durationMs / 1_000));
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainingSeconds = seconds % 60;
  if (showSeconds)
    return [hours, minutes, remainingSeconds]
      .map((value) => String(value).padStart(2, "0"))
      .join(":");
  if (hours === 0) return `${minutes}m`;
  return `${hours}h ${String(minutes).padStart(2, "0")}m`;
}

export function totalDuration(entries: readonly TimeEntry[], since: Date): number {
  const sinceMs = since.getTime();
  return entries.reduce(
    (total, entry) => (Date.parse(entry.stoppedAt) >= sinceMs ? total + entry.durationMs : total),
    0,
  );
}

export function startOfLocalDay(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

export function startOfLocalWeek(now: Date): Date {
  const start = startOfLocalDay(now);
  const mondayOffset = (start.getDay() + 6) % 7;
  start.setDate(start.getDate() - mondayOffset);
  return start;
}
