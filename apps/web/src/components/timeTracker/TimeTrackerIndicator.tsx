import type {
  ActiveTrackedActivities,
  TrackedActivitySession,
} from "@spiritdevs/contracts/businessTools";
import { useNavigate } from "@tanstack/react-router";
import { ArrowUpRightIcon, BotIcon, Clock3Icon, PauseIcon } from "lucide-react";
import { useState } from "react";
import { hasClerkPublicConfig } from "../../cloud/publicConfig";
import { useBusinessToolsCloud, useBusinessToolsQuery } from "../contacts/businessToolsCloud";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import { formatTrackedDuration, trackedActivityDuration } from "./timeTracker.logic";
import { useTimeTrackerClock } from "./useTimeTrackerClock";

function isAwaitingConnection(session: TrackedActivitySession, now: number) {
  return (
    session.source === "agent" &&
    session.state === "running" &&
    now > (session.observedAt ?? Date.parse(session.startedAt)) + 90_000
  );
}

export function TrackedActivityList({
  sessions,
  now,
}: {
  sessions: readonly TrackedActivitySession[];
  now: number;
}) {
  const groups = new Map<string, { name: string; sessions: TrackedActivitySession[] }>();
  for (const session of sessions) {
    const group = groups.get(session.projectKey) ?? {
      name: session.projectName || "No project",
      sessions: [],
    };
    group.sessions.push(session);
    groups.set(session.projectKey, group);
  }
  return (
    <div className="divide-y divide-border/70">
      {[...groups].map(([projectKey, group]) => (
        <section key={projectKey} className="py-3 first:pt-0 last:pb-0">
          <div className="mb-2 flex items-center justify-between gap-3 text-xs">
            <h3 className="min-w-0 truncate font-medium">{group.name}</h3>
            <span
              className="shrink-0 text-muted-foreground tabular-nums"
              title="Combined work across these sessions"
            >
              {formatTrackedDuration(
                group.sessions.reduce(
                  (sum, session) => sum + trackedActivityDuration(session, now),
                  0,
                ),
              )}
            </span>
          </div>
          <ul className="space-y-1">
            {group.sessions.map((session) => {
              const disconnected = isAwaitingConnection(session, now);
              const paused = session.state === "paused" || disconnected;
              return (
                <li
                  key={session.id}
                  className="flex items-center gap-2.5 rounded-lg bg-muted/35 px-2.5 py-2.5"
                >
                  <span
                    className={`flex size-7 shrink-0 items-center justify-center rounded-md ${paused ? "bg-muted text-muted-foreground" : "bg-primary/10 text-primary"}`}
                  >
                    {paused ? (
                      <PauseIcon aria-hidden="true" className="size-3.5" />
                    ) : session.source === "agent" ? (
                      <BotIcon aria-hidden="true" className="size-3.5" />
                    ) : (
                      <Clock3Icon aria-hidden="true" className="size-3.5" />
                    )}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium" title={session.description}>
                      {session.description}
                    </p>
                    <p className="mt-0.5 text-[10px] text-muted-foreground">
                      {disconnected
                        ? "Waiting for connection"
                        : session.state === "paused"
                          ? "Paused · waiting for input"
                          : session.source === "agent"
                            ? "Agent working"
                            : "Manual timer"}
                    </p>
                  </div>
                  <span className="shrink-0 font-mono text-xs tabular-nums">
                    {formatTrackedDuration(trackedActivityDuration(session, now), true)}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}

export function ActiveAgentTimers({ sessions }: { sessions: readonly TrackedActivitySession[] }) {
  const now = useTimeTrackerClock(
    sessions.some((session) => session.state === "running"),
    1_000,
  );
  if (!sessions.length) return null;
  return (
    <section
      className="mt-6 rounded-xl border border-border/70 bg-card/40 p-5"
      aria-label="Automatic agent timers"
    >
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="text-sm font-medium">Tracking now</h2>
        <span className="text-xs text-muted-foreground">{sessions.length} agent sessions</span>
      </div>
      <div className="max-h-80 overflow-y-auto">
        <TrackedActivityList sessions={sessions} now={now} />
      </div>
    </section>
  );
}

export function TimeTrackerIndicator() {
  if (!hasClerkPublicConfig()) return null;
  return <ConfiguredTimeTrackerIndicator />;
}

function ConfiguredTimeTrackerIndicator() {
  const cloud = useBusinessToolsCloud();
  const result = useBusinessToolsQuery<ActiveTrackedActivities>(
    cloud.client,
    cloud.accountID,
    "timeTracking:listActive",
    {},
  );
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const sessions = result.value?.sessions ?? [];
  const now = useTimeTrackerClock(
    sessions.some((session) => session.state === "running"),
    open ? 1_000 : 60_000,
  );
  const running = sessions.filter(
    (session) => session.state === "running" && !isAwaitingConnection(session, now),
  ).length;
  const duration = sessions.reduce(
    (sum, session) => sum + trackedActivityDuration(session, now),
    0,
  );
  if (!cloud.client || running === 0) return null;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={<Button variant="ghost" size="sm" />}
        aria-label={`Time tracker${running ? `, ${running} running` : sessions.length ? `, ${sessions.length} paused` : ""}`}
        className="gap-1.5 rounded-lg px-2 text-muted-foreground [-webkit-app-region:no-drag]"
      >
        <Clock3Icon className={`size-4 ${running ? "text-primary" : ""}`} />
        {sessions.length ? (
          <>
            <span className="font-mono text-xs tabular-nums">
              {formatTrackedDuration(duration)}
            </span>
            <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
              {sessions.length}
            </span>
          </>
        ) : null}
      </PopoverTrigger>
      <PopoverPopup
        align="end"
        sideOffset={8}
        className="w-96 max-w-[calc(100vw-1rem)]"
        viewportClassName="p-0"
      >
        <div className="border-b border-border/70 px-4 py-4">
          <div className="flex items-center justify-between gap-3">
            <PopoverTitle className="text-sm">Time tracking</PopoverTitle>
            <span className="text-xs text-muted-foreground">
              {running} running
              {sessions.length - running ? ` · ${sessions.length - running} paused` : ""}
            </span>
          </div>
          <p className="mt-1.5 text-xs text-muted-foreground">
            All active sessions, across your projects.
          </p>
        </div>
        <div className="max-h-96 overflow-y-auto p-4">
          {result.error ? (
            <p role="alert" className="text-sm text-destructive">
              {result.error}
            </p>
          ) : (
            <TrackedActivityList sessions={sessions} now={now} />
          )}
          {result.value && !result.value.complete ? (
            <p role="status" className="mt-3 text-xs text-muted-foreground">
              Showing a limited set of active sessions.
            </p>
          ) : null}
        </div>
        <div className="border-t border-border/70 p-2">
          <Button
            className="w-full justify-between"
            variant="ghost"
            onClick={() => {
              setOpen(false);
              void navigate({ to: "/time-tracker" });
            }}
          >
            Open Time Tracker
            <ArrowUpRightIcon className="size-4" />
          </Button>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
