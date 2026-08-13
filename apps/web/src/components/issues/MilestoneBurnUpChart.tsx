/**
 * The milestone burn-up: completed work climbing toward a scope line that moves.
 *
 * Hand-rolled SVG on the `UsageProviderChart` pattern — the geometry is pure and tested in
 * `milestoneBurnUp.logic.ts`, this file only paints it. The repo carries no charting library and
 * this is not the feature that should add one.
 *
 * It reads as **emphasis** rather than as three equal series: completed is a filled area in the
 * primary hue because it is the answer, scope is a line in muted ink because it is the context,
 * and the ideal pace is a dashed reference from the start date at zero to the target date at
 * today's scope — a line the work is measured against, not a fourth thing that happened.
 *
 * @module components/issues/MilestoneBurnUpChart
 */
import type { IssueMilestone } from "@t3tools/contracts";
import { useCallback, useMemo, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { useIssueMilestoneHistory, type IssueMilestoneHistoryView } from "~/state/issues";
import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";
import { formatIssueDueDate } from "./issuesList.logic";
import {
  BURN_UP_PLOT_TOP,
  BURN_UP_VIEW_HEIGHT,
  BURN_UP_VIEW_WIDTH,
  buildBurnUpChart,
  burnUpDirectLabels,
  burnUpIndexAtFraction,
  type BurnUpChart,
} from "./milestoneBurnUp.logic";
import {
  MILESTONE_CHART_AREA_OPACITY,
  MILESTONE_CHART_IDEAL_DASH,
  MILESTONE_CHART_IDEAL_OPACITY,
  MILESTONE_CHART_INK,
  MILESTONE_CHART_STROKE_WIDTH,
} from "./milestoneChartColors";

interface MilestoneBurnUpChartProps {
  readonly milestone: Pick<IssueMilestone, "id" | "startDate" | "targetDate">;
  /** `YYYY-MM-DD`. Date labels drop the year when it matches this one. */
  readonly today: string;
}

export function MilestoneBurnUpChart({ milestone, today }: MilestoneBurnUpChartProps) {
  const history = useIssueMilestoneHistory(milestone.id);
  const chart = useMemo(
    () =>
      buildBurnUpChart({
        points: history.points,
        startDate: milestone.startDate,
        targetDate: milestone.targetDate,
      }),
    [history.points, milestone.startDate, milestone.targetDate],
  );

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <h2 className="text-xs font-medium text-muted-foreground">Burn-up</h2>
        <BurnUpLegend hasIdeal={chart !== null && chart.ideal !== null} />
      </div>

      {chart === null ? (
        <BurnUpFallback history={history} />
      ) : (
        <BurnUpPlot chart={chart} today={today} />
      )}

      {history.approximate && !history.isPending ? (
        <p className="text-[11px] text-muted-foreground">
          Part of this history is a best guess: something it counts on has been renamed since.
        </p>
      ) : null}
    </div>
  );
}

/** Loading, empty and failed all land here, so the chart itself never renders half a series. */
function BurnUpFallback({ history }: { readonly history: IssueMilestoneHistoryView }) {
  if (history.isPending && history.points.length === 0) {
    return <Skeleton className="h-48 w-full rounded-lg" />;
  }

  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border/60 px-3 py-8 text-center">
      <p className="text-xs text-muted-foreground">
        {history.error === null
          ? "Not enough history yet. The burn-up appears once this milestone has two days behind it."
          : "The burn-up could not be rebuilt from the change log."}
      </p>
      {history.error === null ? null : (
        <Button onClick={history.refresh} size="xs" variant="outline">
          Try again
        </Button>
      )}
    </div>
  );
}

const PLOT_HEIGHT_CLASS = "h-48";

/** Keyboard equivalents of the crosshair, keyed by `KeyboardEvent.key`. */
const KEY_STEPS: Record<string, number | "start" | "end" | undefined> = {
  ArrowLeft: -1,
  ArrowRight: 1,
  Home: "start",
  End: "end",
};

function BurnUpPlot({ chart, today }: { readonly chart: BurnUpChart; readonly today: string }) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const plotRef = useRef<HTMLDivElement | null>(null);
  const labels = useMemo(() => burnUpDirectLabels(chart), [chart]);

  const handleMove = useCallback(
    (event: React.MouseEvent) => {
      const bounds = plotRef.current?.getBoundingClientRect();
      if (bounds === undefined || bounds.width === 0) return;
      setHoverIndex(burnUpIndexAtFraction(chart, (event.clientX - bounds.left) / bounds.width));
    },
    [chart],
  );

  // Arrow keys walk the same days the pointer snaps to, so the readout is not hover-only.
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      const last = chart.columns.length - 1;
      const step = KEY_STEPS[event.key];
      if (step === undefined) return;
      event.preventDefault();
      setHoverIndex((current) => {
        if (step === "start") return 0;
        if (step === "end") return last;
        return Math.min(last, Math.max(0, (current ?? last) + step));
      });
    },
    [chart.columns.length],
  );

  const hovered = hoverIndex === null ? undefined : chart.columns[hoverIndex];
  const hoverPercent = hovered === undefined ? 0 : (hovered.x / BURN_UP_VIEW_WIDTH) * 100;

  return (
    <div className="flex flex-col gap-1">
      <div className="flex gap-2">
        {/* Tick labels live outside the plot so they stay aligned to their gridlines. */}
        <div className={cn("relative w-6 shrink-0", PLOT_HEIGHT_CLASS)}>
          {chart.ticks.map((tick) => (
            <span
              className="absolute right-0 -translate-y-1/2 text-[10px] tabular-nums text-muted-foreground"
              key={tick.value}
              style={{ top: `${(tick.y / BURN_UP_VIEW_HEIGHT) * 100}%` }}
            >
              {tick.value}
            </span>
          ))}
        </div>

        <div
          aria-label="Burn-up chart. Left and right arrows read one day at a time."
          className={cn(
            "relative flex-1 rounded-sm outline-none focus-visible:ring-1 focus-visible:ring-ring",
            PLOT_HEIGHT_CLASS,
          )}
          onBlur={() => setHoverIndex(null)}
          onKeyDown={handleKeyDown}
          ref={plotRef}
          role="group"
          tabIndex={0}
        >
          <svg
            aria-label={`Issues completed against total scope, ${formatIssueDueDate(chart.axisDates[0], today)} to ${formatIssueDueDate(chart.axisDates[2], today)}`}
            className="h-full w-full"
            preserveAspectRatio="none"
            role="img"
            viewBox={`0 0 ${BURN_UP_VIEW_WIDTH} ${BURN_UP_VIEW_HEIGHT}`}
          >
            {chart.ticks.map((tick) => (
              <line
                className="text-border"
                key={tick.value}
                stroke="currentColor"
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
                x1={0}
                x2={BURN_UP_VIEW_WIDTH}
                y1={tick.y}
                y2={tick.y}
              />
            ))}

            {chart.ideal === null ? null : (
              <path
                className={MILESTONE_CHART_INK.ideal.className}
                d={chart.ideal.path}
                fill="none"
                stroke="currentColor"
                strokeDasharray={MILESTONE_CHART_IDEAL_DASH}
                strokeOpacity={MILESTONE_CHART_IDEAL_OPACITY}
                strokeWidth={MILESTONE_CHART_STROKE_WIDTH}
                vectorEffect="non-scaling-stroke"
              />
            )}

            <path
              className={MILESTONE_CHART_INK.completed.className}
              d={chart.completedArea}
              fill="currentColor"
              fillOpacity={MILESTONE_CHART_AREA_OPACITY}
            />
            <path
              className={MILESTONE_CHART_INK.scope.className}
              d={chart.scopeLine}
              fill="none"
              stroke="currentColor"
              strokeWidth={MILESTONE_CHART_STROKE_WIDTH}
              vectorEffect="non-scaling-stroke"
            />
            <path
              className={MILESTONE_CHART_INK.completed.className}
              d={chart.completedLine}
              fill="none"
              stroke="currentColor"
              strokeWidth={MILESTONE_CHART_STROKE_WIDTH}
              vectorEffect="non-scaling-stroke"
            />

            {hovered === undefined ? null : (
              <line
                className="text-muted-foreground"
                stroke="currentColor"
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
                x1={hovered.x}
                x2={hovered.x}
                y1={BURN_UP_PLOT_TOP}
                y2={BURN_UP_VIEW_HEIGHT}
              />
            )}

            {/* One overlay takes every pointer event, so the reader aims at a day rather than at a
                2px line. */}
            <rect
              fill="transparent"
              height={BURN_UP_VIEW_HEIGHT}
              onMouseLeave={() => setHoverIndex(null)}
              onMouseMove={handleMove}
              width={BURN_UP_VIEW_WIDTH}
              x={0}
              y={0}
            />
          </svg>

          {/* The hovered value sits in HTML rather than as an SVG circle: the viewBox is stretched
              to the plot, which would draw a circle as an ellipse. */}
          {hovered === undefined ? null : (
            <span
              aria-hidden
              className={cn(
                "pointer-events-none absolute size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-current",
                MILESTONE_CHART_INK.completed.className,
              )}
              style={{
                left: `${hoverPercent}%`,
                top: `${(hovered.completedY / BURN_UP_VIEW_HEIGHT) * 100}%`,
              }}
            />
          )}

          {/* Direct labels on the last day: the two numbers that matter are readable without
              hovering, and they wear text tokens rather than their series' colour. */}
          <DirectLabel
            className="font-medium text-foreground"
            label={`${labels.completed.value} done`}
            left={labels.completed.leftPercent}
            top={labels.completed.topPercent}
          />
          <DirectLabel
            className="text-muted-foreground"
            label={`${labels.scope.value} total`}
            left={labels.scope.leftPercent}
            top={labels.scope.topPercent}
          />

          {hovered === undefined ? null : (
            <div
              className="pointer-events-none absolute top-0 z-10 min-w-32 rounded-md border border-border bg-background/95 px-2 py-1.5 text-xs shadow-sm"
              style={{
                left: `${hoverPercent}%`,
                transform: hoverPercent > 60 ? "translateX(-100%)" : "translateX(0)",
              }}
            >
              <div className="mb-1 text-muted-foreground">
                {formatIssueDueDate(hovered.date, today)}
              </div>
              <TooltipRow
                keyClassName={cn("bg-current", MILESTONE_CHART_INK.completed.className)}
                label="Completed"
                value={hovered.completed}
              />
              <TooltipRow label="Started" value={hovered.started} />
              <TooltipRow
                keyClassName={cn("bg-current", MILESTONE_CHART_INK.scope.className)}
                label="Scope"
                value={hovered.scope}
              />
            </div>
          )}
        </div>
      </div>

      <div className="flex justify-between pl-8 text-[10px] uppercase text-muted-foreground">
        <span>{formatIssueDueDate(chart.axisDates[0], today)}</span>
        <span>{formatIssueDueDate(chart.axisDates[1], today)}</span>
        <span>{formatIssueDueDate(chart.axisDates[2], today)}</span>
      </div>
    </div>
  );
}

function DirectLabel({
  className,
  label,
  left,
  top,
}: {
  readonly className: string;
  readonly label: string;
  readonly left: number;
  readonly top: number;
}) {
  // Past two thirds across there is no room to the right of the point, so the label falls back
  // inside the plot rather than off its edge.
  const flipped = left > 66;
  return (
    <span
      className={cn(
        "pointer-events-none absolute whitespace-nowrap text-[10px] tabular-nums",
        className,
      )}
      style={{
        left: `${left}%`,
        top: `${top}%`,
        transform: `translate(${flipped ? "calc(-100% - 6px)" : "6px"}, -50%)`,
      }}
    >
      {label}
    </span>
  );
}

/** Values lead and labels follow: at the crosshair the reader already knows the series. */
function TooltipRow({
  keyClassName,
  label,
  value,
}: {
  readonly keyClassName?: string;
  readonly label: string;
  readonly value: number;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="flex items-center gap-1.5 text-muted-foreground">
        <span
          aria-hidden
          className={cn("h-0.5 w-3 shrink-0 rounded-full", keyClassName ?? "bg-transparent")}
        />
        {label}
      </span>
      <span className="tabular-nums text-foreground">{value}</span>
    </div>
  );
}

function BurnUpLegend({ hasIdeal }: { readonly hasIdeal: boolean }) {
  return (
    <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
      <span className="flex items-center gap-1.5">
        <span
          aria-hidden
          className="h-2.5 w-3.5 shrink-0 rounded-[2px] border-t-2 border-primary bg-primary/15"
        />
        Completed
      </span>
      <span className="flex items-center gap-1.5">
        <span aria-hidden className="h-0.5 w-3.5 shrink-0 rounded-full bg-muted-foreground" />
        Scope
      </span>
      {hasIdeal ? (
        <span className="flex items-center gap-1.5">
          <span
            aria-hidden
            className="h-0 w-3.5 shrink-0 border-t-2 border-dashed border-muted-foreground/80"
          />
          Ideal pace
        </span>
      ) : null}
    </div>
  );
}
