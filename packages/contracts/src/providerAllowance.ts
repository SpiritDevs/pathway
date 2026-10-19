import * as Schema from "effect/Schema";
import { ProviderInstanceId } from "./providerInstance.ts";
import { ServerProviderUsageSnapshot } from "./providerUsage.ts";
import { ProviderAllowanceBudget } from "./providerAllowanceBudget.ts";

export const ProviderAllowanceInput = Schema.Struct({
  instanceId: Schema.optional(ProviderInstanceId),
  allInstances: Schema.optional(Schema.Boolean),
  forceRefresh: Schema.optional(Schema.Boolean),
});
export type ProviderAllowanceInput = typeof ProviderAllowanceInput.Type;
export const ProviderAllowanceReport = Schema.Struct({
  instanceId: ProviderInstanceId,
  provider: Schema.String,
  status: Schema.Literals(["ok", "needs-auth", "unsupported", "error"]),
  freshness: Schema.Literals(["fresh", "stale", "unknown", "unsupported"]),
  snapshot: Schema.NullOr(ServerProviderUsageSnapshot),
  detail: Schema.String,
});
export type ProviderAllowanceReport = typeof ProviderAllowanceReport.Type;
export const ProviderAllowanceResult = Schema.Struct({
  accounts: Schema.Array(ProviderAllowanceReport),
  interpretation: Schema.String,
  budgets: Schema.optional(Schema.Array(ProviderAllowanceBudget)),
  admission: Schema.optional(
    Schema.Struct({
      canStart: Schema.Boolean,
      shouldInterrupt: Schema.Boolean,
      detail: Schema.String,
    }),
  ),
});
export type ProviderAllowanceResult = typeof ProviderAllowanceResult.Type;

export const AllocateAgentAllowanceInput = Schema.Struct({
  companyId: Schema.optional(Schema.String),
  instanceId: Schema.optional(ProviderInstanceId),
  windowKey: Schema.String,
  authorizedPercent: Schema.Number,
  sourceQuote: Schema.String,
  title: Schema.String,
});
export type AllocateAgentAllowanceInput = typeof AllocateAgentAllowanceInput.Type;
export const AllocateAgentAllowanceResult = ProviderAllowanceBudget;

/** A numeric allocation must be quoted from the current human request, never inferred from old context. */
export function quotesAllowanceInstruction(text: string, quote: string, percent: number): boolean {
  if (
    !quote.trim() ||
    !text.includes(quote) ||
    !Number.isFinite(percent) ||
    percent <= 0 ||
    percent > 100
  )
    return false;
  if (!/\b(?:allowance|quota|usage|budget)\b/iu.test(quote)) return false;
  return [...quote.matchAll(/\b(\d+(?:\.\d+)?)\s*(?:%|percent(?:age points)?\b)/giu)].some(
    (match) => Number(match[1]) === percent,
  );
}
