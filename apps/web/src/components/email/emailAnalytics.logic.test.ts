import type { EmailAnalyticsResult, EmailMailSlug, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  deriveEmailAnalyticsWindow,
  emailAnalyticsInput,
  emailAnalyticsRange,
  emailAxisLabelStride,
  emailBarPercent,
  emailBucketDurationMs,
  emailPeakBucketIndex,
  emailProjectCountLabel,
  emailVolumeAxis,
  emailVolumeTotal,
  emailWindowAdvanceDelayMs,
  EMAIL_ANALYTICS_RANGES,
  fillEmailVolumeBuckets,
  formatEmailBucketLabel,
  formatEmailBucketRangeLabel,
  isEmailAnalyticsEmpty,
  isEmailAxisLabelled,
  showsEmailProjectBreakdown,
  TOP_EMAIL_ADDRESS_LIMIT,
} from "./emailAnalytics.logic";

const NOON = new Date("2026-08-13T12:34:56.789Z");

describe("emailAnalyticsRange", () => {
  it("resolves each documented id", () => {
    for (const range of EMAIL_ANALYTICS_RANGES) {
      expect(emailAnalyticsRange(range.id)).toEqual(range);
    }
  });

  it("falls back to the week rather than to an empty chart", () => {
    expect(emailAnalyticsRange(undefined).id).toBe("7d");
    expect(emailAnalyticsRange("all-time").id).toBe("7d");
  });

  it("keeps hour buckets off the long ranges", () => {
    expect(emailAnalyticsRange("24h").interval).toBe("hour");
    expect(emailAnalyticsRange("7d").interval).toBe("day");
    expect(emailAnalyticsRange("30d").interval).toBe("day");
  });
});

describe("deriveEmailAnalyticsWindow", () => {
  it("ends at the end of the bucket now falls in, so the current one is a whole column", () => {
    expect(deriveEmailAnalyticsWindow("24h", NOON).to).toBe("2026-08-13T13:00:00.000Z");
    expect(deriveEmailAnalyticsWindow("7d", NOON).to).toBe("2026-08-14T00:00:00.000Z");
  });

  it("spans exactly the range's bucket count", () => {
    const day = deriveEmailAnalyticsWindow("7d", NOON);
    expect(day.from).toBe("2026-08-07T00:00:00.000Z");
    expect(day.bucketStarts).toHaveLength(7);
    expect(day.bucketStarts.at(0)).toBe("2026-08-07T00:00:00.000Z");
    expect(day.bucketStarts.at(-1)).toBe("2026-08-13T00:00:00.000Z");

    const hour = deriveEmailAnalyticsWindow("24h", NOON);
    expect(hour.from).toBe("2026-08-12T13:00:00.000Z");
    expect(hour.bucketStarts).toHaveLength(24);
    expect(hour.bucketStarts.at(-1)).toBe("2026-08-13T12:00:00.000Z");
  });

  it("emits the exact string SQLite's strftime produces, or every join would miss", () => {
    for (const start of deriveEmailAnalyticsWindow("30d", NOON).bucketStarts) {
      expect(start).toMatch(/^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/);
    }
    for (const start of deriveEmailAnalyticsWindow("24h", NOON).bucketStarts) {
      expect(start).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:00:00\.000Z$/);
    }
  });

  it("keeps the grid evenly spaced by the interval", () => {
    const window = deriveEmailAnalyticsWindow("30d", NOON);
    const size = emailBucketDurationMs("day");
    for (const [index, start] of window.bucketStarts.entries()) {
      if (index === 0) continue;
      const previous = window.bucketStarts[index - 1] ?? "";
      expect(Date.parse(start) - Date.parse(previous)).toBe(size);
    }
  });

  it("snaps a boundary instant onto the next bucket rather than half of one", () => {
    const exact = deriveEmailAnalyticsWindow("7d", new Date("2026-08-13T00:00:00.000Z"));
    expect(exact.to).toBe("2026-08-14T00:00:00.000Z");
    expect(exact.bucketStarts.at(-1)).toBe("2026-08-13T00:00:00.000Z");
  });
});

describe("emailWindowAdvanceDelayMs", () => {
  it("counts down to the window's exclusive `to`", () => {
    // NOON is 12:34:56.789; the hour window ends at 13:00, the day window at the next UTC midnight.
    expect(emailWindowAdvanceDelayMs(deriveEmailAnalyticsWindow("24h", NOON), NOON)).toBe(
      1_503_211,
    );
    expect(emailWindowAdvanceDelayMs(deriveEmailAnalyticsWindow("7d", NOON), NOON)).toBe(
      41_103_211,
    );
  });

  it("asks for an immediate advance once the boundary has passed", () => {
    const window = deriveEmailAnalyticsWindow("24h", NOON);
    expect(emailWindowAdvanceDelayMs(window, new Date("2026-08-13T13:00:00.000Z"))).toBe(0);
    expect(emailWindowAdvanceDelayMs(window, new Date("2026-08-14T05:00:00.000Z"))).toBe(0);
  });

  it("does not schedule off an unparsable instant", () => {
    expect(
      emailWindowAdvanceDelayMs(deriveEmailAnalyticsWindow("24h", NOON), new Date(Number.NaN)),
    ).toBe(0);
  });
});

describe("emailAnalyticsInput", () => {
  it("carries the scope, the window edges, and a modest address limit", () => {
    const window = deriveEmailAnalyticsWindow("7d", NOON);
    expect(emailAnalyticsInput({ type: "unassigned" }, window)).toEqual({
      scope: { type: "unassigned" },
      from: "2026-08-07T00:00:00.000Z",
      to: "2026-08-14T00:00:00.000Z",
      interval: "day",
      topAddressLimit: TOP_EMAIL_ADDRESS_LIMIT,
    });
  });
});

describe("formatEmailBucketLabel", () => {
  it("names a day bucket by its UTC date", () => {
    expect(formatEmailBucketLabel("2026-08-09T00:00:00.000Z", "day")).toBe("Aug 9");
    expect(formatEmailBucketLabel("2026-01-31T00:00:00.000Z", "day")).toBe("Jan 31");
  });

  it("names an hour bucket by its UTC hour, zero padded", () => {
    expect(formatEmailBucketLabel("2026-08-09T07:00:00.000Z", "hour")).toBe("07:00");
    expect(formatEmailBucketLabel("2026-08-09T23:00:00.000Z", "hour")).toBe("23:00");
  });

  it("does not invent a label for an unparsable instant", () => {
    expect(formatEmailBucketLabel("not-a-date", "day")).toBe("—");
    expect(formatEmailBucketRangeLabel("not-a-date", "hour")).toBe("—");
  });
});

describe("formatEmailBucketRangeLabel", () => {
  it("spells out the whole bucket and says which clock it is on", () => {
    expect(formatEmailBucketRangeLabel("2026-08-09T00:00:00.000Z", "day")).toBe("Aug 9 UTC");
    expect(formatEmailBucketRangeLabel("2026-08-09T07:00:00.000Z", "hour")).toBe(
      "Aug 9, 07:00–08:00 UTC",
    );
  });

  it("wraps the last hour of the day onto the next one", () => {
    expect(formatEmailBucketRangeLabel("2026-08-09T23:00:00.000Z", "hour")).toBe(
      "Aug 9, 23:00–00:00 UTC",
    );
  });
});

describe("fillEmailVolumeBuckets", () => {
  const window = deriveEmailAnalyticsWindow("7d", NOON);

  it("fills the days the server left out with zero rather than closing the gap", () => {
    const buckets = fillEmailVolumeBuckets(window, [
      { bucketStart: "2026-08-08T00:00:00.000Z", messageCount: 4 },
      { bucketStart: "2026-08-12T00:00:00.000Z", messageCount: 9 },
    ]);
    expect(buckets).toHaveLength(7);
    expect(buckets.map((bucket) => bucket.messageCount)).toEqual([0, 4, 0, 0, 0, 9, 0]);
    expect(buckets.map((bucket) => bucket.label)).toEqual([
      "Aug 7",
      "Aug 8",
      "Aug 9",
      "Aug 10",
      "Aug 11",
      "Aug 12",
      "Aug 13",
    ]);
  });

  it("ignores a point that falls outside the window", () => {
    const buckets = fillEmailVolumeBuckets(window, [
      { bucketStart: "2020-01-01T00:00:00.000Z", messageCount: 99 },
    ]);
    expect(buckets.every((bucket) => bucket.messageCount === 0)).toBe(true);
  });

  it("returns a grid even when the server returned nothing at all", () => {
    expect(fillEmailVolumeBuckets(window, [])).toHaveLength(7);
  });
});

describe("emailPeakBucketIndex", () => {
  const bucket = (messageCount: number, index: number) => ({
    bucketStart: `2026-08-0${index + 1}T00:00:00.000Z`,
    label: `Aug ${index + 1}`,
    messageCount,
  });

  it("finds the tallest column", () => {
    expect(emailPeakBucketIndex([0, 3, 9, 2].map(bucket))).toBe(2);
  });

  it("gives a tie to the earlier bucket", () => {
    expect(emailPeakBucketIndex([5, 5].map(bucket))).toBe(0);
  });

  it("reports no peak for a silent window", () => {
    expect(emailPeakBucketIndex([0, 0, 0].map(bucket))).toBe(-1);
    expect(emailPeakBucketIndex([])).toBe(-1);
  });
});

describe("emailVolumeAxis", () => {
  it("leaves a whole step of headroom above the peak, so a cap label fits", () => {
    for (const peak of [1, 2, 3, 7, 8, 12, 25, 100, 999]) {
      expect(emailVolumeAxis(peak).max).toBeGreaterThan(peak);
    }
  });

  it("uses clean integer steps", () => {
    expect(emailVolumeAxis(1)).toEqual({ max: 2, ticks: [0, 1, 2] });
    expect(emailVolumeAxis(7)).toEqual({ max: 8, ticks: [0, 2, 4, 6, 8] });
    expect(emailVolumeAxis(8)).toEqual({ max: 10, ticks: [0, 2, 4, 6, 8, 10] });
    expect(emailVolumeAxis(100)).toEqual({ max: 125, ticks: [0, 25, 50, 75, 100, 125] });
  });

  it("keeps every tick a whole message", () => {
    for (const peak of [0, 1, 3, 4, 6, 9, 13, 47, 260, 1001]) {
      for (const tick of emailVolumeAxis(peak).ticks) {
        expect(Number.isInteger(tick)).toBe(true);
      }
    }
  });

  it("still draws an axis for a silent window", () => {
    expect(emailVolumeAxis(0)).toEqual({ max: 1, ticks: [0, 1] });
    expect(emailVolumeAxis(Number.NaN)).toEqual({ max: 1, ticks: [0, 1] });
    expect(emailVolumeAxis(-4)).toEqual({ max: 1, ticks: [0, 1] });
  });
});

describe("emailAxisLabelStride", () => {
  it("labels every bucket when they fit", () => {
    expect(emailAxisLabelStride(7)).toBe(1);
    expect(emailAxisLabelStride(8)).toBe(1);
  });

  it("thins the ticks once they would collide", () => {
    expect(emailAxisLabelStride(24)).toBe(3);
    expect(emailAxisLabelStride(30)).toBe(4);
  });

  it("always names the newest bucket and counts back from it", () => {
    const stride = emailAxisLabelStride(30);
    expect(isEmailAxisLabelled(29, 30, stride)).toBe(true);
    expect(isEmailAxisLabelled(25, 30, stride)).toBe(true);
    expect(isEmailAxisLabelled(28, 30, stride)).toBe(false);
  });

  it("labels everything at stride one", () => {
    expect(isEmailAxisLabelled(3, 7, 1)).toBe(true);
  });
});

describe("emailBarPercent", () => {
  it("scales against the axis maximum", () => {
    expect(emailBarPercent(5, 10)).toBe(50);
    expect(emailBarPercent(1, 3)).toBe(33.3);
  });

  it("draws nothing for a zero, so an empty bucket stays visibly empty", () => {
    expect(emailBarPercent(0, 10)).toBe(0);
  });

  it("never overflows its track", () => {
    expect(emailBarPercent(12, 10)).toBe(100);
    expect(emailBarPercent(3, 0)).toBe(0);
    expect(emailBarPercent(Number.NaN, 10)).toBe(0);
  });
});

const emptyResult: EmailAnalyticsResult = {
  volumeOverTime: [],
  perProjectCounts: [],
  topSenders: [],
  topRecipients: [],
  captureLatency: { messageCount: 0, averageMs: 0, p50Ms: 0, p95Ms: 0, maxMs: 0 },
};

describe("isEmailAnalyticsEmpty", () => {
  it("calls a scope with no mail in range empty", () => {
    expect(isEmailAnalyticsEmpty(emptyResult)).toBe(true);
  });

  it("treats a returned bucket that counted nothing as empty, not as data", () => {
    expect(
      isEmailAnalyticsEmpty({
        ...emptyResult,
        volumeOverTime: [{ bucketStart: "2026-08-07T00:00:00.000Z", messageCount: 0 }],
      }),
    ).toBe(true);
  });

  it("is not empty as soon as one bucket carries mail", () => {
    expect(
      isEmailAnalyticsEmpty({
        ...emptyResult,
        volumeOverTime: [{ bucketStart: "2026-08-07T00:00:00.000Z", messageCount: 1 }],
      }),
    ).toBe(false);
  });

  it("totals every bucket", () => {
    expect(
      emailVolumeTotal([
        { bucketStart: "2026-08-07T00:00:00.000Z", messageCount: 2 },
        { bucketStart: "2026-08-08T00:00:00.000Z", messageCount: 5 },
      ]),
    ).toBe(7);
  });
});

describe("showsEmailProjectBreakdown", () => {
  it("only means something across every inbox", () => {
    expect(showsEmailProjectBreakdown({ type: "all" })).toBe(true);
    expect(showsEmailProjectBreakdown({ type: "unassigned" })).toBe(false);
    expect(showsEmailProjectBreakdown({ type: "project", projectId: "p1" as ProjectId })).toBe(
      false,
    );
  });
});

describe("emailProjectCountLabel", () => {
  const titles = new Map<ProjectId, string>([["p1" as ProjectId, "Checkout"]]);

  it("names the Unassigned inbox for a null project", () => {
    expect(
      emailProjectCountLabel({ projectId: null, mailSlug: null, messageCount: 3 }, titles),
    ).toBe("Unassigned");
  });

  it("prefers the project's title", () => {
    expect(
      emailProjectCountLabel(
        { projectId: "p1" as ProjectId, mailSlug: null, messageCount: 3 },
        titles,
      ),
    ).toBe("Checkout");
  });

  it("falls back to the mail slug, then to the id, for a project since removed", () => {
    expect(
      emailProjectCountLabel(
        { projectId: "p2" as ProjectId, mailSlug: "billing" as EmailMailSlug, messageCount: 3 },
        titles,
      ),
    ).toBe("billing");
    expect(
      emailProjectCountLabel(
        { projectId: "p3" as ProjectId, mailSlug: null, messageCount: 3 },
        titles,
      ),
    ).toBe("p3");
  });
});
