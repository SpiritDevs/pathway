import { ProviderInstanceId } from "@spiritdevs/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  formatContextWindowCompactionMessage,
  resolveContextWindowModelDisplayName,
  shouldOfferResumeCompaction,
} from "./ContextWindowMeter.logic";

describe("resolveContextWindowModelDisplayName", () => {
  it("uses the selected model from the exact provider instance", () => {
    const primaryInstanceId = ProviderInstanceId.make("codex");
    const selectedInstanceId = ProviderInstanceId.make("codex-work");
    const modelOptionsByInstance = new Map([
      [
        primaryInstanceId,
        [{ slug: "gpt-5.6-sol", name: "Primary profile model", shortName: "Primary" }],
      ],
      [selectedInstanceId, [{ slug: "gpt-5.6-sol", name: "GPT-5.6 Sol", shortName: "5.6 Sol" }]],
    ]);

    expect(
      resolveContextWindowModelDisplayName(
        {
          instanceId: selectedInstanceId,
          model: "gpt-5.6-sol",
        },
        modelOptionsByInstance,
      ),
    ).toBe("5.6 Sol");
  });

  it("falls back to the selected model slug when model metadata is unavailable", () => {
    const selectedInstanceId = ProviderInstanceId.make("codex-work");

    expect(
      resolveContextWindowModelDisplayName(
        {
          instanceId: selectedInstanceId,
          model: "custom-model",
        },
        new Map(),
      ),
    ).toBe("custom-model");
  });
});

describe("formatContextWindowCompactionMessage", () => {
  it("describes compaction in terms of the selected model", () => {
    expect(formatContextWindowCompactionMessage("GPT-5.6 Sol")).toBe(
      "Context for GPT-5.6 Sol compacts automatically when needed.",
    );
  });

  it("uses neutral copy when the model is unavailable", () => {
    expect(formatContextWindowCompactionMessage(null)).toBe(
      "Context compacts automatically when needed.",
    );
  });

  it("shows an explicitly configured native threshold", () => {
    expect(formatContextWindowCompactionMessage("Claude", 300_000)).toBe(
      "Compacts automatically at 300,000 tokens.",
    );
  });
});

describe("shouldOfferResumeCompaction", () => {
  it("offers compaction for a Claude session older than 70 minutes with 100k tokens", () => {
    expect(
      shouldOfferResumeCompaction({
        provider: "claudeAgent",
        usedTokens: 100_000,
        updatedAt: "2026-08-28T00:00:00.000Z",
        now: "2026-08-28T01:10:00.000Z",
      }),
    ).toBe(true);
  });

  it("does not offer for another provider, a younger session, or fewer tokens", () => {
    const base = {
      provider: "claudeAgent",
      usedTokens: 100_000,
      updatedAt: "2026-08-28T00:00:00.000Z",
      now: "2026-08-28T01:09:59.000Z",
    };
    expect(shouldOfferResumeCompaction(base)).toBe(false);
    expect(
      shouldOfferResumeCompaction({ ...base, now: "2026-08-28T02:00:00.000Z", usedTokens: 99_999 }),
    ).toBe(false);
    expect(
      shouldOfferResumeCompaction({ ...base, now: "2026-08-28T02:00:00.000Z", provider: "codex" }),
    ).toBe(false);
  });
});
