import { describe, expect, it } from "@effect/vitest";

import {
  deriveProviderUsageLimits,
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
    ).toBe("Resets in 3d");
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
