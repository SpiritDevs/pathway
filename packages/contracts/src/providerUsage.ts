import * as Schema from "effect/Schema";

import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

/** Provider drivers with a stable first-party quota endpoint. */
export const ProviderUsageDriver = Schema.Literals(["codex", "claudeAgent", "cursor"]);
export type ProviderUsageDriver = typeof ProviderUsageDriver.Type;

export const ServerProviderUsageLimit = Schema.Struct({
  window: TrimmedNonEmptyString,
  windowKey: Schema.optional(Schema.Literals(["session", "weekly", "monthly", "custom"])),
  scope: Schema.optional(TrimmedNonEmptyString),
  usedPercent: Schema.optional(Schema.Number),
  resetsAt: Schema.optional(IsoDateTime),
  windowDurationMins: Schema.optional(Schema.Number),
});
export type ServerProviderUsageLimit = typeof ServerProviderUsageLimit.Type;

export const ServerProviderUsageLine = Schema.Struct({
  label: TrimmedNonEmptyString,
  value: TrimmedNonEmptyString,
  subtitle: Schema.optional(TrimmedNonEmptyString),
});
export type ServerProviderUsageLine = typeof ServerProviderUsageLine.Type;

export const ProviderUsageStatus = Schema.Literals(["ok", "needs-auth", "unsupported", "error"]);
export type ProviderUsageStatus = typeof ProviderUsageStatus.Type;

export const ServerProviderUsageSnapshot = Schema.Struct({
  instanceId: ProviderInstanceId,
  provider: ProviderUsageDriver,
  updatedAt: IsoDateTime,
  fetchedAt: Schema.optional(IsoDateTime),
  limits: Schema.Array(ServerProviderUsageLimit),
  usageLines: Schema.Array(ServerProviderUsageLine),
  source: TrimmedNonEmptyString,
  status: ProviderUsageStatus,
  planName: Schema.optional(TrimmedNonEmptyString),
  detail: Schema.optional(TrimmedNonEmptyString),
  stale: Schema.optional(Schema.Boolean),
});
export type ServerProviderUsageSnapshot = typeof ServerProviderUsageSnapshot.Type;

export const ServerGetProviderUsageInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  provider: ProviderUsageDriver,
  forceRefresh: Schema.optional(Schema.Boolean),
});
export type ServerGetProviderUsageInput = typeof ServerGetProviderUsageInput.Type;
