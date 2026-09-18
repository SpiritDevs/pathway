import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import type { ServerProviderUsageLimit, ServerProviderUsageSnapshot } from "./providerUsage.ts";

export const ALLOWANCE_MAX_READING_AGE_MS = 90_000;
export type AllowanceAllocationState =
  | "ready"
  | "near-limit"
  | "limit-reached"
  | "unavailable"
  | "reset";
export interface AllowanceAllocation {
  readonly provider: string;
  readonly accountKey: string;
  readonly windowKey: string;
  readonly windowLabel: string;
  readonly resetsAt: number;
  readonly authorizedPercent: number;
  readonly baselineUsedPercent: number;
  readonly observedUsedPercent: number;
  readonly observedAt: number;
  readonly state: AllowanceAllocationState;
  readonly detail: string;
}

export const ProviderAllowanceScope = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("chat"), chatId: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("thread"),
    environmentId: Schema.String,
    threadId: Schema.String,
  }),
]);
export type ProviderAllowanceScope = typeof ProviderAllowanceScope.Type;
export const ProviderAllowanceAllocation = Schema.Struct({
  provider: Schema.String,
  accountKey: Schema.String,
  windowKey: Schema.String,
  windowLabel: Schema.String,
  resetsAt: Schema.Number,
  authorizedPercent: Schema.Number,
  baselineUsedPercent: Schema.Number,
  observedUsedPercent: Schema.Number,
  observedAt: Schema.Number,
  state: Schema.Literals(["ready", "near-limit", "limit-reached", "unavailable", "reset"]),
  detail: Schema.String,
});
export const ProviderAllowanceBudget = Schema.Struct({
  id: Schema.String,
  companyId: Schema.String,
  title: Schema.String,
  ownerSubject: Schema.String,
  scopes: Schema.Array(ProviderAllowanceScope),
  allocations: Schema.Array(ProviderAllowanceAllocation),
  status: Schema.Literals(["active", "paused", "closed"]),
  revision: Schema.Number,
  detail: Schema.String,
  scheduledResume: Schema.optional(
    Schema.Struct({
      at: Schema.Number,
      timeZone: Schema.String,
      expiresAt: Schema.Number,
      allocations: Schema.Array(
        Schema.Struct({
          provider: Schema.String,
          accountKey: Schema.String,
          windowKey: Schema.String,
          windowLabel: Schema.optionalKey(Schema.String),
          authorizedPercent: Schema.Number,
        }),
      ),
      observations: Schema.Array(ProviderAllowanceAllocation),
    }),
  ),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
});
export type ProviderAllowanceBudget = typeof ProviderAllowanceBudget.Type;

export function allowanceScopeKey(scope: ProviderAllowanceScope): string {
  return scope.kind === "chat"
    ? JSON.stringify(["chat", scope.chatId])
    : JSON.stringify(["thread", scope.environmentId, scope.threadId]);
}

/** Provider identifiers take precedence over presentation labels when identifying a quota window. */
export function allowanceWindowKey(limit: ServerProviderUsageLimit): string {
  return JSON.stringify([
    limit.limitId ?? limit.windowKey ?? limit.window,
    limit.scope ?? "",
    limit.lane ?? "",
    limit.windowDurationMins ?? null,
  ]);
}

function reliableReading(snapshot: ServerProviderUsageSnapshot, key: string, now: number) {
  if (snapshot.status !== "ok" || snapshot.stale || !snapshot.accountKey)
    return {
      error: "A fresh reading with a stable provider account identity is required.",
    } as const;
  if (snapshot.rateLimitedUntil && Date.parse(snapshot.rateLimitedUntil) > now)
    return { error: "The provider is throttling allowance checks." } as const;
  const limit = snapshot.limits.find((limit) => allowanceWindowKey(limit) === key);
  if (
    !limit ||
    limit.usedPercent === undefined ||
    !Number.isFinite(limit.usedPercent) ||
    limit.usedPercent < 0
  )
    return { error: "The selected allowance window has no reliable usage reading." } as const;
  const fetchedAt = limit.fetchedAt ? Date.parse(limit.fetchedAt) : NaN;
  if (
    !Number.isFinite(fetchedAt) ||
    fetchedAt > now + 30_000 ||
    now - fetchedAt >= ALLOWANCE_MAX_READING_AGE_MS
  )
    return {
      error: "The selected allowance window is stale or its freshness is unknown.",
    } as const;
  const resetsAt = limit.resetsAt ? Date.parse(limit.resetsAt) : NaN;
  if (!Number.isFinite(resetsAt))
    return { error: "The allowance window's reset boundary is unknown." } as const;
  return { limit, usedPercent: limit.usedPercent, fetchedAt, resetsAt } as const;
}

export function allocateProviderAllowance(
  snapshot: ServerProviderUsageSnapshot,
  windowKey: string,
  authorizedPercent: number,
  now: number,
): { allocation: AllowanceAllocation; error?: never } | { error: string; allocation?: never } {
  if (!Number.isFinite(authorizedPercent) || authorizedPercent <= 0 || authorizedPercent > 100)
    return {
      error: "Choose an allowance greater than zero and at most 100 percentage points.",
    } as const;
  const reading = reliableReading(snapshot, windowKey, now);
  if (reading.error !== undefined) return { error: reading.error };
  if (reading.resetsAt <= now || reading.usedPercent >= 100)
    return {
      error: "This provider window is exhausted or waiting for a confirmed reset.",
    } as const;
  return {
    allocation: {
      provider: snapshot.provider,
      accountKey: snapshot.accountKey!,
      windowKey,
      windowLabel: reading.limit.window,
      resetsAt: reading.resetsAt,
      authorizedPercent,
      baselineUsedPercent: reading.usedPercent,
      observedUsedPercent: reading.usedPercent,
      observedAt: reading.fetchedAt,
      state: "ready",
      detail: "Allowance is available.",
    } satisfies AllowanceAllocation,
  } as const;
}

/** Monotonic account-wide consumption; a reset never turns an existing allocation into a new one. */
export function observeProviderAllowance(
  allocation: AllowanceAllocation,
  snapshot: ServerProviderUsageSnapshot | null,
  now: number,
): AllowanceAllocation {
  const unavailable = (detail: string): AllowanceAllocation => ({
    ...allocation,
    state: "unavailable",
    detail,
  });
  if (allocation.state === "reset") return allocation;
  if (allocation.resetsAt <= now)
    return {
      ...allocation,
      state: "reset",
      detail: "The quota window reset. A new explicit allocation is required.",
    };
  if (
    !snapshot ||
    snapshot.provider !== allocation.provider ||
    snapshot.accountKey !== allocation.accountKey
  )
    return unavailable("This provider account has no matching authorized allowance reading.");
  const reading = reliableReading(snapshot, allocation.windowKey, now);
  if ("error" in reading) return unavailable(reading.error!);
  if (reading.fetchedAt < allocation.observedAt) {
    if (now - allocation.observedAt >= ALLOWANCE_MAX_READING_AGE_MS)
      return unavailable("The latest confirmed allowance reading is stale.");
    return allocation;
  }
  if (reading.resetsAt !== allocation.resetsAt)
    return {
      ...allocation,
      state: "reset",
      detail: `The provider changed this quota window's reset from ${DateTime.formatIso(DateTime.makeUnsafe(allocation.resetsAt))} to ${DateTime.formatIso(DateTime.makeUnsafe(reading.resetsAt))}. A new explicit allocation is required.`,
    };
  if (reading.usedPercent < allocation.observedUsedPercent)
    return unavailable(
      "The provider's usage decreased unexpectedly. The existing allocation is retained while the reading is checked.",
    );
  const next = {
    ...allocation,
    observedUsedPercent: reading.usedPercent,
    observedAt: reading.fetchedAt,
  };
  const consumed = next.observedUsedPercent - next.baselineUsedPercent;
  const remaining = Math.min(next.authorizedPercent - consumed, 100 - next.observedUsedPercent);
  if (remaining <= 0 || allocation.state === "limit-reached")
    return {
      ...next,
      state: "limit-reached",
      detail:
        "The observed allowance threshold was reached. Stop managed work and retain partial results.",
    };
  if (remaining <= Math.min(1, next.authorizedPercent / 10))
    return {
      ...next,
      state: "near-limit",
      detail: "The allowance threshold is close. Do not start additional work.",
    };
  return { ...next, state: "ready", detail: "Allowance is available." };
}

export function allowanceAllocationProgress(allocation: AllowanceAllocation) {
  const consumedPercent = Math.max(
    0,
    allocation.observedUsedPercent - allocation.baselineUsedPercent,
  );
  return {
    consumedPercent,
    remainingPercent: Math.max(0, allocation.authorizedPercent - consumedPercent),
    targetRemainingPercent: Math.max(
      0,
      100 - allocation.baselineUsedPercent - allocation.authorizedPercent,
    ),
    overshootPercent: Math.max(0, consumedPercent - allocation.authorizedPercent),
    canStart: allocation.state === "ready",
    shouldInterrupt: allocation.state !== "ready" && allocation.state !== "near-limit",
  };
}

export function budgetAdmission(
  budget: Pick<ProviderAllowanceBudget, "status" | "allocations">,
  account: { provider: string; accountKey?: string | undefined },
  now: number,
) {
  if (budget.status !== "active")
    return {
      canStart: false,
      shouldInterrupt: true,
      detail: "This allowance allocation is paused.",
    };
  const allocations = budget.allocations.filter(
    (a) => a.provider === account.provider && a.accountKey === account.accountKey,
  );
  if (!allocations.length)
    return {
      canStart: false,
      shouldInterrupt: true,
      detail: "This fallback account has no authorized allocation.",
    };
  const checked = allocations.map((allocation) => {
    if (allocation.state === "reset")
      return { canStart: false, shouldInterrupt: true, detail: allocation.detail };
    if (allocation.resetsAt <= now || now - allocation.observedAt >= 90_000)
      return {
        canStart: false,
        shouldInterrupt: true,
        detail: "Allowance readings are stale or the quota window reset.",
      };
    return { ...allowanceAllocationProgress(allocation), detail: allocation.detail };
  });
  return {
    canStart: checked.every((a) => a.canStart),
    shouldInterrupt: checked.some((a) => a.shouldInterrupt),
    detail: checked.find((a) => !a.canStart)?.detail ?? "Allowance is available.",
  };
}
