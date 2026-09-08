import { describe, expect, it } from "vite-plus/test";
import { createIssueComposerClock } from "./issueComposerTime";

describe("issue composer time", () => {
  it("keeps intervals ordered when the device clock moves backward between interactions", () => {
    const clock = createIssueComposerClock();
    clock.activity(10_000);
    clock.pause(20_000);
    clock.activity(15_000);
    clock.activity(14_000);
    expect(clock.snapshot(25_000).intervals).toEqual([
      { start: 10_000, end: 20_000 },
      { start: 20_000, end: 25_000 },
    ]);
  });
  it("excludes an idle gap and preserves separate active intervals", () => {
    const clock = createIssueComposerClock();
    clock.activity(1_000);
    clock.activity(11_000);
    clock.activity(100_000);
    expect(clock.snapshot(105_000).intervals).toEqual([
      { start: 1_000, end: 41_000 },
      { start: 100_000, end: 105_000 },
    ]);
  });

  it("stops immediately on backgrounding and does not count time until interaction resumes", () => {
    const clock = createIssueComposerClock();
    clock.activity(1_000);
    clock.pause(6_000);
    expect(clock.snapshot(200_000).intervals).toEqual([{ start: 1_000, end: 6_000 }]);
    clock.activity(201_000);
    expect(clock.snapshot(204_000).intervals).toHaveLength(2);
  });

  it("retains measurements for retry but starts create-more from zero", () => {
    const clock = createIssueComposerClock();
    clock.activity(1_000);
    clock.pause(11_000);
    expect(clock.snapshot(11_000)).toEqual(clock.snapshot(15_000));
    clock.reset();
    expect(clock.snapshot(16_000).intervals).toEqual([]);
  });
});
