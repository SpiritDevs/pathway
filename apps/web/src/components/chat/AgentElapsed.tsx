import { useEffect, useState } from "react";

export function formatAgentElapsed(elapsedMs: number): string {
  const seconds = Number.isFinite(elapsedMs) ? Math.max(0, Math.floor(elapsedMs / 1000)) : 0;
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** An agent's elapsed time. Self-ticks while live so only this span re-renders each second. */
export function AgentElapsed(props: {
  readonly startedAtMs: number | null;
  readonly completedAtMs: number | null;
  readonly live: boolean;
}) {
  const [, setTick] = useState(0);
  const ticking = props.live && props.startedAtMs !== null;
  useEffect(() => {
    if (!ticking) return;
    const id = window.setInterval(() => setTick((tick) => tick + 1), 1_000);
    return () => window.clearInterval(id);
  }, [ticking]);
  if (props.startedAtMs === null) return null;
  const endMs = props.live ? Date.now() : props.completedAtMs;
  if (endMs === null) return null;
  return <span className="tabular-nums">{formatAgentElapsed(endMs - props.startedAtMs)}</span>;
}
