import { describe, expect, it } from "vite-plus/test";

import { msUntilNextLocalMidnight } from "./useTodayIssueDate";

describe("msUntilNextLocalMidnight", () => {
  it("waits out the rest of the evening rather than a fixed period", () => {
    expect(msUntilNextLocalMidnight(new Date(2026, 7, 12, 23, 30))).toBe(30 * 60_000);
    expect(msUntilNextLocalMidnight(new Date(2026, 7, 12, 9, 0))).toBe(15 * 60 * 60_000);
  });

  it("is a whole day at midnight itself, so the tick that just fired arms the next one", () => {
    expect(msUntilNextLocalMidnight(new Date(2026, 7, 12, 0, 0, 0, 0))).toBe(24 * 60 * 60_000);
  });

  it("never returns zero, which would spin on the boundary it just crossed", () => {
    expect(msUntilNextLocalMidnight(new Date(2026, 7, 12, 23, 59, 59, 999))).toBe(1);
  });
});
