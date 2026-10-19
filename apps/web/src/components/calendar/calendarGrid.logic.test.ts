import type { IssueDate } from "@spiritdevs/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  CALENDAR_DEFAULT_EVENT_MINUTES,
  CALENDAR_EDGE_GRAB_PX,
  CALENDAR_HOUR_ROW_PX,
  CALENDAR_MIN_BLOCK_PX,
  CALENDAR_SNAP_MINUTES,
  DEFAULT_CALENDAR_MODE,
  MINUTES_PER_DAY,
  buildCalendarAllDayLane,
  buildCalendarDays,
  buildCalendarEventBlocks,
  buildCalendarHourRows,
  buildCalendarMonthCells,
  calendarAnchor,
  calendarAnchorPatch,
  calendarDayBounds,
  calendarEventsInRange,
  calendarGrabEdge,
  calendarInstantAt,
  calendarMinutesAtY,
  calendarMinutesFromOffset,
  calendarMinutesToY,
  calendarMode,
  calendarRange,
  calendarWallClock,
  calendarWeekdayIndex,
  diffCalendarDays,
  formatCalendarMinutes,
  formatCalendarRangeLabel,
  isCalendarTimeGridMode,
  makeCalendarCreateTarget,
  parseCalendarSearch,
  resolveCalendarAllDayDrop,
  resolveCalendarAllDayToggle,
  resolveCalendarNewEvent,
  resolveCalendarTimedDrop,
  shiftCalendarAnchor,
  shiftCalendarMonths,
  startOfCalendarMonth,
  startOfCalendarWeek,
  type CalendarAllDayItem,
  type CalendarEventInput,
} from "./calendarGrid.logic";

/** 2026-08-12 is a Wednesday, so its Monday-based week opens on the 10th. */
const TODAY = "2026-08-12" as IssueDate;
const LONDON = "Europe/London";
const UTC = "UTC";

/** 2026-08-12T09:00:00Z. London is on BST that day, so this is 10:00 there. */
const AUG_12_0900Z = Date.UTC(2026, 7, 12, 9, 0);

function event(overrides: Partial<CalendarEventInput> = {}): CalendarEventInput {
  return {
    id: "event-1",
    calendarId: "calendar-1",
    title: "Design review",
    startAt: AUG_12_0900Z,
    endAt: AUG_12_0900Z + 60 * 60_000,
    timeZone: UTC,
    allDay: false,
    notes: "",
    reminderMinutes: [],
    urls: [],
    location: null,
    invitees: [],
    attachments: [],
    editable: true,
    ...overrides,
  };
}

function allDay(overrides: Partial<CalendarAllDayItem> = {}): CalendarAllDayItem {
  return {
    id: "item-1",
    kind: "milestone",
    title: "Beta",
    startDate: TODAY,
    endDate: TODAY,
    editable: true,
    timeZone: null,
    ...overrides,
  };
}

const weekDays = (today: IssueDate = TODAY) =>
  buildCalendarDays({ range: calendarRange("week", today), today });

// ── Search params ──────────────────────────────────────────────────────

describe("calendar search params", () => {
  it("reads the week and today from an empty URL", () => {
    const search = parseCalendarSearch({});
    expect(calendarMode(search)).toBe(DEFAULT_CALENDAR_MODE);
    expect(calendarMode(search)).toBe("week");
    expect(calendarAnchor(search, TODAY)).toBe(TODAY);
  });

  it("keeps the default out of the URL, so ?mode=week and a bare link are one screen", () => {
    expect(parseCalendarSearch({ mode: "week" }).mode).toBeUndefined();
    expect(parseCalendarSearch({ mode: "timeline" }).mode).toBe("timeline");
    expect(calendarAnchorPatch(TODAY, TODAY)).toEqual({ date: undefined });
    expect(calendarAnchorPatch("2026-09-01" as IssueDate, TODAY)).toEqual({ date: "2026-09-01" });
  });

  it("falls back rather than failing the route on a hand-edited param", () => {
    expect(parseCalendarSearch({ mode: "agenda", date: "yesterday" })).toEqual({
      mode: undefined,
      date: undefined,
    });
    expect(parseCalendarSearch({ date: "2026-8-1" }).date).toBeUndefined();
  });

  it("refuses a date nobody can be on, rather than normalising it into another year", () => {
    // `Date.UTC` would roll this one to 2034-06-07 while the toolbar still read 2026 off the string.
    expect(parseCalendarSearch({ date: "2026-99-99" }).date).toBeUndefined();
    expect(parseCalendarSearch({ date: "2026-02-30" }).date).toBeUndefined();
    expect(parseCalendarSearch({ date: "2026-00-10" }).date).toBeUndefined();
    expect(parseCalendarSearch({ date: "2026-02-28" }).date).toBe("2026-02-28");
    // A leap day is a real day, and the year it is not one in is not.
    expect(parseCalendarSearch({ date: "2028-02-29" }).date).toBe("2028-02-29");
    expect(parseCalendarSearch({ date: "2026-02-29" }).date).toBeUndefined();
  });

  it("separates the three grid modes from Timeline", () => {
    expect(isCalendarTimeGridMode("day")).toBe(true);
    expect(isCalendarTimeGridMode("week")).toBe(true);
    expect(isCalendarTimeGridMode("month")).toBe(true);
    expect(isCalendarTimeGridMode("timeline")).toBe(false);
  });
});

describe("events reaching the range", () => {
  const week = calendarRange("week", TODAY);

  it("keeps what the week can draw and drops a lifetime of history", () => {
    const kept = calendarEventsInRange(
      [
        event({
          id: "on-monday",
          startAt: Date.UTC(2026, 7, 10, 9, 0),
          endAt: Date.UTC(2026, 7, 10, 10, 0),
        }),
        event({
          id: "last-year",
          startAt: Date.UTC(2025, 7, 12, 9, 0),
          endAt: Date.UTC(2025, 7, 12, 10, 0),
        }),
        event({
          id: "next-month",
          startAt: Date.UTC(2026, 8, 12, 9, 0),
          endAt: Date.UTC(2026, 8, 12, 10, 0),
        }),
      ],
      week,
    );
    expect(kept.map((candidate) => candidate.id)).toEqual(["on-monday"]);
  });

  it("keeps an event that only runs through the range, having started before it", () => {
    const kept = calendarEventsInRange(
      [event({ startAt: Date.UTC(2026, 6, 1, 9, 0), endAt: Date.UTC(2026, 8, 1, 9, 0) })],
      week,
    );
    expect(kept).toHaveLength(1);
  });

  it("keeps the edges whatever zone they are read in", () => {
    // Midday UTC on the day either side of the week is on the range in some zone, so the filter
    // pads by a day rather than reading a wall clock per event.
    const kept = calendarEventsInRange(
      [
        event({
          id: "sunday-before",
          startAt: Date.UTC(2026, 7, 9, 12, 0),
          endAt: Date.UTC(2026, 7, 9, 13, 0),
        }),
        event({
          id: "monday-after",
          startAt: Date.UTC(2026, 7, 17, 12, 0),
          endAt: Date.UTC(2026, 7, 17, 13, 0),
        }),
      ],
      week,
    );
    expect(kept).toHaveLength(2);
  });

  it("costs a spanning event the days on screen rather than the days it runs", () => {
    const blocks = buildCalendarEventBlocks({
      events: [event({ startAt: Date.UTC(2026, 0, 1, 9, 0), endAt: Date.UTC(2026, 11, 31, 9, 0) })],
      days: weekDays(),
    });
    expect(blocks).toHaveLength(7);
    expect(blocks.every((block) => block.clippedStart && block.clippedEnd)).toBe(true);
  });
});

// ── Ranges and navigation ──────────────────────────────────────────────

describe("calendar ranges", () => {
  it("opens a week on Monday, the same Monday the timeline scale snaps to", () => {
    expect(startOfCalendarWeek(TODAY)).toBe("2026-08-10");
    expect(startOfCalendarWeek("2026-08-10")).toBe("2026-08-10");
    // Sunday belongs to the week that just ended, not the one about to start.
    expect(startOfCalendarWeek("2026-08-16")).toBe("2026-08-10");
    expect(calendarWeekdayIndex("2026-08-10")).toBe(0);
    expect(calendarWeekdayIndex("2026-08-16")).toBe(6);
  });

  it("is one day for Day and seven for Week", () => {
    expect(calendarRange("day", TODAY)).toEqual({ start: TODAY, end: TODAY });
    expect(calendarRange("week", TODAY)).toEqual({ start: "2026-08-10", end: "2026-08-16" });
  });

  it("covers whole weeks for Month, so the 1st sits under the weekday it falls on", () => {
    // August 2026 opens on a Saturday and closes on a Monday, so its grid is six whole weeks.
    const august = calendarRange("month", TODAY);
    expect(august.start).toBe("2026-07-27");
    expect(august.end).toBe("2026-09-06");
    expect(calendarWeekdayIndex(august.start)).toBe(0);
    expect((diffCalendarDays(august.start, august.end) + 1) % 7).toBe(0);
    expect(startOfCalendarMonth(TODAY)).toBe("2026-08-01");
  });

  it("steps by the unit the mode is read in, and leaves Timeline where it is", () => {
    expect(shiftCalendarAnchor("day", TODAY, 1)).toBe("2026-08-13");
    expect(shiftCalendarAnchor("day", TODAY, -1)).toBe("2026-08-11");
    expect(shiftCalendarAnchor("week", TODAY, 1)).toBe("2026-08-19");
    expect(shiftCalendarAnchor("month", TODAY, 1)).toBe("2026-09-12");
    expect(shiftCalendarAnchor("month", TODAY, -1)).toBe("2026-07-12");
    // Timeline's scale comes from its milestones, so stepping an anchor would move nothing.
    expect(shiftCalendarAnchor("timeline", TODAY, 1)).toBe(TODAY);
  });

  it("lands the 31st on the last day of a shorter month rather than spilling over", () => {
    expect(shiftCalendarMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(shiftCalendarMonths("2026-12-15", 1)).toBe("2027-01-15");
    expect(shiftCalendarMonths("2026-01-15", -1)).toBe("2025-12-15");
  });

  it("names the range the way the mode reads it", () => {
    expect(formatCalendarRangeLabel("month", TODAY)).toBe("August 2026");
    expect(formatCalendarRangeLabel("day", TODAY)).toBe("August 12, 2026");
    expect(formatCalendarRangeLabel("week", TODAY)).toBe("August 10 – 16, 2026");
    // A week that straddles two months names both.
    expect(formatCalendarRangeLabel("week", "2026-09-02" as IssueDate)).toBe(
      "August 31 – September 6, 2026",
    );
  });
});

describe("day columns", () => {
  it("numbers the columns in draw order and marks today and the weekend", () => {
    const days = weekDays();
    expect(days).toHaveLength(7);
    expect(days.map((day) => day.index)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(days[0]?.date).toBe("2026-08-10");
    expect(days[0]?.weekdayLabel).toBe("Mon");
    expect(days[2]?.isToday).toBe(true);
    expect(days.filter((day) => day.isWeekend).map((day) => day.date)).toEqual([
      "2026-08-15",
      "2026-08-16",
    ]);
  });

  it("marks the days a month grid borrows from its neighbours", () => {
    const days = buildCalendarDays({
      range: calendarRange("month", TODAY),
      today: TODAY,
      anchorMonth: TODAY,
    });
    expect(days).toHaveLength(42);
    expect(days[0]?.date).toBe("2026-07-27");
    expect(days[0]?.inAnchorMonth).toBe(false);
    expect(days[5]?.date).toBe("2026-08-01");
    expect(days[5]?.inAnchorMonth).toBe(true);
    expect(days[41]?.date).toBe("2026-09-06");
    expect(days[41]?.inAnchorMonth).toBe(false);
  });
});

// ── Hours and zones ────────────────────────────────────────────────────

describe("hour geometry", () => {
  it("maps minutes to pixels and back through the snap", () => {
    expect(calendarMinutesToY(0)).toBe(0);
    expect(calendarMinutesToY(60)).toBe(CALENDAR_HOUR_ROW_PX);
    expect(calendarMinutesToY(MINUTES_PER_DAY)).toBe(24 * CALENDAR_HOUR_ROW_PX);
    expect(calendarMinutesAtY(CALENDAR_HOUR_ROW_PX * 9)).toBe(540);
    expect(calendarMinutesAtY(CALENDAR_HOUR_ROW_PX * 9 + 1) % CALENDAR_SNAP_MINUTES).toBe(0);
  });

  it("clamps a click above the grid and one past the last slot", () => {
    expect(calendarMinutesAtY(-500)).toBe(0);
    expect(calendarMinutesAtY(CALENDAR_HOUR_ROW_PX * 40)).toBe(
      MINUTES_PER_DAY - CALENDAR_SNAP_MINUTES,
    );
  });

  it("moves a drag in whole snap steps, both directions", () => {
    expect(calendarMinutesFromOffset(0)).toBe(0);
    expect(calendarMinutesFromOffset(CALENDAR_HOUR_ROW_PX)).toBe(60);
    expect(calendarMinutesFromOffset(-CALENDAR_HOUR_ROW_PX / 2)).toBe(-30);
    expect(calendarMinutesFromOffset(2) % CALENDAR_SNAP_MINUTES).toBe(0);
  });

  it("labels 24 rows, leaving midnight blank because it is the top of the grid", () => {
    const rows = buildCalendarHourRows("24-hour");
    expect(rows).toHaveLength(24);
    expect(rows[0]?.label).toBe("");
    expect(rows[9]?.label).toBe("09:00");
    expect(rows[9]?.y).toBe(9 * CALENDAR_HOUR_ROW_PX);
    expect(formatCalendarMinutes(9 * 60, "12-hour")).toBe("9:00 AM");
    expect(formatCalendarMinutes(13 * 60 + 30, "24-hour")).toBe("13:30");
  });
});

describe("zones", () => {
  it("reads an instant as the wall clock of its own zone, not the viewer's", () => {
    expect(calendarWallClock(AUG_12_0900Z, UTC)).toEqual({ date: "2026-08-12", minutes: 540 });
    // Same instant, London: BST in August, so an hour later on the clock.
    expect(calendarWallClock(AUG_12_0900Z, LONDON)).toEqual({ date: "2026-08-12", minutes: 600 });
    // And a zone far enough west that the same instant is still the previous day.
    expect(calendarWallClock(AUG_12_0900Z, "America/Los_Angeles")).toEqual({
      date: "2026-08-12",
      minutes: 120,
    });
    expect(calendarWallClock(Date.UTC(2026, 7, 12, 3, 0), "America/Los_Angeles").date).toBe(
      "2026-08-11",
    );
  });

  it("falls back to UTC for a zone the runtime does not know rather than losing the event", () => {
    expect(calendarWallClock(AUG_12_0900Z, "Mars/Olympus")).toEqual({
      date: "2026-08-12",
      minutes: 540,
    });
  });

  it("round-trips a wall clock back to the instant that names it", () => {
    for (const zone of [UTC, LONDON, "America/Los_Angeles", "Asia/Kolkata"]) {
      const clock = calendarWallClock(AUG_12_0900Z, zone);
      expect(calendarInstantAt(clock.date, clock.minutes, zone)).toBe(AUG_12_0900Z);
    }
  });

  it("resolves a wall clock on the two days a zone changes offset", () => {
    // London springs forward at 01:00 on 2026-03-29 and back at 02:00 on 2026-10-25.
    expect(calendarInstantAt("2026-03-29", 0, LONDON)).toBe(Date.UTC(2026, 2, 29, 0, 0));
    expect(calendarInstantAt("2026-03-29", 120, LONDON)).toBe(Date.UTC(2026, 2, 29, 1, 0));
    // An ambiguous hour resolves to its first occurrence, which is what every calendar does.
    expect(calendarInstantAt("2026-10-25", 90, LONDON)).toBe(Date.UTC(2026, 9, 25, 0, 30));
  });

  it("bounds an all-day span at local midnight to local midnight after it", () => {
    const bounds = calendarDayBounds({
      startDate: "2026-08-12",
      endDate: "2026-08-13",
      timeZone: LONDON,
    });
    expect(bounds.startAt).toBe(Date.UTC(2026, 7, 11, 23, 0));
    expect(bounds.endAt).toBe(Date.UTC(2026, 7, 13, 23, 0));
    expect(calendarWallClock(bounds.startAt, LONDON)).toEqual({
      date: "2026-08-12",
      minutes: 0,
    });
  });
});

// ── Event blocks ───────────────────────────────────────────────────────

describe("event block layout", () => {
  it("places a block at the hour it names in its own zone", () => {
    const [block] = buildCalendarEventBlocks({ events: [event()], days: weekDays() });
    expect(block?.columnIndex).toBe(2);
    expect(block?.startMinutes).toBe(540);
    expect(block?.top).toBe(9 * CALENDAR_HOUR_ROW_PX);
    expect(block?.height).toBe(CALENDAR_HOUR_ROW_PX);
    expect(block?.lanes).toBe(1);
  });

  it("draws the same event an hour later when its zone says so", () => {
    const [block] = buildCalendarEventBlocks({
      events: [event({ timeZone: LONDON })],
      days: weekDays(),
    });
    expect(block?.startMinutes).toBe(600);
  });

  it("gives a five-minute event a height anyone can grab", () => {
    const [block] = buildCalendarEventBlocks({
      events: [event({ endAt: AUG_12_0900Z + 5 * 60_000 })],
      days: weekDays(),
    });
    expect(block?.height).toBe(CALENDAR_MIN_BLOCK_PX);
    expect(block?.endMinutes).toBe(545);
  });

  it("splits overlapping events into equal lanes across the whole cluster", () => {
    const blocks = buildCalendarEventBlocks({
      events: [
        event({ id: "a", startAt: AUG_12_0900Z, endAt: AUG_12_0900Z + 60 * 60_000 }),
        event({ id: "b", startAt: AUG_12_0900Z, endAt: AUG_12_0900Z + 60 * 60_000 }),
        // Overlaps only `a` and `b`'s tail, but the cluster is what sets the width.
        event({
          id: "c",
          startAt: AUG_12_0900Z + 30 * 60_000,
          endAt: AUG_12_0900Z + 90 * 60_000,
        }),
      ],
      days: weekDays(),
    });
    expect(blocks).toHaveLength(3);
    expect(new Set(blocks.map((block) => block.lanes))).toEqual(new Set([3]));
    expect(blocks.map((block) => block.lane).sort()).toEqual([0, 1, 2]);
  });

  it("starts a new cluster once a gap opens, so an unrelated event stays full width", () => {
    const blocks = buildCalendarEventBlocks({
      events: [
        event({ id: "a", startAt: AUG_12_0900Z, endAt: AUG_12_0900Z + 60 * 60_000 }),
        event({ id: "b", startAt: AUG_12_0900Z, endAt: AUG_12_0900Z + 60 * 60_000 }),
        event({
          id: "c",
          startAt: AUG_12_0900Z + 120 * 60_000,
          endAt: AUG_12_0900Z + 180 * 60_000,
        }),
      ],
      days: weekDays(),
    });
    const byId = new Map(blocks.map((block) => [block.event.id, block]));
    expect(byId.get("a")?.lanes).toBe(2);
    expect(byId.get("b")?.lanes).toBe(2);
    expect(byId.get("c")?.lanes).toBe(1);
  });

  it("reuses a lane once the event on it has ended", () => {
    const blocks = buildCalendarEventBlocks({
      events: [
        event({ id: "long", startAt: AUG_12_0900Z, endAt: AUG_12_0900Z + 180 * 60_000 }),
        event({ id: "first", startAt: AUG_12_0900Z, endAt: AUG_12_0900Z + 60 * 60_000 }),
        event({
          id: "second",
          startAt: AUG_12_0900Z + 60 * 60_000,
          endAt: AUG_12_0900Z + 120 * 60_000,
        }),
      ],
      days: weekDays(),
    });
    const byId = new Map(blocks.map((block) => [block.event.id, block]));
    expect(byId.get("first")?.lane).toBe(byId.get("second")?.lane);
    expect(new Set(blocks.map((block) => block.lanes))).toEqual(new Set([2]));
  });

  it("gives an event that crosses midnight a segment in each day it touches", () => {
    const blocks = buildCalendarEventBlocks({
      events: [
        event({
          startAt: Date.UTC(2026, 7, 12, 22, 0),
          endAt: Date.UTC(2026, 7, 13, 2, 0),
        }),
      ],
      days: weekDays(),
    });
    expect(blocks.map((block) => block.columnIndex)).toEqual([2, 3]);
    expect(blocks[0]).toMatchObject({
      startMinutes: 22 * 60,
      endMinutes: MINUTES_PER_DAY,
      clippedStart: false,
      clippedEnd: true,
    });
    expect(blocks[1]).toMatchObject({
      startMinutes: 0,
      endMinutes: 120,
      clippedStart: true,
      clippedEnd: false,
    });
  });

  it("keeps an event ending at midnight on the day it ran through", () => {
    const blocks = buildCalendarEventBlocks({
      events: [
        event({ startAt: Date.UTC(2026, 7, 12, 22, 0), endAt: Date.UTC(2026, 7, 13, 0, 0) }),
      ],
      days: weekDays(),
    });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.columnIndex).toBe(2);
    expect(blocks[0]?.endMinutes).toBe(MINUTES_PER_DAY);
  });

  it("drops the days of a spanning event that fall outside the range, keeping the rest", () => {
    const blocks = buildCalendarEventBlocks({
      events: [event({ startAt: Date.UTC(2026, 7, 9, 22, 0), endAt: Date.UTC(2026, 7, 10, 2, 0) })],
      days: weekDays(),
    });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ columnIndex: 0, startMinutes: 0, clippedStart: true });
  });

  it("leaves all-day events to the all-day lane", () => {
    expect(
      buildCalendarEventBlocks({ events: [event({ allDay: true })], days: weekDays() }),
    ).toEqual([]);
  });

  it("keys a block per column, so React never sees one key twice", () => {
    const blocks = buildCalendarEventBlocks({
      events: [
        event({ startAt: Date.UTC(2026, 7, 12, 22, 0), endAt: Date.UTC(2026, 7, 13, 2, 0) }),
      ],
      days: weekDays(),
    });
    expect(new Set(blocks.map((block) => block.key)).size).toBe(blocks.length);
  });
});

// ── All-day lane ───────────────────────────────────────────────────────

describe("all-day lane", () => {
  it("is empty when nothing lands on the range", () => {
    expect(buildCalendarAllDayLane({ items: [], days: weekDays() })).toEqual({
      bars: [],
      lanes: 0,
    });
    expect(
      buildCalendarAllDayLane({
        items: [
          allDay({ startDate: "2026-09-01" as IssueDate, endDate: "2026-09-02" as IssueDate }),
        ],
        days: weekDays(),
      }).bars,
    ).toEqual([]);
  });

  it("spans a multi-day item across the columns it covers", () => {
    const { bars, lanes } = buildCalendarAllDayLane({
      items: [allDay({ startDate: "2026-08-11" as IssueDate, endDate: "2026-08-14" as IssueDate })],
      days: weekDays(),
    });
    expect(bars[0]).toMatchObject({ columnIndex: 1, span: 4, lane: 0, clippedStart: false });
    expect(lanes).toBe(1);
  });

  it("clips a bar that runs off either end and says which end", () => {
    const { bars } = buildCalendarAllDayLane({
      items: [allDay({ startDate: "2026-08-05" as IssueDate, endDate: "2026-08-20" as IssueDate })],
      days: weekDays(),
    });
    expect(bars[0]).toMatchObject({
      columnIndex: 0,
      span: 7,
      clippedStart: true,
      clippedEnd: true,
    });
  });

  it("stacks overlapping items and reuses a lane once one has ended", () => {
    const { bars, lanes } = buildCalendarAllDayLane({
      items: [
        allDay({
          id: "long",
          startDate: "2026-08-10" as IssueDate,
          endDate: "2026-08-16" as IssueDate,
        }),
        allDay({
          id: "early",
          startDate: "2026-08-10" as IssueDate,
          endDate: "2026-08-11" as IssueDate,
        }),
        allDay({
          id: "late",
          startDate: "2026-08-13" as IssueDate,
          endDate: "2026-08-14" as IssueDate,
        }),
      ],
      days: weekDays(),
    });
    const byId = new Map(bars.map((bar) => [bar.item.id, bar]));
    // Longest first takes the top row; the two short ones share the one under it.
    expect(byId.get("long")?.lane).toBe(0);
    expect(byId.get("early")?.lane).toBe(1);
    expect(byId.get("late")?.lane).toBe(1);
    expect(lanes).toBe(2);
  });

  it("holds every date-only kind alongside all-day events", () => {
    const { bars } = buildCalendarAllDayLane({
      items: [
        allDay({ id: "i", kind: "issue" }),
        allDay({ id: "m", kind: "milestone" }),
        allDay({ id: "c", kind: "cycle" }),
        allDay({ id: "e", kind: "event", timeZone: UTC }),
      ],
      days: weekDays(),
    });
    expect(bars.map((bar) => bar.item.kind).sort()).toEqual([
      "cycle",
      "event",
      "issue",
      "milestone",
    ]);
  });
});

// ── Month cells ────────────────────────────────────────────────────────

describe("month cell packing", () => {
  const monthDays = () =>
    buildCalendarDays({
      range: calendarRange("month", TODAY),
      today: TODAY,
      anchorMonth: TODAY,
    });

  it("puts all-day spans above timed events and counts what does not fit", () => {
    const cells = buildCalendarMonthCells({
      days: monthDays(),
      allDay: [allDay({ id: "m1", startDate: TODAY, endDate: TODAY })],
      events: [
        event({ id: "e1", startAt: AUG_12_0900Z }),
        event({ id: "e2", startAt: AUG_12_0900Z + 60 * 60_000 }),
        event({ id: "e3", startAt: AUG_12_0900Z + 120 * 60_000 }),
      ],
      capacity: 2,
      timestampFormat: "24-hour",
    });
    const cell = cells.find((candidate) => candidate.date === TODAY);
    expect(cell?.chips.map((chip) => chip.id)).toEqual(["m1", "e1"]);
    expect(cell?.chips[0]?.time).toBeNull();
    expect(cell?.chips[1]?.time).toBe("09:00");
    expect(cell?.overflow).toBe(2);
  });

  it("repeats a spanning item in every cell it covers, only starting in the first", () => {
    const cells = buildCalendarMonthCells({
      days: monthDays(),
      allDay: [
        allDay({
          id: "m1",
          startDate: "2026-08-11" as IssueDate,
          endDate: "2026-08-13" as IssueDate,
        }),
      ],
      events: [],
      capacity: 4,
      timestampFormat: "24-hour",
    });
    const covered = cells.filter((cell) => cell.chips.some((chip) => chip.id === "m1"));
    expect(covered.map((cell) => cell.date)).toEqual(["2026-08-11", "2026-08-12", "2026-08-13"]);
    expect(covered.map((cell) => cell.chips[0]?.startsHere)).toEqual([true, false, false]);
  });

  it("orders a day's timed chips by start instant", () => {
    const cells = buildCalendarMonthCells({
      days: monthDays(),
      allDay: [],
      events: [
        event({ id: "late", startAt: AUG_12_0900Z + 180 * 60_000 }),
        event({ id: "early", startAt: AUG_12_0900Z }),
      ],
      capacity: 4,
      timestampFormat: "24-hour",
    });
    const cell = cells.find((candidate) => candidate.date === TODAY);
    expect(cell?.chips.map((chip) => chip.id)).toEqual(["early", "late"]);
  });

  it("shows an overnight event on both days, only timing the one it starts on", () => {
    const cells = buildCalendarMonthCells({
      days: monthDays(),
      allDay: [],
      events: [
        event({
          id: "night",
          startAt: Date.UTC(2026, 7, 12, 22, 0),
          endAt: Date.UTC(2026, 7, 13, 2, 0),
        }),
      ],
      capacity: 4,
      timestampFormat: "24-hour",
    });
    const covered = cells.filter((cell) => cell.chips.some((chip) => chip.id === "night"));
    expect(covered.map((cell) => cell.date)).toEqual(["2026-08-12", "2026-08-13"]);
    expect(covered.map((cell) => cell.chips[0]?.startsHere)).toEqual([true, false]);
    expect(covered.map((cell) => cell.chips[0]?.time)).toEqual(["22:00", null]);
  });

  it("keeps an event ending at midnight in the cell it ran through", () => {
    const cells = buildCalendarMonthCells({
      days: monthDays(),
      allDay: [],
      events: [
        event({
          id: "night",
          startAt: Date.UTC(2026, 7, 12, 22, 0),
          endAt: Date.UTC(2026, 7, 13, 0, 0),
        }),
      ],
      capacity: 4,
      timestampFormat: "24-hour",
    });
    expect(
      cells
        .filter((cell) => cell.chips.some((chip) => chip.id === "night"))
        .map((cell) => cell.date),
    ).toEqual(["2026-08-12"]);
  });

  it("puts a continuation ahead of the events that start that morning", () => {
    const cells = buildCalendarMonthCells({
      days: monthDays(),
      allDay: [],
      events: [
        event({
          id: "night",
          startAt: Date.UTC(2026, 7, 12, 22, 0),
          endAt: Date.UTC(2026, 7, 13, 2, 0),
        }),
        event({
          id: "standup",
          startAt: Date.UTC(2026, 7, 13, 9, 0),
          endAt: Date.UTC(2026, 7, 13, 9, 30),
        }),
      ],
      capacity: 4,
      timestampFormat: "24-hour",
    });
    const cell = cells.find((candidate) => candidate.date === "2026-08-13");
    expect(cell?.chips.map((chip) => chip.id)).toEqual(["night", "standup"]);
  });

  it("keeps every day of the grid, borrowed neighbours included", () => {
    const cells = buildCalendarMonthCells({
      days: monthDays(),
      allDay: [],
      events: [],
      capacity: 3,
      timestampFormat: "24-hour",
    });
    expect(cells).toHaveLength(42);
    expect(cells[0]?.inAnchorMonth).toBe(false);
    expect(cells.filter((cell) => cell.isToday)).toHaveLength(1);
  });
});

// ── Drops ──────────────────────────────────────────────────────────────

describe("grab edges", () => {
  it("resizes near an end and moves anywhere else", () => {
    expect(calendarGrabEdge({ offsetY: 2, height: 100 })).toBe("start");
    expect(calendarGrabEdge({ offsetY: 98, height: 100 })).toBe("end");
    expect(calendarGrabEdge({ offsetY: 50, height: 100 })).toBe("move");
  });

  it("makes a short block all body, because moving it matters more than resizing it", () => {
    expect(calendarGrabEdge({ offsetY: 1, height: CALENDAR_EDGE_GRAB_PX * 2 })).toBe("move");
  });
});

describe("timed drops", () => {
  it("means nothing when nothing moved", () => {
    expect(
      resolveCalendarTimedDrop({ event: event(), edge: "move", deltaDays: 0, deltaMinutes: 0 }),
    ).toBeNull();
  });

  it("moves both ends and keeps the duration", () => {
    const write = resolveCalendarTimedDrop({
      event: event(),
      edge: "move",
      deltaDays: 1,
      deltaMinutes: 30,
    });
    expect(write).toEqual({
      _tag: "Instants",
      startAt: Date.UTC(2026, 7, 13, 9, 30),
      endAt: Date.UTC(2026, 7, 13, 10, 30),
    });
  });

  it("carries past midnight when the minutes overflow the day", () => {
    const write = resolveCalendarTimedDrop({
      event: event({ startAt: Date.UTC(2026, 7, 12, 23, 0), endAt: Date.UTC(2026, 7, 13, 0, 0) }),
      edge: "move",
      deltaDays: 0,
      deltaMinutes: 120,
    });
    expect(write?.startAt).toBe(Date.UTC(2026, 7, 13, 1, 0));
  });

  it("keeps the hour across a clock change instead of sliding by one", () => {
    // 10:00 London on the Saturday before the autumn change, dragged two days forward.
    const before = calendarInstantAt("2026-10-24", 600, LONDON);
    const write = resolveCalendarTimedDrop({
      event: { startAt: before, endAt: before + 60 * 60_000, timeZone: LONDON },
      edge: "move",
      deltaDays: 2,
      deltaMinutes: 0,
    });
    expect(calendarWallClock(write?.startAt ?? 0, LONDON)).toEqual({
      date: "2026-10-26",
      minutes: 600,
    });
  });

  it("resizes one end and leaves the other alone", () => {
    const grown = resolveCalendarTimedDrop({
      event: event(),
      edge: "end",
      deltaDays: 0,
      deltaMinutes: 30,
    });
    expect(grown).toEqual({
      _tag: "Instants",
      startAt: AUG_12_0900Z,
      endAt: AUG_12_0900Z + 90 * 60_000,
    });
    const trimmed = resolveCalendarTimedDrop({
      event: event(),
      edge: "start",
      deltaDays: 0,
      deltaMinutes: 15,
    });
    expect(trimmed?.startAt).toBe(AUG_12_0900Z + 15 * 60_000);
    expect(trimmed?.endAt).toBe(AUG_12_0900Z + 60 * 60_000);
  });

  it("clamps a resize rather than turning the event inside out", () => {
    const write = resolveCalendarTimedDrop({
      event: event(),
      edge: "start",
      deltaDays: 0,
      deltaMinutes: 600,
    });
    expect(write?.startAt).toBe(write === null ? 0 : write.endAt - CALENDAR_SNAP_MINUTES * 60_000);
    const shrunk = resolveCalendarTimedDrop({
      event: event(),
      edge: "end",
      deltaDays: 0,
      deltaMinutes: -600,
    });
    expect(shrunk?.endAt).toBe(AUG_12_0900Z + CALENDAR_SNAP_MINUTES * 60_000);
  });
});

describe("all-day drops", () => {
  it("writes a date, and only a date, for every date-only kind", () => {
    for (const kind of ["issue", "milestone", "cycle"] as const) {
      const write = resolveCalendarAllDayDrop({
        item: allDay({ kind, startDate: TODAY, endDate: TODAY }),
        deltaDays: 3,
      });
      expect(write).toEqual({
        _tag: "Dates",
        startDate: "2026-08-15",
        endDate: "2026-08-15",
      });
    }
  });

  it("cannot reach an instant for a date-only item, because it has no zone to build one in", () => {
    const write = resolveCalendarAllDayDrop({
      item: { startDate: TODAY, endDate: TODAY, timeZone: null },
      deltaDays: 1,
    });
    expect(write?._tag).toBe("Dates");
    expect(write).not.toHaveProperty("startAt");
  });

  it("writes instants for an all-day event, bounded at midnight in its own zone", () => {
    const write = resolveCalendarAllDayDrop({
      item: { startDate: TODAY, endDate: TODAY, timeZone: LONDON },
      deltaDays: 1,
    });
    expect(write).toEqual({
      _tag: "Instants",
      startAt: Date.UTC(2026, 7, 12, 23, 0),
      endAt: Date.UTC(2026, 7, 13, 23, 0),
    });
  });

  it("moves both ends of a span together", () => {
    expect(
      resolveCalendarAllDayDrop({
        item: allDay({ startDate: "2026-08-10" as IssueDate, endDate: "2026-08-12" as IssueDate }),
        deltaDays: -2,
      }),
    ).toEqual({ _tag: "Dates", startDate: "2026-08-08", endDate: "2026-08-10" });
  });

  it("means nothing when nothing moved", () => {
    expect(resolveCalendarAllDayDrop({ item: allDay(), deltaDays: 0 })).toBeNull();
  });
});

describe("crossing between the lane and the grid", () => {
  it("turns a timed event all-day at the day it was dropped on", () => {
    const write = resolveCalendarAllDayToggle({
      event: { ...event(), timeZone: UTC },
      allDay: true,
      date: "2026-08-14" as IssueDate,
    });
    expect(write).toEqual({
      _tag: "Instants",
      startAt: Date.UTC(2026, 7, 14),
      endAt: Date.UTC(2026, 7, 15),
    });
  });

  it("brings an all-day event back onto the hours at the start of the working day", () => {
    const write = resolveCalendarAllDayToggle({
      event: { ...event({ allDay: true }), timeZone: UTC },
      allDay: false,
      date: TODAY,
    });
    expect(write).toEqual({
      _tag: "Instants",
      startAt: Date.UTC(2026, 7, 12, 9, 0),
      endAt: Date.UTC(2026, 7, 12, 10, 0),
    });
  });

  it("means nothing when the event is already the way it was dropped", () => {
    expect(resolveCalendarAllDayToggle({ event: event(), allDay: false, date: TODAY })).toBeNull();
  });
});

describe("the first calendar", () => {
  it("uses the calendar the member already has", async () => {
    let made = 0;
    const target = makeCalendarCreateTarget(async () => {
      made += 1;
      return "made";
    });
    await expect(target("calendar-1")).resolves.toBe("calendar-1");
    expect(made).toBe(0);
  });

  it("makes one calendar for two creates that beat the change feed to it", async () => {
    let made = 0;
    const target = makeCalendarCreateTarget(async () => {
      made += 1;
      return `calendar-${made}`;
    });
    // Both creates happen while `defaultCalendarId` is still null: the replica has not echoed yet.
    const [first, second] = await Promise.all([target(null), target(null)]);
    expect([first, second]).toEqual(["calendar-1", "calendar-1"]);
    expect(made).toBe(1);
  });

  it("lets the next create try again after one that failed", async () => {
    let made = 0;
    const target = makeCalendarCreateTarget(async () => {
      made += 1;
      if (made === 1) throw new Error("refused");
      return "calendar-2";
    });
    await expect(target(null)).rejects.toThrow("refused");
    await expect(target(null)).resolves.toBe("calendar-2");
  });

  it("follows the replica once it catches up", async () => {
    let made = 0;
    const target = makeCalendarCreateTarget(async () => {
      made += 1;
      return "calendar-1";
    });
    await target(null);
    await expect(target("calendar-1")).resolves.toBe("calendar-1");
    expect(made).toBe(1);
  });
});

describe("click to create", () => {
  it("makes an hour at the snapped slot under the pointer", () => {
    expect(resolveCalendarNewEvent({ date: TODAY, minutes: 545, timeZone: UTC })).toEqual({
      _tag: "Instants",
      startAt: Date.UTC(2026, 7, 12, 9, 0),
      endAt: Date.UTC(2026, 7, 12, 10, 0),
    });
  });

  it("starts the last hour of the day rather than one that would run into tomorrow", () => {
    const write = resolveCalendarNewEvent({ date: TODAY, minutes: 1439, timeZone: UTC });
    expect(write.endAt - write.startAt).toBe(CALENDAR_DEFAULT_EVENT_MINUTES * 60_000);
    expect(calendarWallClock(write.startAt, UTC)).toEqual({ date: TODAY, minutes: 1380 });
  });
});
