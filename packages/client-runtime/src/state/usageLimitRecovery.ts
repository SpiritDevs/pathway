import type {
  OrchestrationV2ProviderFailure,
  ServerProviderUsageSnapshot,
} from "@spiritdevs/contracts";
import * as DateTime from "effect/DateTime";

const USAGE_LIMIT_CODE_PATTERN =
  /(?:^|[_-])(?:429|insufficient[_-]?quota|quota[_-]?(?:exceeded|exhausted)|rate[_-]?limit|session[_-]?limit|usage[_-]?limit)(?:$|[_-])/iu;
const USAGE_LIMIT_MESSAGE_PATTERN =
  /\b(?:hit|reached|exceeded|exhausted|used up|ran out of)\b[^\n.]{0,80}\b(?:session|usage|rate|token|credit|quota)\s+limit\b|\b(?:session|usage|rate)\s+limit\b[^\n.]{0,80}\b(?:hit|reached|exceeded|exhausted|reset|resets|retry|try again)\b|\b(?:insufficient|exceeded|exhausted)\s+(?:credit|quota)|\btoo many requests\b/iu;

const ISO_DATE_PATTERN =
  /\b(?:reset|resets|retry|available again)(?:s|ting)?(?:\s+at|\s+on|\s+in)?\s+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2}))/iu;
const CLOCK_RESET_PATTERN =
  /\breset(?:s|ting)?(?:\s+at)?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*\(([^)]+)\))?/iu;
const RELATIVE_RESET_PATTERN =
  /\b(?:reset(?:s|ting)?|try again|available again)\s+in\s+(?:(\d+)\s*(?:hours?|hrs?|h))?(?:\s*(?:and\s*)?)?(?:(\d+)\s*(?:minutes?|mins?|m))?/iu;

export const USAGE_LIMIT_RECOVERY_PROMPT =
  "Continue the work from the previous turn, which stopped because the provider hit a usage limit. Pick up where it stopped, preserve completed work, and do not repeat steps unnecessarily.";

export function isUsageLimitFailure(failure: OrchestrationV2ProviderFailure): boolean {
  return (
    (failure.code !== null && USAGE_LIMIT_CODE_PATTERN.test(failure.code)) ||
    USAGE_LIMIT_MESSAGE_PATTERN.test(failure.message)
  );
}

function localDateParts(
  timestampMs: number,
  timeZone: string,
): {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
} | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(timestampMs);
    const read = (type: Intl.DateTimeFormatPartTypes) =>
      Number(parts.find((part) => part.type === type)?.value);
    const result = {
      year: read("year"),
      month: read("month"),
      day: read("day"),
      hour: read("hour"),
      minute: read("minute"),
    };
    return Object.values(result).every(Number.isFinite) ? result : null;
  } catch {
    return null;
  }
}

function zonedClockToEpochMs(input: {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly timeZone: string;
}): number | null {
  const desiredAsUtc = Date.UTC(input.year, input.month - 1, input.day, input.hour, input.minute);
  let candidate = desiredAsUtc;
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const displayed = localDateParts(candidate, input.timeZone);
    if (displayed === null) return null;
    const displayedAsUtc = Date.UTC(
      displayed.year,
      displayed.month - 1,
      displayed.day,
      displayed.hour,
      displayed.minute,
    );
    const correction = desiredAsUtc - displayedAsUtc;
    candidate += correction;
    if (correction === 0) return candidate;
  }
  return candidate;
}

function addLocalDay(input: {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}) {
  const leapYear = input.year % 4 === 0 && (input.year % 100 !== 0 || input.year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][
    input.month - 1
  ]!;
  if (input.day < daysInMonth) return { ...input, day: input.day + 1 };
  if (input.month < 12) return { year: input.year, month: input.month + 1, day: 1 };
  return {
    year: input.year + 1,
    month: 1,
    day: 1,
  };
}

function parseClockReset(message: string, nowMs: number): number | null {
  const match = CLOCK_RESET_PATTERN.exec(message);
  if (!match) return null;
  const rawHour = Number(match[1]);
  const minute = Number(match[2] ?? "0");
  const meridiem = match[3]?.toLowerCase();
  if (
    !Number.isInteger(rawHour) ||
    !Number.isInteger(minute) ||
    minute < 0 ||
    minute > 59 ||
    (meridiem ? rawHour < 1 || rawHour > 12 : rawHour < 0 || rawHour > 23)
  ) {
    return null;
  }
  const hour = meridiem ? (rawHour % 12) + (meridiem === "pm" ? 12 : 0) : rawHour;
  const timeZone = match[4]?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const today = localDateParts(nowMs, timeZone);
  if (today === null) return null;
  const candidateFor = (date: {
    readonly year: number;
    readonly month: number;
    readonly day: number;
  }) => zonedClockToEpochMs({ ...date, hour, minute, timeZone });
  const todayCandidate = candidateFor(today);
  if (todayCandidate !== null && todayCandidate > nowMs) return todayCandidate;
  return candidateFor(addLocalDay(today));
}

export function parseUsageLimitResetAt(message: string, nowMs: number): string | null {
  const iso = ISO_DATE_PATTERN.exec(message)?.[1];
  if (iso) {
    const timestamp = Date.parse(iso);
    if (Number.isFinite(timestamp) && timestamp > nowMs) {
      return DateTime.formatIso(DateTime.makeUnsafe(timestamp));
    }
  }

  const relative = RELATIVE_RESET_PATTERN.exec(message);
  if (relative) {
    const hours = Number(relative[1] ?? "0");
    const minutes = Number(relative[2] ?? "0");
    const delayMs = (hours * 60 + minutes) * 60_000;
    if (delayMs > 0) return DateTime.formatIso(DateTime.makeUnsafe(nowMs + delayMs));
  }

  const clock = parseClockReset(message, nowMs);
  return clock === null ? null : DateTime.formatIso(DateTime.makeUnsafe(clock));
}

export function resolveUsageLimitResetAt(input: {
  readonly failureMessage: string;
  readonly model?: string;
  readonly snapshot?: ServerProviderUsageSnapshot | null;
  readonly nowMs: number;
}): string | null {
  const explicit = parseUsageLimitResetAt(input.failureMessage, input.nowMs);
  if (explicit !== null) return explicit;
  const snapshot = input.snapshot;
  if (snapshot?.status !== "ok" || snapshot.stale) return null;
  const model = input.model?.toLowerCase();
  const blocking = snapshot.limits.filter((limit) => {
    // Providers can round an exhausted quota just below 100%.
    if ((limit.usedPercent ?? 0) < 99) return false;
    if (!limit.scope) return true;
    // Scope labels are provider supplied. Only match known model families;
    // an unknown scope cannot safely schedule automatic recovery.
    const scope = limit.scope.toLowerCase();
    return (
      model !== undefined &&
      ["spark", "sonnet", "opus", "haiku", "fable"].some(
        (family) => scope.includes(family) && model.includes(family),
      )
    );
  });
  if (blocking.length === 0) return null;
  const resets = blocking.map((limit) => Date.parse(limit.resetsAt ?? ""));
  if (resets.some((timestamp) => !Number.isFinite(timestamp) || timestamp <= input.nowMs))
    return null;
  return DateTime.formatIso(DateTime.makeUnsafe(Math.max(...resets)));
}
