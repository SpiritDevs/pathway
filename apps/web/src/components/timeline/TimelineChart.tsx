/**
 * The chrome a Gantt is made of: the scale toolbar, the sticky header with its tick labels and its
 * cycle band, the gridlines and the today rule under everything, and the lanes rows sit on.
 *
 * Split out of `MilestonesTimeline` so `/calendar`'s Timeline mode mounts the same chart rather than
 * a second one that drifts (ADR 0011). Nothing here knows what a lane holds — the milestones view
 * fills them with draggable bars and a read-only surface would pass plain ones — and nothing here
 * computes geometry either: it arrives already in pixels from
 * `components/issues/milestonesTimeline.logic`.
 *
 * @module components/timeline/TimelineChart
 */
import { issueCycleStatusOn, type IssueDate } from "@spiritdevs/contracts";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";
import { formatIssueDateRange } from "../issues/issuesList.logic";
import {
  TIMELINE_ZOOMS,
  TIMELINE_ZOOM_LABELS,
  timelineCycleBandLanes,
  timelineX,
  type TimelineCycleBand,
  type TimelineDueTick,
  type TimelineScale,
  type TimelineZoom,
} from "../issues/milestonesTimeline.logic";
import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group";

/** The frozen column of names, in pixels — the gridlines and the today rule start after it. */
export const TIMELINE_NAME_COLUMN_PX = 176;

/** Row heights, in pixels, so the lanes and the name column stay on the same lines. */
export const TIMELINE_HEADER_ROW_PX = 28;
export const TIMELINE_LANE_ROW_PX = 28;

/** One stacked row of cycle band, under the tick labels and inside the sticky header. */
const CYCLE_BAND_ROW_PX = 18;

/** Half a diamond, so a tick straddles the centre of its day rather than starting there. */
const DUE_TICK_HALF_PX = 3;

/**
 * The scale the chart is read at: the span on screen, then whatever the surface adds, then zoom.
 * Zoom is the only control every timeline has, which is why it is the one that lives here.
 */
export function TimelineToolbar({
  children,
  onZoom,
  scale,
  today,
  zoom,
}: {
  readonly children?: ReactNode;
  readonly onZoom: (zoom: TimelineZoom) => void;
  readonly scale: TimelineScale;
  readonly today: IssueDate;
  readonly zoom: TimelineZoom;
}) {
  return (
    <div className="flex items-center gap-2 border-b border-border/50 px-3 py-1.5 sm:px-5">
      <span className="text-xs tabular-nums text-muted-foreground">
        {formatIssueDateRange(scale.start, scale.end, today)}
      </span>
      {children}
      <ToggleGroup
        aria-label="Timeline zoom"
        className="ms-auto"
        onValueChange={(next) => {
          const chosen = TIMELINE_ZOOMS.find((candidate) => candidate === next[0]);
          if (chosen !== undefined) onZoom(chosen);
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
  );
}

/**
 * The scrolling body: one horizontal scroller wide enough for the frozen name column plus the whole
 * scale, so the header, the gridlines, and every lane travel together rather than in three panes
 * kept in sync by hand.
 *
 * The header grows by a row for each stacked cycle band, and by none when there are no cycles — a
 * surface that passes none gets exactly the header it had before bands existed.
 */
export function TimelineChart({
  children,
  cycles,
  gridRef,
  scale,
  today,
}: {
  /** The lanes, in order. */
  readonly children: ReactNode;
  /** Cycles as a band across the header. Left out by `/issues/milestones`, which is milestones only. */
  readonly cycles?: ReadonlyArray<TimelineCycleBand> | undefined;
  /** The grid box, handed out so a caller can make it the drop target a dragged bar lands on. */
  readonly gridRef?: ((node: HTMLElement | null) => void) | undefined;
  readonly scale: TimelineScale;
  readonly today: IssueDate;
}) {
  const bands = cycles ?? [];
  const headerPx = TIMELINE_HEADER_ROW_PX + timelineCycleBandLanes(bands) * CYCLE_BAND_ROW_PX;

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <div
        className="relative min-w-max pb-6"
        style={{ minWidth: TIMELINE_NAME_COLUMN_PX + scale.width }}
      >
        <TimelineGrid gridRef={gridRef} scale={scale} today={today} topPx={headerPx} />

        <div className="sticky top-0 z-30 flex bg-background" style={{ height: headerPx }}>
          <div
            className="sticky z-40 shrink-0 bg-background"
            style={{ insetInlineStart: 0, width: TIMELINE_NAME_COLUMN_PX }}
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
            {bands.map((band) => (
              <TimelineCycleBandChip band={band} key={band.cycle.id} today={today} />
            ))}
          </div>
        </div>

        <div className="relative z-10">{children}</div>
      </div>
    </div>
  );
}

/**
 * The gridlines, the today rule, and the box a drop is measured against — one element, so its left
 * edge is exactly day zero and a dropped chip's date is a subtraction.
 *
 * It takes no pointer events: a drop is resolved against measured rects rather than by hit-testing,
 * so the layer can sit under the bars without stealing their presses.
 */
function TimelineGrid({
  gridRef,
  scale,
  today,
  topPx,
}: {
  readonly gridRef: ((node: HTMLElement | null) => void) | undefined;
  readonly scale: TimelineScale;
  readonly today: IssueDate;
  readonly topPx: number;
}) {
  return (
    <div
      className="pointer-events-none absolute bottom-0 z-0"
      ref={gridRef}
      style={{ insetInlineStart: TIMELINE_NAME_COLUMN_PX, top: topPx, width: scale.width }}
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
 * One cycle in the header. The active one is the period the rows are being read against, so it is
 * the only one that carries colour; a clipped end is drawn square, so a band that runs off the
 * scale does not read as one that ends there.
 */
function TimelineCycleBandChip({
  band,
  today,
}: {
  readonly band: TimelineCycleBand;
  readonly today: IssueDate;
}) {
  return (
    <span
      className={cn(
        "absolute flex items-center overflow-hidden px-1.5 text-[10px] whitespace-nowrap",
        issueCycleStatusOn(band.cycle, today) === "active"
          ? "bg-primary/15 text-foreground"
          : "bg-muted text-muted-foreground",
        band.clippedStart ? "rounded-s-none" : "rounded-s-sm",
        band.clippedEnd ? "rounded-e-none" : "rounded-e-sm",
      )}
      style={{
        height: CYCLE_BAND_ROW_PX - 4,
        insetInlineStart: band.x,
        top: TIMELINE_HEADER_ROW_PX + band.lane * CYCLE_BAND_ROW_PX,
        width: band.width,
      }}
      title={band.cycle.name}
    >
      {band.cycle.name}
    </span>
  );
}

/**
 * One lane: its name in the frozen column and whatever the surface puts on the scale beside it.
 *
 * `indent` is what tells a milestone row from the project row it hangs under — the two differ by
 * their name cell and nothing else, so they are one component rather than two that drift apart.
 */
export function TimelineLaneRow({
  children,
  dueTicks,
  indent = false,
  name,
  scale,
}: {
  readonly children?: ReactNode;
  /** Issue due dates on this lane. Only a project row carries any. */
  readonly dueTicks?: ReadonlyArray<TimelineDueTick> | undefined;
  readonly indent?: boolean;
  readonly name: ReactNode;
  readonly scale: TimelineScale;
}) {
  return (
    <div className="flex" style={{ height: TIMELINE_LANE_ROW_PX }}>
      <div
        className={cn(
          "sticky z-20 flex shrink-0 items-center bg-background pe-2",
          indent && "ps-7",
        )}
        style={{ insetInlineStart: 0, width: TIMELINE_NAME_COLUMN_PX }}
      >
        {name}
      </div>
      <div className="relative shrink-0" style={{ width: scale.width }}>
        {dueTicks?.map((tick) => (
          <TimelineDueTickMark key={tick.date} tick={tick} />
        ))}
        {children}
      </div>
    </div>
  );
}

/**
 * A day's due dates as one diamond on the project's row. Everything due that day shares the mark,
 * because at quarter zoom the day it stands on is four pixels wide.
 */
function TimelineDueTickMark({ tick }: { readonly tick: TimelineDueTick }) {
  return (
    <span
      className="absolute top-1/2 size-1.5 -translate-y-1/2 rotate-45 rounded-[1px] bg-muted-foreground/70"
      style={{ insetInlineStart: tick.x - DUE_TICK_HALF_PX }}
      title={tick.issues.map((issue) => `${issue.key} ${issue.title}`).join("\n")}
    />
  );
}

/** The project row's name cell: pressing it opens or closes the milestone rows beneath it. */
export function TimelineProjectDisclosure({
  expanded,
  onToggle,
  title,
}: {
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly title: string;
}) {
  return (
    <button
      aria-expanded={expanded}
      className="flex min-w-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
      onClick={onToggle}
      type="button"
    >
      {expanded ? (
        <ChevronDownIcon className="size-3.5 shrink-0" />
      ) : (
        <ChevronRightIcon className="size-3.5 shrink-0" />
      )}
      <span className="truncate">{title}</span>
    </button>
  );
}
