import { afterEach, vi } from "vite-plus/test";
import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@spiritdevs/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import {
  ingestPushedSnapshot,
  mapCodexRateLimitsUpdated,
  parseCodexUsage,
  providerUsageTestKit,
  resetProviderUsageCache,
} from "./ProviderUsageService.ts";
import { initialCodexScanState, parseCodexLine } from "../usage/usageTranscripts.ts";
import { parseRateTable, lookupRate } from "../usage/usagePricing.ts";
import { resolveUsageLimitResetAt } from "../../../../packages/client-runtime/src/state/usageLimitRecovery.ts";

const instanceId = ProviderInstanceId.make("audit-synthetic");
const nowMs = Date.parse("2026-09-05T00:00:00Z");
afterEach(() => {
  resetProviderUsageCache();
  vi.unstubAllGlobals();
});

describe("usage data integrity regressions", () => {
  it.effect("a scoped Codex push preserves the unscoped allowance", () =>
    Effect.gen(function* () {
      yield* ingestPushedSnapshot(
        mapCodexRateLimitsUpdated({
          instanceId,
          rateLimits: { primary: { usedPercent: 10, windowDurationMins: 300 } },
        }),
        nowMs,
      );
      const result = yield* ingestPushedSnapshot(
        mapCodexRateLimitsUpdated({
          instanceId,
          rateLimits: {
            limitId: "codex_spark",
            limitName: "Codex Spark",
            primary: { usedPercent: 95, windowDurationMins: 300 },
          },
        }),
        nowMs + 1,
      );
      expect(result.limits).toHaveLength(2);
      expect(result.limits[0]).toMatchObject({ usedPercent: 10, windowKey: "session" });
      expect(result.limits[1]).toMatchObject({
        usedPercent: 95,
        limitId: "codex_spark",
        scope: "Codex Spark",
      });
      expect(result.limits[0]?.scope).toBeUndefined();
    }),
  );

  it("switching the credential home invalidates the previous account snapshot", async () => {
    const fetchUsage = vi.fn(async (ctx) => ({
      snapshot: parseCodexUsage({
        instanceId,
        nowMs: ctx.nowMs,
        json: {
          rate_limit: {
            primary_window: {
              used_percent: ctx.providerHomePath === "/synthetic/account-a" ? 10 : 90,
              limit_window_seconds: 18000,
            },
          },
        },
      }),
    }));
    await providerUsageTestKit.resolve(
      { instanceId, provider: "codex", nowMs, providerHomePath: "/synthetic/account-a" },
      fetchUsage,
    );
    const result = await providerUsageTestKit.resolve(
      { instanceId, provider: "codex", nowMs: nowMs + 1, providerHomePath: "/synthetic/account-b" },
      fetchUsage,
    );
    expect(fetchUsage).toHaveBeenCalledTimes(2);
    expect(result.limits[0]?.usedPercent).toBe(90);
  });

  it("counts equal-sized Codex requests when cumulative usage increases", () => {
    const state = initialCodexScanState();
    state.model = "gpt-5";
    state.sessionId = "synthetic-session";
    const last = {
      input_tokens: 100,
      cached_input_tokens: 0,
      output_tokens: 10,
      total_tokens: 110,
    };
    const event = (multiplier: number) =>
      JSON.stringify({
        type: "event_msg",
        timestamp: DateTime.formatIso(DateTime.makeUnsafe(nowMs + multiplier * 10000)),
        payload: {
          type: "token_count",
          info: {
            last_token_usage: last,
            total_token_usage: {
              input_tokens: 100 * multiplier,
              output_tokens: 10 * multiplier,
              total_tokens: 110 * multiplier,
            },
          },
        },
      });
    expect(parseCodexLine(event(1), state)).not.toBeNull();
    expect(parseCodexLine(event(2), state)).not.toBeNull();
    expect(parseCodexLine(event(2), state)).toBeNull();
  });

  it("keeps native and reseller rates independent of insertion order", () => {
    const table = parseRateTable({
      "gpt-5": { input_cost_per_token: 1, output_cost_per_token: 2 },
      "azure/gpt-5": { input_cost_per_token: 5, output_cost_per_token: 10 },
    });
    expect(lookupRate(table, "gpt-5")?.inputCostPerToken).toBe(1);
    expect(lookupRate(table, "azure/gpt-5")?.inputCostPerToken).toBe(5);
  });

  it("recovery waits for both applicable exhausted windows", () => {
    const result = resolveUsageLimitResetAt({
      nowMs,
      failureMessage: "Usage limit reached",
      snapshot: {
        instanceId,
        provider: "codex",
        status: "ok",
        source: "synthetic",
        updatedAt: DateTime.formatIso(DateTime.makeUnsafe(nowMs)),
        usageLines: [],
        limits: [
          {
            window: "5h",
            usedPercent: 100,
            resetsAt: DateTime.formatIso(DateTime.makeUnsafe(nowMs + 3600000)),
          },
          {
            window: "Weekly",
            usedPercent: 100,
            resetsAt: DateTime.formatIso(DateTime.makeUnsafe(nowMs + 86400000)),
          },
        ],
      },
    });
    expect(result).toBe(DateTime.formatIso(DateTime.makeUnsafe(nowMs + 86400000)));
  });
});

it("keeps an old account request from replacing a new account snapshot", async () => {
  let release!: (value: { snapshot: ReturnType<typeof parseCodexUsage> }) => void;
  const old = new Promise<{ snapshot: ReturnType<typeof parseCodexUsage> }>((resolve) => {
    release = resolve;
  });
  const snapshot = (usedPercent: number) =>
    parseCodexUsage({
      instanceId,
      nowMs,
      json: { rate_limit: { primary_window: { used_percent: usedPercent } } },
    });
  const oldRequest = providerUsageTestKit.resolve(
    { instanceId, provider: "codex", nowMs, providerHomePath: "/a" },
    () => old,
  );
  await providerUsageTestKit.resolve(
    { instanceId, provider: "codex", nowMs: nowMs + 1, providerHomePath: "/b" },
    async () => ({ snapshot: snapshot(80) }),
  );
  release({ snapshot: snapshot(10) });
  await oldRequest;
  const result = await providerUsageTestKit.resolve(
    { instanceId, provider: "codex", nowMs: nowMs + 2, providerHomePath: "/b" },
    async () => {
      throw new Error("must use account B cache");
    },
  );
  expect(result.limits[0]?.usedPercent).toBe(80);
});

it("does not carry a rate-limit gate into a different account home", async () => {
  await providerUsageTestKit.resolve(
    { instanceId, provider: "codex", nowMs, providerHomePath: "/a" },
    async () => ({
      snapshot: {
        instanceId,
        provider: "codex",
        status: "error",
        source: "test",
        updatedAt: DateTime.formatIso(DateTime.makeUnsafe(nowMs)),
        limits: [],
        usageLines: [],
      },
      retryAfterUntilMs: nowMs + 300_000,
    }),
  );
  const fetchUsage = vi.fn(async () => ({
    snapshot: parseCodexUsage({
      instanceId,
      nowMs: nowMs + 1,
      json: { rate_limit: { primary_window: { used_percent: 20 } } },
    }),
  }));
  const result = await providerUsageTestKit.resolve(
    { instanceId, provider: "codex", nowMs: nowMs + 1, providerHomePath: "/b" },
    fetchUsage,
  );
  expect(fetchUsage).toHaveBeenCalledOnce();
  expect(result.status).toBe("ok");
});

it.effect("does not postpone a complete refresh when sparse Codex pushes keep arriving", () =>
  Effect.gen(function* () {
    const fetchUsage = vi.fn(async () => ({
      snapshot: parseCodexUsage({
        instanceId,
        nowMs,
        json: {
          rate_limit: {
            primary_window: { used_percent: 10 },
            secondary_window: { used_percent: 30 },
          },
        },
      }),
    }));
    yield* Effect.promise(() =>
      providerUsageTestKit.resolve({ instanceId, provider: "codex", nowMs }, fetchUsage),
    );
    yield* ingestPushedSnapshot(
      mapCodexRateLimitsUpdated({ instanceId, rateLimits: { primary: { usedPercent: 20 } } }),
      nowMs + 299_000,
    );
    yield* Effect.promise(() =>
      providerUsageTestKit.resolve(
        { instanceId, provider: "codex", nowMs: nowMs + 300_000 },
        fetchUsage,
      ),
    );
    expect(fetchUsage).toHaveBeenCalledTimes(2);
  }),
);

it.effect("updates the matching explicit lane when both Codex windows have the same duration", () =>
  Effect.gen(function* () {
    yield* ingestPushedSnapshot(
      mapCodexRateLimitsUpdated({
        instanceId,
        rateLimits: {
          primary: { usedPercent: 10, windowDurationMins: 1440 },
          secondary: { usedPercent: 20, windowDurationMins: 1440 },
        },
      }),
      nowMs,
    );
    const result = yield* ingestPushedSnapshot(
      mapCodexRateLimitsUpdated({
        instanceId,
        rateLimits: { secondary: { usedPercent: 90, windowDurationMins: 1440 } },
      }),
      nowMs + 1,
    );
    expect(result.limits.map((limit) => [limit.lane, limit.usedPercent])).toEqual([
      ["primary", 10],
      ["secondary", 90],
    ]);
  }),
);

it("detects a Keychain-only account change without credential files", async () => {
  let account = "account-a";
  providerUsageTestKit.setKeychainReader(async ({ service }) =>
    service === "Codex Auth"
      ? JSON.stringify({ tokens: { access_token: "synthetic-token", account_id: account } })
      : null,
  );
  const input = { instanceId, provider: "codex" as const, nowMs, platform: "darwin" as const };
  const first = await providerUsageTestKit.credentialIdentity(input);
  account = "account-b";
  const second = await providerUsageTestKit.credentialIdentity(input);
  expect(second).not.toBe(first);
  expect(second).not.toContain("account-b");
});

it.effect("fetches a complete account immediately after a cold sparse push", () =>
  Effect.gen(function* () {
    const pushed = yield* ingestPushedSnapshot(
      mapCodexRateLimitsUpdated({ instanceId, rateLimits: { primary: { usedPercent: 10 } } }),
      nowMs,
    );
    expect(pushed.fetchedAt).toBeUndefined();
    const fetchUsage = vi.fn(async () => ({
      snapshot: parseCodexUsage({
        instanceId,
        nowMs: nowMs + 1,
        json: {
          plan_type: "pro",
          rate_limit: {
            primary_window: { used_percent: 11 },
            secondary_window: { used_percent: 30 },
          },
          credits: { has_credits: true, balance: 25 },
        },
      }),
    }));
    const result = yield* Effect.promise(() =>
      providerUsageTestKit.resolve({ instanceId, provider: "codex", nowMs: nowMs + 1 }, fetchUsage),
    );
    expect(fetchUsage).toHaveBeenCalledOnce();
    expect(result.limits).toHaveLength(2);
    expect(result.planName).toBe("ChatGPT Pro");
    expect(result.usageLines).toHaveLength(1);
  }),
);

it.effect("preserves only metadata pushed after an HTTP refresh started", () =>
  Effect.gen(function* () {
    for (const field of ["credits", "plan", "limits"] as const) {
      resetProviderUsageCache();
      const initial = parseCodexUsage({
        instanceId,
        nowMs,
        json: {
          plan_type: "plus",
          credits: { has_credits: true, balance: 1 },
          rate_limit: { primary_window: { used_percent: 10 } },
        },
      });
      yield* Effect.promise(() =>
        providerUsageTestKit.resolve({ instanceId, provider: "codex", nowMs }, async () => ({
          snapshot: initial,
        })),
      );
      const started = Promise.withResolvers<void>();
      const response = Promise.withResolvers<{ snapshot: ReturnType<typeof parseCodexUsage> }>();
      const pending = providerUsageTestKit.resolve(
        { instanceId, provider: "codex", nowMs: nowMs + 1000, forceRefresh: true },
        () => {
          started.resolve();
          return response.promise;
        },
      );
      yield* Effect.promise(() => started.promise);
      yield* ingestPushedSnapshot(
        mapCodexRateLimitsUpdated({
          instanceId,
          rateLimits:
            field === "credits"
              ? { credits: { hasCredits: true, unlimited: false, balance: "50" } }
              : field === "plan"
                ? { planType: "pro" }
                : { primary: { usedPercent: 25 } },
        }),
        nowMs + 2000,
      );
      // A later sparse push must not lose the earlier metadata timestamp.
      yield* ingestPushedSnapshot(
        mapCodexRateLimitsUpdated({
          instanceId,
          rateLimits: {
            primary: { usedPercent: 30 },
          },
        }),
        nowMs + 3000,
      );
      response.resolve({
        snapshot: parseCodexUsage({
          instanceId,
          nowMs: nowMs + 1000,
          json: {
            plan_type: "plus",
            credits: { has_credits: true, balance: 10 },
            rate_limit: { primary_window: { used_percent: 20 } },
          },
        }),
      });
      const result = yield* Effect.promise(() => pending);
      expect(result.limits[0]?.usedPercent).toBe(30);
      expect(result.planName).toBe(field === "plan" ? "ChatGPT Pro" : "ChatGPT Plus");
      expect(result.usageLines[0]?.value).toBe(
        field === "credits" ? "$50.00 remaining" : "$10.00 remaining",
      );
    }
  }),
);
