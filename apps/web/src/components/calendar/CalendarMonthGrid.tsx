/**
 * Month mode: a day-cell grid of chips, not an hour grid.
 *
 * A cell is a list because an hour has no height at this scale — a 30-minute meeting on a 90-pixel
 * cell would be a three-pixel sliver — so a chip carries its time as text and nothing positional.
 * Cells hold a fixed number of chips and count the rest, because a cell that grew to fit would take
 * its whole week row with it and the month would stop being a grid.
 *
 * Nothing drags here. A month cell has no minute under the pointer to drop onto, and a drag that
 * could only ever mean "same time, different day" is better spelled by opening the event.
 *
 * @module components/calendar/CalendarMonthGrid
 */
import type { IssueDate } from "@spiritdevs/contracts";
import type { TimestampFormat } from "@spiritdevs/contracts/settings";
import { useMemo } from "react";

import { cn } from "~/lib/utils";
import {
  buildCalendarMonthCells,
  type CalendarAllDayItem,
  type CalendarDayColumn,
  type CalendarEventInput,
  type CalendarMonthCell,
  type CalendarMonthChip,
} from "./calendarGrid.logic";

/** How many chips a cell shows before it starts counting. Six weeks of five still fits a laptop. */
const CELL_CAPACITY = 3;

const WEEKDAY_HEADINGS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

const CHIP_KIND_CLASS: Readonly<Record<CalendarAllDayItem["kind"], string>> = {
  event: "bg-primary/15 text-foreground",
  issue: "bg-muted text-muted-foreground",
  milestone: "bg-warning/15 text-foreground",
  cycle: "bg-info/15 text-foreground",
};

export interface CalendarMonthGridProps {
  readonly days: ReadonlyArray<CalendarDayColumn>;
  readonly events: ReadonlyArray<CalendarEventInput>;
  readonly allDayItems: ReadonlyArray<CalendarAllDayItem>;
  readonly timestampFormat: TimestampFormat;
  /** Pressing a day opens it in Day mode — the only way to reach an hour from here. */
  readonly onOpenDay: (date: IssueDate) => void;
  readonly onOpenChip: (chip: CalendarMonthChip) => void;
}

export function CalendarMonthGrid({
  allDayItems,
  days,
  events,
  onOpenChip,
  onOpenDay,
  timestampFormat,
}: CalendarMonthGridProps) {
  const cells = useMemo(
    () =>
      buildCalendarMonthCells({
        days,
        allDay: allDayItems,
        events,
        capacity: CELL_CAPACITY,
        timestampFormat,
      }),
    [allDayItems, days, events, timestampFormat],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="grid shrink-0 grid-cols-7 border-b border-border/50">
        {WEEKDAY_HEADINGS.map((heading) => (
          <div
            className="py-1.5 text-center text-[10px] uppercase tracking-wide text-muted-foreground/70"
            key={heading}
          >
            {heading}
          </div>
        ))}
      </div>
      <div
        className="grid min-h-0 flex-1 grid-cols-7 overflow-auto"
        style={{ gridAutoRows: "minmax(6rem, 1fr)" }}
      >
        {cells.map((cell) => (
          <MonthCell cell={cell} key={cell.date} onOpenChip={onOpenChip} onOpenDay={onOpenDay} />
        ))}
      </div>
    </div>
  );
}

function MonthCell({
  cell,
  onOpenChip,
  onOpenDay,
}: {
  readonly cell: CalendarMonthCell;
  readonly onOpenChip: (chip: CalendarMonthChip) => void;
  readonly onOpenDay: (date: IssueDate) => void;
}) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col gap-0.5 border-b border-s border-border/30 p-1 [&:nth-child(7n+1)]:border-s-0",
        !cell.inAnchorMonth && "bg-muted/20",
      )}
    >
      <button
        className={cn(
          "self-start rounded-full px-1 text-[11px] tabular-nums outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
          cell.isToday
            ? "bg-primary font-medium text-primary-foreground hover:bg-primary"
            : cell.inAnchorMonth
              ? "text-foreground"
              : "text-muted-foreground/60",
        )}
        onClick={() => onOpenDay(cell.date)}
        type="button"
      >
        {Number(cell.date.slice(8, 10))}
      </button>

      {cell.chips.map((chip) => (
        <button
          className={cn(
            "flex w-full min-w-0 items-center gap-1 rounded-sm px-1 py-px text-start text-[10px] outline-none hover:brightness-105 focus-visible:ring-2 focus-visible:ring-ring",
            CHIP_KIND_CLASS[chip.kind],
            // A continuation day gets no title again: the bar reads as one thing across the week.
            !chip.startsHere && "opacity-70",
          )}
          key={`${chip.id}:${cell.date}`}
          onClick={() => onOpenChip(chip)}
          type="button"
        >
          {chip.time === null ? null : (
            <span className="shrink-0 tabular-nums opacity-70">{chip.time}</span>
          )}
          <span className="truncate">{chip.title}</span>
        </button>
      ))}

      {cell.overflow === 0 ? null : (
        <button
          className="self-start px-1 text-[10px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => onOpenDay(cell.date)}
          type="button"
        >
          +{cell.overflow} more
        </button>
      )}
    </div>
  );
}
