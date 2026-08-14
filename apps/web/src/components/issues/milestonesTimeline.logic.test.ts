import { IssueMilestoneId, ProjectId, type IssueMilestone } from "@spiritdevs/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { IssueProgress } from "~/state/issues";
import type { MilestonesOverviewGroup } from "./milestonesOverview.logic";
import {
  TIMELINE_DEFAULT_SPAN_DAYS,
  TIMELINE_EDGE_GRAB_PX,
  buildTimelineRows,
  buildTimelineScale,
  diffTimelineDays,
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
} from "./milestonesTimeline.logic";

const NOW = "2026-08-12T00:00:00.000Z";
const TODAY = "2026-08-12";

function milestone(id: string, overrides: Partial<IssueMilestone> = {}) {
  return {
    id: IssueMilestoneId.make(id),
    projectId: ProjectId.make("prj_1"),
    name: id,
    description: null,
    startDate: null,
    targetDate: null,
    position: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } satisfies IssueMilestone;
}

function group(projectId: string, milestones: ReadonlyArray<IssueMilestone>) {
  return {
    projectId: ProjectId.make(projectId),
    title: projectId,
    milestones,
  } satisfies MilestonesOverviewGroup;
}

function progress(entries: ReadonlyArray<readonly [IssueMilestone, IssueProgress]>) {
  return new Map(entries.map(([target, value]) => [target.id, value] as const));
}

describe("diffTimelineDays", () => {
  it("counts whole days in both directions and across a month boundary", () => {
    expect(diffTimelineDays("2026-08-12", "2026-08-12")).toBe(0);
    expect(diffTimelineDays("2026-08-28", "2026-09-02")).toBe(5);
    expect(diffTimelineDays("2026-09-02", "2026-08-28")).toBe(-5);
  });

  it("crosses a leap day without a library", () => {
    expect(diffTimelineDays("2028-02-27", "2028-03-01")).toBe(3);
  });

  it("reads an unparseable date as no distance rather than as NaN", () => {
    expect(diffTimelineDays("not-a-date", "2026-08-12")).toBe(0);
  });
});

describe("milestonesTimelineRange", () => {
  it("spans every date any milestone carries", () => {
    const range = milestonesTimelineRange(
      [
        milestone("a", { startDate: "2026-07-01", targetDate: "2026-07-20" }),
        milestone("b", { targetDate: "2026-10-05" }),
      ],
      TODAY,
    );
    expect(range).toEqual({ start: "2026-07-01", end: "2026-10-05" });
  });

  it("always contains today, so the today rule is on screen", () => {
    const range = milestonesTimelineRange(
      [milestone("a", { startDate: "2026-09-01", targetDate: "2026-09-10" })],
      TODAY,
    );
    expect(range.start).toBe(TODAY);
  });

  it("gives an all-undated tracker the empty grid a tray chip is dropped onto", () => {
    expect(milestonesTimelineRange([milestone("a")], TODAY)).toEqual({
      start: TODAY,
      end: TODAY,
    });
  });
});

describe("buildTimelineScale", () => {
  it("snaps a week scale outward to Mondays", () => {
    const scale = buildTimelineScale({ start: "2026-08-12", end: "2026-08-12" }, "week");
    // 2026-08-12 is a Wednesday; padded by a week each way, then snapped to whole weeks.
    expect(scale.start).toBe("2026-08-03");
    expect(scale.end).toBe("2026-08-23");
    expect(scale.days).toBe(21);
    expect(scale.width).toBe(scale.days * scale.dayWidth);
  });

  it("snaps a month scale to the first of the month", () => {
    const scale = buildTimelineScale({ start: "2026-08-12", end: "2026-09-02" }, "month");
    expect(scale.start).toBe("2026-08-01");
    expect(scale.end).toBe("2026-09-30");
  });

  it("snaps a quarter scale to Jan/Apr/Jul/Oct", () => {
    const scale = buildTimelineScale({ start: "2026-08-12", end: "2026-08-20" }, "quarter");
    expect(scale.start).toBe("2026-07-01");
    expect(scale.end).toBe("2026-09-30");
  });

  it("refuses to invert when the range arrives backwards", () => {
    const scale = buildTimelineScale({ start: "2026-08-12", end: "2026-01-01" }, "month");
    expect(scale.start).toBe("2026-08-01");
    expect(scale.days).toBeGreaterThan(0);
  });

  it("ticks every day at week zoom, marking the Mondays", () => {
    const scale = buildTimelineScale({ start: "2026-08-12", end: "2026-08-12" }, "week");
    expect(scale.ticks).toHaveLength(21);
    expect(scale.ticks[0]).toEqual({ date: "2026-08-03", x: 0, label: "3", major: true });
    expect(scale.ticks[1]?.major).toBe(false);
    expect(scale.ticks[1]?.x).toBe(scale.dayWidth);
    expect(scale.ticks[7]?.date).toBe("2026-08-10");
    expect(scale.ticks[7]?.major).toBe(true);
  });

  it("ticks weekly at month zoom and names the day", () => {
    const scale = buildTimelineScale({ start: "2026-08-12", end: "2026-08-12" }, "month");
    expect(scale.ticks[0]).toEqual({ date: "2026-08-01", x: 0, label: "Aug 1", major: true });
    expect(scale.ticks[1]).toEqual({
      date: "2026-08-08",
      x: 7 * scale.dayWidth,
      label: "Aug 8",
      major: false,
    });
  });

  it("ticks monthly at quarter zoom and spells the year out at January", () => {
    const scale = buildTimelineScale({ start: "2026-11-01", end: "2027-02-01" }, "quarter");
    expect(scale.start).toBe("2026-10-01");
    expect(scale.ticks[0]).toEqual({ date: "2026-10-01", x: 0, label: "Oct", major: true });
    const january = scale.ticks.find((tick) => tick.date === "2027-01-01");
    expect(january?.label).toBe("Jan 2027");
    expect(january?.major).toBe(true);
    expect(scale.ticks.find((tick) => tick.date === "2026-11-01")?.major).toBe(false);
  });
});

describe("timelineX / timelineDateAtX / timelineDaysFromOffset", () => {
  const scale = buildTimelineScale({ start: "2026-08-12", end: "2026-08-12" }, "week");

  it("maps a day to the left edge of its column and back", () => {
    expect(timelineX(scale, "2026-08-03")).toBe(0);
    expect(timelineX(scale, "2026-08-05")).toBe(2 * scale.dayWidth);
    expect(timelineDateAtX(scale, 2 * scale.dayWidth)).toBe("2026-08-05");
    // Anywhere inside a column is that day, not the next one.
    expect(timelineDateAtX(scale, 2 * scale.dayWidth + scale.dayWidth - 1)).toBe("2026-08-05");
  });

  it("clamps a drop outside the scale to a real day on it", () => {
    expect(timelineDateAtX(scale, -500)).toBe(scale.start);
    expect(timelineDateAtX(scale, 10_000)).toBe(scale.end);
  });

  it("rounds travel to whole days, because a date has no other unit", () => {
    expect(timelineDaysFromOffset(scale, scale.dayWidth * 2)).toBe(2);
    expect(timelineDaysFromOffset(scale, scale.dayWidth * 2.6)).toBe(3);
    expect(timelineDaysFromOffset(scale, -scale.dayWidth * 1.4)).toBe(-1);
    expect(timelineDaysFromOffset(scale, 3)).toBe(0);
  });
});

describe("buildTimelineRows", () => {
  const scale = buildTimelineScale({ start: "2026-08-01", end: "2026-09-30" }, "month");

  it("places a two-ended milestone as an inclusive span", () => {
    const bar = milestone("a", { startDate: "2026-08-03", targetDate: "2026-08-05" });
    const rows = buildTimelineRows(
      [group("prj_1", [bar])],
      progress([[bar, { done: 1, total: 4 }]]),
      scale,
    );
    const [first] = rows.rows[0]?.bars ?? [];
    expect(first?.dated).toBe("both");
    expect(first?.x).toBe(timelineX(scale, "2026-08-03"));
    expect(first?.width).toBe(3 * scale.dayWidth);
    expect(first?.completionRatio).toBe(0.25);
  });

  it("renders a one-ended milestone as a one-day marker rather than a guessed span", () => {
    const target = milestone("a", { targetDate: "2026-08-20" });
    const start = milestone("b", { startDate: "2026-08-20" });
    const rows = buildTimelineRows([group("prj_1", [target, start])], new Map(), scale);
    expect(rows.rows[0]?.bars.map((entry) => entry.dated)).toEqual(["target", "start"]);
    expect(rows.rows[0]?.bars.every((entry) => entry.width === scale.dayWidth)).toBe(true);
  });

  it("sends undated milestones to the tray and keeps their project's lane", () => {
    const rows = buildTimelineRows(
      [group("prj_1", [milestone("a"), milestone("b")]), group("prj_2", [])],
      new Map(),
      scale,
    );
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows[0]?.bars).toHaveLength(0);
    expect(rows.rows[0]?.undated.map((entry) => entry.name)).toEqual(["a", "b"]);
    expect(rows.undated.map((entry) => entry.name)).toEqual(["a", "b"]);
  });

  it("reads a milestone the progress map has not seen as empty, not as finished", () => {
    const bar = milestone("a", { startDate: "2026-08-03", targetDate: "2026-08-05" });
    const rows = buildTimelineRows([group("prj_1", [bar])], new Map(), scale);
    expect(rows.rows[0]?.bars[0]?.completionRatio).toBe(0);
  });

  it("clips a bar that hangs off the scale instead of drawing past its end", () => {
    const bar = milestone("a", { startDate: "2026-07-01", targetDate: "2026-12-31" });
    const rows = buildTimelineRows([group("prj_1", [bar])], new Map(), scale);
    expect(rows.rows[0]?.bars[0]?.x).toBe(0);
    expect(rows.rows[0]?.bars[0]?.width).toBe(scale.width);
  });

  it("survives a row whose dates arrived backwards", () => {
    const bar = milestone("a", { startDate: "2026-08-20", targetDate: "2026-08-03" });
    const rows = buildTimelineRows([group("prj_1", [bar])], new Map(), scale);
    expect(rows.rows[0]?.bars[0]?.width).toBe(scale.dayWidth);
  });
});

describe("timelineGrabEdge", () => {
  it("splits a wide bar into two edge zones and a body", () => {
    expect(timelineGrabEdge({ offsetX: 0, width: 200 })).toBe("start");
    expect(timelineGrabEdge({ offsetX: TIMELINE_EDGE_GRAB_PX, width: 200 })).toBe("start");
    expect(timelineGrabEdge({ offsetX: TIMELINE_EDGE_GRAB_PX + 1, width: 200 })).toBe("move");
    expect(timelineGrabEdge({ offsetX: 100, width: 200 })).toBe("move");
    expect(timelineGrabEdge({ offsetX: 200 - TIMELINE_EDGE_GRAB_PX, width: 200 })).toBe("end");
    expect(timelineGrabEdge({ offsetX: 200, width: 200 })).toBe("end");
  });

  it("makes a narrow bar all body, so it stays movable", () => {
    expect(timelineGrabEdge({ offsetX: 1, width: TIMELINE_EDGE_GRAB_PX * 3 - 1 })).toBe("move");
  });
});

describe("parseTimelineDragId", () => {
  it("round-trips a bar and a tray chip, and refuses anything else", () => {
    const id = IssueMilestoneId.make("mst_1");
    expect(parseTimelineDragId(timelineBarDragId(id))).toEqual({ kind: "bar", milestoneId: id });
    expect(parseTimelineDragId(timelineTrayDragId(id))).toEqual({ kind: "tray", milestoneId: id });
    expect(parseTimelineDragId("milestone-bar:")).toBeNull();
    expect(parseTimelineDragId("issue-card:iss_1")).toBeNull();
  });
});

describe("resolveTimelineDrag", () => {
  const span = milestone("a", { startDate: "2026-08-10", targetDate: "2026-08-20" });

  it("moves both ends by the same whole days", () => {
    expect(resolveTimelineDrag({ milestone: span, edge: "move", deltaDays: 3 })).toEqual({
      startDate: "2026-08-13",
      targetDate: "2026-08-23",
    });
  });

  it("moves the one end a one-ended milestone has", () => {
    expect(
      resolveTimelineDrag({
        milestone: milestone("a", { targetDate: "2026-08-20" }),
        edge: "move",
        deltaDays: -2,
      }),
    ).toEqual({ startDate: null, targetDate: "2026-08-18" });
  });

  it("drags each edge on its own", () => {
    expect(resolveTimelineDrag({ milestone: span, edge: "start", deltaDays: -4 })).toEqual({
      startDate: "2026-08-06",
      targetDate: "2026-08-20",
    });
    expect(resolveTimelineDrag({ milestone: span, edge: "end", deltaDays: 5 })).toEqual({
      startDate: "2026-08-10",
      targetDate: "2026-08-25",
    });
  });

  it("clamps rather than inverts when an edge is dragged past the other", () => {
    expect(resolveTimelineDrag({ milestone: span, edge: "start", deltaDays: 40 })).toEqual({
      startDate: "2026-08-20",
      targetDate: "2026-08-20",
    });
    expect(resolveTimelineDrag({ milestone: span, edge: "end", deltaDays: -40 })).toEqual({
      startDate: "2026-08-10",
      targetDate: "2026-08-10",
    });
  });

  it("turns a checkpoint into a span by dragging the end it does not have", () => {
    expect(
      resolveTimelineDrag({
        milestone: milestone("a", { targetDate: "2026-08-20" }),
        edge: "start",
        deltaDays: -6,
      }),
    ).toEqual({ startDate: "2026-08-14", targetDate: "2026-08-20" });
  });

  it("writes nothing when the drag moved nothing", () => {
    expect(resolveTimelineDrag({ milestone: span, edge: "move", deltaDays: 0 })).toBeNull();
    // Already parked on the target: dragging further into it is not a change.
    const parked = milestone("a", { startDate: "2026-08-20", targetDate: "2026-08-20" });
    expect(resolveTimelineDrag({ milestone: parked, edge: "start", deltaDays: 3 })).toBeNull();
    expect(resolveTimelineDrag({ milestone: parked, edge: "end", deltaDays: -3 })).toBeNull();
  });

  it("has nothing to move on an undated milestone", () => {
    expect(
      resolveTimelineDrag({ milestone: milestone("a"), edge: "move", deltaDays: 4 }),
    ).toBeNull();
    expect(
      resolveTimelineDrag({ milestone: milestone("a"), edge: "start", deltaDays: 4 }),
    ).toBeNull();
  });
});

describe("resolveTimelineSchedule / resolveTimelineUnschedule", () => {
  it("schedules a tray chip as a grabbable week", () => {
    expect(resolveTimelineSchedule("2026-08-12")).toEqual({
      startDate: "2026-08-12",
      targetDate: "2026-08-18",
    });
    expect(TIMELINE_DEFAULT_SPAN_DAYS).toBe(7);
  });

  it("clears both dates on the way back to the tray", () => {
    expect(
      resolveTimelineUnschedule(milestone("a", { startDate: "2026-08-10", targetDate: null })),
    ).toEqual({ startDate: null, targetDate: null });
  });

  it("writes nothing when a chip lands back where it started", () => {
    expect(resolveTimelineUnschedule(milestone("a"))).toBeNull();
  });
});
