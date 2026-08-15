import { describe, expect, it } from "vite-plus/test";

import {
  formatTrackedDuration,
  startOfLocalWeek,
  totalDuration,
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
