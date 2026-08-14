// @effect-diagnostics nodeBuiltinImport:off
import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@spiritdevs/contracts";

import { parseClaudeUsage, parseCodexUsage, parseCursorUsage } from "./ProviderUsageService.ts";

const instanceId = ProviderInstanceId.make("usage_test");
const nowMs = Date.parse("2026-08-12T00:00:00.000Z");

describe("provider usage snapshots", () => {
  it("maps the Codex weekly limit and credits", () => {
    const result = parseCodexUsage({
      instanceId,
      nowMs,
      json: {
        plan_type: "chatgpt_plus",
        rate_limit: {
          primary_window: { used_percent: 22, reset_at: 1_786_579_200 },
        },
        credits: { has_credits: true, balance: 4.5 },
      },
    });

    expect(result).toMatchObject({
      instanceId,
      provider: "codex",
      status: "ok",
      planName: "Chatgpt Plus",
      limits: [{ window: "Weekly", usedPercent: 22, windowDurationMins: 10_080 }],
      usageLines: [{ label: "Credits", value: "$4.50 remaining" }],
    });
  });

  it("maps Claude model windows and extra usage", () => {
    const result = parseClaudeUsage({
      instanceId,
      nowMs,
      planName: "Max (20x)",
      json: {
        five_hour: { utilization: 18, resets_at: "2026-08-12T04:00:00Z" },
        seven_day: { utilization: 47, resets_at: "2026-08-18T00:00:00Z" },
        seven_day_sonnet: { utilization: 31 },
        extra_usage: { is_enabled: true, used_credits: 125, monthly_limit: 2_000 },
      },
    });

    expect(result).toMatchObject({
      provider: "claudeAgent",
      planName: "Max (20x)",
      limits: [
        { window: "5h", usedPercent: 18 },
        { window: "Weekly", usedPercent: 47 },
        { window: "Sonnet", usedPercent: 31 },
      ],
      usageLines: [{ label: "Extra usage", value: "$1.25 of $20.00" }],
    });
  });

  it("maps Cursor billing usage and credit grants", () => {
    const result = parseCursorUsage({
      instanceId,
      nowMs,
      planName: "Pro",
      usage: {
        planUsage: { totalPercentUsed: 55 },
        billingCycleEnd: nowMs + 86_400_000,
        spendLimitUsage: { individualLimit: 5_000, individualRemaining: 3_500 },
      },
      credits: { hasCreditGrants: true, totalCents: 2_000, usedCents: 400 },
    });

    expect(result).toMatchObject({
      provider: "cursor",
      planName: "Pro",
      limits: [{ window: "Current", usedPercent: 55 }],
      usageLines: [
        { label: "On-demand", value: "$15.00 of $50.00" },
        { label: "Credits", value: "$16.00 of $20.00 remaining" },
      ],
    });
  });
});
