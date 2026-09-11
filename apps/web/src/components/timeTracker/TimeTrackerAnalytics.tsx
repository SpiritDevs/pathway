import type { TrackedActivityOverview } from "@spiritdevs/contracts/businessTools";
import { BotIcon, Clock3Icon, LayersIcon, UserRoundIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { useBusinessToolsCloud, useBusinessToolsQuery } from "../contacts/businessToolsCloud";
import {
  formatTrackedDuration,
  startOfLocalDay,
  startOfLocalWeek,
  trackedActivityDayBoundaries,
} from "./timeTracker.logic";
import { useTimeTrackerClock } from "./useTimeTrackerClock";

type Period = "today" | "week" | "month";

export function TimeTrackerAnalytics({
  cloud,
  projects,
}: {
  cloud: ReturnType<typeof useBusinessToolsCloud>;
  projects: readonly { key: string; title: string }[];
}) {
  const [period, setPeriod] = useState<Period>("week");
  const [projectKey, setProjectKey] = useState("all");
  const now = useTimeTrackerClock();
  const since =
    period === "week" ? startOfLocalWeek(new Date(now)) : startOfLocalDay(new Date(now));
  if (period === "month") since.setDate(since.getDate() - 29);
  const result = useBusinessToolsQuery<TrackedActivityOverview>(
    cloud.client,
    cloud.accountID,
    "timeTracking:overview",
    {
      since: since.toISOString(),
      until: new Date(now).toISOString(),
      timezoneOffsetMinutes: new Date(now).getTimezoneOffset(),
      dayBoundaries: trackedActivityDayBoundaries(since, new Date(now)),
      ...(projectKey === "all" ? {} : { projectKey }),
    },
  );
  const scope = `${cloud.accountID}:${period}:${projectKey}:${since.toISOString()}`;
  const [lastResult, setLastResult] = useState<{
    scope: string;
    value: TrackedActivityOverview;
  } | null>(null);
  useEffect(() => {
    if (result.value) setLastResult({ scope, value: result.value });
  }, [scope, result.value]);
  // Keep the current period visible while its minute refresh is in flight.
  const value = cloud.client
    ? (result.value ??
      (!result.error && lastResult?.scope === scope ? lastResult.value : undefined))
    : undefined;
  const overview = value?.complete ? value : undefined;
  const duration = (value: number | undefined) =>
    value === undefined ? "—" : formatTrackedDuration(value);
  const maxDay = Math.max(1, ...(overview?.days.map((day) => day.workMs) ?? []));
  const maxProject = Math.max(1, ...(overview?.projects.map((project) => project.workMs) ?? []));
  const metrics = [
    {
      label: "Combined work",
      value: overview?.totals.workMs,
      detail: "Every concurrent session counts",
      Icon: LayersIcon,
    },
    {
      label: "Elapsed activity",
      value: overview?.totals.elapsedMs,
      detail: "Overlapping intervals count once",
      Icon: Clock3Icon,
    },
    {
      label: "Agent work",
      value: overview?.totals.agentMs,
      detail: "Blocked time is excluded",
      Icon: BotIcon,
    },
    {
      label: "Your work",
      value: overview ? overview.totals.manualMs + overview.totals.issueMs : undefined,
      detail: "Manual timers and task creation",
      Icon: UserRoundIcon,
    },
  ];

  return (
    <section aria-label="Time analytics" className="mt-8">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-heading text-lg font-semibold">Work overview</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Your time across projects, including work happening in parallel.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            aria-label="Filter analytics by project"
            value={projectKey}
            onChange={(event) => setProjectKey(event.target.value)}
            className="h-9 max-w-48 rounded-lg border border-border/70 bg-background px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <option value="all">All projects</option>
            <option value="">No project</option>
            {projects.map((project) => (
              <option key={project.key} value={project.key}>
                {project.title}
              </option>
            ))}
          </select>
          <div
            role="group"
            aria-label="Analytics period"
            className="flex gap-1 rounded-lg border border-border/70 bg-muted/30 p-1"
          >
            {(
              [
                ["today", "Today"],
                ["week", "This week"],
                ["month", "Last 30 days"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={period === value}
                onClick={() => setPeriod(value)}
                className={`rounded-md px-3 py-1.5 text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring ${period === value ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>
      {result.error ? (
        <p role="alert" className="mb-4 text-sm text-destructive">
          {result.error}
        </p>
      ) : null}
      {value && !value.complete ? (
        <p
          role="status"
          className="mb-4 rounded-lg border border-border bg-muted/30 p-3 text-sm text-muted-foreground"
        >
          This period has too many sessions to summarize. Choose a shorter period. All sessions
          remain available in history.
        </p>
      ) : null}
      <div
        className="grid grid-cols-2 gap-3 lg:grid-cols-4"
        aria-busy={!!cloud.client && !result.value && !result.error}
      >
        {metrics.map(({ label, value, detail, Icon }, index) => (
          <div
            key={label}
            className={`rounded-xl border p-4 sm:p-5 ${index === 0 ? "border-primary/20 bg-primary/5" : "border-border/70 bg-card/40"}`}
          >
            <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
              <span>{label}</span>
              <Icon aria-hidden="true" className="size-4" />
            </div>
            <p className="mt-4 font-heading text-2xl font-semibold tracking-tight tabular-nums sm:text-3xl">
              {duration(value)}
            </p>
            <p className="mt-2 text-[11px] leading-4 text-muted-foreground">{detail}</p>
          </div>
        ))}
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        <div className="min-w-0 rounded-xl border border-border/70 p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="text-sm font-medium">Daily activity</h3>
            <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <span className="size-2 rounded-sm bg-primary" />
                Agents
              </span>
              <span className="flex items-center gap-1.5">
                <span className="size-2 rounded-sm bg-teal-500" />
                You
              </span>
            </div>
          </div>
          {overview && overview.totals.workMs > 0 ? (
            <div className="mt-6 flex h-44 items-end gap-1.5 border-b border-border/70 pb-6 sm:gap-2">
              {overview.days.map((day, index) => {
                const label = new Date(`${day.date}T12:00:00`).toLocaleDateString(undefined, {
                  month: "short",
                  day: "numeric",
                });
                const you = day.manualMs + day.issueMs;
                return (
                  <div
                    key={day.date}
                    className="relative flex h-full min-w-0 flex-1 items-end justify-center"
                    role="img"
                    aria-label={`${label}: ${duration(day.workMs)} combined, ${duration(day.agentMs)} agent, ${duration(you)} your work`}
                    title={`${label} · ${duration(day.workMs)} combined · ${duration(day.elapsedMs)} elapsed`}
                  >
                    <div
                      className="flex w-full max-w-12 flex-col-reverse overflow-hidden rounded-t-sm"
                      style={{
                        height: `${Math.max(day.workMs > 0 ? 2 : 0, (day.workMs / maxDay) * 100)}%`,
                      }}
                    >
                      <div
                        className="w-full bg-primary"
                        style={{ height: `${day.workMs ? (day.agentMs / day.workMs) * 100 : 0}%` }}
                      />
                      <div
                        className="w-full bg-teal-500"
                        style={{ height: `${day.workMs ? (you / day.workMs) * 100 : 0}%` }}
                      />
                    </div>
                    {overview.days.length <= 7 ||
                    index === 0 ||
                    index === overview.days.length - 1 ||
                    index % 7 === 0 ? (
                      <span className="absolute -bottom-5 whitespace-nowrap text-[10px] text-muted-foreground">
                        {overview.days.length <= 7
                          ? new Date(`${day.date}T12:00:00`).toLocaleDateString(undefined, {
                              weekday: "short",
                            })
                          : new Date(`${day.date}T12:00:00`).getDate()}
                      </span>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="flex h-50 items-center justify-center text-sm text-muted-foreground">
              {overview
                ? "Tracked work will appear here."
                : result.error || !cloud.client || result.value
                  ? "Activity unavailable"
                  : "Loading activity…"}
            </div>
          )}
          <p className="mt-4 text-[11px] leading-5 text-muted-foreground">
            Concurrent agents add to combined work. Eight agents working for 30 minutes record 4
            hours of work and 30 minutes of elapsed activity.
          </p>
        </div>
        <div className="rounded-xl border border-border/70 p-5">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-medium">By project</h3>
            <span className="text-[11px] text-muted-foreground">Combined / elapsed</span>
          </div>
          {overview?.projects.length ? (
            <div className="mt-5 max-h-60 space-y-5 overflow-y-auto pr-1">
              {[...overview.projects]
                .sort((a, b) => b.workMs - a.workMs)
                .map((project) => (
                  <div key={project.projectKey}>
                    <div className="flex items-start justify-between gap-4 text-xs">
                      <span className="min-w-0 truncate font-medium" title={project.projectName}>
                        {project.projectName || "No project"}
                      </span>
                      <span className="shrink-0 tabular-nums">
                        {duration(project.workMs)}
                        <span className="text-muted-foreground">
                          {" "}
                          / {duration(project.elapsedMs)}
                        </span>
                      </span>
                    </div>
                    <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full bg-primary/70"
                        style={{ width: `${(project.workMs / maxProject) * 100}%` }}
                      />
                    </div>
                  </div>
                ))}
            </div>
          ) : (
            <div className="flex h-50 items-center justify-center text-sm text-muted-foreground">
              {overview ? "No project activity in this period." : "Project totals unavailable"}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
