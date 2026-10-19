import { useEffect, useState } from "react";

/** Refresh visible clocks only; hidden windows do not need timer repaints. */
export function useTimeTrackerClock(enabled = true, intervalMs = 60_000) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!enabled) return;
    let interval: ReturnType<typeof setInterval> | undefined;
    const refresh = () => {
      if (interval) clearInterval(interval);
      interval = undefined;
      if (document.visibilityState === "hidden") return;
      setNow(Date.now());
      interval = setInterval(() => setNow(Date.now()), intervalMs);
    };
    refresh();
    document.addEventListener("visibilitychange", refresh);
    return () => {
      if (interval) clearInterval(interval);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [enabled, intervalMs]);
  return now;
}
