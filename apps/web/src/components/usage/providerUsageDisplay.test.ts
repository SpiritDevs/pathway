import { describe, expect, it } from "@effect/vitest";

import {
  deriveProviderUsageLimits,
  formatDuration,
  formatProviderUsageCaptureAge,
  formatProviderUsageRateLimit,
  formatProviderUsageReset,
  shouldCollapseProviderUsage,
} from "./providerUsageDisplay";

describe("provider usage display", () => {
  it("turns used quota into clamped remaining quota and warning tones", () => {
    expect(
      deriveProviderUsageLimits(
        [
          { window: "5h", usedPercent: 87 },
          { window: "Weekly", usedPercent: 103 },
        ],
        0,
      ),
    ).toMatchObject([
      { window: "5h", remainingPercent: 13, remainingLabel: "13% left", tone: "warning" },
      { window: "Weekly", remainingPercent: 0, remainingLabel: "0% left", tone: "danger" },
    ]);
  });

  it("formats reset countdowns without a live timer", () => {
    expect(
      formatProviderUsageReset("2026-08-12T00:45:00.000Z", Date.parse("2026-08-12T00:00:00Z")),
    ).toBe("Resets in 45m");
    expect(
      formatProviderUsageReset("2026-08-14T12:00:00.000Z", Date.parse("2026-08-12T00:00:00Z")),
    ).toBe("Resets in 2d 12h");
  });

  it("keeps two tiers of duration precision", () => {
    expect(formatDuration(61 * 60_000)).toBe("1h 1m");
    expect(formatDuration(25 * 60 * 60_000)).toBe("1d 1h");
  });

  it("keeps reset-only limits visible without inventing a percentage", () => {
    expect(
      deriveProviderUsageLimits(
        [
          {
            window: "Weekly",
            windowKey: "weekly",
            scope: "Sonnet",
            resetsAt: "2026-08-12T01:00:00.000Z",
          },
        ],
        Date.parse("2026-08-12T00:00:00.000Z"),
      ),
    ).toEqual([
      {
        window: "Weekly",
        windowKey: "weekly",
        scope: "Sonnet",
        resetsAt: "2026-08-12T01:00:00.000Z",
        remainingPercent: null,
        remainingLabel: "No % reported",
        resetLabel: "Resets in 1h",
        tone: null,
      },
    ]);
  });

  it("formats stale snapshot capture age", () => {
    expect(
      formatProviderUsageCaptureAge(
        "2026-08-12T00:00:00.000Z",
        Date.parse("2026-08-12T00:12:00.000Z"),
      ),
    ).toBe("as of 12m ago");
  });

  it("formats live rate-limit countdowns from the structured pause time", () => {
    const now = Date.parse("2026-08-12T00:00:00.000Z");
    expect(formatProviderUsageRateLimit("Claude", "2026-08-12T00:00:45.000Z", now)).toBe(
      "Claude usage is rate limited by the provider. Refreshes resume in less than a minute.",
    );
    expect(formatProviderUsageRateLimit("Claude", "2026-08-12T00:58:00.000Z", now)).toBe(
      "Claude usage is rate limited by the provider. Refreshes resume in about 58 minutes.",
    );
    expect(formatProviderUsageRateLimit("Claude", "2026-08-12T03:01:00.000Z", now)).toBe(
      "Claude usage is rate limited by the provider. Refreshes resume in about 4 hours.",
    );
  });

  it("only offers disclosure when there is more than one quota bar", () => {
    const oneLimit = deriveProviderUsageLimits([{ window: "Weekly", usedPercent: 5 }], 0);
    const twoLimits = deriveProviderUsageLimits(
      [
        { window: "5h", usedPercent: 5 },
        { window: "Weekly", usedPercent: 10 },
      ],
      0,
    );

    expect(shouldCollapseProviderUsage(oneLimit)).toBe(false);
    expect(shouldCollapseProviderUsage(twoLimits)).toBe(true);
  });
});
