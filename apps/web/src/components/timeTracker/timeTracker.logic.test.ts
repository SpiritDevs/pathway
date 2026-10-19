import { describe, expect, it } from "vite-plus/test";

import {
  formatTrackedDuration,
  startOfLocalWeek,
  totalDuration,
  trackedActivityDuration,
  trackedActivityDayBoundaries,
  type TimeEntry,
} from "./timeTracker.logic";

describe("formatTrackedDuration", () => {
  it("formats compact summaries and live timers", () => {
    expect(formatTrackedDuration(65_000)).toBe("1m");
    expect(formatTrackedDuration(3_725_000)).toBe("1h 02m");
    expect(formatTrackedDuration(3_725_000, true)).toBe("01:02:05");
  });
});

describe("time entry totals", () => {
  it("adds entries within the requested window", () => {
    const entries: TimeEntry[] = [
      {
        id: "1",
        description: "Design",
        projectKey: "p1",
        projectName: "Pathway",
        startedAt: "2026-08-14T23:00:00.000Z",
        stoppedAt: "2026-08-15T00:00:00.000Z",
        durationMs: 3_600_000,
      },
      {
        id: "2",
        description: "Old work",
        projectKey: "p1",
        projectName: "Pathway",
        startedAt: "2026-08-01T00:00:00.000Z",
        stoppedAt: "2026-08-01T01:00:00.000Z",
        durationMs: 3_600_000,
      },
    ];

    expect(totalDuration(entries, new Date("2026-08-10T00:00:00.000Z"))).toBe(3_600_000);
  });

  it("starts weeks on Monday", () => {
    expect(startOfLocalWeek(new Date(2026, 7, 16, 10)).getDate()).toBe(10);
  });
});

describe("tracked activity clocks", () => {
  const session = {
    source: "agent" as const,
    state: "running" as const,
    startedAt: "2026-09-08T00:00:00.000Z",
    durationMs: 120_000,
    runningSince: 1_000,
    observedAt: 20_000,
  };

  it("adds current work to completed intervals without adding blocked time", () => {
    expect(trackedActivityDuration(session, 31_000)).toBe(150_000);
    expect(
      trackedActivityDuration({ ...session, state: "paused", runningSince: null }, 999_000),
    ).toBe(120_000);
  });

  it("stops an agent clock growing after its observation lease", () => {
    expect(trackedActivityDuration(session, 999_000)).toBe(229_000);
    expect(trackedActivityDuration({ ...session, source: "manual" }, 999_000)).toBe(1_118_000);
  });
});

describe("local activity days", () => {
  it("uses local midnight boundaries across daylight saving", () => {
    const previous = process.env.TZ;
    process.env.TZ = "Australia/Sydney";
    try {
      const days = trackedActivityDayBoundaries(new Date(2026, 9, 3), new Date(2026, 9, 6));
      expect(days.map((day) => day.date)).toEqual(["2026-10-03", "2026-10-04", "2026-10-05"]);
      expect(days.map((day) => (day.end - day.start) / 3_600_000)).toEqual([24, 23, 24]);
      expect(days[0]?.end).toBe(days[1]?.start);
      expect(days[1]?.end).toBe(days[2]?.start);
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  });
});
