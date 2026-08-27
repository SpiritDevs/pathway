import type { ModelTotals } from "@spiritdevs/shared/usageMerge";
import { describe, expect, it } from "vite-plus/test";

import { sortUsageModels } from "./UsagePage";

const models: readonly ModelTotals[] = [
  {
    model: "expensive-model",
    provider: "claude",
    costUsd: 10,
    totalTokens: 100,
    records: 1,
    costShare: 0.625,
  },
  {
    model: "token-heavy-model",
    provider: "codex",
    costUsd: 5,
    totalTokens: 1_000,
    records: 1,
    costShare: 0.3125,
  },
  {
    model: "token-heavy-cheaper-model",
    provider: "codex",
    costUsd: 1,
    totalTokens: 1_000,
    records: 1,
    costShare: 0.0625,
  },
];

describe("sortUsageModels", () => {
  it("preserves cost ordering for the cost metric", () => {
    expect(sortUsageModels(models, "cost")).toBe(models);
  });

  it("sorts by token count and then cost without mutating the source", () => {
    expect(sortUsageModels(models, "tokens").map((model) => model.model)).toEqual([
      "token-heavy-model",
      "token-heavy-cheaper-model",
      "expensive-model",
    ]);
    expect(models.map((model) => model.model)).toEqual([
      "expensive-model",
      "token-heavy-model",
      "token-heavy-cheaper-model",
    ]);
  });
});
