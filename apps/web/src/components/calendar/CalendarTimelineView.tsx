/**
 * Timeline mode: the same Gantt `/issues/milestones?view=timeline` draws, at full width and with
 * everything that view leaves out.
 *
 * This is the reuse ADR 0011 is about. The chart chrome is `components/timeline/TimelineChart` and
 * the geometry is `components/issues/milestonesTimeline.logic`, both untouched — what is added here
 * is the two arguments the milestones view passes empty: the cycles that band the header, and the
 * issues whose due dates tick their project's row. Rows are projects that expand to their
 * milestones, which is the shared flattening in `timelineLanes` rather than a second one.
 *
 * Calendar events are deliberately absent and there is no row type that would take one: an hour on
 * a day-wide scale is a sub-pixel hairline. The Layers sidebar's three work sources are what filters
 * this view; its calendars have nothing to say here.
 *
 * The scale covers every dated thing the enabled layers hold rather than the milestones alone, so a
 * layer that is on always has somewhere to draw.
 *
 * Bars are read-only. Dragging a milestone is `/issues/milestones`' job, where the tray that gives
 * an undated milestone its first dates also lives; a calendar showing the same bars twice-editable
 * would be two places to make the same write and one of them without the tray.
 *
 * @module components/calendar/CalendarTimelineView
 */
import type { IssueCycle, IssueDate, IssueMilestoneId, ProjectId } from "@spiritdevs/contracts";
import { useMemo, useState } from "react";

import { cn } from "~/lib/utils";
import type { IssueProgress } from "~/state/issues";
import {
  TimelineChart,
  TimelineLaneRow,
  TimelineProjectDisclosure,
  TimelineToolbar,
} from "../timeline/TimelineChart";
import type { MilestonesOverviewGroup } from "../issues/milestonesOverview.logic";
import { formatMilestoneDateRange } from "../issues/milestonesOverview.logic";
import {
  buildTimelineCycleBands,
  buildTimelineRows,
  buildTimelineScale,
  timelineLanes,
  timelineScaleRange,
  type TimelineBar,
  type TimelineDueIssue,
  type TimelineScale,
  type TimelineZoom,
} from "../issues/milestonesTimeline.logic";

/** A one-day bar at quarter zoom is 4px wide, so bars never render thinner than this. */
const MIN_BAR_PX = 14;

export interface CalendarTimelineViewProps {
  readonly groups: ReadonlyArray<MilestonesOverviewGroup>;
  readonly progressByMilestone: ReadonlyMap<IssueMilestoneId, IssueProgress>;
  /** Bands across the header. Empty when the Cycles layer is off. */
  readonly cycles: ReadonlyArray<IssueCycle>;
  /** Ticks on their project's row. Empty when the Issues layer is off. */
  readonly issues: ReadonlyArray<TimelineDueIssue>;
  readonly today: IssueDate;
}

export function CalendarTimelineView({
  cycles,
  groups,
  issues,
  progressByMilestone,
  today,
}: CalendarTimelineViewProps) {
  const [zoom, setZoom] = useState<TimelineZoom>("month");
  const [collapsed, setCollapsed] = useState<ReadonlySet<ProjectId>>(() => new Set());

  const milestones = useMemo(() => groups.flatMap((group) => [...group.milestones]), [groups]);
  // Every enabled layer is on the scale, not just the milestones: a due date or a cycle outside
  // their span would be off it, and both are dropped rather than clamped.
  const scale = useMemo(
    () => buildTimelineScale(timelineScaleRange({ milestones, issues, cycles, today }), zoom),
    [cycles, issues, milestones, today, zoom],
  );
  const rows = useMemo(
    () => buildTimelineRows({ groups, issues, progressByMilestone, scale }),
    [groups, issues, progressByMilestone, scale],
  );
  const lanes = useMemo(() => timelineLanes(rows.rows, collapsed), [collapsed, rows]);
  const bands = useMemo(() => buildTimelineCycleBands(cycles, scale), [cycles, scale]);

  const toggle = (projectId: ProjectId) =>
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (!next.delete(projectId)) next.add(projectId);
      return next;
    });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <TimelineToolbar onZoom={setZoom} scale={scale} today={today} zoom={zoom}>
        {rows.undated.length === 0 ? null : (
          <span className="text-xs text-muted-foreground/70">
            {rows.undated.length} unscheduled
          </span>
        )}
      </TimelineToolbar>

      <TimelineChart cycles={bands} scale={scale} today={today}>
        {lanes.map((lane) => {
          if (lane.kind === "project") {
            return (
              <TimelineLaneRow
                dueTicks={lane.row.dueTicks}
                key={lane.key}
                name={
                  <TimelineProjectDisclosure
                    expanded={lane.expanded}
                    onToggle={() => toggle(lane.row.projectId)}
                    title={lane.row.title}
                  />
                }
                scale={scale}
              />
            );
          }
          if (lane.kind === "empty") {
            return (
              <TimelineLaneRow
                indent
                key={lane.key}
                name={
                  <span className="text-[11px] text-muted-foreground/60">Nothing scheduled</span>
                }
                scale={scale}
              />
            );
          }
          return <ReadOnlyBarRow bar={lane.bar} key={lane.key} scale={scale} today={today} />;
        })}
      </TimelineChart>
    </div>
  );
}

/**
 * A milestone's bar, drawn but not grabbable.
 *
 * A span rather than a button: there is nothing to press, and a focusable element that does nothing
 * is a tab stop that lies. The dates are on the title so hovering still answers "when".
 */
function ReadOnlyBarRow({
  bar,
  scale,
  today,
}: {
  readonly bar: TimelineBar;
  readonly scale: TimelineScale;
  readonly today: IssueDate;
}) {
  const { milestone } = bar;
  const dates = formatMilestoneDateRange(milestone.startDate, milestone.targetDate, today);
  const complete = bar.completionRatio >= 1;

  return (
    <TimelineLaneRow
      indent
      name={<span className="truncate text-xs text-muted-foreground">{milestone.name}</span>}
      scale={scale}
    >
      <span
        className={cn(
          "absolute top-1 flex h-5 items-center overflow-hidden rounded-md border",
          complete ? "border-success/50 bg-success/15" : "border-border/60 bg-muted",
        )}
        style={{ insetInlineStart: bar.x, width: Math.max(bar.width, MIN_BAR_PX) }}
        title={`${milestone.name}${dates === null ? "" : ` — ${dates}`}`}
      >
        <span
          className={cn("absolute inset-y-0 start-0", complete ? "bg-success/45" : "bg-primary/45")}
          style={{ width: `${bar.completionRatio * 100}%` }}
        />
        <span className="relative px-1.5 text-[11px] whitespace-nowrap">{milestone.name}</span>
      </span>
    </TimelineLaneRow>
  );
}
