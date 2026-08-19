/**
 * AI usage attributed to one project.
 *
 * Provider CLIs name their transcript directory after the working directory they ran in, which is
 * the only per-project signal a transcript carries. The server reports totals keyed by that name;
 * this matches by encoding each of the project's checkout roots the same way. Codex stores sessions
 * by date rather than by directory, so its usage cannot be attributed and is not counted here.
 *
 * @module components/projects/ProjectUsageTile
 */
import { transcriptWorkspaceSlug } from "@spiritdevs/contracts";
import { SparklesIcon } from "lucide-react";
import { useMemo } from "react";

import { useUsage } from "~/state/usage";
import { Badge } from "../ui/badge";
import { DashboardTile } from "./ProjectDashboardTiles";
import type { ProjectConnectionMetadata } from "./projectConnectionMetadata";

const USAGE_WINDOW_DAYS = 30;

function usageWindow(): { sinceDay: string; untilDay: string; timeZone: string } {
  const now = new Date();
  const since = new Date(now.getTime() - USAGE_WINDOW_DAYS * 86_400_000);
  const day = (date: Date) => date.toISOString().slice(0, 10);
  return {
    sinceDay: day(since),
    untilDay: day(now),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

function formatDuration(ms: number): string {
  if (ms < 60_000) return "under a minute";
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.round((ms % 3_600_000) / 60_000);
  if (hours === 0) return `${minutes}m`;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

function formatTokens(tokens: number): string {
  if (tokens < 1_000) return `${tokens}`;
  if (tokens < 1_000_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}

export function ProjectUsageTile({
  connections,
}: {
  readonly connections: ReadonlyArray<ProjectConnectionMetadata>;
}) {
  const window = useMemo(usageWindow, []);
  const usage = useUsage({
    sinceDay: window.sinceDay as never,
    untilDay: window.untilDay as never,
    timeZone: window.timeZone,
  });

  // One project can have several checkouts, each with its own transcript directory. Sum them.
  const slugs = useMemo(
    () =>
      new Set(
        connections
          .map((connection) => connection.directory)
          .filter((directory): directory is string => directory !== null)
          .map(transcriptWorkspaceSlug),
      ),
    [connections],
  );

  const totals = useMemo(() => {
    let costUsd = 0;
    let totalTokens = 0;
    let sessions = 0;
    let activeMs = 0;
    for (const workspace of usage.merged.workspaces) {
      if (!slugs.has(workspace.workspaceSlug)) continue;
      costUsd += workspace.costUsd;
      totalTokens += workspace.totalTokens;
      sessions += workspace.sessions;
      activeMs += workspace.activeMs;
    }
    return { costUsd, totalTokens, sessions, activeMs };
  }, [slugs, usage.merged.workspaces]);

  return (
    <DashboardTile
      icon={<SparklesIcon />}
      title="AI usage"
      action={<Badge variant="outline">Last {USAGE_WINDOW_DAYS} days</Badge>}
    >
      {slugs.size === 0 ? (
        <p className="text-xs leading-5 text-muted-foreground">
          Usage is attributed by working directory. Attach a checkout to see this project&rsquo;s.
        </p>
      ) : usage.isPending ? (
        <p className="text-xs leading-5 text-muted-foreground">Scanning transcripts…</p>
      ) : totals.sessions === 0 ? (
        <p className="text-xs leading-5 text-muted-foreground">
          No agent sessions in this project&rsquo;s directories over the last {USAGE_WINDOW_DAYS}{" "}
          days.
        </p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            <div>
              <p className="text-2xl font-semibold tabular-nums tracking-tight">
                {formatDuration(totals.activeMs)}
              </p>
              {/*
                Wall clock from a session's first record to its last, which is the closest honest
                answer available. A session left open over lunch reads as a long one, so this is
                labelled as session time rather than as work done.
              */}
              <p className="text-xs text-muted-foreground">Session time</p>
            </div>
            <div>
              <p className="text-2xl font-semibold tabular-nums tracking-tight">
                {formatTokens(totals.totalTokens)}
              </p>
              <p className="text-xs text-muted-foreground">Tokens</p>
            </div>
            <div>
              <p className="text-2xl font-semibold tabular-nums tracking-tight">
                ${totals.costUsd.toFixed(2)}
              </p>
              <p className="text-xs text-muted-foreground">API-equivalent</p>
            </div>
          </div>
          <p className="mt-3 text-[11px] leading-4 text-muted-foreground/80">
            {totals.sessions} {totals.sessions === 1 ? "session" : "sessions"}. Cost is what these
            tokens would bill at API rates, not what a subscription charged.
          </p>
        </>
      )}
    </DashboardTile>
  );
}
