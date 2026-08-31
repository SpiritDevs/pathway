/**
 * The hour grid behind Day and Week: an all-day lane on top, twenty-four hour rows under it, and
 * events as absolutely positioned blocks over the columns.
 *
 * Blocks are divs rather than SVG for the reason the milestones timeline gives: a block carries a
 * title, a time, two resize edges, and a popover, and every one of those is cheaper as an element
 * than as a shape with hit-testing bolted on. All geometry arrives already in pixels from
 * `calendarGrid.logic`; this file measures the pointer and dispatches.
 *
 * Two rules are visible in the wiring and are the ones worth reading for:
 *
 * - **Only Pathway-owned events drag.** A mirrored Google event is a button that opens a read-only
 *   popover and registers no draggable at all, so there is no path from a pointer to a write.
 * - **The all-day lane writes dates.** A dragged issue, milestone, or cycle goes through
 *   {@link resolveCalendarAllDayDrop}, which has no time to give it. See that module's note.
 *
 * @module components/calendar/CalendarTimeGrid
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
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import type { IssueDate } from "@spiritdevs/contracts";
import type { TimestampFormat } from "@spiritdevs/contracts/settings";
import { LockIcon } from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";

import { cn } from "~/lib/utils";
import {
  CALENDAR_GRID_HEIGHT_PX,
  CALENDAR_HOUR_ROW_PX,
  buildCalendarAllDayLane,
  buildCalendarEventBlocks,
  buildCalendarHourRows,
  calendarGrabEdge,
  calendarMinutesAtY,
  calendarMinutesFromOffset,
  calendarMinutesToY,
  calendarWallClock,
  formatCalendarMinutes,
  resolveCalendarAllDayDrop,
  resolveCalendarAllDayToggle,
  resolveCalendarNewEvent,
  resolveCalendarTimedDrop,
  type CalendarAllDayBar,
  type CalendarAllDayItem,
  type CalendarDayColumn,
  type CalendarDragEdge,
  type CalendarEventBlock,
  type CalendarEventInput,
  type CalendarDropWrite,
} from "./calendarGrid.logic";

/** The frozen hour gutter, in pixels. The columns start after it. */
const GUTTER_PX = 56;

/** One stacked row of the all-day lane. */
const ALL_DAY_ROW_PX = 22;

const GRID_DROP_ID = "calendar-grid";
const ALL_DAY_DROP_ID = "calendar-all-day";
const EVENT_DRAG_PREFIX = "calendar-event:";
const ALL_DAY_DRAG_PREFIX = "calendar-all-day:";

/** How often the now rule moves. A minute, because that is the smallest thing it can say. */
const NOW_TICK_MS = 60_000;

export interface CalendarTimeGridProps {
  readonly days: ReadonlyArray<CalendarDayColumn>;
  readonly events: ReadonlyArray<CalendarEventInput>;
  readonly allDayItems: ReadonlyArray<CalendarAllDayItem>;
  readonly today: IssueDate;
  readonly timestampFormat: TimestampFormat;
  /** The viewer's zone: what a new event is created in, and where the now rule is read. */
  readonly timeZone: string;
  /** A timed drag or resize finished. Nothing is optimistic; the block waits for the feed. */
  readonly onEventWrite: (
    event: CalendarEventInput,
    write: { readonly startAt: number; readonly endAt: number; readonly allDay?: boolean },
  ) => void;
  /** An all-day drag finished. The write is dates or instants, decided by what was dragged. */
  readonly onAllDayWrite: (item: CalendarAllDayItem, write: CalendarDropWrite) => void;
  /** A press on empty grid. Null when the viewer has no calendar of their own to create into. */
  readonly onCreate: ((input: { readonly startAt: number; readonly endAt: number }) => void) | null;
  readonly onOpenEvent: (event: CalendarEventInput) => void;
  readonly onOpenAllDayItem: (item: CalendarAllDayItem) => void;
}

export function CalendarTimeGrid({
  allDayItems,
  days,
  events,
  onAllDayWrite,
  onCreate,
  onEventWrite,
  onOpenAllDayItem,
  onOpenEvent,
  timeZone,
  timestampFormat,
}: CalendarTimeGridProps) {
  const [dragKind, setDragKind] = useState<"event" | "allDay" | null>(null);
  const [edge, setEdge] = useState<CalendarDragEdge>("move");
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const hours = useMemo(() => buildCalendarHourRows(timestampFormat), [timestampFormat]);
  const blocks = useMemo(() => buildCalendarEventBlocks({ events, days }), [days, events]);
  const lane = useMemo(
    () => buildCalendarAllDayLane({ items: allDayItems, days }),
    [allDayItems, days],
  );
  const eventById = useMemo(() => new Map(events.map((event) => [event.id, event])), [events]);
  const itemById = useMemo(
    () => new Map(allDayItems.map((item) => [item.id, item])),
    [allDayItems],
  );

  const handleDragEnd = (dragEvent: DragEndEvent) => {
    const kind = dragKind;
    setDragKind(null);
    const over = dragEvent.over;
    if (over === null) return;
    const columnWidth = over.rect.width / Math.max(1, days.length);
    const deltaDays = columnWidth > 0 ? Math.round(dragEvent.delta.x / columnWidth) : 0;
    const id = String(dragEvent.active.id);

    if (kind === "event") {
      const event = eventById.get(id.slice(EVENT_DRAG_PREFIX.length));
      if (event === undefined) return;
      // Dropped in the lane: the event becomes all-day on the column it landed on.
      if (over.id === ALL_DAY_DROP_ID) {
        const column = days[clampColumn(columnIndexOf(event, days) + deltaDays, days.length)];
        if (column === undefined) return;
        const toggled = resolveCalendarAllDayToggle({ event, allDay: true, date: column.date });
        if (toggled !== null) onEventWrite(event, { ...toggled, allDay: true });
        return;
      }
      if (over.id !== GRID_DROP_ID) return;
      const grabbed = edgeOf(dragEvent);
      const write = resolveCalendarTimedDrop({
        event,
        edge: grabbed,
        // A resize never changes the day: the edge being dragged is locked to its own column.
        deltaDays: grabbed === "move" ? deltaDays : 0,
        deltaMinutes: calendarMinutesFromOffset(dragEvent.delta.y),
      });
      if (write !== null) onEventWrite(event, write);
      return;
    }

    if (kind !== "allDay") return;
    const item = itemById.get(id.slice(ALL_DAY_DRAG_PREFIX.length));
    if (item === undefined) return;
    // An all-day event dragged down onto the hours becomes timed again; a date-only item cannot.
    if (over.id === GRID_DROP_ID && item.timeZone !== null) {
      const source = eventById.get(item.id);
      const column = days[clampColumn(columnOfDate(item.startDate, days) + deltaDays, days.length)];
      if (source === undefined || column === undefined) return;
      const toggled = resolveCalendarAllDayToggle({
        event: source,
        allDay: false,
        date: column.date,
      });
      if (toggled !== null) onEventWrite(source, { ...toggled, allDay: false });
      return;
    }
    const write = resolveCalendarAllDayDrop({ item, deltaDays });
    if (write !== null) onAllDayWrite(item, write);
  };

  return (
    <DndContext
      collisionDetection={pointerWithin}
      // Columns scroll under the pointer mid-drag, so a rect measured once at drag start stops
      // being true as soon as somebody drags toward an edge.
      measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
      // A resize stays on its own column; a move is free in both axes.
      modifiers={dragKind === "event" && edge !== "move" ? [restrictToVerticalAxis] : []}
      onDragCancel={() => setDragKind(null)}
      onDragEnd={handleDragEnd}
      onDragStart={(start: DragStartEvent) => {
        const id = String(start.active.id);
        setDragKind(
          id.startsWith(EVENT_DRAG_PREFIX)
            ? "event"
            : id.startsWith(ALL_DAY_DRAG_PREFIX)
              ? "allDay"
              : null,
        );
      }}
      sensors={sensors}
    >
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <DayHeaderRow days={days} />
        <AllDayLane
          days={days}
          lane={lane}
          onOpen={onOpenAllDayItem}
          timestampFormat={timestampFormat}
        />
        <div className="min-h-0 flex-1 overflow-auto overscroll-contain">
          <div className="relative flex" style={{ height: CALENDAR_GRID_HEIGHT_PX }}>
            <div
              className="sticky z-20 shrink-0 bg-background"
              style={{ insetInlineStart: 0, width: GUTTER_PX }}
            >
              {hours.map((row) => (
                <span
                  className="absolute -translate-y-1/2 pe-2 text-end text-[10px] tabular-nums text-muted-foreground/70"
                  key={row.hour}
                  style={{ insetInlineEnd: 0, top: row.y }}
                >
                  {row.label}
                </span>
              ))}
            </div>
            <HourColumns
              blocks={blocks}
              days={days}
              edge={edge}
              onCreate={onCreate}
              onEdge={setEdge}
              onOpenEvent={onOpenEvent}
              timeZone={timeZone}
              timestampFormat={timestampFormat}
            />
          </div>
        </div>
      </div>
    </DndContext>
  );
}

function columnIndexOf(event: CalendarEventInput, days: ReadonlyArray<CalendarDayColumn>): number {
  return columnOfDate(calendarWallClock(event.startAt, event.timeZone).date, days);
}

function columnOfDate(date: string, days: ReadonlyArray<CalendarDayColumn>): number {
  const found = days.findIndex((day) => day.date === date);
  return found === -1 ? 0 : found;
}

function clampColumn(index: number, length: number): number {
  return Math.min(Math.max(0, index), Math.max(0, length - 1));
}

function edgeOf(dragEvent: DragEndEvent): CalendarDragEdge {
  const value = dragEvent.active.data.current?.["edge"];
  return value === "start" || value === "end" ? value : "move";
}

/** The weekday and date strip. Sticky, because losing the date while scrolling to 6pm is worse. */
function DayHeaderRow({ days }: { readonly days: ReadonlyArray<CalendarDayColumn> }) {
  return (
    <div className="flex shrink-0 border-b border-border/50">
      <div className="shrink-0" style={{ width: GUTTER_PX }} />
      {days.map((day) => (
        <div
          className={cn(
            "flex flex-1 items-baseline justify-center gap-1.5 py-1.5",
            day.isWeekend && "bg-muted/25",
          )}
          key={day.date}
        >
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground/70">
            {day.weekdayLabel}
          </span>
          <span
            className={cn(
              "text-sm tabular-nums",
              day.isToday
                ? "flex size-6 items-center justify-center rounded-full bg-primary font-medium text-primary-foreground"
                : "text-foreground",
            )}
          >
            {day.dayLabel}
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * The lane above the hours: all-day events, and every date-only work item there is.
 *
 * It keeps a minimum height when empty rather than collapsing, because that empty strip is the drop
 * target an event is dragged into to become all-day.
 */
function AllDayLane({
  days,
  lane,
  onOpen,
  timestampFormat,
}: {
  readonly days: ReadonlyArray<CalendarDayColumn>;
  readonly lane: ReturnType<typeof buildCalendarAllDayLane>;
  readonly onOpen: (item: CalendarAllDayItem) => void;
  readonly timestampFormat: TimestampFormat;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: ALL_DAY_DROP_ID });
  const height = Math.max(1, lane.lanes) * ALL_DAY_ROW_PX + 8;

  return (
    <div
      className={cn(
        "flex shrink-0 border-b border-border/50 transition-colors motion-reduce:transition-none",
        isOver && "bg-accent/30",
      )}
    >
      <div
        className="flex shrink-0 items-start justify-end pe-2 pt-1 text-[10px] text-muted-foreground/70"
        style={{ width: GUTTER_PX }}
      >
        All-day
      </div>
      <div className="relative flex-1" ref={setNodeRef} style={{ height }}>
        <div className="absolute inset-0 flex">
          {days.map((day) => (
            <div
              className={cn(
                "flex-1 border-s border-border/30 first:border-s-0",
                day.isWeekend && "bg-muted/20",
              )}
              key={day.date}
            />
          ))}
        </div>
        {lane.bars.map((bar) => (
          <AllDayBarChip
            bar={bar}
            columns={days.length}
            key={bar.item.id}
            onOpen={onOpen}
            timestampFormat={timestampFormat}
          />
        ))}
      </div>
    </div>
  );
}

const ALL_DAY_KIND_CLASS: Readonly<Record<CalendarAllDayItem["kind"], string>> = {
  event: "border-primary/40 bg-primary/15 text-foreground",
  issue: "border-border/60 bg-muted text-muted-foreground",
  milestone: "border-warning/40 bg-warning/15 text-foreground",
  cycle: "border-info/40 bg-info/15 text-foreground",
};

function AllDayBarChip({
  bar,
  columns,
  onOpen,
}: {
  readonly bar: CalendarAllDayBar;
  readonly columns: number;
  readonly onOpen: (item: CalendarAllDayItem) => void;
  readonly timestampFormat: TimestampFormat;
}) {
  const { item } = bar;
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    disabled: !item.editable,
    id: `${ALL_DAY_DRAG_PREFIX}${item.id}`,
  });
  const dragged = useRef(false);
  useEffect(() => {
    if (isDragging) dragged.current = true;
  }, [isDragging]);

  const width = `calc(${(bar.span / Math.max(1, columns)) * 100}% - 4px)`;
  return (
    <button
      {...attributes}
      {...listeners}
      aria-label={item.title}
      className={cn(
        "absolute flex touch-none items-center gap-1 overflow-hidden border px-1.5 text-[11px] whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-ring",
        ALL_DAY_KIND_CLASS[item.kind],
        item.editable ? "cursor-grab active:cursor-grabbing" : "cursor-pointer",
        bar.clippedStart ? "rounded-s-none" : "rounded-s-sm",
        bar.clippedEnd ? "rounded-e-none" : "rounded-e-sm",
        isDragging && "z-40 shadow-xs",
      )}
      onClick={() => {
        if (dragged.current) {
          dragged.current = false;
          return;
        }
        onOpen(item);
      }}
      onPointerDown={(pointer) => {
        dragged.current = false;
        listeners?.onPointerDown?.(pointer);
      }}
      ref={setNodeRef}
      style={{
        height: ALL_DAY_ROW_PX - 4,
        insetInlineStart: `calc(${(bar.columnIndex / Math.max(1, columns)) * 100}% + 2px)`,
        top: bar.lane * ALL_DAY_ROW_PX + 4,
        transform:
          transform === null ? undefined : `translate3d(${transform.x}px, ${transform.y}px, 0)`,
        width,
      }}
      type="button"
    >
      {item.editable ? null : <LockIcon className="size-2.5 shrink-0 opacity-60" />}
      <span className="truncate">{item.title}</span>
    </button>
  );
}

/** The hour rows, the now rule, the drop target, and the blocks — one element deep, one z-order. */
function HourColumns({
  blocks,
  days,
  edge,
  onCreate,
  onEdge,
  onOpenEvent,
  timeZone,
  timestampFormat,
}: {
  readonly blocks: ReadonlyArray<CalendarEventBlock>;
  readonly days: ReadonlyArray<CalendarDayColumn>;
  readonly edge: CalendarDragEdge;
  readonly onCreate: ((input: { readonly startAt: number; readonly endAt: number }) => void) | null;
  readonly onEdge: (edge: CalendarDragEdge) => void;
  readonly onOpenEvent: (event: CalendarEventInput) => void;
  readonly timeZone: string;
  readonly timestampFormat: TimestampFormat;
}) {
  const { setNodeRef } = useDroppable({ id: GRID_DROP_ID });
  const nowMinutes = useNowMinutes(timeZone);
  const todayColumn = days.findIndex((day) => day.date === nowMinutes.date);

  return (
    <div className="relative flex-1" ref={setNodeRef}>
      <div className="absolute inset-0 flex">
        {days.map((day) => (
          <CalendarDayColumnBody day={day} key={day.date} onCreate={onCreate} timeZone={timeZone} />
        ))}
      </div>

      {todayColumn === -1 ? null : (
        <div
          className="pointer-events-none absolute z-30 h-px bg-destructive"
          style={{
            insetInlineStart: `${(todayColumn / Math.max(1, days.length)) * 100}%`,
            top: calendarMinutesToY(nowMinutes.minutes),
            width: `${(1 / Math.max(1, days.length)) * 100}%`,
          }}
        >
          <span className="absolute -top-[3px] size-[7px] rounded-full bg-destructive" />
        </div>
      )}

      {blocks.map((block) => (
        <EventBlock
          block={block}
          columns={days.length}
          edge={edge}
          key={block.key}
          onEdge={onEdge}
          onOpen={onOpenEvent}
          timestampFormat={timestampFormat}
        />
      ))}
    </div>
  );
}

/** One day's hour lines, and the surface a press on empty grid creates an event on. */
function CalendarDayColumnBody({
  day,
  onCreate,
  timeZone,
}: {
  readonly day: CalendarDayColumn;
  readonly onCreate: ((input: { readonly startAt: number; readonly endAt: number }) => void) | null;
  readonly timeZone: string;
}) {
  return (
    <div
      className={cn(
        "relative flex-1 border-s border-border/30 first:border-s-0",
        day.isWeekend && "bg-muted/20",
        onCreate !== null && "cursor-cell",
      )}
      onPointerDown={(pointer: ReactPointerEvent<HTMLDivElement>) => {
        if (onCreate === null) return;
        // Only a press on the column itself: a press that started on a block is that block's.
        if (pointer.target !== pointer.currentTarget) return;
        const rect = pointer.currentTarget.getBoundingClientRect();
        const minutes = calendarMinutesAtY(pointer.clientY - rect.top);
        const write = resolveCalendarNewEvent({ date: day.date, minutes, timeZone });
        onCreate({ startAt: write.startAt, endAt: write.endAt });
      }}
    >
      {Array.from({ length: 24 }, (_, hour) => (
        <div
          className={cn(
            "absolute inset-x-0 h-px",
            hour % 6 === 0 ? "bg-border/60" : "bg-border/25",
          )}
          key={hour}
          style={{ top: hour * CALENDAR_HOUR_ROW_PX }}
        />
      ))}
    </div>
  );
}

const NOW_INITIAL = { date: "" as IssueDate, minutes: 0 };

/** The now rule's position, re-read each minute. It is the smallest thing the rule can say. */
function useNowMinutes(timeZone: string) {
  const [now, setNow] = useState(NOW_INITIAL);
  useEffect(() => {
    const read = () => setNow(calendarWallClock(Date.now(), timeZone));
    read();
    const timer = window.setInterval(read, NOW_TICK_MS);
    return () => window.clearInterval(timer);
  }, [timeZone]);
  return now;
}

/**
 * One event.
 *
 * Drag feedback is transform only: a body drag translates the whole block, and an edge drag leaves
 * the block where it is and translates a rule at the end being moved, because a height that follows
 * the pointer is a layout pass on every pointer move and the rule says the same thing.
 */
function EventBlock({
  block,
  columns,
  edge,
  onEdge,
  onOpen,
  timestampFormat,
}: {
  readonly block: CalendarEventBlock;
  readonly columns: number;
  readonly edge: CalendarDragEdge;
  readonly onEdge: (edge: CalendarDragEdge) => void;
  readonly onOpen: (event: CalendarEventInput) => void;
  readonly timestampFormat: TimestampFormat;
}) {
  const { event } = block;
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    data: { edge },
    disabled: !event.editable,
    id: `${EVENT_DRAG_PREFIX}${event.id}`,
  });
  const dragged = useRef(false);
  useEffect(() => {
    if (isDragging) dragged.current = true;
  }, [isDragging]);

  const columnWidth = 100 / Math.max(1, columns);
  const laneWidth = columnWidth / Math.max(1, block.lanes);
  const start = formatCalendarMinutes(block.startMinutes, timestampFormat);

  return (
    <button
      {...attributes}
      {...listeners}
      aria-label={`${event.title}, ${start}`}
      className={cn(
        "absolute flex touch-none flex-col items-start overflow-hidden border px-1.5 py-0.5 text-start outline-none focus-visible:ring-2 focus-visible:ring-ring",
        event.editable
          ? "cursor-grab border-primary/40 bg-primary/15 hover:bg-primary/20 active:cursor-grabbing"
          : "cursor-pointer border-border/60 bg-muted/80 hover:bg-muted",
        block.clippedStart ? "rounded-t-none" : "rounded-t-md",
        block.clippedEnd ? "rounded-b-none" : "rounded-b-md",
        isDragging && "z-40 shadow-sm",
      )}
      onClick={(click) => {
        if (dragged.current) {
          dragged.current = false;
          click.preventDefault();
          return;
        }
        onOpen(event);
      }}
      onPointerDown={(pointer) => {
        dragged.current = false;
        const rect = pointer.currentTarget.getBoundingClientRect();
        onEdge(
          event.editable
            ? calendarGrabEdge({ offsetY: pointer.clientY - rect.top, height: rect.height })
            : "move",
        );
        // Ours shadows the sensor's own handler, so the drag starts from here — after the edge is
        // known, which is what the drop then resolves against.
        listeners?.onPointerDown?.(pointer);
      }}
      ref={setNodeRef}
      style={{
        height: block.height,
        insetInlineStart: `calc(${block.columnIndex * columnWidth + block.lane * laneWidth}% + 1px)`,
        top: block.top,
        transform:
          transform === null || edge !== "move"
            ? undefined
            : `translate3d(${transform.x}px, ${transform.y}px, 0)`,
        width: `calc(${laneWidth}% - 2px)`,
        zIndex: isDragging ? 40 : 10 + block.lane,
      }}
      type="button"
    >
      <span className="w-full truncate text-[11px] leading-tight font-medium">{event.title}</span>
      {block.height >= CALENDAR_HOUR_ROW_PX * 0.75 ? (
        <span className="w-full truncate text-[10px] leading-tight tabular-nums opacity-70">
          {start}
        </span>
      ) : null}
    </button>
  );
}
