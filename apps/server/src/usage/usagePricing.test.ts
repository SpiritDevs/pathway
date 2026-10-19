import { describe, it, expect } from "vite-plus/test";
import { parseRateTable, lookupRate } from "./usagePricing.ts";
describe("native model pricing", () => {
  it("keeps native cache discounts regardless of reseller insertion order", () => {
    const native = [
      "claude-fable-5",
      {
        input_cost_per_token: 1e-5,
        output_cost_per_token: 5e-5,
        cache_read_input_token_cost: 1e-6,
      },
    ] as const;
    const reseller = [
      "deepinfra/anthropic/claude-fable-5",
      { input_cost_per_token: 1e-5, output_cost_per_token: 5e-5 },
    ] as const;
    for (const entries of [
      [native, reseller],
      [reseller, native],
    ]) {
      const table = parseRateTable(Object.fromEntries(entries));
      expect(lookupRate(table, "claude-fable-5")?.cacheReadCostPerToken).toBe(1e-6);
      expect(lookupRate(table, "anthropic/claude-fable-5")?.cacheReadCostPerToken).toBe(1e-6);
      expect(lookupRate(table, "deepinfra/anthropic/claude-fable-5")?.cacheReadCostPerToken).toBe(
        1e-5,
      );
      expect(lookupRate(table, "unknown/claude-fable-5")).toBeNull();
    }
  });
});
