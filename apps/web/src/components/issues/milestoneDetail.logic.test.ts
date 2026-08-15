import type { IssueMilestone, IssueStatusCategory } from "@spiritdevs/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  formatMilestoneDaysRemaining,
  formatMilestonePace,
  milestoneKpis,
  milestoneStartedCount,
  milestoneStatusPresentation,
  milestoneVerdictPresentation,
  type MilestoneKpiInput,
} from "./milestoneDetail.logic";

const TODAY = "2026-08-11";

function milestone(
  overrides: Partial<Pick<IssueMilestone, "startDate" | "targetDate" | "createdAt">> = {},
): MilestoneKpiInput["milestone"] {
  return {
    startDate: "2026-08-01",
    targetDate: "2026-08-20",
    createdAt: "2026-07-15T09:00:00.000Z",
    ...overrides,
  };
}

function kpis(done: number, total: number, overrides: Partial<MilestoneKpiInput> = {}) {
  return milestoneKpis({
    milestone: milestone(),
    progress: { done, total },
    today: TODAY,
    ...overrides,
  });
}

describe("milestoneKpis", () => {
  it("reads a milestone holding nothing as unjudgeable rather than as behind", () => {
    const result = kpis(0, 0);
    expect(result.ratio).toBe(0);
    expect(result.remaining).toBe(0);
    expect(result.pace).toBe(0);
    expect(result.projectedFinish).toBeNull();
    expect(result.verdict).toBe("unknown");
  });

  it("counts elapsed days inclusively, so a milestone started today has a pace", () => {
    const result = kpis(2, 6, { milestone: milestone({ startDate: TODAY }) });
    expect(result.elapsedDays).toBe(1);
    expect(result.pace).toBe(2);
  });

  it("measures a milestone whose start is still in the future from today", () => {
    const result = kpis(0, 6, { milestone: milestone({ startDate: "2026-09-01" }) });
    expect(result.elapsedDays).toBe(1);
  });

  it("falls back to the creation day when the milestone has no start date", () => {
    const result = kpis(4, 8, { milestone: milestone({ startDate: null }) });
    // 2026-07-15 through 2026-08-11, both counted.
    expect(result.elapsedDays).toBe(28);
  });

  it("calls a milestone on track when its pace beats the pace the target needs", () => {
    const result = kpis(6, 10);
    expect(result.elapsedDays).toBe(11);
    expect(result.daysRemaining).toBe(9);
    expect(result.verdict).toBe("on-track");
    // The projection and the verdict are the same comparison, so they agree.
    expect(result.projectedFinish).toBe("2026-08-18");
  });

  it("calls a milestone at risk when it is short of the required pace but within reach", () => {
    const result = kpis(5, 10);
    expect(result.verdict).toBe("at-risk");
    expect(result.projectedFinish).toBe("2026-08-21");
  });

  it("calls a milestone behind when the pace is nowhere near the required one", () => {
    const result = kpis(2, 10);
    expect(result.verdict).toBe("behind");
  });

  it("calls a milestone with work left behind once the target is past", () => {
    const result = kpis(9, 10, { milestone: milestone({ targetDate: "2026-08-05" }) });
    expect(result.daysRemaining).toBe(-6);
    expect(result.verdict).toBe("behind");
  });

  it("withholds a verdict until something has been completed", () => {
    const result = kpis(0, 10);
    expect(result.pace).toBe(0);
    expect(result.projectedFinish).toBeNull();
    expect(result.verdict).toBe("unknown");
  });

  it("withholds a verdict when there is no target to be measured against", () => {
    const result = kpis(5, 10, { milestone: milestone({ targetDate: null }) });
    expect(result.daysRemaining).toBeNull();
    expect(result.requiredPace).toBeNull();
    expect(result.verdict).toBe("unknown");
  });

  it("reads a finished milestone as on track and stops projecting", () => {
    const result = kpis(10, 10, { milestone: milestone({ targetDate: "2026-08-05" }) });
    expect(result.ratio).toBe(1);
    expect(result.remaining).toBe(0);
    expect(result.projectedFinish).toBeNull();
    expect(result.verdict).toBe("on-track");
  });

  it("clamps a rollup that claims more done than it holds", () => {
    const result = kpis(12, 10);
    expect(result.done).toBe(10);
    expect(result.ratio).toBe(1);
    expect(result.remaining).toBe(0);
  });

  it("withholds a verdict rather than guessing at an unparseable target", () => {
    const result = kpis(5, 10, { milestone: milestone({ targetDate: "not-a-date" }) });
    expect(result.daysRemaining).toBeNull();
    expect(result.verdict).toBe("unknown");
  });
});

describe("milestoneStartedCount", () => {
  function counts(entries: Partial<Record<IssueStatusCategory, number>>) {
    return new Map(Object.entries(entries) as ReadonlyArray<[IssueStatusCategory, number]>);
  }

  it("counts everything past the backlog and short of done, review included", () => {
    const started = milestoneStartedCount(
      { done: 2, total: 9 },
      counts({ backlog: 1, unstarted: 3, started: 2, review: 1, completed: 2, canceled: 4 }),
    );
    expect(started).toBe(3);
  });

  it("is zero when nothing has been picked up", () => {
    expect(milestoneStartedCount({ done: 0, total: 4 }, counts({ unstarted: 4 }))).toBe(0);
  });

  it("never goes negative when the breakdown has not caught up with the rollup", () => {
    expect(milestoneStartedCount({ done: 0, total: 1 }, counts({ backlog: 5 }))).toBe(0);
  });
});

describe("presentation", () => {
  it("gives every verdict a word of its own, so the tone is never the only signal", () => {
    expect(milestoneVerdictPresentation("on-track")).toEqual({
      label: "On track",
      tone: "success",
    });
    expect(milestoneVerdictPresentation("at-risk")).toEqual({ label: "At risk", tone: "warning" });
    expect(milestoneVerdictPresentation("behind")).toEqual({ label: "Behind", tone: "error" });
    expect(milestoneVerdictPresentation("unknown").tone).toBe("outline");
  });

  it("names each derived milestone status", () => {
    expect(milestoneStatusPresentation("overdue")).toEqual({ label: "Overdue", tone: "error" });
    expect(milestoneStatusPresentation("in-progress").label).toBe("In progress");
    expect(milestoneStatusPresentation("completed").tone).toBe("success");
    expect(milestoneStatusPresentation("upcoming").tone).toBe("outline");
  });

  it("formats the days-to-target tile in both directions", () => {
    expect(formatMilestoneDaysRemaining(null)).toBe("—");
    expect(formatMilestoneDaysRemaining(0)).toBe("Due today");
    expect(formatMilestoneDaysRemaining(1)).toBe("1 day");
    expect(formatMilestoneDaysRemaining(9)).toBe("9 days");
    expect(formatMilestoneDaysRemaining(-1)).toBe("1 day ago");
    expect(formatMilestoneDaysRemaining(-6)).toBe("6 days ago");
  });

  it("keeps a decimal on the pace, so three issues a week is not reported as none", () => {
    expect(formatMilestonePace(3 / 7)).toBe("0.4/day");
    expect(formatMilestonePace(0)).toBe("—");
    expect(formatMilestonePace(Number.NaN)).toBe("—");
  });
});
