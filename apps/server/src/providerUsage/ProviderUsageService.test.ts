// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId, type ServerProviderUsageSnapshot } from "@spiritdevs/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { vi } from "vite-plus/test";

import { ServerSettingsService } from "../serverSettings.ts";
import {
  ingestPushedSnapshot,
  mapCodexRateLimitsUpdated,
  parseClaudeUsage,
  parseCodexUsage,
  parseCursorUsage,
  providerUsageTestKit,
  resetProviderUsageCache,
  subscribeProviderUsage,
} from "./ProviderUsageService.ts";

const instanceId = ProviderInstanceId.make("usage_test");
const nowMs = Date.parse("2026-08-12T00:00:00.000Z");
// Default settings carry legacy providers.<kind> blobs for every built-in
// driver, which the subscription list synthesizes into instances; disable
// those slots so tests control membership explicitly.
const disabledLegacySlots = {
  [ProviderInstanceId.make("codex")]: { driver: "codex", enabled: false },
  [ProviderInstanceId.make("claudeAgent")]: { driver: "claudeAgent", enabled: false },
  [ProviderInstanceId.make("cursor")]: { driver: "cursor", enabled: false },
} as const;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function fetchResult(snapshot: ServerProviderUsageSnapshot, retryAfterUntilMs?: number) {
  return {
    snapshot,
    ...(retryAfterUntilMs === undefined ? {} : { retryAfterUntilMs }),
  };
}

function rateLimitedFetchResult(input: {
  provider: ServerProviderUsageSnapshot["provider"];
  nowMs: number;
  untilMs: number;
}) {
  return {
    snapshot: {
      instanceId,
      provider: input.provider,
      source: "provider-test",
      updatedAt: DateTime.formatIso(DateTime.makeUnsafe(input.nowMs)),
      limits: [],
      usageLines: [],
      status: "error" as const,
      detail: "Rate limited by provider.",
      rateLimitedUntil: DateTime.formatIso(DateTime.makeUnsafe(input.untilMs)),
    },
    retryAfterUntilMs: input.untilMs,
  };
}

function cursorSnapshot(input: {
  instanceId?: ProviderInstanceId;
  nowMs: number;
  usedPercent: number;
}) {
  return parseCursorUsage({
    instanceId: input.instanceId ?? instanceId,
    nowMs: input.nowMs,
    usage: { planUsage: { totalPercentUsed: input.usedPercent } },
  });
}

describe("provider usage snapshots", () => {
  it("maps both Codex windows, scoped limits, truthful plan names, and credits", () => {
    const result = parseCodexUsage({
      instanceId,
      nowMs,
      json: {
        plan_type: "chatgpt_plus",
        rate_limit: {
          primary_window: {
            used_percent: 22,
            reset_at: 1_786_579_200,
            limit_window_seconds: 18_000,
          },
          secondary_window: {
            used_percent: 41,
            reset_at: 1_787_184_000,
            limit_window_seconds: 604_800,
          },
        },
        additional_rate_limits: [
          {
            limit_name: "codex_other",
            rate_limit: {
              primary_window: { used_percent: 63, limit_window_seconds: 5_400 },
            },
          },
        ],
        credits: { has_credits: true, unlimited: true, balance: 4.5 },
      },
    });

    expect(result).toMatchObject({
      instanceId,
      provider: "codex",
      status: "ok",
      planName: "ChatGPT Plus",
      updatedAt: "2026-08-12T00:00:00.000Z",
      fetchedAt: "2026-08-12T00:00:00.000Z",
      limits: [
        { window: "5h", windowKey: "session", usedPercent: 22, windowDurationMins: 300 },
        {
          window: "Weekly",
          windowKey: "weekly",
          usedPercent: 41,
          windowDurationMins: 10_080,
        },
        {
          window: "1h 30m",
          windowKey: "custom",
          scope: "codex_other",
          usedPercent: 63,
          windowDurationMins: 90,
        },
      ],
      usageLines: [{ label: "Credits", value: "Unlimited" }],
    });

    expect(
      parseCodexUsage({
        instanceId,
        nowMs,
        json: { rate_limit: {}, credits: { balance: 0 } },
      }).usageLines,
    ).toEqual([]);
  });

  it("uses independent Codex headers without fabricating window durations", () => {
    const result = parseCodexUsage({
      instanceId,
      nowMs,
      json: { rate_limit: {} },
      headers: {
        "x-codex-primary-used-percent": "12",
        "x-codex-primary-window-minutes": "300",
        "x-codex-primary-reset-at": "1786579200",
        "x-codex-secondary-used-percent": "34",
        "x-codex-secondary-window-minutes": "10080",
        "x-codex-secondary-reset-at": "1787184000",
      },
    });

    expect(result.limits).toMatchObject([
      { window: "5h", windowKey: "session", usedPercent: 12, windowDurationMins: 300 },
      {
        window: "Weekly",
        windowKey: "weekly",
        usedPercent: 34,
        windowDurationMins: 10_080,
      },
    ]);
    expect(
      parseCodexUsage({
        instanceId,
        nowMs,
        json: { rate_limit: { primary_window: { used_percent: 9 } } },
      }).limits[0],
    ).not.toHaveProperty("windowDurationMins");
  });

  it("maps structured and forward-compatible Claude windows", () => {
    const result = parseClaudeUsage({
      instanceId,
      nowMs,
      planName: "Max (20x)",
      json: {
        five_hour: { utilization: 18, resets_at: "2026-08-12T04:00:00Z" },
        seven_day: { utilization: 47, resets_at: "2026-08-18T00:00:00Z" },
        seven_day_sonnet: { utilization: 31 },
        seven_day_opus: { utilization: 29 },
        seven_day_routines: { utilization: 11 },
        limits: [
          {
            kind: "session",
            group: "session",
            percent: 18,
            resets_at: "2026-08-12T04:00:00Z",
            is_active: true,
          },
          {
            kind: "weekly_all",
            group: "weekly",
            percent: 47,
            resets_at: "2026-08-18T00:00:00Z",
            scope: { model: { display_name: "All models" } },
            is_active: false,
          },
          // Enforceable scoped carve-outs report is_active: false in the wild.
          {
            kind: "weekly_scoped",
            group: "weekly",
            percent: 52,
            resets_at: "2026-08-18T00:00:00Z",
            scope: { model: { display_name: "Fable" } },
            is_active: false,
          },
        ],
        extra_usage: { is_enabled: true, used_credits: 125, monthly_limit: 2_000 },
      },
    });

    expect(result).toMatchObject({
      provider: "claudeAgent",
      planName: "Max (20x)",
      limits: [
        { window: "5h", windowKey: "session", usedPercent: 18 },
        { window: "Weekly", windowKey: "weekly", usedPercent: 47 },
        { window: "Weekly", windowKey: "weekly", scope: "Fable", usedPercent: 52 },
        { window: "Weekly", windowKey: "weekly", scope: "Sonnet", usedPercent: 31 },
        { window: "Weekly", windowKey: "weekly", scope: "Opus", usedPercent: 29 },
        { window: "Seven Day Routines", windowKey: "custom", usedPercent: 11 },
      ],
      usageLines: [{ label: "Extra usage", value: "$1.25 of $20.00" }],
    });
    // "All models" folds into the single unscoped weekly row.
    expect(result.limits.filter((l) => l.windowKey === "weekly" && !l.scope)).toHaveLength(1);
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
      limits: [{ window: "Current", windowKey: "monthly", usedPercent: 55 }],
      usageLines: [
        { label: "On-demand", value: "$15.00 of $50.00" },
        { label: "Credits", value: "$16.00 of $20.00 remaining" },
      ],
    });

    expect(
      providerUsageTestKit.cursorStatePath({ platform: "win32", homeDir: "C:\\Users\\Corey" }),
    ).toBe("C:\\Users\\Corey/AppData/Roaming/Cursor/User/globalStorage/state.vscdb");
    expect(
      providerUsageTestKit.cursorStatePath({
        platform: "linux",
        homeDir: "/home/corey",
      }),
    ).toBe("/home/corey/.config/Cursor/User/globalStorage/state.vscdb");
  });

  it("maps known provider plans and title-cases unknown identifiers", () => {
    expect(
      parseCodexUsage({
        instanceId,
        nowMs,
        json: { plan_type: "chatgpt_business" },
      }).planName,
    ).toBe("ChatGPT Business");
    expect(
      parseCodexUsage({
        instanceId,
        nowMs,
        json: { plan_type: "custom_oauth_api_plan" },
      }).planName,
    ).toBe("Custom OAuth API Plan");
    expect(
      providerUsageTestKit.claudePlanNameFromAuth({
        claudeAiOauth: {
          accessToken: "token",
          subscriptionType: "max",
          rateLimitTier: "default_claude_max_5x",
        },
      }),
    ).toBe("Max (5x)");
  });

  it("preserves capture timestamps when a refresh falls back to stale data", async () => {
    resetProviderUsageCache();
    try {
      const original = cursorSnapshot({ nowMs, usedPercent: 20 });
      await providerUsageTestKit.resolve({ instanceId, provider: "cursor", nowMs }, async () =>
        fetchResult(original),
      );
      const failedAt = nowMs + 600_000;
      const failed: ServerProviderUsageSnapshot = {
        ...cursorSnapshot({ nowMs: failedAt, usedPercent: 0 }),
        status: "error",
        limits: [],
        detail: "network unavailable",
      };
      const stale = await providerUsageTestKit.resolve(
        { instanceId, provider: "cursor", nowMs: failedAt, forceRefresh: true },
        async () => fetchResult(failed),
      );

      expect(stale).toMatchObject({
        stale: true,
        updatedAt: original.updatedAt,
        fetchedAt: original.fetchedAt,
        detail: "network unavailable",
      });
    } finally {
      resetProviderUsageCache();
    }
  });

  it("starts one forced fetch alongside a non-forced fetch and dedupes forced callers", async () => {
    resetProviderUsageCache();
    const regular = deferred<ReturnType<typeof fetchResult>>();
    const forced = deferred<ReturnType<typeof fetchResult>>();
    let fetchCount = 0;
    const fetchUsage = () => {
      fetchCount += 1;
      return fetchCount === 1 ? regular.promise : forced.promise;
    };
    try {
      const regularRequest = providerUsageTestKit.resolve(
        { instanceId, provider: "cursor", nowMs },
        fetchUsage,
      );
      const forcedRequest = providerUsageTestKit.resolve(
        { instanceId, provider: "cursor", nowMs: nowMs + 1, forceRefresh: true },
        fetchUsage,
      );
      const duplicateForcedRequest = providerUsageTestKit.resolve(
        { instanceId, provider: "cursor", nowMs: nowMs + 1, forceRefresh: true },
        fetchUsage,
      );

      expect(fetchCount).toBe(2);
      forced.resolve(fetchResult(cursorSnapshot({ nowMs: nowMs + 1, usedPercent: 80 })));
      expect((await forcedRequest).limits[0]?.usedPercent).toBe(80);
      expect((await duplicateForcedRequest).limits[0]?.usedPercent).toBe(80);
      regular.resolve(fetchResult(cursorSnapshot({ nowMs, usedPercent: 10 })));
      await regularRequest;
      expect(
        (
          await providerUsageTestKit.resolve(
            { instanceId, provider: "cursor", nowMs: nowMs + 2 },
            async () => {
              throw new Error("fresh forced value should be cached");
            },
          )
        ).limits[0]?.usedPercent,
      ).toBe(80);
    } finally {
      resetProviderUsageCache();
    }
  });

  it("does not let an older request clear a newer rate-limit gate", async () => {
    resetProviderUsageCache();
    const regular = deferred<ReturnType<typeof fetchResult>>();
    const forced = deferred<ReturnType<typeof rateLimitedFetchResult>>();
    let fetchCount = 0;
    const fetchUsage = () => {
      fetchCount += 1;
      return fetchCount === 1 ? regular.promise : forced.promise;
    };
    try {
      const regularRequest = providerUsageTestKit.resolve(
        { instanceId, provider: "cursor", nowMs },
        fetchUsage,
      );
      const forcedRequest = providerUsageTestKit.resolve(
        { instanceId, provider: "cursor", nowMs: nowMs + 1, forceRefresh: true },
        fetchUsage,
      );
      const blockedUntilMs = nowMs + 120_000;
      forced.resolve(
        rateLimitedFetchResult({ provider: "cursor", nowMs: nowMs + 1, untilMs: blockedUntilMs }),
      );
      await forcedRequest;
      regular.resolve(fetchResult(cursorSnapshot({ nowMs, usedPercent: 10 })));
      await regularRequest;

      const blocked = await providerUsageTestKit.resolve(
        { instanceId, provider: "cursor", nowMs: nowMs + 2, forceRefresh: true },
        async () => {
          throw new Error("newer rate-limit gate should prevent this fetch");
        },
      );

      expect(fetchCount).toBe(2);
      expect(blocked.rateLimitedUntil).toBe(
        DateTime.formatIso(DateTime.makeUnsafe(blockedUntilMs)),
      );
    } finally {
      resetProviderUsageCache();
    }
  });

  it("honors Retry-After seconds and HTTP dates without re-hitting the provider", async () => {
    resetProviderUsageCache();
    providerUsageTestKit.setClaudeVersionRunner(async () => "claude 2.1.222");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", {
        status: 429,
        headers: { "Retry-After": "120" },
      }),
    );
    try {
      const original = parseClaudeUsage({
        instanceId,
        nowMs,
        json: { five_hour: { utilization: 20 } },
      });
      await providerUsageTestKit.resolve({ instanceId, provider: "claudeAgent", nowMs }, async () =>
        fetchResult(original),
      );
      const refreshedAt = nowMs + 300_000;
      const rateLimited = await providerUsageTestKit.resolve(
        { instanceId, provider: "claudeAgent", nowMs: refreshedAt, forceRefresh: true },
        () =>
          providerUsageTestKit.fetchClaude(
            { instanceId, provider: "claudeAgent", nowMs: refreshedAt },
            [{ accessToken: "first" }],
          ),
      );
      const blocked = await providerUsageTestKit.resolve(
        {
          instanceId,
          provider: "claudeAgent",
          nowMs: refreshedAt + 1_000,
          forceRefresh: true,
        },
        async () => {
          throw new Error("Retry-After gate should prevent this fetch");
        },
      );

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(rateLimited.fetchedAt).toBe(original.fetchedAt);
      expect(blocked).toMatchObject({ stale: true, fetchedAt: original.fetchedAt });
      expect(blocked).toMatchObject({
        detail:
          "Claude usage is rate limited by the provider. Refreshes resume in about 2 minutes.",
        rateLimitedUntil: DateTime.formatIso(DateTime.makeUnsafe(refreshedAt + 120_000)),
      });
      expect(providerUsageTestKit.retryAfterUntilMs("120", refreshedAt)).toBe(
        refreshedAt + 120_000,
      );
      expect(
        providerUsageTestKit.retryAfterUntilMs(
          DateTime.toDate(DateTime.makeUnsafe(refreshedAt + 240_000)).toUTCString(),
          refreshedAt,
        ),
      ).toBe(refreshedAt + 240_000);
    } finally {
      fetchMock.mockRestore();
      resetProviderUsageCache();
    }
  });

  it.each([
    { label: "a missing header", headers: undefined },
    { label: "retry-after: 0", headers: { "Retry-After": "0" } },
  ])("uses the default 429 backoff for $label", async ({ headers }) => {
    resetProviderUsageCache();
    providerUsageTestKit.setClaudeVersionRunner(async () => "claude 2.1.222");
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response("{}", { status: 429, ...(headers === undefined ? {} : { headers }) }),
      );
    try {
      const rateLimited = await providerUsageTestKit.resolve(
        { instanceId, provider: "claudeAgent", nowMs, forceRefresh: true },
        () =>
          providerUsageTestKit.fetchClaude({ instanceId, provider: "claudeAgent", nowMs }, [
            { accessToken: "first" },
          ]),
      );
      const expectedUntil = nowMs + providerUsageTestKit.defaultRateLimitBackoffMs;
      const blocked = await providerUsageTestKit.resolve(
        { instanceId, provider: "claudeAgent", nowMs: nowMs + 1, forceRefresh: true },
        async () => {
          throw new Error("default rate-limit gate should prevent this fetch");
        },
      );

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(rateLimited).toMatchObject({
        status: "error",
        detail:
          "Claude usage is rate limited by the provider. Refreshes resume in about 5 minutes.",
        rateLimitedUntil: DateTime.formatIso(DateTime.makeUnsafe(expectedUntil)),
      });
      expect(blocked.rateLimitedUntil).toBe(rateLimited.rateLimitedUntil);
    } finally {
      fetchMock.mockRestore();
      resetProviderUsageCache();
    }
  });

  it("reloads and displays a persisted rate-limit gate after a process reset", async () => {
    resetProviderUsageCache();
    const tempDir = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "pathway-provider-usage-rate-limit-"),
    );
    const persistencePath = NodePath.join(tempDir, "provider-usage-rate-limits.json");
    providerUsageTestKit.setClaudeVersionRunner(async () => "claude 2.1.222");
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response("{}", { status: 429 }));
    try {
      const first = await providerUsageTestKit.resolve(
        {
          instanceId,
          provider: "claudeAgent",
          nowMs,
          forceRefresh: true,
          rateLimitPersistencePath: persistencePath,
        },
        () =>
          providerUsageTestKit.fetchClaude({ instanceId, provider: "claudeAgent", nowMs }, [
            { accessToken: "first" },
          ]),
      );
      resetProviderUsageCache();
      providerUsageTestKit.setClaudeVersionRunner(async () => "claude 2.1.222");
      const reloaded = await providerUsageTestKit.resolve(
        {
          instanceId,
          provider: "claudeAgent",
          nowMs: nowMs + 1,
          forceRefresh: true,
          rateLimitPersistencePath: persistencePath,
        },
        async () => {
          throw new Error("persisted rate-limit gate should prevent this fetch");
        },
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(reloaded.rateLimitedUntil).toBe(first.rateLimitedUntil);
      expect(reloaded.source).toBe("provider-rate-limit");
      expect(providerUsageTestKit.cacheSizes().snapshots).toBe(1);
    } finally {
      fetchMock.mockRestore();
      resetProviderUsageCache();
      await NodeFSP.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("drops expired persisted gates before fetching again", async () => {
    resetProviderUsageCache();
    const tempDir = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "pathway-provider-usage-rate-limit-"),
    );
    const persistencePath = NodePath.join(tempDir, "provider-usage-rate-limits.json");
    providerUsageTestKit.setClaudeVersionRunner(async () => "claude 2.1.222");
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("{}", { status: 429 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ five_hour: { utilization: 17 } }), { status: 200 }),
      );
    const resolveAt = (requestNowMs: number) =>
      providerUsageTestKit.resolve(
        {
          instanceId,
          provider: "claudeAgent",
          nowMs: requestNowMs,
          forceRefresh: true,
          rateLimitPersistencePath: persistencePath,
        },
        () =>
          providerUsageTestKit.fetchClaude(
            { instanceId, provider: "claudeAgent", nowMs: requestNowMs },
            [{ accessToken: "first" }],
          ),
      );
    try {
      await resolveAt(nowMs);
      resetProviderUsageCache();
      const refreshed = await resolveAt(nowMs + providerUsageTestKit.defaultRateLimitBackoffMs + 1);
      const persisted = JSON.parse(await NodeFSP.readFile(persistencePath, "utf8")) as {
        providerGates: Record<string, unknown>;
      };

      expect(refreshed.status).toBe("ok");
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(persisted.providerGates[`${instanceId}:claudeAgent`]).toBeUndefined();
    } finally {
      fetchMock.mockRestore();
      resetProviderUsageCache();
      await NodeFSP.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("refreshes automatically when a rate-limit gate expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(nowMs);
    resetProviderUsageCache();
    const blockedUntilMs = nowMs + 120_000;
    let fetchCount = 0;
    const fetchUsage = async (ctx: { readonly nowMs: number }) => {
      fetchCount += 1;
      return fetchCount === 1
        ? rateLimitedFetchResult({ provider: "cursor", nowMs: ctx.nowMs, untilMs: blockedUntilMs })
        : fetchResult(cursorSnapshot({ nowMs: ctx.nowMs, usedPercent: 25 }));
    };
    try {
      await providerUsageTestKit.resolve(
        { instanceId, provider: "cursor", nowMs, forceRefresh: true },
        fetchUsage,
      );

      expect(fetchCount).toBe(1);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(fetchCount).toBe(2);
      const refreshed = await providerUsageTestKit.resolve(
        { instanceId, provider: "cursor", nowMs: blockedUntilMs + 1 },
        async () => {
          throw new Error("automatic refresh should populate the cache");
        },
      );
      expect(refreshed).toMatchObject({ status: "ok", limits: [{ usedPercent: 25 }] });
    } finally {
      resetProviderUsageCache();
      vi.useRealTimers();
    }
  });

  it.live("cancels a scheduled refresh when the provider is disabled", () => {
    vi.useFakeTimers();
    vi.setSystemTime(nowMs);
    resetProviderUsageCache();
    const blockedUntilMs = nowMs + 120_000;
    let fetchCount = 0;
    const fetchUsage = async (ctx: { readonly nowMs: number }) => {
      fetchCount += 1;
      return rateLimitedFetchResult({
        provider: "cursor",
        nowMs: ctx.nowMs,
        untilMs: blockedUntilMs,
      });
    };
    return Effect.gen(function* () {
      yield* Effect.promise(() =>
        providerUsageTestKit.resolve(
          { instanceId, provider: "cursor", nowMs, forceRefresh: true },
          fetchUsage,
        ),
      );
      yield* providerUsageTestKit.loadList().pipe(
        Effect.provide(
          ServerSettingsService.layerTest({
            providerInstances: {
              ...disabledLegacySlots,
              [instanceId]: { driver: "cursor", enabled: false },
            },
          }),
        ),
      );
      yield* Effect.promise(() => vi.advanceTimersByTimeAsync(120_000));

      expect(fetchCount).toBe(1);
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          resetProviderUsageCache();
          vi.useRealTimers();
        }),
      ),
    );
  });

  it("detects the Claude CLI version and continues after a credential network error", async () => {
    resetProviderUsageCache();
    const versionRunner = vi.fn(async (command: string) => {
      expect(command).toBe("/opt/claude-custom");
      return "Claude Code 2.1.222";
    });
    providerUsageTestKit.setClaudeVersionRunner(versionRunner);
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new TypeError("offline credential"))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ five_hour: { utilization: 17 } }), { status: 200 }),
      );
    try {
      const result = await providerUsageTestKit.fetchClaude(
        {
          instanceId,
          provider: "claudeAgent",
          nowMs,
          providerBinaryPath: "/opt/claude-custom",
        },
        [{ accessToken: "first" }, { accessToken: "second", planName: "Max (20x)" }],
      );

      expect(result.snapshot).toMatchObject({ status: "ok", planName: "Max (20x)" });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(versionRunner).toHaveBeenCalledTimes(1);
      const secondRequest = fetchMock.mock.calls[1]?.[1];
      expect(new Headers(secondRequest?.headers).get("User-Agent")).toBe("claude-code/2.1.222");
      expect(new Headers(secondRequest?.headers).get("Authorization")).toBe("Bearer second");
    } finally {
      fetchMock.mockRestore();
      resetProviderUsageCache();
    }

    providerUsageTestKit.setClaudeVersionRunner(async () => {
      throw new Error("missing binary");
    });
    const fallbackFetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ seven_day: { utilization: 4 } })));
    try {
      await providerUsageTestKit.fetchClaude({ instanceId, provider: "claudeAgent", nowMs }, [
        { accessToken: "fallback" },
      ]);
      expect(new Headers(fallbackFetch.mock.calls[0]?.[1]?.headers).get("User-Agent")).toBe(
        "claude-code/2.1.69",
      );
    } finally {
      fallbackFetch.mockRestore();
      resetProviderUsageCache();
    }
  });

  it("bounds snapshot and in-flight caches", async () => {
    resetProviderUsageCache();
    const pending = Array.from({ length: 70 }, () => deferred<ReturnType<typeof fetchResult>>());
    const requests = pending.map((entry, index) => {
      const scopedInstanceId = ProviderInstanceId.make(`usage_${index}`);
      return providerUsageTestKit.resolve(
        { instanceId: scopedInstanceId, provider: "cursor", nowMs },
        () => entry.promise,
      );
    });
    try {
      expect(providerUsageTestKit.cacheSizes().inFlight).toBe(64);
      pending.forEach((entry, index) => {
        entry.resolve(
          fetchResult(
            cursorSnapshot({
              instanceId: ProviderInstanceId.make(`usage_${index}`),
              nowMs,
              usedPercent: index,
            }),
          ),
        );
      });
      await Promise.all(requests);
      expect(providerUsageTestKit.cacheSizes()).toMatchObject({ snapshots: 64, inFlight: 0 });
    } finally {
      resetProviderUsageCache();
    }
  });

  it.effect("refreshes an expired cached snapshot while loading the subscription list", () =>
    Effect.acquireUseRelease(
      Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pathway-provider-usage-list-")),
      ),
      (providerHomePath) =>
        Effect.gen(function* () {
          resetProviderUsageCache();
          yield* Effect.promise(() =>
            NodeFSP.writeFile(
              NodePath.join(providerHomePath, ".credentials.json"),
              '{"claudeAiOauth":{"accessToken":"test-token"}}',
            ),
          );
          providerUsageTestKit.setClaudeVersionRunner(async () => "claude 2.1.222");
          const fetchMock = vi
            .spyOn(globalThis, "fetch")
            .mockResolvedValue(new Response('{"five_hour":{"utilization":20}}'));
          yield* Effect.gen(function* () {
            const currentNowMs = DateTime.toEpochMillis(DateTime.nowUnsafe());
            const cachedAtMs = currentNowMs - 6 * 60_000;
            yield* Effect.promise(() =>
              providerUsageTestKit.resolve(
                { instanceId, provider: "claudeAgent", nowMs: cachedAtMs },
                async () =>
                  fetchResult(
                    parseClaudeUsage({
                      instanceId,
                      nowMs: cachedAtMs,
                      json: { five_hour: { utilization: 10 } },
                    }),
                  ),
              ),
            );

            const snapshots = yield* providerUsageTestKit.loadList().pipe(
              Effect.provide(
                ServerSettingsService.layerTest({
                  providerInstances: {
                    ...disabledLegacySlots,
                    [ProviderInstanceId.make("usage_test")]: {
                      driver: "claudeAgent",
                      config: { homePath: providerHomePath },
                    },
                  },
                }),
              ),
            );

            expect(fetchMock).toHaveBeenCalledTimes(1);
            expect(snapshots[0]?.limits[0]?.usedPercent).toBe(20);
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                fetchMock.mockRestore();
                resetProviderUsageCache();
              }),
            ),
          );
        }),
      (providerHomePath) =>
        Effect.promise(() => NodeFSP.rm(providerHomePath, { recursive: true, force: true })),
    ),
  );

  it("explains that an expired Codex token will be refreshed by the CLI", async () => {
    const providerHomePath = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "pathway-provider-usage-"),
    );
    const payload = Buffer.from(JSON.stringify({ exp: Math.floor(nowMs / 1000) - 60 })).toString(
      "base64url",
    );
    await NodeFSP.writeFile(
      NodePath.join(providerHomePath, "auth.json"),
      JSON.stringify({ tokens: { access_token: `header.${payload}.signature` } }),
    );
    try {
      const result = await providerUsageTestKit.fetchCodex({
        instanceId,
        provider: "codex",
        nowMs,
        providerHomePath,
        homeDir: providerHomePath,
      });
      expect(result.snapshot).toMatchObject({
        status: "needs-auth",
        detail: "Token expired — run codex to refresh",
      });
    } finally {
      await NodeFSP.rm(providerHomePath, { recursive: true, force: true });
    }
  });

  // it.live, not it.effect: the cache TTL compares against wall-clock time, so
  // TestClock timestamps would make the pushed snapshot look expired and
  // trigger a live bootstrap fetch.
  it.live("merges sparse pushed usage into the full cached and subscribed snapshot", () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("network disabled in test"));
    return Effect.scoped(
      Effect.gen(function* () {
        resetProviderUsageCache();
        const pushedAtMs = DateTime.toEpochMillis(yield* DateTime.now);
        yield* ingestPushedSnapshot(
          mapCodexRateLimitsUpdated({
            instanceId,
            rateLimits: {
              primary: { usedPercent: 10, windowDurationMins: 300 },
              secondary: { usedPercent: 40, windowDurationMins: 10_080 },
              credits: { hasCredits: true, unlimited: false, balance: "12.50" },
              planType: "pro",
            },
          }),
          pushedAtMs,
        );

        const merged = yield* ingestPushedSnapshot(
          mapCodexRateLimitsUpdated({
            instanceId,
            rateLimits: {
              primary: { usedPercent: 25, windowDurationMins: 300 },
            },
          }),
          pushedAtMs + 1_000,
        );
        expect(merged).toMatchObject({
          source: "codex-app-server-push",
          planName: "ChatGPT Pro",
          limits: [
            { window: "5h", windowKey: "session", usedPercent: 25 },
            { window: "Weekly", windowKey: "weekly", usedPercent: 40 },
          ],
          usageLines: [{ label: "Credits", value: "$12.50 remaining" }],
        });

        const current = yield* subscribeProviderUsage().pipe(Stream.take(1), Stream.runCollect);
        expect(current[0]).toMatchObject([
          {
            source: "codex-app-server-push",
            planName: "ChatGPT Pro",
            limits: [
              { window: "5h", windowKey: "session", usedPercent: 25 },
              { window: "Weekly", windowKey: "weekly", usedPercent: 40 },
            ],
            usageLines: [{ label: "Credits", value: "$12.50 remaining" }],
          },
        ]);
        expect(fetchMock).not.toHaveBeenCalled();
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            fetchMock.mockRestore();
            resetProviderUsageCache();
          }),
        ),
        Effect.provide(
          ServerSettingsService.layerTest({
            providerInstances: {
              ...disabledLegacySlots,
              [ProviderInstanceId.make("usage_test")]: { driver: "codex" },
            },
          }),
        ),
      ),
    );
  });

  it.effect("lists legacy settings.providers instances in the subscription bootstrap", () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("network disabled in test"));
    return Effect.scoped(
      Effect.gen(function* () {
        resetProviderUsageCache();
        const providerHomePath = yield* Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pathway-provider-usage-")),
        );
        yield* Effect.gen(function* () {
          const current = yield* subscribeProviderUsage().pipe(Stream.take(1), Stream.runCollect);
          expect(current[0]).toMatchObject([{ provider: "codex", status: "needs-auth" }]);
          expect(fetchMock).not.toHaveBeenCalled();
        }).pipe(
          Effect.provide(
            ServerSettingsService.layerTest({
              providers: { codex: { homePath: providerHomePath } },
              providerInstances: {
                [ProviderInstanceId.make("claudeAgent")]: {
                  driver: "claudeAgent",
                  enabled: false,
                },
                [ProviderInstanceId.make("cursor")]: { driver: "cursor", enabled: false },
              },
            }),
          ),
          Effect.ensuring(
            Effect.promise(() => NodeFSP.rm(providerHomePath, { recursive: true, force: true })),
          ),
        );
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            fetchMock.mockRestore();
            resetProviderUsageCache();
          }),
        ),
      ),
    );
  });
});
