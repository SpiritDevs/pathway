/**
 * `/calendar` — one surface, one URL, one filter sidebar, four modes.
 *
 * Day, Week, and Month are the time grid; Timeline is the Gantt. They are modes of one screen
 * rather than four screens because they answer questions about the same dates (ADR 0011): the mode
 * rides in the URL next to the anchor date, so a link carries what somebody was looking at, and
 * switching modes keeps the day you were on rather than resetting to today.
 *
 * Everything the surface decides without the DOM is in `calendarGrid.logic`; this file is the
 * wiring — atoms and hooks in, Convex mutations and issue commands out.
 *
 * The keys are ordinary rebindable commands with a `calendarView` `when` clause. What is handled
 * here is only the dispatch and the guard that a bare letter does not fire mid-word; see
 * `calendarKeybindings.logic`.
 *
 * @module components/calendar/CalendarPage
 */
import { useAtomValue } from "@effect/atom-react";
import type { AtomCommandResult } from "@spiritdevs/client-runtime/state/runtime";
import type {
  IssueCycleId,
  IssueDate,
  IssueId,
  IssueMilestoneId,
  CalendarEventId,
  CalendarId,
} from "@spiritdevs/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  Columns3Icon,
  GanttChartIcon,
  Grid3x3Icon,
  PlusIcon,
  SquareIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { primaryServerKeybindingsAtom } from "~/state/server";
import { useClientSettings } from "~/hooks/useSettings";
import { useTodayIssueDate } from "~/hooks/useTodayIssueDate";
import { resolveShortcutCommand } from "~/keybindings";
import { cn } from "~/lib/utils";
import {
  useIssueCycles,
  useIssueMilestoneProgress,
  useIssueMilestones,
  useIssuesStore,
  useUpdateIssue,
  useUpdateIssueCycle,
  useUpdateIssueMilestone,
} from "~/state/issues";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "~/workspaceTitlebar";
import { useIssueProjectOptions } from "../issues/useIssueProjectOptions";
import { milestonesOverviewGroups } from "../issues/milestonesOverview.logic";
import { reportIssueWriteFailure } from "../issues/issueWriteFeedback";
import { Button } from "../ui/button";
import { SidebarInset } from "../ui/sidebar";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { CalendarAccessDenied } from "./CalendarSidebar";
import { CalendarEventDialog, type CalendarEventDraft } from "./CalendarEventDialog";
import { CalendarMonthGrid } from "./CalendarMonthGrid";
import { CalendarTimeGrid } from "./CalendarTimeGrid";
import { CalendarTimelineView } from "./CalendarTimelineView";
import {
  buildCalendarDays,
  calendarAnchor,
  calendarAnchorPatch,
  calendarEventsInRange,
  calendarMode,
  calendarRange,
  calendarWallClock,
  formatCalendarRangeLabel,
  isCalendarTimeGridMode,
  makeCalendarCreateTarget,
  resolveCalendarNewEvent,
  shiftCalendarAnchor,
  type CalendarAllDayItem,
  type CalendarDropWrite,
  type CalendarEventInput,
  type CalendarMode,
  type CalendarSearch,
  type CalendarSearchPatch,
} from "./calendarGrid.logic";
import { calendarKeyAction, calendarKeyIsAllowed } from "./calendarKeybindings.logic";
import {
  useCalendarLayers,
  useCalendarWriter,
  viewerTimeZone,
  type CalendarWriter,
} from "./useCalendarSurface";

export { parseCalendarSearch } from "./calendarGrid.logic";

const MODE_ICONS = {
  day: SquareIcon,
  week: Columns3Icon,
  month: Grid3x3Icon,
  timeline: GanttChartIcon,
} as const satisfies Record<CalendarMode, typeof SquareIcon>;

const MODE_LABELS: Readonly<Record<CalendarMode, string>> = {
  day: "Day",
  week: "Week",
  month: "Month",
  timeline: "Timeline",
};

const MODE_ORDER: ReadonlyArray<CalendarMode> = ["day", "week", "month", "timeline"];

export function CalendarPage({
  search,
  onSearch,
}: {
  readonly search: CalendarSearch;
  readonly onSearch: (patch: CalendarSearchPatch) => void;
}) {
  const surface = useCalendarLayers();
  const writer = useCalendarWriter(surface.viewer);
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  // Tracked rather than read once per mount: the Today button, the `t` key, the highlighted day and
  // every cycle status read from this, and a calendar is exactly the surface somebody leaves open
  // past midnight. One timeout on the boundary, not a tick.
  const today = useTodayIssueDate();
  const timeZone = useMemo(() => viewerTimeZone(), []);

  const mode = calendarMode(search);
  const anchor = calendarAnchor(search, today);
  const [dialog, setDialog] = useState<CalendarEventDraft | null>(null);

  const setMode = useCallback((next: CalendarMode) => onSearch({ mode: next }), [onSearch]);
  const goTo = useCallback(
    (date: IssueDate) => onSearch(calendarAnchorPatch(date, today)),
    [onSearch, today],
  );
  const step = useCallback(
    (direction: -1 | 1) => goTo(shiftCalendarAnchor(mode, anchor, direction)),
    [anchor, goTo, mode],
  );

  const range = useMemo(() => calendarRange(mode, anchor), [anchor, mode]);
  const days = useMemo(
    () =>
      buildCalendarDays({
        range,
        today,
        ...(mode === "month" ? { anchorMonth: anchor } : {}),
      }),
    [anchor, mode, range, today],
  );

  // The surface holds every event on every visible calendar, which is a whole company's history and
  // no cheaper to lay out for being off screen.
  const events = useMemo(
    () => calendarEventsInRange(surface.events, range),
    [range, surface.events],
  );

  const work = useCalendarWorkItems({ hiddenLayers: surface.hiddenLayers });
  const { writeDates } = work;
  const allDayItems = useMemo(
    () => [...allDayEventItems(events), ...work.allDayItems],
    [events, work.allDayItems],
  );

  const openNewEvent = useCallback(
    (slot?: { readonly startAt: number; readonly endAt: number }) => {
      if (surface.defaultCalendarId === null && !writer.ready) return;
      const start = slot ?? defaultSlotOn(anchor, timeZone);
      setDialog({ mode: "create", title: "", timeZone, allDay: false, ...start });
    },
    [anchor, surface.defaultCalendarId, writer.ready, timeZone],
  );

  useCalendarKeys({
    enabled: surface.viewer.canRead !== false,
    onAction: (action) => {
      if (action.kind === "mode") setMode(action.mode);
      else if (action.kind === "today") goTo(today);
      else if (action.kind === "step") step(action.direction);
      else openNewEvent();
    },
  });

  // Rebuilt with the writer, so switching company never lands an event on the other company's
  // pending calendar.
  const createTarget = useMemo(
    () => makeCalendarCreateTarget(() => writer.createCalendar("My calendar")),
    [writer],
  );

  const writeEvent = useCallback(
    (
      event: CalendarEventInput,
      patch: { readonly startAt: number; readonly endAt: number; readonly allDay?: boolean },
    ) => {
      // Built field by field: `patch` is often a tagged drop result, and a spread would send its
      // `_tag` to a Convex validator that rejects unknown fields.
      void writer
        .updateEvent({
          eventId: event.id as CalendarEventId,
          startAt: patch.startAt,
          endAt: patch.endAt,
          ...(patch.allDay === undefined ? {} : { allDay: patch.allDay }),
        })
        .catch((error: unknown) => reportCalendarFailure("Failed to move the event", error));
    },
    [writer],
  );

  const writeAllDay = useCallback(
    (item: CalendarAllDayItem, result: CalendarDropWrite) => {
      if (result._tag === "Instants") {
        void writer
          .updateEvent({
            eventId: item.id as CalendarEventId,
            startAt: result.startAt,
            endAt: result.endAt,
          })
          .catch((error: unknown) => reportCalendarFailure("Failed to move the event", error));
        return;
      }
      writeDates(item, result.startDate, result.endDate);
    },
    [writer, writeDates],
  );

  if (surface.viewer.canRead === false) {
    return (
      <CalendarShell
        anchor={anchor}
        mode={mode}
        onNewEvent={null}
        onSetMode={setMode}
        onStep={step}
        onToday={() => goTo(today)}
      >
        <CalendarAccessDenied />
      </CalendarShell>
    );
  }

  return (
    <CalendarShell
      anchor={anchor}
      mode={mode}
      onNewEvent={writer.ready ? () => openNewEvent() : null}
      onSetMode={setMode}
      onStep={step}
      onToday={() => goTo(today)}
    >
      {mode === "timeline" ? (
        <CalendarTimelineView
          cycles={work.cycles}
          groups={work.groups}
          issues={work.dueIssues}
          progressByMilestone={work.progressByMilestone}
          today={today}
        />
      ) : mode === "month" ? (
        <CalendarMonthGrid
          allDayItems={allDayItems}
          days={days}
          events={events}
          onOpenChip={(chip) => {
            const event = events.find((candidate) => candidate.id === chip.id);
            if (event !== undefined) {
              setDialog(draftFromEvent(event));
              return;
            }
            const item = allDayItems.find((candidate) => candidate.id === chip.id);
            if (item !== undefined) work.openItem(item);
          }}
          onOpenDay={(date) => {
            goTo(date);
            setMode("day");
          }}
          timestampFormat={timestampFormat}
        />
      ) : (
        <CalendarTimeGrid
          allDayItems={allDayItems}
          days={days}
          events={events}
          onAllDayWrite={writeAllDay}
          onCreate={writer.ready ? (slot) => openNewEvent(slot) : null}
          onEventWrite={writeEvent}
          onOpenAllDayItem={(item) => {
            if (item.kind !== "event") {
              work.openItem(item);
              return;
            }
            const event = events.find((candidate) => candidate.id === item.id);
            if (event !== undefined) setDialog(draftFromEvent(event));
          }}
          onOpenEvent={(event) => setDialog(draftFromEvent(event))}
          timeZone={timeZone}
          timestampFormat={timestampFormat}
          today={today}
        />
      )}

      {dialog === null ? null : (
        <CalendarEventDialog
          draft={dialog}
          key={dialog.mode === "edit" ? dialog.eventId : "create"}
          onClose={() => setDialog(null)}
          onDelete={
            dialog.mode === "edit" && dialog.editable
              ? () => {
                  const eventId = dialog.eventId;
                  setDialog(null);
                  void writer
                    .deleteEvent(eventId)
                    .catch((error: unknown) =>
                      reportCalendarFailure("Failed to delete the event", error),
                    );
                }
              : null
          }
          onSubmit={(next) => {
            setDialog(null);
            const failed = (error: unknown) =>
              reportCalendarFailure(
                next.mode === "create" ? "Failed to create the event" : "Failed to save the event",
                error,
              );
            if (next.mode === "create") {
              void createEventOn(createTarget(surface.defaultCalendarId), writer, next).catch(
                failed,
              );
              return;
            }
            void writer
              .updateEvent({
                eventId: next.eventId,
                title: next.title,
                startAt: next.startAt,
                endAt: next.endAt,
                allDay: next.allDay,
              })
              .catch(failed);
          }}
        />
      )}
    </CalendarShell>
  );
}

/**
 * The first event a member creates has nowhere to go until they own a calendar, so the calendar is
 * made on the way. Doing it here rather than on first visit means somebody who only ever reads
 * other people's calendars never acquires an empty one of their own. Which calendar that is — and
 * that two quick creates share one — is {@link makeCalendarCreateTarget}'s.
 */
async function createEventOn(
  calendarId: Promise<string>,
  writer: CalendarWriter,
  draft: Extract<CalendarEventDraft, { mode: "create" }>,
): Promise<void> {
  await writer.createEvent({
    calendarId: (await calendarId) as CalendarId,
    title: draft.title,
    startAt: draft.startAt,
    endAt: draft.endAt,
    timeZone: draft.timeZone,
    allDay: draft.allDay,
  });
}

/**
 * What a refused calendar write says.
 *
 * Nothing on this surface is optimistic — a block stays where it was until the feed echoes the
 * write back — so a refusal is indistinguishable from a press that never registered unless it says
 * so. The message is already friendly by the time it arrives; `mapCalendarWriteError` did that.
 */
function reportCalendarFailure(title: string, error: unknown): void {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "An error occurred.",
    }),
  );
}

function draftFromEvent(event: CalendarEventInput): CalendarEventDraft {
  return {
    mode: "edit",
    eventId: event.id as CalendarEventId,
    title: event.title,
    startAt: event.startAt,
    endAt: event.endAt,
    timeZone: event.timeZone,
    allDay: event.allDay,
    editable: event.editable,
  };
}

/** 9am on the anchor day — where `c` puts an event when no slot was pointed at. */
function defaultSlotOn(anchor: IssueDate, timeZone: string) {
  const write = resolveCalendarNewEvent({ date: anchor, minutes: 9 * 60, timeZone });
  return { startAt: write.startAt, endAt: write.endAt };
}

function allDayEventItems(
  events: ReadonlyArray<CalendarEventInput>,
): ReadonlyArray<CalendarAllDayItem> {
  const items: Array<CalendarAllDayItem> = [];
  for (const event of events) {
    if (!event.allDay) continue;
    const start = calendarWallClock(event.startAt, event.timeZone);
    // The stored end is midnight opening the day *after* the span, so the last covered day is the
    // one a minute earlier. Reading the raw end would draw every all-day event a day too long.
    const end = calendarWallClock(Math.max(event.startAt, event.endAt - 60_000), event.timeZone);
    items.push({
      id: event.id,
      kind: "event",
      title: event.title,
      startDate: start.date,
      endDate: end.date,
      editable: event.editable,
      timeZone: event.timeZone,
    });
  }
  return items;
}

// ---------------------------------------------------------------------------
// Work layers
// ---------------------------------------------------------------------------

/**
 * The date-only sources: issue due dates, milestones, and cycles.
 *
 * They reach the all-day lane and nothing else, and every write they take is a date. The Timeline
 * mode reads the same three, which is what keeps a layer toggle meaning the same thing in both.
 */
function useCalendarWorkItems({ hiddenLayers }: { readonly hiddenLayers: ReadonlySet<string> }) {
  const navigate = useNavigate();
  const store = useIssuesStore();
  const milestones = useIssueMilestones();
  const cycles = useIssueCycles();
  const progressByMilestone = useIssueMilestoneProgress();
  const projects = useIssueProjectOptions();
  const updateIssue = useUpdateIssue();
  const updateMilestone = useUpdateIssueMilestone();
  const updateCycle = useUpdateIssueCycle();

  const showIssues = !hiddenLayers.has("issues");
  const showMilestones = !hiddenLayers.has("milestones");
  const showCycles = !hiddenLayers.has("cycles");

  const issues = useMemo(() => [...store.issuesById.values()], [store.issuesById]);
  const dueIssues = useMemo(
    () =>
      showIssues
        ? issues.map((issue) => ({
            id: issue.id,
            key: issue.key,
            title: issue.title,
            projectId: issue.projectId,
            dueDate: issue.dueDate,
          }))
        : [],
    [issues, showIssues],
  );
  const groups = useMemo(
    () => (showMilestones ? milestonesOverviewGroups(projects, milestones, undefined) : []),
    [milestones, projects, showMilestones],
  );

  const allDayItems = useMemo(() => {
    const items: Array<CalendarAllDayItem> = [];
    if (showIssues) {
      for (const issue of issues) {
        if (issue.dueDate === null) continue;
        items.push({
          id: issue.id,
          kind: "issue",
          title: `${issue.key} ${issue.title}`,
          startDate: issue.dueDate,
          endDate: issue.dueDate,
          editable: true,
          timeZone: null,
        });
      }
    }
    if (showMilestones) {
      for (const milestone of milestones) {
        const start = milestone.startDate ?? milestone.targetDate;
        const end = milestone.targetDate ?? milestone.startDate;
        if (start === null || end === null) continue;
        items.push({
          id: milestone.id,
          kind: "milestone",
          title: milestone.name,
          startDate: start,
          endDate: end,
          editable: true,
          timeZone: null,
        });
      }
    }
    if (showCycles) {
      for (const cycle of cycles) {
        items.push({
          id: cycle.id,
          kind: "cycle",
          title: cycle.name,
          startDate: cycle.startDate,
          endDate: cycle.endDate,
          editable: true,
          timeZone: null,
        });
      }
    }
    return items;
  }, [cycles, issues, milestones, showCycles, showIssues, showMilestones]);

  /**
   * The one write a date-only item takes.
   *
   * Every branch here writes an `IssueDate` and there is nowhere in it to put a time, which is the
   * point: {@link resolveCalendarAllDayDrop} could not have produced one to pass in.
   */
  const writeDates = useCallback(
    (item: CalendarAllDayItem, startDate: IssueDate, endDate: IssueDate) => {
      const report = (title: string) => (result: AtomCommandResult<unknown, unknown>) => {
        reportIssueWriteFailure(title, result);
      };
      if (item.kind === "issue") {
        void updateIssue({ issueId: item.id as IssueId, patch: { dueDate: endDate } }).then(
          report("Failed to move the due date"),
        );
        return;
      }
      if (item.kind === "milestone") {
        void updateMilestone({
          milestoneId: item.id as IssueMilestoneId,
          patch: { startDate, targetDate: endDate },
        }).then(report("Failed to move the milestone"));
        return;
      }
      if (item.kind === "cycle") {
        void updateCycle({
          cycleId: item.id as IssueCycleId,
          patch: { startDate, endDate },
        }).then(report("Failed to move the cycle"));
      }
    },
    [updateCycle, updateIssue, updateMilestone],
  );

  /**
   * Where a work chip goes when it is pressed.
   *
   * Typed navigation per kind rather than a stored URL: an issue is reached through the list's
   * search params and a milestone through its own route, and spelling either as a string here would
   * be a second definition of a link the router already owns. A cycle has no page of its own, so
   * pressing one does nothing — and it is not made focusable in a way that promises otherwise.
   */
  const openItem = useCallback(
    (item: CalendarAllDayItem) => {
      if (item.kind === "issue") {
        const issue = store.issuesById.get(item.id as IssueId);
        if (issue === undefined) return;
        void navigate({ to: "/issues", search: { issue: issue.key } });
        return;
      }
      if (item.kind === "milestone") {
        void navigate({
          to: "/issues/milestones/$milestoneId",
          params: { milestoneId: item.id },
        });
      }
    },
    [navigate, store.issuesById],
  );

  return {
    allDayItems,
    cycles: showCycles ? cycles : [],
    dueIssues,
    groups,
    openItem,
    progressByMilestone,
    writeDates,
  };
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

/**
 * The surface's own key handling.
 *
 * It resolves through the user's bindings with `calendarView` on, which is what makes these keys
 * rebindable and what keeps them from firing on any other surface — this listener only exists while
 * `/calendar` is mounted, and every other listener resolves with `calendarView` false.
 */
function useCalendarKeys({
  enabled,
  onAction,
}: {
  readonly enabled: boolean;
  readonly onAction: (action: NonNullable<ReturnType<typeof calendarKeyAction>>) => void;
}) {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  // The handler closes over the anchor and the mode, both of which change on every press, so it is
  // held in a ref rather than in the dependency list: rebinding a window listener on every render
  // would tear down and re-add it between a key going down and the next one.
  const onActionRef = useRef(onAction);
  onActionRef.current = onAction;
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.repeat) return;
      if (!calendarKeyIsAllowed(event)) return;
      const action = calendarKeyAction(
        resolveShortcutCommand(event, keybindings, { context: { calendarView: true } }),
      );
      if (action === null) return;
      event.preventDefault();
      event.stopPropagation();
      onActionRef.current(action);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled, keybindings]);
}

// ---------------------------------------------------------------------------
// Chrome
// ---------------------------------------------------------------------------

/** The header, the toolbar, and whichever mode is mounted under them. */
function CalendarShell({
  anchor,
  children,
  mode,
  onNewEvent,
  onSetMode,
  onStep,
  onToday,
}: {
  readonly anchor: IssueDate;
  readonly children: React.ReactNode;
  readonly mode: CalendarMode;
  readonly onNewEvent: (() => void) | null;
  readonly onSetMode: (mode: CalendarMode) => void;
  readonly onStep: (direction: -1 | 1) => void;
  readonly onToday: () => void;
}) {
  const steppable = isCalendarTimeGridMode(mode);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <header
          className={cn(
            "workspace-topbar drag-region px-3 transition-[padding-left] duration-200 ease-linear motion-reduce:transition-none sm:px-5",
            COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
          )}
        >
          <WorkspaceBreadcrumb ariaLabel="Calendar breadcrumb">
            <WorkspaceBreadcrumbItem current>Calendar</WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
        </header>

        <div className="flex items-center gap-2 border-b border-border/50 px-3 py-1.5 sm:px-5">
          <h1 className="text-sm font-medium tabular-nums">
            {formatCalendarRangeLabel(mode, anchor)}
          </h1>

          {steppable ? (
            <div className="flex items-center gap-0.5">
              <Button
                aria-label="Previous"
                onClick={() => onStep(-1)}
                size="icon-sm"
                variant="ghost"
              >
                <ChevronLeftIcon />
              </Button>
              <Button aria-label="Next" onClick={() => onStep(1)} size="icon-sm" variant="ghost">
                <ChevronRightIcon />
              </Button>
              <Button className="text-xs" onClick={onToday} size="sm" variant="ghost">
                Today
              </Button>
            </div>
          ) : null}

          <div className="ms-auto flex items-center gap-1.5">
            {onNewEvent === null ? null : (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button aria-label="New event" onClick={onNewEvent} size="sm" variant="outline">
                      <PlusIcon />
                      New event
                    </Button>
                  }
                />
                <TooltipPopup side="bottom">Create an event (C)</TooltipPopup>
              </Tooltip>
            )}

            {/* The mode rides in the URL, and the default rides as an absent param — the same rule
                `/issues` and the milestones view follow. */}
            <ToggleGroup
              aria-label="Calendar mode"
              onValueChange={(next) => {
                const chosen = MODE_ORDER.find((candidate) => candidate === next[0]);
                if (chosen !== undefined) onSetMode(chosen);
              }}
              size="xs"
              value={[mode]}
              variant="outline"
            >
              {MODE_ORDER.map((candidate) => {
                const Icon = MODE_ICONS[candidate];
                return (
                  <ToggleGroupItem
                    aria-label={`${MODE_LABELS[candidate]} view`}
                    key={candidate}
                    value={candidate}
                  >
                    <Icon />
                  </ToggleGroupItem>
                );
              })}
            </ToggleGroup>
          </div>
        </div>

        <div className="relative flex min-h-0 flex-1 flex-col">{children}</div>
      </div>
    </SidebarInset>
  );
}
