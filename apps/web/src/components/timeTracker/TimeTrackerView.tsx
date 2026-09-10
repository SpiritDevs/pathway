import { Link } from "@tanstack/react-router";
import { useBusinessToolsCloud, useBusinessToolsQuery } from "../contacts/businessToolsCloud";
import type { Value } from "convex/values";
import { makeFunctionReference } from "convex/server";
import type {
  TrackedSessionPage,
  ActiveTrackedActivities,
} from "@spiritdevs/contracts/businessTools";
import * as Schema from "effect/Schema";
import { Clock3Icon, FolderKanbanIcon, PlayIcon, SquareIcon, Trash2Icon } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";

import { useLocalStorage } from "~/hooks/useLocalStorage";
import { randomUUID } from "~/lib/utils";
import { useProjects, useThreadTitlesByKey } from "~/state/entities";
import {
  useSyncedCloudProjects,
  useSyncedEnvironmentBindings,
} from "../../cloud/issueDomainReadModel";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Input } from "../ui/input";
import { ScrollArea } from "../ui/scroll-area";
import { WorkspaceViewFrame } from "../workspace/WorkspaceViewFrame";
import { formatTrackedDuration, type ActiveTimeEntry, type TimeEntry } from "./timeTracker.logic";

import { TimeTrackerAnalytics } from "./TimeTrackerAnalytics";
import { ActiveAgentTimers } from "./TimeTrackerIndicator";
import { useTimeTrackerClock } from "./useTimeTrackerClock";

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
  const now = useTimeTrackerClock(true, 1_000);
  return <>{formatTrackedDuration(now - Date.parse(startedAt), true)}</>;
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
  const threadTitles = useThreadTitlesByKey();
  const localProjects = useProjects().filter(({ workspaceRoot }) => workspaceRoot !== null);
  const cloudProjects = useSyncedCloudProjects();
  const bindings = useSyncedEnvironmentBindings();
  const projectOptions = new Map(
    cloudProjects.map((project) => [
      String(project.id),
      { key: String(project.id), title: project.name },
    ]),
  );
  for (const project of localProjects) {
    const binding = bindings.find(
      (row) =>
        row.status === "active" &&
        row.environmentId === project.environmentId &&
        row.localProjectId === project.id,
    );
    const key = binding?.cloudProjectId ?? `${project.environmentId}:${project.id}`;
    if (!projectOptions.has(key)) projectOptions.set(key, { key, title: project.title });
  }
  const projects = [...projectOptions.values()];
  const [legacyState] = useLocalStorage(
    TIME_TRACKER_STORAGE_KEY,
    EMPTY_TIME_TRACKER_STATE,
    TimeTrackerStateSchema,
  );
  const cloud = useBusinessToolsCloud();
  const result = useBusinessToolsQuery<TrackedSessionPage>(
    cloud.client,
    cloud.accountID,
    "timeTracking:listMine",
    {},
  );
  const state = result.value ?? EMPTY_TIME_TRACKER_STATE;
  const latestPage = useRef(result.value);
  useEffect(() => {
    latestPage.current = result.value;
    return () => {
      latestPage.current = undefined;
    };
  }, [result.value]);
  const activeActivities = useBusinessToolsQuery<ActiveTrackedActivities>(
    cloud.client,
    cloud.accountID,
    "timeTracking:listActive",
    {},
  );
  const automaticSessions =
    activeActivities.value?.sessions.filter((session) => session.source === "agent") ?? [];
  const [history, setHistory] = useState<{
    base: TrackedSessionPage;
    entries: TrackedSessionPage["entries"];
    cursor: string | null;
    isDone: boolean;
  } | null>(null);
  // A new live first page invalidates previously fetched pages and outstanding requests.
  const currentHistory = history?.base === result.value ? history : null;
  const orderedEntries = currentHistory?.entries ?? result.value?.entries ?? [];
  const nextCursor = currentHistory?.cursor ?? result.value?.cursor;
  const historyDone = currentHistory?.isDone ?? result.value?.isDone ?? true;
  const [pageRequest, setPageRequest] = useState<{
    base: TrackedSessionPage;
    loading: boolean;
    error?: string;
  } | null>(null);
  const loadingMore =
    pageRequest !== null && pageRequest.base === result.value && pageRequest.loading;
  const pageError =
    pageRequest !== null && pageRequest.base === result.value ? pageRequest.error : undefined;
  const loadMore = async () => {
    if (!cloud.client || !result.value || !nextCursor || loadingMore) return;
    const base = result.value;
    setPageRequest({ base, loading: true });
    try {
      const page = await cloud.client.query(
        makeFunctionReference<"query", { cursor: string }, TrackedSessionPage>(
          "timeTracking:listMine",
        ),
        { cursor: nextCursor },
      );
      if (latestPage.current !== base) return;
      const ids = new Set(orderedEntries.map((entry) => entry.id));
      setHistory({
        base,
        entries: [...orderedEntries, ...page.entries.filter((entry) => !ids.has(entry.id))],
        cursor: page.cursor,
        isDone: page.isDone,
      });
      setPageRequest({ base, loading: false });
    } catch (error) {
      if (latestPage.current !== base) return;
      setPageRequest({
        base,
        loading: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<{
    accountID: string;
    name: "start" | "stop";
    args: Record<string, Value>;
  } | null>(null);
  const [writing, setWriting] = useState(false);
  const [corruptedRetry, setCorruptedRetry] = useState(false);
  const [importing, setImporting] = useState(false);
  useEffect(() => {
    setPending(null);
    setError(null);
    setCorruptedRetry(false);
    if (!cloud.accountID) return;
    try {
      const raw: unknown = JSON.parse(
        localStorage.getItem(`pathway:time-pending:${cloud.accountID}`) ?? "null",
      );
      if (
        raw &&
        typeof raw === "object" &&
        "name" in raw &&
        (raw.name === "start" || raw.name === "stop") &&
        "args" in raw &&
        raw.args &&
        typeof raw.args === "object" &&
        "id" in raw.args &&
        typeof raw.args.id === "string"
      ) {
        if (raw.name === "stop")
          setPending({ accountID: cloud.accountID, name: "stop", args: { id: raw.args.id } });
        else if (
          "description" in raw.args &&
          typeof raw.args.description === "string" &&
          "projectKey" in raw.args &&
          typeof raw.args.projectKey === "string" &&
          "projectName" in raw.args &&
          typeof raw.args.projectName === "string"
        )
          setPending({
            accountID: cloud.accountID,
            name: "start",
            args: {
              id: raw.args.id,
              ...("title" in raw.args && typeof raw.args.title === "string"
                ? { title: raw.args.title }
                : {}),
              description: raw.args.description,
              projectKey: raw.args.projectKey,
              projectName: raw.args.projectName,
            },
          });
      }
    } catch {
      setCorruptedRetry(true);
      setError("The pending timer change could not be read. Its stored data has been preserved.");
    }
  }, [cloud.accountID]);
  const activePending = pending?.accountID === cloud.accountID ? pending : null;
  const run = async (operation: () => Promise<unknown>) => {
    setWriting(true);
    setError(null);
    try {
      await operation();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setWriting(false);
    }
  };
  const retryPending = async (command: NonNullable<typeof pending>) => {
    await cloud.request(`timeTracking:${command.name}`, command.args);
    localStorage.removeItem(`pathway:time-pending:${command.accountID}`);
    setPending((current) => (current?.accountID === command.accountID ? null : current));
  };
  const command = async (name: "start" | "stop", args: Record<string, Value>) => {
    if (!cloud.accountID || !cloud.client) throw new Error("Sign in to track time.");
    if (activePending || corruptedRetry)
      throw new Error("Retry or discard the pending timer change first.");
    const next = { accountID: cloud.accountID, name, args };
    localStorage.setItem(`pathway:time-pending:${cloud.accountID}`, JSON.stringify(next));
    setPending(next);
    await retryPending(next);
  };
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [projectKey, setProjectKey] = useState("");

  const startTimer = (event: FormEvent) => {
    event.preventDefault();
    const trimmedDescription = description.trim();
    if (!title.trim() || !trimmedDescription || state.active) return;
    const project = projects.find(({ key }) => key === projectKey);
    void run(async () => {
      await command("start", {
        id: randomUUID(),
        title: title.trim(),
        description: trimmedDescription,
        projectKey,
        projectName: project?.title ?? "No project",
      });
      setTitle("");
      setDescription("");
    });
  };

  const stopTimer = () => {
    if (state.active) {
      const id = state.active.id;
      void run(() => command("stop", { id }));
    }
  };

  return (
    <WorkspaceViewFrame title="Time Tracker">
      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto flex w-full max-w-6xl flex-col px-5 py-6 sm:px-8 sm:py-8">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <p className="text-[11px] font-semibold tracking-[0.15em] text-muted-foreground uppercase">
                Time Tracker
              </p>
              <h1 className="mt-2 font-heading text-2xl font-semibold tracking-tight sm:text-3xl">
                A clear view of your work.
              </h1>
            </div>
            <p className="max-w-sm text-sm leading-6 text-muted-foreground">
              Manual time, agent work, and issue creation, together. Concurrent sessions each
              contribute to your project totals.
            </p>
          </div>

          {error || result.error || activeActivities.error || pageError ? (
            <p role="alert" className="mt-4 text-sm text-destructive">
              {error ?? result.error ?? activeActivities.error ?? pageError}
            </p>
          ) : null}
          {!cloud.client ? (
            <p className="mt-4 text-sm">Sign in to track time across devices.</p>
          ) : null}
          {corruptedRetry ? (
            <Button
              variant="outline"
              onClick={() => {
                localStorage.removeItem(`pathway:time-pending:${cloud.accountID}`);
                setCorruptedRetry(false);
                setError(null);
              }}
            >
              Discard unreadable timer retry
            </Button>
          ) : null}
          {activePending ? (
            <div className="mt-4 flex flex-wrap items-center gap-3 border p-3 text-sm">
              <span>A timer change is awaiting confirmation.</span>
              <Button
                disabled={writing}
                onClick={() => void run(() => retryPending(activePending))}
              >
                Retry change
              </Button>
              <Button
                variant="outline"
                disabled={writing}
                onClick={() => {
                  localStorage.removeItem(`pathway:time-pending:${cloud.accountID}`);
                  setPending(null);
                }}
              >
                Discard retry
              </Button>
              <span className="text-muted-foreground">
                Discarding a retry does not undo an accepted server change.
              </span>
            </div>
          ) : null}
          {legacyState.entries.length > 0 || legacyState.active ? (
            <div className="mt-4 border p-3 text-sm">
              <p>
                {legacyState.entries.length} completed sessions remain on this device.
                {legacyState.active
                  ? " A local timer is still recorded; importing it finishes that local session at the time you choose Import."
                  : ""}{" "}
                Originals are retained and repeated imports do not duplicate sessions.
              </p>
              <Button
                className="mt-2"
                variant="outline"
                disabled={!cloud.client || importing}
                onClick={() => {
                  setImporting(true);
                  void run(async () => {
                    try {
                      const entries = [...legacyState.entries];
                      if (legacyState.active) {
                        const stoppedAt = new Date().toISOString();
                        entries.push({
                          ...legacyState.active,
                          stoppedAt,
                          durationMs:
                            Date.parse(stoppedAt) - Date.parse(legacyState.active.startedAt),
                        });
                      }
                      for (let index = 0; index < entries.length; index += 200)
                        await cloud.request("timeTracking:importLocal", {
                          entries: entries.slice(index, index + 200).map((entry) => ({ ...entry })),
                        });
                    } finally {
                      setImporting(false);
                    }
                  });
                }}
              >
                {importing ? "Importing…" : "Import local sessions into my account"}
              </Button>
            </div>
          ) : null}
          <section className="mt-8 border-y border-border/70 py-5">
            {state.active ? (
              <div className="flex flex-col gap-5 sm:flex-row sm:items-center">
                <span className="relative flex size-11 shrink-0 items-center justify-center rounded-full bg-red-500/10 text-red-600 dark:text-red-400">
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
                <Button
                  variant="destructive"
                  onClick={stopTimer}
                  disabled={writing || !!activePending || corruptedRetry}
                >
                  <SquareIcon className="fill-current" />
                  Stop timer
                </Button>
              </div>
            ) : (
              <form className="flex flex-col gap-3 lg:flex-row" onSubmit={startTimer}>
                <Input
                  aria-label="Time entry title"
                  placeholder="What are you working on?"
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  required
                  maxLength={200}
                  className="min-w-0 flex-1"
                />
                <Input
                  aria-label="Time entry description"
                  placeholder="Describe the work"
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
                    <option key={project.key} value={project.key}>
                      {project.title}
                    </option>
                  ))}
                </select>
                <Button
                  type="submit"
                  disabled={
                    writing ||
                    !!activePending ||
                    !cloud.client ||
                    !result.value ||
                    !title.trim() ||
                    !description.trim()
                  }
                >
                  <PlayIcon className="fill-current" />
                  Start timer
                </Button>
              </form>
            )}
          </section>

          <ActiveAgentTimers sessions={automaticSessions} />
          <TimeTrackerAnalytics cloud={cloud} projects={projects} />
          <section className="mt-8">
            <div className="flex items-center justify-between gap-4">
              <h2 className="font-heading text-lg font-semibold">Recent entries</h2>
              <span className="text-xs text-muted-foreground tabular-nums">
                {orderedEntries.length} {historyDone ? "total" : "loaded"}
              </span>
            </div>
            {orderedEntries.length === 0 ? (
              <Empty className="min-h-72 border-b border-border/70">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <Clock3Icon />
                  </EmptyMedia>
                  <EmptyTitle>
                    {result.error
                      ? "Time entries unavailable"
                      : !result.value
                        ? "Loading time entries…"
                        : "No time tracked yet"}
                  </EmptyTitle>
                  <EmptyDescription>
                    {result.error
                      ? "Your history could not be loaded. Check the connection and try again."
                      : !result.value
                        ? "Waiting for your tracked activity to load."
                        : "Start a manual timer or work in a thread. Completed agent, manual, and issue sessions collect here."}
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
                      <p className="text-sm font-medium">
                        {entry.title ?? entry.description.split("\n")[0]}
                      </p>
                      {entry.title && (
                        <p className="mt-1 text-xs text-muted-foreground whitespace-pre-wrap">
                          {entry.description}
                        </p>
                      )}
                      {entry.threadId && entry.environmentId && (
                        <Link
                          className="mt-1 block text-xs text-primary hover:underline"
                          to="/threads/$environmentId/$threadId"
                          params={{ environmentId: entry.environmentId, threadId: entry.threadId }}
                        >
                          Thread:{" "}
                          {threadTitles.get(`${entry.environmentId}:${entry.threadId}`) ??
                            entry.threadId}
                        </Link>
                      )}
                      <span className="mt-1 inline-flex rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                        {entry.source === "agent"
                          ? "Agent"
                          : entry.source === "issue"
                            ? "Issue creation"
                            : "Manual"}
                      </span>
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
                      disabled={writing}
                      onClick={() =>
                        void run(async () => {
                          await cloud.request("timeTracking:remove", { id: entry.id });
                          setHistory((current) =>
                            current
                              ? {
                                  ...current,
                                  entries: current.entries.filter((row) => row.id !== entry.id),
                                }
                              : current,
                          );
                        })
                      }
                    >
                      <Trash2Icon />
                    </Button>
                  </div>
                ))}
              </div>
            )}
            {!historyDone ? (
              <Button
                className="mt-4"
                variant="outline"
                disabled={loadingMore}
                onClick={() => void loadMore()}
              >
                {loadingMore ? "Loading…" : "Load more sessions"}
              </Button>
            ) : null}
            {currentHistory ? (
              <Button className="mt-4 ml-2" variant="ghost" onClick={() => setHistory(null)}>
                Refresh history
              </Button>
            ) : null}
          </section>
        </div>
      </ScrollArea>
    </WorkspaceViewFrame>
  );
}
