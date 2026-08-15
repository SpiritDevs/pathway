import * as Schema from "effect/Schema";
import { Clock3Icon, FolderKanbanIcon, PlayIcon, SquareIcon, Trash2Icon } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";

import { useLocalStorage } from "~/hooks/useLocalStorage";
import { randomUUID } from "~/lib/utils";
import { useProjects } from "~/state/entities";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Input } from "../ui/input";
import { ScrollArea } from "../ui/scroll-area";
import { WorkspaceViewFrame } from "../workspace/WorkspaceViewFrame";
import {
  formatTrackedDuration,
  startOfLocalDay,
  startOfLocalWeek,
  totalDuration,
  type ActiveTimeEntry,
  type TimeEntry,
} from "./timeTracker.logic";

const TIME_TRACKER_STORAGE_KEY = "pathway:time-tracker";
const ActiveTimeEntrySchema = Schema.Struct({
  id: Schema.String,
  description: Schema.String,
  projectKey: Schema.String,
  projectName: Schema.String,
  startedAt: Schema.String,
});
const TimeEntrySchema = Schema.Struct({
  ...ActiveTimeEntrySchema.fields,
  stoppedAt: Schema.String,
  durationMs: Schema.Number,
});
const TimeTrackerStateSchema = Schema.Struct({
  active: Schema.NullOr(ActiveTimeEntrySchema),
  entries: Schema.Array(TimeEntrySchema),
});
const EMPTY_TIME_TRACKER_STATE: {
  readonly active: ActiveTimeEntry | null;
  readonly entries: readonly TimeEntry[];
} = { active: null, entries: [] };

function LiveDuration({ startedAt }: { startedAt: string }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((value) => value + 1), 1_000);
    return () => window.clearInterval(id);
  }, []);
  return <>{formatTrackedDuration(Date.now() - Date.parse(startedAt), true)}</>;
}

function formatEntryDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

export function TimeTrackerView() {
  const projects = useProjects().filter(({ workspaceRoot }) => workspaceRoot !== null);
  const [state, setState] = useLocalStorage(
    TIME_TRACKER_STORAGE_KEY,
    EMPTY_TIME_TRACKER_STATE,
    TimeTrackerStateSchema,
  );
  const [description, setDescription] = useState("");
  const [projectKey, setProjectKey] = useState("");
  const todayTotal = totalDuration(state.entries, startOfLocalDay(new Date()));
  const weekTotal = totalDuration(state.entries, startOfLocalWeek(new Date()));
  const orderedEntries = useMemo(
    () => state.entries.toSorted((left, right) => right.startedAt.localeCompare(left.startedAt)),
    [state.entries],
  );

  const startTimer = (event: FormEvent) => {
    event.preventDefault();
    const trimmedDescription = description.trim();
    if (!trimmedDescription || state.active) return;
    const project = projects.find(
      ({ environmentId, id }) => `${environmentId}:${id}` === projectKey,
    );
    setState((current) => ({
      ...current,
      active: {
        id: randomUUID(),
        description: trimmedDescription,
        projectKey,
        projectName: project?.title ?? "No project",
        startedAt: new Date().toISOString(),
      },
    }));
    setDescription("");
  };

  const stopTimer = () => {
    const active = state.active;
    if (!active) return;
    const stoppedAt = new Date().toISOString();
    const entry: TimeEntry = {
      ...active,
      stoppedAt,
      durationMs: Math.max(1_000, Date.parse(stoppedAt) - Date.parse(active.startedAt)),
    };
    setState((current) => ({ active: null, entries: [entry, ...current.entries] }));
  };

  return (
    <WorkspaceViewFrame title="Time Tracker">
      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto flex w-full max-w-6xl flex-col px-5 py-6 sm:px-8 sm:py-8">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <p className="text-[11px] font-semibold tracking-[0.15em] text-muted-foreground uppercase">
                Focus ledger
              </p>
              <h1 className="mt-2 font-heading text-2xl font-semibold tracking-tight sm:text-3xl">
                Make the work visible.
              </h1>
            </div>
            <p className="max-w-sm text-sm leading-6 text-muted-foreground">
              Entries stay on this device. Use the project label to keep sessions easy to reconcile.
            </p>
          </div>

          <section className="mt-8 border-y border-border/70 py-5">
            {state.active ? (
              <div className="flex flex-col gap-5 sm:flex-row sm:items-center">
                <span className="relative flex size-11 shrink-0 items-center justify-center rounded-full bg-red-500/10 text-red-600 dark:text-red-400">
                  <span className="absolute inset-0 animate-ping rounded-full bg-red-500/10 motion-reduce:animate-none" />
                  <Clock3Icon className="relative size-5" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{state.active.description}</p>
                  <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                    <FolderKanbanIcon className="size-3.5" />
                    {state.active.projectName}
                  </p>
                </div>
                <span className="font-mono text-2xl tracking-tight tabular-nums sm:text-3xl">
                  <LiveDuration startedAt={state.active.startedAt} />
                </span>
                <Button variant="destructive" onClick={stopTimer}>
                  <SquareIcon className="fill-current" />
                  Stop timer
                </Button>
              </div>
            ) : (
              <form className="flex flex-col gap-3 lg:flex-row" onSubmit={startTimer}>
                <Input
                  aria-label="Time entry description"
                  placeholder="What are you working on?"
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  className="min-w-0 flex-1"
                  required
                />
                <label className="sr-only" htmlFor="time-tracker-project">
                  Project
                </label>
                <select
                  id="time-tracker-project"
                  value={projectKey}
                  onChange={(event) => setProjectKey(event.target.value)}
                  className="h-9 min-w-48 rounded-lg border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-8"
                >
                  <option value="">No project</option>
                  {projects.map((project) => (
                    <option
                      key={`${project.environmentId}:${project.id}`}
                      value={`${project.environmentId}:${project.id}`}
                    >
                      {project.title}
                    </option>
                  ))}
                </select>
                <Button type="submit">
                  <PlayIcon className="fill-current" />
                  Start timer
                </Button>
              </form>
            )}
          </section>

          <section
            aria-label="Tracked time summary"
            className="grid grid-cols-2 border-b border-border/70"
          >
            <div className="py-6 pr-6">
              <p className="text-xs text-muted-foreground">Today</p>
              <p className="mt-1 font-heading text-2xl font-semibold tabular-nums">
                {formatTrackedDuration(todayTotal)}
              </p>
            </div>
            <div className="border-l border-border/70 py-6 pl-6">
              <p className="text-xs text-muted-foreground">This week</p>
              <p className="mt-1 font-heading text-2xl font-semibold tabular-nums">
                {formatTrackedDuration(weekTotal)}
              </p>
            </div>
          </section>

          <section className="mt-8">
            <div className="flex items-center justify-between gap-4">
              <h2 className="font-heading text-lg font-semibold">Recent entries</h2>
              <span className="text-xs text-muted-foreground tabular-nums">
                {orderedEntries.length} total
              </span>
            </div>
            {orderedEntries.length === 0 ? (
              <Empty className="min-h-72 border-b border-border/70">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <Clock3Icon />
                  </EmptyMedia>
                  <EmptyTitle>No time tracked yet</EmptyTitle>
                  <EmptyDescription>
                    Start the timer above. Finished sessions will collect here.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <div className="mt-3 divide-y divide-border/70 border-y border-border/70">
                {orderedEntries.map((entry) => (
                  <div
                    key={entry.id}
                    className="group grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-1 py-4 sm:grid-cols-[minmax(0,1fr)_minmax(8rem,0.35fr)_8rem_2rem]"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{entry.description}</p>
                      <p className="mt-1 text-xs text-muted-foreground sm:hidden">
                        {entry.projectName}
                      </p>
                    </div>
                    <p className="hidden truncate text-xs text-muted-foreground sm:block">
                      {entry.projectName}
                    </p>
                    <div className="text-right">
                      <p className="font-mono text-sm tabular-nums">
                        {formatTrackedDuration(entry.durationMs)}
                      </p>
                      <p className="mt-1 text-[11px] text-muted-foreground">
                        {formatEntryDate(entry.startedAt)}
                      </p>
                    </div>
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label={`Delete ${entry.description} entry`}
                      className="opacity-70 sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100"
                      onClick={() =>
                        setState((current) => ({
                          ...current,
                          entries: current.entries.filter(({ id }) => id !== entry.id),
                        }))
                      }
                    >
                      <Trash2Icon />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      </ScrollArea>
    </WorkspaceViewFrame>
  );
}
