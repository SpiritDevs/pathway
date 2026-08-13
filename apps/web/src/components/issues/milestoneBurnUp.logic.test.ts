import type { IssueMilestoneHistoryPoint } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  BURN_UP_VIEW_HEIGHT,
  BURN_UP_VIEW_WIDTH,
  buildBurnUpChart,
  burnUpDirectLabels,
  burnUpIndexAtFraction,
  niceCountScale,
  type BurnUpInput,
} from "./milestoneBurnUp.logic";

/** Four days from the 1st, scope holding at 4 while completed climbs. */
function series(
  values: ReadonlyArray<{ scope: number; started: number; completed: number }>,
  from = "2026-08-01",
): ReadonlyArray<IssueMilestoneHistoryPoint> {
  const [year, month, day] = from.split("-").map(Number);
  return values.map((value, index) => ({
    date: new Date(Date.UTC(year ?? 2026, (month ?? 1) - 1, (day ?? 1) + index))
      .toISOString()
      .slice(0, 10),
    ...value,
  }));
}

const POINTS = series([
  { scope: 4, started: 0, completed: 0 },
  { scope: 4, started: 2, completed: 1 },
  { scope: 5, started: 3, completed: 2 },
  { scope: 5, started: 4, completed: 3 },
]);

function chart(overrides: Partial<BurnUpInput> = {}) {
  const built = buildBurnUpChart({
    points: POINTS,
    startDate: "2026-08-01",
    targetDate: "2026-08-08",
    ...overrides,
  });
  if (built === null) throw new Error("expected a chart");
  return built;
}

describe("niceCountScale", () => {
  it("never puts the peak above the top of the scale", () => {
    for (const peak of [1, 3, 7, 12, 99, 1000]) {
      expect(niceCountScale(peak, 4).max, `peak ${peak}`).toBeGreaterThanOrEqual(peak);
    }
  });

  it("counts issues in whole numbers", () => {
    // A "2.5 issues" gridline is the defect this exists to prevent.
    for (const peak of [1, 2, 3, 5, 7, 13]) {
      for (const tick of niceCountScale(peak, 4).ticks) {
        expect(Number.isInteger(tick), `peak ${peak} tick ${tick}`).toBe(true);
      }
    }
  });

  it("keeps a small milestone on single-issue steps", () => {
    expect(niceCountScale(3, 4)).toEqual({ max: 3, ticks: [0, 1, 2, 3] });
  });

  it("degrades to a single zero tick with no data", () => {
    expect(niceCountScale(0, 4)).toEqual({ max: 0, ticks: [0] });
  });
});

describe("buildBurnUpChart", () => {
  it("declines to draw a single day", () => {
    expect(buildBurnUpChart({ points: [], startDate: null, targetDate: null })).toBeNull();
    expect(
      buildBurnUpChart({
        points: series([{ scope: 3, started: 1, completed: 0 }]),
        startDate: "2026-08-01",
        targetDate: "2026-08-08",
      }),
    ).toBeNull();
  });

  it("spans the axis through the target date, not just the last point", () => {
    // Aug 1 through Aug 8 is eight days; the four points fill the first half.
    const built = chart();

    expect(built.domainDays).toBe(8);
    expect(built.firstDayOffset).toBe(0);
    expect(built.columns[0]?.x).toBe(0);
    expect(built.last.x).toBeCloseTo((3 / 7) * BURN_UP_VIEW_WIDTH, 6);
    expect(built.axisDates).toEqual(["2026-08-01", "2026-08-04", "2026-08-08"]);
  });

  it("keeps the last point at the right edge when the target is already past", () => {
    const built = chart({ targetDate: "2026-08-02" });

    expect(built.domainDays).toBe(4);
    expect(built.last.x).toBeCloseTo(BURN_UP_VIEW_WIDTH, 6);
  });

  it("offsets the points when the milestone started before them", () => {
    const built = chart({ startDate: "2026-07-30" });

    expect(built.domainDays).toBe(10);
    expect(built.firstDayOffset).toBe(2);
    expect(built.columns[0]?.x).toBeCloseTo((2 / 9) * BURN_UP_VIEW_WIDTH, 6);
  });

  it("plots completed and scope against one axis", () => {
    const built = chart();

    // Peak scope is 5, which rounds the axis up to a whole-step 6; both series measure against it.
    expect(built.max).toBe(6);
    expect(built.last.completedY).toBeCloseTo(
      BURN_UP_VIEW_HEIGHT - (3 / 6) * (BURN_UP_VIEW_HEIGHT - 8),
      6,
    );
    expect(built.last.scopeY).toBeCloseTo(
      BURN_UP_VIEW_HEIGHT - (5 / 6) * (BURN_UP_VIEW_HEIGHT - 8),
      6,
    );
  });

  it("closes the completed area on the baseline", () => {
    const built = chart();

    expect(built.completedLine.startsWith("M0.00,")).toBe(true);
    expect(built.completedArea.startsWith(built.completedLine)).toBe(true);
    expect(built.completedArea.endsWith(`L0.00,${BURN_UP_VIEW_HEIGHT} Z`)).toBe(true);
  });

  it("runs the ideal line from the start at zero to the target at final scope", () => {
    const built = chart();

    expect(built.ideal?.path).toBe(
      `M0.00,${BURN_UP_VIEW_HEIGHT.toFixed(2)} L${BURN_UP_VIEW_WIDTH.toFixed(2)},${built.last.scopeY.toFixed(2)}`,
    );
    expect(built.ideal?.x).toBeCloseTo(BURN_UP_VIEW_WIDTH, 6);
    expect(built.ideal?.y).toBeCloseTo(built.last.scopeY, 6);
  });

  it("drops the ideal line when the milestone is missing a date", () => {
    expect(chart({ startDate: null }).ideal).toBeNull();
    expect(chart({ targetDate: null }).ideal).toBeNull();
    // A start and target on the same day is a vertical line, which reads as an error, not a plan.
    expect(chart({ startDate: "2026-08-04", targetDate: "2026-08-04" }).ideal).toBeNull();
  });

  it("still draws both series for an undated milestone", () => {
    const built = chart({ startDate: null, targetDate: null });

    expect(built.ideal).toBeNull();
    expect(built.columns).toHaveLength(4);
    expect(built.last.x).toBeCloseTo(BURN_UP_VIEW_WIDTH, 6);
  });

  it("flattens an empty milestone onto the baseline instead of dividing by zero", () => {
    const built = chart({
      points: series([
        { scope: 0, started: 0, completed: 0 },
        { scope: 0, started: 0, completed: 0 },
      ]),
    });

    expect(built.max).toBe(0);
    expect(built.last.scopeY).toBe(BURN_UP_VIEW_HEIGHT);
    expect(built.last.completedY).toBe(BURN_UP_VIEW_HEIGHT);
  });

  it("carries each day's counts through to the column the tooltip reads", () => {
    const built = chart();

    expect(built.columns[1]).toMatchObject({
      date: "2026-08-02",
      scope: 4,
      started: 2,
      completed: 1,
    });
  });
});

describe("burnUpIndexAtFraction", () => {
  it("snaps to the nearest day", () => {
    const built = chart();

    expect(burnUpIndexAtFraction(built, 0)).toBe(0);
    expect(burnUpIndexAtFraction(built, 1 / 7)).toBe(1);
    expect(burnUpIndexAtFraction(built, 1 / 7 + 0.02)).toBe(1);
  });

  it("clamps past the last day with data", () => {
    const built = chart();

    // The axis runs to Aug 8 but the data stops on the 4th.
    expect(burnUpIndexAtFraction(built, 1)).toBe(3);
    expect(burnUpIndexAtFraction(built, 2)).toBe(3);
    expect(burnUpIndexAtFraction(built, -1)).toBe(0);
  });

  it("clamps before the first day with data", () => {
    const built = chart({ startDate: "2026-07-30" });

    expect(burnUpIndexAtFraction(built, 0)).toBe(0);
    expect(burnUpIndexAtFraction(built, 2 / 9)).toBe(0);
    expect(burnUpIndexAtFraction(built, 3 / 9)).toBe(1);
  });
});

describe("burnUpDirectLabels", () => {
  it("anchors both labels on the last day", () => {
    const built = chart();
    const labels = burnUpDirectLabels(built);

    expect(labels.completed.value).toBe(3);
    expect(labels.scope.value).toBe(5);
    expect(labels.completed.leftPercent).toBeCloseTo((3 / 7) * 100, 6);
    expect(labels.scope.leftPercent).toBe(labels.completed.leftPercent);
  });

  it("pushes the pair apart once the milestone finishes", () => {
    const built = chart({
      points: series([
        { scope: 4, started: 4, completed: 2 },
        { scope: 4, started: 4, completed: 4 },
      ]),
    });
    const labels = burnUpDirectLabels(built);

    expect(built.last.completedY).toBe(built.last.scopeY);
    const separation =
      ((labels.completed.topPercent - labels.scope.topPercent) / 100) * BURN_UP_VIEW_HEIGHT;
    expect(separation).toBeCloseTo(13, 6);
  });

  it("leaves labels alone when the series are already apart", () => {
    const built = chart();
    const labels = burnUpDirectLabels(built);

    expect(labels.completed.topPercent).toBeCloseTo(
      (built.last.completedY / BURN_UP_VIEW_HEIGHT) * 100,
      6,
    );
    expect(labels.scope.topPercent).toBeCloseTo((built.last.scopeY / BURN_UP_VIEW_HEIGHT) * 100, 6);
  });
});
