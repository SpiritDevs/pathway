// @effect-diagnostics nodeBuiltinImport:off -- isolated credential fixtures.
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { ProviderInstanceId } from "@spiritdevs/contracts";
import { afterEach, vi } from "vite-plus/test";
import { describe, expect, it } from "@effect/vitest";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  consumeProviderResetCredit,
  getProviderUsage,
  ingestPushedSnapshot,
  mapCodexRateLimitsUpdated,
  parseCodexResetCredits,
  providerUsageTestKit,
  resetCreditRequestId,
  resetProviderUsageCache,
} from "./ProviderUsageService.ts";

const nowMs = Date.parse("2026-09-08T00:00:00Z");
const instanceId = ProviderInstanceId.make("codex-reset-test");
const accountKey = NodeCrypto.createHash("sha256").update("account-a").digest("hex");
const credit = { instanceId, accountKey, creditId: "credit-a" };
const directories: string[] = [];
async function context() {
  const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pathway-reset-test-"));
  directories.push(home);
  await NodeFSP.writeFile(
    NodePath.join(home, "auth.json"),
    JSON.stringify({ tokens: { access_token: "token", account_id: "account-a" } }),
  );
  return { instanceId, provider: "codex" as const, nowMs, providerHomePath: home, homeDir: home };
}
afterEach(async () => {
  vi.unstubAllGlobals();
  resetProviderUsageCache();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => NodeFSP.rm(directory, { recursive: true, force: true })),
  );
});

describe("Codex reset credits", () => {
  it("lists only available, unexpired Codex credits in expiry order", () => {
    const row = {
      id: "later",
      status: "available",
      reset_type: "codex_rate_limits",
      expires_at: "2026-09-10T00:00:00Z",
    };
    expect(
      parseCodexResetCredits(
        {
          credits: [
            row,
            { ...row, id: "soon", expires_at: "2026-09-09T00:00:00Z" },
            { ...row, status: "redeemed" },
            { ...row, reset_type: "other" },
            { ...row, expires_at: "2020-01-01" },
            { ...row, expires_at: "invalid" },
          ],
        },
        nowMs,
      ),
    ).toEqual({
      availableCount: 2,
      credits: [
        { id: "soon", expiresAt: "2026-09-09T00:00:00.000Z" },
        { id: "later", expiresAt: "2026-09-10T00:00:00.000Z" },
      ],
      nextExpiresAt: "2026-09-09T00:00:00.000Z",
    });
    expect(parseCodexResetCredits({}, nowMs)).toBeUndefined();
    expect(parseCodexResetCredits({ credits: [] }, nowMs)).toEqual({
      availableCount: 0,
      credits: [],
    });
  });

  it("keeps quota available when the credits endpoint fails", async () => {
    const ctx = await context();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.endsWith("/usage")
          ? Response.json({ rate_limit: { primary_window: { used_percent: 20 } } })
          : new Response("unavailable", { status: 500 }),
      ),
    );
    const result = await providerUsageTestKit.fetchCodex(ctx);
    expect(result.snapshot.status).toBe("ok");
    expect(result.snapshot.limits[0]?.usedPercent).toBe(20);
    expect(result.snapshot.resetCredits).toBeUndefined();
  });

  it.effect("preserves reset credits when a streamed update only changes usage windows", () =>
    Effect.gen(function* () {
      const resetCredits = {
        availableCount: 1,
        credits: [{ id: "credit-a", expiresAt: "2026-09-10T00:00:00.000Z" }],
      };
      yield* Effect.promise(() =>
        providerUsageTestKit.resolve({ instanceId, provider: "codex", nowMs }, async () => ({
          snapshot: {
            instanceId,
            provider: "codex",
            accountKey,
            updatedAt: "2026-09-08T00:00:00.000Z",
            status: "ok",
            source: "test",
            limits: [],
            usageLines: [],
            resetCredits,
          },
        })),
      );
      providerUsageTestKit.setCodexAccountKeyReader(instanceId, async () => accountKey);
      yield* ingestPushedSnapshot(
        mapCodexRateLimitsUpdated({
          instanceId,
          rateLimits: { primary: { usedPercent: 50, windowDurationMins: 300 } },
        }),
        nowMs + 1,
      );
      const result = yield* Effect.promise(() =>
        providerUsageTestKit.resolve(
          { instanceId, provider: "codex", nowMs: nowMs + 2 },
          async () => {
            throw new Error("should stay cached");
          },
        ),
      );
      expect(result.resetCredits).toEqual(resetCredits);
    }),
  );

  it.effect("rejects disabled and missing instances without contacting Codex", () =>
    Effect.gen(function* () {
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);
      for (const providerInstances of [{}, { [instanceId]: { driver: "codex", enabled: false } }]) {
        const result = yield* consumeProviderResetCredit(credit).pipe(
          Effect.provide(ServerSettingsService.layerTest({ providerInstances })),
          Effect.result,
        );
        expect(result._tag).toBe("Failure");
      }
      expect(fetch).not.toHaveBeenCalled();
    }),
  );

  it.effect("returns a confirmed outcome with a warning when refreshing usage fails", () =>
    Effect.gen(function* () {
      const ctx = yield* Effect.promise(context);
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) =>
          url.endsWith("/consume")
            ? Response.json({ code: "reset" })
            : new Response("unavailable", { status: 500 }),
        ),
      );
      const result = yield* consumeProviderResetCredit(credit).pipe(
        Effect.provide(
          ServerSettingsService.layerTest({
            providerInstances: {
              [instanceId]: { driver: "codex", config: { homePath: ctx.providerHomePath } },
            },
          }),
        ),
      );
      expect(result.outcome).toBe("reset");
      expect(result.warning).toContain("latest usage");
    }),
  );

  it.effect("rejects disabled legacy Codex before reading credentials or sending requests", () =>
    Effect.gen(function* () {
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);
      const result = yield* consumeProviderResetCredit({
        ...credit,
        instanceId: ProviderInstanceId.make("codex"),
      }).pipe(
        Effect.provide(
          ServerSettingsService.layerTest({ providers: { codex: { enabled: false } } }),
        ),
        Effect.result,
      );
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure")
        expect(String(result.failure)).toContain("missing or disabled");
      expect(fetch).not.toHaveBeenCalled();
    }),
  );

  it.effect("retains the empty balance when only the post-redemption credit refresh fails", () =>
    Effect.gen(function* () {
      const ctx = yield* Effect.promise(context);
      let spent = false;
      let creditRefreshFails = true;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
          if (url.endsWith("/consume")) {
            spent = true;
            return Response.json({ code: "reset" });
          }
          if (url.endsWith("/usage"))
            return Response.json({
              rate_limit: { primary_window: { used_percent: spent ? 0 : 90 } },
            });
          if (spent && creditRefreshFails) return new Response("unavailable", { status: 500 });
          return Response.json({
            credits: spent
              ? []
              : [
                  {
                    id: "credit-a",
                    status: "available",
                    reset_type: "codex_rate_limits",
                    expires_at: "2099-09-10T00:00:00Z",
                  },
                ],
          });
        }),
      );
      yield* Effect.gen(function* () {
        yield* getProviderUsage({ instanceId, provider: "codex" });
        const result = yield* consumeProviderResetCredit(credit);
        expect(result.outcome).toBe("reset");
        expect(result.warning).toContain("latest usage");
        const snapshot = yield* getProviderUsage({ instanceId, provider: "codex" });
        expect(snapshot.status).toBe("ok");
        expect(snapshot.stale).not.toBe(true);
        expect(snapshot.limits[0]?.usedPercent).toBe(0);
        expect(snapshot.resetCredits).toEqual({ availableCount: 0, credits: [], stale: true });
        creditRefreshFails = false;
        const recovered = yield* getProviderUsage({
          instanceId,
          provider: "codex",
          forceRefresh: true,
        });
        expect(recovered.resetCredits).toEqual({ availableCount: 0, credits: [] });
      }).pipe(
        Effect.provide(
          ServerSettingsService.layerTest({
            providerInstances: {
              [instanceId]: { driver: "codex", config: { homePath: ctx.providerHomePath } },
            },
          }),
        ),
      );
    }),
  );

  it.effect("publishes refreshed credits and limits after redemption", () =>
    Effect.gen(function* () {
      const ctx = yield* Effect.promise(context);
      let spent = false;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
          if (url.endsWith("/consume")) {
            spent = true;
            return Response.json({ code: "reset" });
          }
          if (url.endsWith("/usage"))
            return Response.json({
              rate_limit: { primary_window: { used_percent: spent ? 0 : 90 } },
            });
          return Response.json({
            credits: spent
              ? []
              : [
                  {
                    id: "credit-a",
                    status: "available",
                    reset_type: "codex_rate_limits",
                    expires_at: "2099-09-10T00:00:00Z",
                  },
                ],
          });
        }),
      );
      yield* Effect.gen(function* () {
        expect(
          (yield* getProviderUsage({ instanceId, provider: "codex" })).resetCredits?.availableCount,
        ).toBe(1);
        const result = yield* consumeProviderResetCredit(credit);
        expect(result).toEqual({ outcome: "reset" });
        const snapshot = yield* getProviderUsage({ instanceId, provider: "codex" });
        expect(snapshot.resetCredits?.availableCount).toBe(0);
        expect(snapshot.limits[0]?.usedPercent).toBe(0);
      }).pipe(
        Effect.provide(
          ServerSettingsService.layerTest({
            providerInstances: {
              [instanceId]: { driver: "codex", config: { homePath: ctx.providerHomePath } },
            },
          }),
        ),
      );
    }),
  );

  it.effect("does not let a pre-redemption forced read overwrite the refreshed account", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const ctx = yield* Effect.promise(context);
        const oldResponse = Promise.withResolvers<Response>();
        const oldStarted = Promise.withResolvers<void>();
        let usageReads = 0;
        let spent = false;
        vi.stubGlobal(
          "fetch",
          vi.fn(async (url: string) => {
            if (url.endsWith("/consume")) {
              spent = true;
              return Response.json({ code: "reset" });
            }
            if (url.endsWith("/usage")) {
              usageReads += 1;
              if (usageReads === 2) {
                oldStarted.resolve();
                return oldResponse.promise;
              }
              return Response.json({
                rate_limit: { primary_window: { used_percent: spent ? 0 : 90 } },
              });
            }
            return Response.json({
              credits: spent
                ? []
                : [
                    {
                      id: "credit-a",
                      status: "available",
                      reset_type: "codex_rate_limits",
                      expires_at: "2099-09-10T00:00:00Z",
                    },
                  ],
            });
          }),
        );
        yield* Effect.gen(function* () {
          yield* getProviderUsage({ instanceId, provider: "codex" });
          const pending = yield* getProviderUsage({
            instanceId,
            provider: "codex",
            forceRefresh: true,
          }).pipe(Effect.forkScoped);
          yield* Effect.promise(() => oldStarted.promise);
          expect(yield* consumeProviderResetCredit(credit)).toEqual({ outcome: "reset" });
          oldResponse.resolve(
            Response.json({ rate_limit: { primary_window: { used_percent: 90 } } }),
          );
          yield* Fiber.join(pending);
          const snapshot = yield* getProviderUsage({ instanceId, provider: "codex" });
          expect(snapshot.limits[0]?.usedPercent).toBe(0);
          expect(snapshot.resetCredits?.availableCount).toBe(0);
        }).pipe(
          Effect.provide(
            ServerSettingsService.layerTest({
              providerInstances: {
                [instanceId]: { driver: "codex", config: { homePath: ctx.providerHomePath } },
              },
            }),
          ),
        );
      }),
    ),
  );

  it("rejects an account switch before sending redemption", async () => {
    const ctx = await context();
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(
      providerUsageTestKit.redeemCodex(ctx, { ...credit, accountKey: "other-account" }),
    ).rejects.toThrow("account changed");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reuses the exact account-and-credit request id after an ambiguous failure", async () => {
    const ctx = await context();
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error("connection lost"))
      .mockResolvedValueOnce(Response.json({ code: "already_redeemed" }));
    vi.stubGlobal("fetch", fetch);
    await expect(providerUsageTestKit.redeemCodex(ctx, credit)).rejects.toThrow("connection lost");
    await expect(providerUsageTestKit.redeemCodex(ctx, credit)).resolves.toEqual({
      outcome: "alreadyRedeemed",
    });
    const bodies = fetch.mock.calls.map((call) => JSON.parse(call[1].body));
    expect(bodies[0]).toEqual(bodies[1]);
    expect(bodies[0]).toEqual({
      credit_id: credit.creditId,
      redeem_request_id: resetCreditRequestId(accountKey, credit.creditId),
    });
    expect(resetCreditRequestId("another-account", credit.creditId)).not.toBe(
      bodies[0].redeem_request_id,
    );
  });

  it("rejects a different pending credit on the same account", async () => {
    const ctx = await context();
    const response = Promise.withResolvers<Response>();
    const started = Promise.withResolvers<void>();
    const fetch = vi.fn(() => {
      started.resolve();
      return response.promise;
    });
    vi.stubGlobal("fetch", fetch);
    const first = providerUsageTestKit.redeemCodex(ctx, credit);
    await started.promise;
    await expect(
      providerUsageTestKit.redeemCodex(ctx, { ...credit, creditId: "credit-b" }),
    ).rejects.toThrow("already being redeemed");
    response.resolve(Response.json({ code: "reset" }));
    expect(await first).toEqual({ outcome: "reset" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
