import { afterEach, vi } from "vite-plus/test";
import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@spiritdevs/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
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

it.effect(
  "keeps account grouping through token rotation and failures, but clears it on a login switch",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* Effect.promise(() => import("node:fs/promises"));
        const os = yield* Effect.promise(() => import("node:os"));
        const path = yield* Effect.promise(() => import("node:path"));
        const home = yield* Effect.acquireRelease(
          Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "pathway-usage-identity-"))),
          (directory) => Effect.promise(() => fs.rm(directory, { recursive: true, force: true })),
        );
        let httpStatus = 200;
        vi.stubGlobal(
          "fetch",
          vi.fn(
            async () =>
              new Response(
                JSON.stringify({
                  rate_limit: {
                    primary_window: { used_percent: 20, limit_window_seconds: 18000 },
                    secondary_window: { used_percent: 40, limit_window_seconds: 604800 },
                  },
                }),
                { status: httpStatus },
              ),
          ),
        );
        const input = {
          instanceId,
          provider: "codex" as const,
          nowMs,
          providerHomePath: home,
          homeDir: home,
        };
        const writeAuth = (accountId: string | undefined, token = "token") =>
          fs.writeFile(
            path.join(home, "auth.json"),
            JSON.stringify({ tokens: { access_token: token, account_id: accountId } }),
          );
        const first = yield* Effect.promise(async () => {
          await writeAuth("account-a", "token-a");
          const first = await providerUsageTestKit.fetchCodex(input);
          await writeAuth("account-a", "token-b");
          expect((await providerUsageTestKit.fetchCodex(input)).snapshot.accountKey).toBe(
            first.snapshot.accountKey,
          );
          expect(first.snapshot.accountKey).toMatch(/^[a-f0-9]{64}$/);
          for (const status of [401, 403, 500]) {
            httpStatus = status;
            const result = await providerUsageTestKit.fetchCodex(input);
            expect(result.snapshot.accountKey).toBe(first.snapshot.accountKey);
            expect(result.snapshot.status).toBe(status === 500 ? "error" : "needs-auth");
          }
          httpStatus = 200;
          const expired = `header.${Buffer.from('{"exp":1}').toString("base64url")}.signature`;
          await writeAuth("account-a", expired);
          expect((await providerUsageTestKit.fetchCodex(input)).snapshot).toMatchObject({
            status: "needs-auth",
            accountKey: first.snapshot.accountKey,
          });
          await writeAuth(undefined);
          expect(
            (await providerUsageTestKit.fetchCodex(input)).snapshot.accountKey,
          ).toBeUndefined();
          await writeAuth("account-a");
          await providerUsageTestKit.resolve(input, async () => first);
          return first;
        });
        const push = mapCodexRateLimitsUpdated({
          instanceId,
          rateLimits: { primary: { usedPercent: 30, windowDurationMins: 300 } },
        });
        const pushed = yield* ingestPushedSnapshot(push, nowMs + 1);
        expect(pushed.accountKey).toBe(first.snapshot.accountKey);
        expect(pushed.limits).toHaveLength(2);
        yield* Effect.promise(() => writeAuth("account-b"));
        const switched = yield* ingestPushedSnapshot(push, nowMs + 2);
        expect(switched.accountKey).toBeUndefined();
        expect(switched.limits).toHaveLength(1);
        const other = yield* Effect.promise(() => providerUsageTestKit.fetchCodex(input));
        expect(other.snapshot.accountKey).not.toBe(first.snapshot.accountKey);
      }),
    ),
);

it.effect("preserves a new-login refresh that starts while a push checks the old login", () =>
  Effect.gen(function* () {
    const initial = {
      ...parseCodexUsage({
        instanceId,
        nowMs,
        json: { rate_limit: { primary_window: { used_percent: 10 } } },
      }),
      accountKey: "account-a",
    };
    yield* Effect.promise(() =>
      providerUsageTestKit.resolve(
        { instanceId, provider: "codex", nowMs, providerHomePath: "/synthetic/a" },
        async () => ({ snapshot: initial }),
      ),
    );
    const readerStarted = Promise.withResolvers<void>();
    const identity = Promise.withResolvers<string>();
    providerUsageTestKit.setCodexAccountKeyReader(instanceId, () => {
      readerStarted.resolve();
      return identity.promise;
    });
    const push = yield* ingestPushedSnapshot(
      mapCodexRateLimitsUpdated({ instanceId, rateLimits: { primary: { usedPercent: 30 } } }),
      nowMs + 2,
    ).pipe(Effect.forkChild);
    yield* Effect.promise(() => readerStarted.promise);
    const response = Promise.withResolvers<{ snapshot: typeof initial }>();
    const refreshStarted = Promise.withResolvers<void>();
    const input = {
      instanceId,
      provider: "codex" as const,
      nowMs: nowMs + 1,
      providerHomePath: "/synthetic/b",
    };
    const refresh = providerUsageTestKit.resolve(input, () => {
      refreshStarted.resolve();
      return response.promise;
    });
    yield* Effect.promise(() => refreshStarted.promise);
    identity.resolve("account-b");
    yield* Fiber.join(push);
    response.resolve({ snapshot: { ...initial, accountKey: "account-b" } });
    yield* Effect.promise(() => refresh);
    const cached = yield* Effect.promise(() =>
      providerUsageTestKit.resolve(input, async () => {
        throw new Error("The completed refresh should remain cached");
      }),
    );
    expect(cached.accountKey).toBe("account-b");
  }),
);

it.effect("serializes sparse pushes while a credential read is pending", () =>
  Effect.gen(function* () {
    const initial = {
      ...parseCodexUsage({
        instanceId,
        nowMs,
        json: {
          rate_limit: {
            primary_window: { used_percent: 10 },
            secondary_window: { used_percent: 20 },
          },
        },
      }),
      accountKey: "account-a",
    };
    yield* Effect.promise(() =>
      providerUsageTestKit.resolve({ instanceId, provider: "codex", nowMs }, async () => ({
        snapshot: initial,
      })),
    );
    const readerStarted = Promise.withResolvers<void>();
    const identity = Promise.withResolvers<string>();
    let reads = 0;
    providerUsageTestKit.setCodexAccountKeyReader(instanceId, () => {
      reads += 1;
      readerStarted.resolve();
      return reads === 1 ? identity.promise : Promise.resolve("account-a");
    });
    const first = yield* ingestPushedSnapshot(
      mapCodexRateLimitsUpdated({ instanceId, rateLimits: { primary: { usedPercent: 25 } } }),
      nowMs + 1,
    ).pipe(Effect.forkChild);
    yield* Effect.promise(() => readerStarted.promise);
    const second = yield* ingestPushedSnapshot(
      mapCodexRateLimitsUpdated({ instanceId, rateLimits: { secondary: { usedPercent: 90 } } }),
      nowMs + 2,
    ).pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    expect(reads).toBe(1);
    identity.resolve("account-a");
    yield* Fiber.join(first);
    const result = yield* Fiber.join(second);
    expect(result.limits.map((limit) => limit.usedPercent)).toEqual([25, 90]);
  }),
);
