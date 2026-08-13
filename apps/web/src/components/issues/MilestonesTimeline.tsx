/**
 * `/issues/milestones?view=timeline` — the same milestones the list shows, laid on a calendar.
 *
 * Bars are absolutely positioned divs over a day scale rather than SVG: a bar carries a name, a
 * completion fill, two resize edges, and a popover, and every one of those is cheaper as an element
 * than as a shape with hit-testing bolted on. Geometry and drop resolution live in
 * `milestonesTimeline.logic.ts`; this file measures the pointer and dispatches.
 *
 * Drag is the fast path, not the only one: a bar is a button that opens a date popover, so the
 * surface works from a keyboard. Undated milestones wait in the tray, and dragging a bar back into
 * it clears both dates again.
 *
 * @module components/issues/MilestonesTimeline
 */
import {
  DndContext,
  MeasuringStrategy,
  PointerSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { restrictToHorizontalAxis } from "@dnd-kit/modifiers";
import type { IssueDate, IssueMilestone, IssueMilestoneId, ProjectId } from "@t3tools/contracts";
import { ChevronDownIcon, ChevronRightIcon, FlagIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import type { IssueProgress } from "~/state/issues";
import { Button } from "../ui/button";
import { Label } from "../ui/label";
import { Popover, PopoverClose, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group";
import { formatIssueDateRange } from "./issuesList.logic";
import { formatMilestoneDateRange, type MilestonesOverviewGroup } from "./milestonesOverview.logic";
import {
  TIMELINE_GRID_DROP_ID,
  TIMELINE_TRAY_DROP_ID,
  TIMELINE_ZOOMS,
  TIMELINE_ZOOM_LABELS,
  buildTimelineRows,
  buildTimelineScale,
  milestonesTimelineRange,
  parseTimelineDragId,
  resolveTimelineDrag,
  resolveTimelineSchedule,
  resolveTimelineUnschedule,
  timelineBarDragId,
  timelineDateAtX,
  timelineDaysFromOffset,
  timelineGrabEdge,
  timelineTrayDragId,
  timelineX,
  type TimelineBar,
  type TimelineDragEdge,
  type TimelineScale,
  type TimelineZoom,
} from "./milestonesTimeline.logic";

/** Native date entry, the same control the dates dialog and the cycle dialog use. */
const DATE_INPUT_CLASS =
  "h-8 w-full rounded-md border border-input bg-transparent px-2 text-sm tabular-nums outline-none [color-scheme:light] focus-visible:ring-2 focus-visible:ring-ring dark:[color-scheme:dark]";

/** The frozen column of names, in pixels — the gridlines and the today rule start after it. */
const NAME_COLUMN_PX = 176;

/** Row heights, in pixels, so the lanes and the name column stay on the same lines. */
const HEADER_ROW_PX = 28;
const LANE_ROW_PX = 28;

/** A one-day bar at quarter zoom is 4px wide. Nobody can grab 4px, so bars never render thinner. */
const MIN_BAR_PX = 14;

export interface MilestonesTimelineProps {
  /** The overview's grouping, unchanged: the timeline is the same set read a second way. */
  readonly groups: ReadonlyArray<MilestonesOverviewGroup>;
  readonly progressByMilestone: ReadonlyMap<IssueMilestoneId, IssueProgress>;
  readonly today: IssueDate;
  readonly onDates: (
    milestone: IssueMilestone,
    startDate: IssueDate | null,
    targetDate: IssueDate | null,
  ) => void;
}

export function MilestonesTimeline({
  groups,
  progressByMilestone,
  today,
  onDates,
}: MilestonesTimelineProps) {
  const [zoom, setZoom] = useState<TimelineZoom>("month");
  const [collapsed, setCollapsed] = useState<ReadonlySet<ProjectId>>(() => new Set());
  const [dragKind, setDragKind] = useState<"bar" | "tray" | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const milestones = useMemo(() => groups.flatMap((group) => [...group.milestones]), [groups]);
  const scale = useMemo(
    () => buildTimelineScale(milestonesTimelineRange(milestones, today), zoom),
    [milestones, today, zoom],
  );
  const rows = useMemo(
    () => buildTimelineRows(groups, progressByMilestone, scale),
    [groups, progressByMilestone, scale],
  );
  const byId = useMemo(
    () => new Map(milestones.map((milestone) => [milestone.id, milestone])),
    [milestones],
  );

  const handleDragStart = (event: DragStartEvent) => {
    setDragKind(parseTimelineDragId(String(event.active.id))?.kind ?? null);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    setDragKind(null);
    const dragged = parseTimelineDragId(String(event.active.id));
    if (dragged === null) return;
    const milestone = byId.get(dragged.milestoneId);
    if (milestone === undefined) return;

    const over = event.over;
    if (over === null) return;

    // The way out: a scheduled bar dropped back in the tray loses both of its dates.
    if (over.id === TIMELINE_TRAY_DROP_ID) {
      const cleared = resolveTimelineUnschedule(milestone);
      if (cleared !== null) onDates(milestone, cleared.startDate, cleared.targetDate);
      return;
    }
    if (over.id !== TIMELINE_GRID_DROP_ID) return;

    if (dragged.kind === "tray") {
      // Where the chip came to rest, measured against the lane it landed on rather than the page.
      const translated = event.active.rect.current.translated;
      if (translated === null) return;
      const date = timelineDateAtX(scale, translated.left - over.rect.left);
      const dates = resolveTimelineSchedule(date);
      onDates(milestone, dates.startDate, dates.targetDate);
      return;
    }

    const dates = resolveTimelineDrag({
      milestone,
      edge: dragEdgeOf(event.active.data.current),
      deltaDays: timelineDaysFromOffset(scale, event.delta.x),
    });
    // Nothing optimistic: the bar sits where it started until the stream echoes the write back, so
    // a refusal simply leaves it there.
    if (dates !== null) onDates(milestone, dates.startDate, dates.targetDate);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-border/50 px-3 py-1.5 sm:px-5">
        <span className="text-xs tabular-nums text-muted-foreground">
          {formatIssueDateRange(scale.start, scale.end, today)}
        </span>
        <ToggleGroup
          aria-label="Timeline zoom"
          className="ms-auto"
          onValueChange={(next) => {
            const chosen = TIMELINE_ZOOMS.find((candidate) => candidate === next[0]);
            if (chosen !== undefined) setZoom(chosen);
          }}
          size="xs"
          value={[zoom]}
          variant="outline"
        >
          {TIMELINE_ZOOMS.map((candidate) => (
            <ToggleGroupItem key={candidate} value={candidate}>
              {TIMELINE_ZOOM_LABELS[candidate]}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>

      <DndContext
        collisionDetection={pointerWithin}
        // Lanes scroll under the pointer mid-drag, so a rect measured once at drag start stops
        // being true as soon as somebody drags toward an edge.
        measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
        // Bars stay on their lane, whichever part of one is being dragged: they live inside the
        // scrolling grid, and one lifted out of it would be clipped away rather than seen crossing
        // the tray. Nothing is lost — `pointerWithin` resolves the drop against the pointer, so the
        // tray still takes a bar the pointer reaches. A tray chip is outside the grid and free.
        modifiers={dragKind === "bar" ? [restrictToHorizontalAxis] : []}
        onDragCancel={() => setDragKind(null)}
        onDragEnd={handleDragEnd}
        onDragStart={handleDragStart}
        sensors={sensors}
      >
        <MilestoneTray milestones={rows.undated} onDates={onDates} />

        <div className="min-h-0 flex-1 overflow-auto">
          <div
            className="relative min-w-max pb-6"
            style={{ minWidth: NAME_COLUMN_PX + scale.width }}
          >
            <TimelineGrid scale={scale} today={today} />

            <div className="sticky top-0 z-30 flex bg-background" style={{ height: HEADER_ROW_PX }}>
              <div
                className="sticky z-40 shrink-0 bg-background"
                style={{ insetInlineStart: 0, width: NAME_COLUMN_PX }}
              />
              <div className="relative shrink-0" style={{ width: scale.width }}>
                {scale.ticks.map((tick) => (
                  <span
                    className={cn(
                      "absolute top-1.5 ps-1 text-[10px] whitespace-nowrap tabular-nums",
                      tick.major ? "text-muted-foreground" : "text-muted-foreground/50",
                    )}
                    key={tick.date}
                    style={{ insetInlineStart: tick.x }}
                  >
                    {tick.label}
                  </span>
                ))}
              </div>
            </div>

            <div className="relative z-10">
              {rows.rows.map((row) => {
                const open = !collapsed.has(row.projectId);
                return (
                  <div key={row.projectId}>
                    <div className="flex" style={{ height: LANE_ROW_PX }}>
                      <div
                        className="sticky z-20 flex shrink-0 items-center bg-background pe-2"
                        style={{ insetInlineStart: 0, width: NAME_COLUMN_PX }}
                      >
                        <button
                          aria-expanded={open}
                          className="flex min-w-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
                          onClick={() =>
                            setCollapsed((previous) => {
                              const next = new Set(previous);
                              if (!next.delete(row.projectId)) next.add(row.projectId);
                              return next;
                            })
                          }
                          type="button"
                        >
                          {open ? (
                            <ChevronDownIcon className="size-3.5 shrink-0" />
                          ) : (
                            <ChevronRightIcon className="size-3.5 shrink-0" />
                          )}
                          <span className="truncate">{row.title}</span>
                        </button>
                      </div>
                    </div>

                    {!open ? null : row.bars.length === 0 ? (
                      <div className="flex" style={{ height: LANE_ROW_PX }}>
                        <span
                          className="sticky z-20 shrink-0 bg-background ps-7 text-[11px] leading-7 text-muted-foreground/60"
                          style={{ insetInlineStart: 0, width: NAME_COLUMN_PX }}
                        >
                          Nothing scheduled
                        </span>
                      </div>
                    ) : (
                      row.bars.map((bar) => (
                        <TimelineBarRow
                          bar={bar}
                          key={bar.milestone.id}
                          onDates={onDates}
                          scale={scale}
                          today={today}
                        />
                      ))
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </DndContext>
    </div>
  );
}

/** `data.edge` as `@dnd-kit` hands it back — an unknown value is a body drag, which moves both ends. */
function dragEdgeOf(data: Record<string, unknown> | undefined): TimelineDragEdge {
  const edge = data?.edge;
  return edge === "start" || edge === "end" ? edge : "move";
}

/**
 * The gridlines, the today rule, and the drop target every scheduled bar lands on — one box, so the
 * droppable's left edge is exactly day zero and a dropped chip's date is a subtraction.
 *
 * It takes no pointer events: `pointerWithin` resolves against measured rects, not hit-testing, so
 * the layer can sit under the bars without stealing their presses.
 */
function TimelineGrid({ scale, today }: { scale: TimelineScale; today: IssueDate }) {
  const { setNodeRef } = useDroppable({ id: TIMELINE_GRID_DROP_ID });
  return (
    <div
      className="pointer-events-none absolute bottom-0 z-0"
      ref={setNodeRef}
      style={{ insetInlineStart: NAME_COLUMN_PX, top: HEADER_ROW_PX, width: scale.width }}
    >
      {scale.ticks.map((tick) => (
        <div
          className={cn("absolute inset-y-0 w-px", tick.major ? "bg-border/70" : "bg-border/30")}
          key={tick.date}
          style={{ insetInlineStart: tick.x }}
        />
      ))}
      <div
        className="absolute inset-y-0 w-px bg-primary/60"
        style={{ insetInlineStart: timelineX(scale, today) }}
      />
    </div>
  );
}

/**
 * Milestones with no dates at all. They have nowhere to sit on a calendar, and hiding them would
 * hide the ones most in need of planning — so they wait here until one is dragged onto a lane, and
 * come back the moment a bar is dragged in.
 */
function MilestoneTray({
  milestones,
  onDates,
}: {
  milestones: ReadonlyArray<IssueMilestone>;
  onDates: (
    milestone: IssueMilestone,
    startDate: IssueDate | null,
    targetDate: IssueDate | null,
  ) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: TIMELINE_TRAY_DROP_ID });
  return (
    <div
      className={cn(
        "flex min-h-11 shrink-0 flex-wrap items-center gap-1.5 border-b border-border/50 px-3 py-1.5 transition-colors motion-reduce:transition-none sm:px-5",
        isOver && "bg-accent/40",
      )}
      ref={setNodeRef}
    >
      <span className="text-[11px] font-medium text-muted-foreground">Unscheduled</span>
      {milestones.length === 0 ? (
        <span className="text-[11px] text-muted-foreground/60">
          Drag a bar here to clear its dates.
        </span>
      ) : (
        milestones.map((milestone) => (
          <TrayChip key={milestone.id} milestone={milestone} onDates={onDates} />
        ))
      )}
    </div>
  );
}

/**
 * An undated milestone waiting for dates. Dragging it onto a lane is the fast way to give it some;
 * pressing it opens the same date popover a bar does, because dragging is the one gesture a
 * keyboard cannot make and the tray is the only way onto the calendar.
 */
function TrayChip({
  milestone,
  onDates,
}: {
  milestone: IssueMilestone;
  onDates: (
    milestone: IssueMilestone,
    startDate: IssueDate | null,
    targetDate: IssueDate | null,
  ) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: timelineTrayDragId(milestone.id),
  });
  // A drag ends with the pointer still on the chip, so the click the popover would open on has to
  // be swallowed — the same trade a bar makes.
  const dragged = useRef(false);
  useEffect(() => {
    if (isDragging) dragged.current = true;
  }, [isDragging]);

  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            {...attributes}
            {...listeners}
            aria-label={`Schedule ${milestone.name}`}
            className={cn(
              "flex max-w-48 cursor-grab touch-none items-center gap-1 rounded-full border border-border/60 bg-muted/50 px-2 py-0.5 text-[11px] outline-none focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing",
              isDragging && "z-50 shadow-xs",
            )}
            onClick={(event) => {
              if (!dragged.current) return;
              dragged.current = false;
              event.preventDefault();
            }}
            onPointerDown={(event) => {
              dragged.current = false;
              // Ours shadows the sensor's own `onPointerDown`, so the drag starts from here.
              listeners?.onPointerDown?.(event);
            }}
            ref={setNodeRef}
            style={
              transform === null
                ? undefined
                : { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` }
            }
            type="button"
          />
        }
      >
        <FlagIcon className="size-3 shrink-0 text-muted-foreground" />
        <span className="truncate">{milestone.name}</span>
      </PopoverTrigger>

      <MilestoneDatesPopover
        key={`${milestone.startDate ?? ""}:${milestone.targetDate ?? ""}`}
        milestone={milestone}
        onDates={onDates}
      />
    </Popover>
  );
}

/**
 * One milestone: its name in the frozen column and its bar on the lane.
 *
 * Drag feedback is transform only. A body drag translates the bar by whole days; an edge drag
 * leaves the bar where it is and translates a rule at the end being moved, because a width that
 * follows the pointer is a layout pass on every pointer move and the rule says the same thing.
 */
function TimelineBarRow({
  bar,
  scale,
  today,
  onDates,
}: {
  bar: TimelineBar;
  scale: TimelineScale;
  today: IssueDate;
  onDates: (
    milestone: IssueMilestone,
    startDate: IssueDate | null,
    targetDate: IssueDate | null,
  ) => void;
}) {
  const { milestone } = bar;
  const [edge, setEdge] = useState<TimelineDragEdge>("move");
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    data: { edge },
    id: timelineBarDragId(milestone.id),
  });
  // A drag ends with the pointer still on the bar, so the browser fires the click the popover would
  // otherwise open on. Base UI skips its own handler once ours has called `preventDefault`.
  const dragged = useRef(false);
  useEffect(() => {
    if (isDragging) dragged.current = true;
  }, [isDragging]);

  const dates = formatMilestoneDateRange(milestone.startDate, milestone.targetDate, today);
  const snappedX = timelineDaysFromOffset(scale, transform?.x ?? 0) * scale.dayWidth;
  const width = Math.max(bar.width, MIN_BAR_PX);
  const complete = bar.completionRatio >= 1;
  const resizing = isDragging && edge !== "move";

  return (
    <div className="flex" style={{ height: LANE_ROW_PX }}>
      <div
        className="sticky z-20 flex shrink-0 items-center bg-background ps-7 pe-2"
        style={{ insetInlineStart: 0, width: NAME_COLUMN_PX }}
      >
        <span className="truncate text-xs text-muted-foreground">{milestone.name}</span>
      </div>
      <div className="relative shrink-0" style={{ width: scale.width }}>
        <Popover>
          <PopoverTrigger
            render={
              <button
                {...attributes}
                {...listeners}
                aria-label={`${milestone.name}, ${dates ?? "no dates"}`}
                className={cn(
                  "absolute top-1 h-5 touch-none overflow-hidden rounded-md border text-start outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  bar.dated === "both" ? "cursor-grab active:cursor-grabbing" : "cursor-pointer",
                  complete ? "border-success/50 bg-success/15" : "border-border/60 bg-muted",
                  isDragging && "z-40 shadow-xs",
                )}
                onClick={(event) => {
                  if (!dragged.current) return;
                  dragged.current = false;
                  event.preventDefault();
                }}
                onPointerDown={(event) => {
                  // A press that never became a drag has nothing to swallow on the way out.
                  dragged.current = false;
                  const rect = event.currentTarget.getBoundingClientRect();
                  setEdge(
                    bar.dated === "both"
                      ? timelineGrabEdge({ offsetX: event.clientX - rect.left, width: rect.width })
                      : "move",
                  );
                  // Ours shadows the sensor's own `onPointerDown`, so the drag starts from here —
                  // after the edge is known, which is what the drag then resolves against.
                  listeners?.onPointerDown?.(event);
                }}
                ref={setNodeRef}
                style={{
                  insetInlineStart: bar.x,
                  width,
                  transform:
                    transform === null || edge !== "move"
                      ? undefined
                      : `translate3d(${snappedX}px, ${transform.y}px, 0)`,
                }}
                type="button"
              />
            }
          >
            <span
              className={cn(
                "absolute inset-y-0 start-0",
                complete ? "bg-success/45" : "bg-primary/45",
              )}
              style={{ width: `${bar.completionRatio * 100}%` }}
            />
            <span className="relative flex h-full items-center px-1.5 text-[11px] whitespace-nowrap">
              {milestone.name}
            </span>
            {bar.dated === "both" ? (
              <>
                <span className="absolute inset-y-0 start-0 w-1.5 cursor-ew-resize bg-foreground/10" />
                <span className="absolute inset-y-0 end-0 w-1.5 cursor-ew-resize bg-foreground/10" />
              </>
            ) : null}
          </PopoverTrigger>

          {/* Where the edge being dragged is going to land, snapped to the day it will write. */}
          {resizing ? (
            <span
              className="pointer-events-none absolute top-0.5 h-6 w-0.5 bg-primary"
              style={{
                insetInlineStart: edge === "start" ? bar.x : bar.x + width,
                transform: `translate3d(${snappedX}px, 0, 0)`,
              }}
            />
          ) : null}

          <MilestoneDatesPopover
            key={`${milestone.startDate ?? ""}:${milestone.targetDate ?? ""}`}
            milestone={milestone}
            onDates={onDates}
          />
        </Popover>
      </div>
    </div>
  );
}

/**
 * The non-drag path, and the only path from a keyboard: type either date, or clear both. Keyed on
 * the stored dates by its parent, so a drag that lands while the popover is closed is what it opens
 * with next time.
 */
function MilestoneDatesPopover({
  milestone,
  onDates,
}: {
  milestone: IssueMilestone;
  onDates: (
    milestone: IssueMilestone,
    startDate: IssueDate | null,
    targetDate: IssueDate | null,
  ) => void;
}) {
  const [startDate, setStartDate] = useState(milestone.startDate ?? "");
  const [targetDate, setTargetDate] = useState(milestone.targetDate ?? "");
  const backwards = startDate.length > 0 && targetDate.length > 0 && startDate > targetDate;

  return (
    <PopoverPopup align="start" className="w-64 p-2" side="bottom">
      <p className="pb-1.5 text-xs font-medium">{milestone.name}</p>
      <div className="flex items-center gap-2">
        <Label className="flex min-w-0 flex-1 flex-col gap-1 text-[11px] text-muted-foreground">
          Starts
          <input
            aria-label={`${milestone.name} start date`}
            className={DATE_INPUT_CLASS}
            onChange={(event) => setStartDate(event.currentTarget.value)}
            type="date"
            value={startDate}
          />
        </Label>
        <Label className="flex min-w-0 flex-1 flex-col gap-1 text-[11px] text-muted-foreground">
          Target
          <input
            aria-label={`${milestone.name} target date`}
            className={DATE_INPUT_CLASS}
            onChange={(event) => setTargetDate(event.currentTarget.value)}
            type="date"
            value={targetDate}
          />
        </Label>
      </div>
      {backwards ? (
        <p className="pt-1.5 text-[11px] text-destructive-foreground">
          A milestone cannot start after its target date.
        </p>
      ) : null}
      <div className="flex items-center gap-1.5 pt-2">
        <PopoverClose
          render={
            <Button
              className="text-muted-foreground"
              onClick={() => onDates(milestone, null, null)}
              size="sm"
              variant="ghost"
            />
          }
        >
          Clear dates
        </PopoverClose>
        <PopoverClose
          className="ms-auto"
          render={
            <Button
              disabled={backwards}
              onClick={() => {
                if (backwards) return;
                onDates(
                  milestone,
                  startDate.length === 0 ? null : (startDate as IssueDate),
                  targetDate.length === 0 ? null : (targetDate as IssueDate),
                );
              }}
              size="sm"
            />
          }
        >
          Save
        </PopoverClose>
      </div>
    </PopoverPopup>
  );
}
