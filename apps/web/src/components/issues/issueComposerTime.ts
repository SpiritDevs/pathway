export const ISSUE_COMPOSER_IDLE_MS = 30_000;
const MAX_INTERVALS = 256;

/** An interaction extends the active interval by at most the idle allowance. */
export function createIssueComposerClock() {
  let intervals: Array<{ start: number; end: number }> = [];
  let start: number | null = null;
  let lastActivity = 0;

  function monotonicNow(now: number) {
    return Math.max(now, lastActivity, intervals.at(-1)?.end ?? 0);
  }

  function pause(now: number) {
    if (start === null) return;
    const end = Math.max(start, Math.min(monotonicNow(now), lastActivity + ISSUE_COMPOSER_IDLE_MS));
    if (end > start && intervals.length < MAX_INTERVALS) intervals.push({ start, end });
    start = null;
  }

  return {
    activity(now: number) {
      now = monotonicNow(now);
      if (start !== null && now > lastActivity + ISSUE_COMPOSER_IDLE_MS) pause(now);
      if (start === null) start = now;
      lastActivity = now;
    },
    pause,
    snapshot(now: number) {
      const end = Math.max(
        start ?? now,
        Math.min(monotonicNow(now), lastActivity + ISSUE_COMPOSER_IDLE_MS),
      );
      return {
        intervals: [
          ...intervals,
          ...(start !== null && end > start && intervals.length < MAX_INTERVALS
            ? [{ start, end }]
            : []),
        ],
      };
    },
    reset() {
      intervals = [];
      start = null;
      lastActivity = 0;
    },
  };
}
