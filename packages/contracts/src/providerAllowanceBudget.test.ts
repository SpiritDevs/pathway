import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";
import { ProviderInstanceId } from "./providerInstance.ts";
import type { ServerProviderUsageSnapshot } from "./providerUsage.ts";
import {
  allocateProviderAllowance,
  allowanceAllocationProgress,
  allowanceWindowKey,
  observeProviderAllowance,
} from "./providerAllowanceBudget.ts";
const now = Date.parse("2026-09-13T09:00:00Z"),
  reset = now + 3_600_000;
const sample = (usedPercent = 40, at = now): ServerProviderUsageSnapshot => ({
  instanceId: ProviderInstanceId.make("codex"),
  provider: "codex",
  accountKey: "account",
  status: "ok",
  source: "provider",
  fetchedAt: DateTime.formatIso(DateTime.makeUnsafe(at)),
  updatedAt: DateTime.formatIso(DateTime.makeUnsafe(at)),
  usageLines: [],
  limits: [
    {
      window: "Weekly",
      windowKey: "weekly",
      usedPercent,
      fetchedAt: DateTime.formatIso(DateTime.makeUnsafe(at)),
      resetsAt: DateTime.formatIso(DateTime.makeUnsafe(reset)),
    },
  ],
});
const key = allowanceWindowKey(sample().limits[0]!);
function allocation(percent = 10) {
  const result = allocateProviderAllowance(sample(), key, percent, now);
  if (!result.allocation) throw new Error(result.error);
  return result.allocation;
}
describe("provider allowance allocation", () => {
  it("allocates percentage points of the full window and counts all observed account activity", () => {
    const budget = allocation();
    expect(allowanceAllocationProgress(budget).targetRemainingPercent).toBe(50);
    const used = observeProviderAllowance(budget, sample(46, now + 1000), now + 1000);
    expect(allowanceAllocationProgress(used)).toMatchObject({
      consumedPercent: 6,
      remainingPercent: 4,
      canStart: true,
      shouldInterrupt: false,
    });
    expect(allowanceAllocationProgress(allocation(5)).targetRemainingPercent).toBe(55);
  });
  it("stops admission near the threshold and requests interruption with honest observed overshoot", () => {
    const near = observeProviderAllowance(allocation(), sample(49, now + 1000), now + 1000);
    expect(allowanceAllocationProgress(near)).toMatchObject({
      canStart: false,
      shouldInterrupt: false,
    });
    const stopped = observeProviderAllowance(near, sample(51, now + 2000), now + 2000);
    expect(allowanceAllocationProgress(stopped)).toMatchObject({
      canStart: false,
      shouldInterrupt: true,
      overshootPercent: 1,
    });
  });
  it("holds on stale readings and mismatched fallback accounts without losing consumption", () => {
    const used = observeProviderAllowance(allocation(), sample(46, now + 1000), now + 1000);
    for (const snapshot of [
      null,
      { ...sample(), stale: true },
      { ...sample(), accountKey: "another-account" },
      { ...sample(), rateLimitedUntil: DateTime.formatIso(DateTime.makeUnsafe(now + 60_000)) },
    ]) {
      const waiting = observeProviderAllowance(used, snapshot, now + 2000);
      expect(waiting.state).toBe("unavailable");
      expect(allowanceAllocationProgress(waiting)).toMatchObject({
        consumedPercent: 6,
        canStart: false,
        shouldInterrupt: true,
      });
    }
    expect(observeProviderAllowance(used, sample(46, now + 1000), now + 91_000).state).toBe(
      "unavailable",
    );
  });
  it("does not renew authorization on reset, late snapshots, or decreasing usage", () => {
    const used = observeProviderAllowance(allocation(), sample(46, now + 1000), now + 1000);
    expect(observeProviderAllowance(used, sample(), now + 2000).observedUsedPercent).toBe(46);
    expect(observeProviderAllowance(used, sample(42, now + 2000), now + 2000).state).toBe(
      "unavailable",
    );
    const resetSnapshot = {
      ...sample(0, reset),
      limits: [
        {
          ...sample(0, reset).limits[0]!,
          resetsAt: DateTime.formatIso(DateTime.makeUnsafe(reset + 3_600_000)),
        },
      ],
    };
    const expired = observeProviderAllowance(used, resetSnapshot, reset);
    expect(expired.state).toBe("reset");
    expect(allowanceAllocationProgress(expired).consumedPercent).toBe(6);
    expect(observeProviderAllowance(expired, resetSnapshot, reset + 1000).state).toBe("reset");
  });
  it("requires known account identity, per-window freshness, reset boundary, and a valid user allocation", () => {
    for (const percent of [0, -1, 101, NaN])
      expect(allocateProviderAllowance(sample(), key, percent, now)).toHaveProperty("error");
    for (const snapshot of [
      { ...sample(), accountKey: undefined },
      { ...sample(), status: "unsupported" as const },
      { ...sample(), limits: [{ ...sample().limits[0]!, fetchedAt: undefined }] },
      { ...sample(), limits: [{ ...sample().limits[0]!, resetsAt: undefined }] },
    ])
      expect(allocateProviderAllowance(snapshot, key, 10, now)).toHaveProperty("error");
  });
});
