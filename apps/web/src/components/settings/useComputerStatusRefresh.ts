import { useEffect, useRef } from "react";

/** Health can flip (reconnecting, recovered) while the panel is open. */
export const COMPUTER_STATUS_VISIBLE_REFRESH_INTERVAL_MS = 10_000;

/**
 * Keeps Settings → Computer current. The server status refreshes on an
 * interval while the document is visible; a failing read pauses the interval
 * until Check again succeeds. Returning to the window (for example from System
 * Settings) also re-reads the native grant snapshot, which is a helper round
 * trip, so it never runs on the interval.
 */
export function useComputerStatusRefresh(input: {
  readonly refreshStatus: () => void;
  readonly refreshNativeState: () => void;
  readonly paused: boolean;
}): void {
  const latest = useRef(input);
  latest.current = input;

  useEffect(() => {
    if (input.paused) return;
    const interval = setInterval(() => {
      if (document.visibilityState !== "hidden") latest.current.refreshStatus();
    }, COMPUTER_STATUS_VISIBLE_REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [input.paused]);

  useEffect(() => {
    const refreshOnReturn = () => {
      if (document.visibilityState === "hidden") return;
      latest.current.refreshStatus();
      latest.current.refreshNativeState();
    };
    window.addEventListener("focus", refreshOnReturn);
    document.addEventListener("visibilitychange", refreshOnReturn);
    return () => {
      window.removeEventListener("focus", refreshOnReturn);
      document.removeEventListener("visibilitychange", refreshOnReturn);
    };
  }, []);
}
