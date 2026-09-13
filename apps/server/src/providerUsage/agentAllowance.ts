import type { ServerProvider, ServerProviderUsageSnapshot } from "@spiritdevs/contracts";
import { OrchestratorMcpFailure } from "@spiritdevs/contracts";
import type {
  AllocateAgentAllowanceInput,
  ProviderAllowanceInput,
  ProviderAllowanceReport,
} from "@spiritdevs/contracts/providerAllowance";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as Option from "effect/Option";
import { ALLOWANCE_MAX_READING_AGE_MS } from "@spiritdevs/contracts/providerAllowanceBudget";
import { McpInvocationContext } from "../mcp/McpInvocationContext.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { getProviderUsage } from "./ProviderUsageService.ts";
import { ProviderAllowanceRuntime } from "./AllowanceRuntime.ts";

export const ALLOWANCE_INTERPRETATION =
  "Allowance is account-wide provider quota, not this task's token usage. A budget of ten percentage points against a full window would move 60% remaining to 50%. Unrelated activity on the account also consumes allowance. Reporting can be delayed; inspect per-window freshness. A quota reset does not authorize more work. This read tool does not set or enforce a budget.";

/** Keep unknown identity and window freshness visible instead of substituting token counts. */
export function allowanceReport(
  provider: Pick<ServerProvider, "instanceId" | "driver">,
  snapshot: ServerProviderUsageSnapshot | null,
  now: number,
): ProviderAllowanceReport {
  if (!snapshot)
    return {
      instanceId: provider.instanceId,
      provider: provider.driver,
      status: "unsupported",
      freshness: "unsupported",
      snapshot: null,
      detail: "This provider does not expose supported account allowance telemetry.",
    };
  const timestamps = [snapshot.fetchedAt, ...snapshot.limits.map((limit) => limit.fetchedAt)];
  const unknown =
    !snapshot.limits.length ||
    timestamps.some(
      (at) => !at || !Number.isFinite(Date.parse(at)) || Date.parse(at) > now + 5_000,
    );
  const stale =
    snapshot.stale === true ||
    timestamps.some((at) => at && now - Date.parse(at) >= ALLOWANCE_MAX_READING_AGE_MS);
  const freshness = snapshot.status !== "ok" || unknown ? "unknown" : stale ? "stale" : "fresh";
  return {
    instanceId: provider.instanceId,
    provider: provider.driver,
    status: snapshot.status,
    freshness,
    snapshot: { ...snapshot, stale: stale || unknown },
    detail: [
      snapshot.detail,
      freshness === "fresh"
        ? "The account and every reported quota window have fresh readings."
        : freshness === "stale"
          ? "Allowance readings are stale; refresh before dispatch admission."
          : "Allowance freshness is unknown; do not assume capacity is available.",
      !snapshot.accountKey ? "No stable cross-environment account identity is available." : "",
      snapshot.limits.some(
        (limit) =>
          !limit.fetchedAt || now - Date.parse(limit.fetchedAt) >= ALLOWANCE_MAX_READING_AGE_MS,
      )
        ? "Some quota windows have stale or unknown freshness."
        : "",
    ]
      .filter(Boolean)
      .join(" "),
  };
}

export const readAgentAllowance = Effect.fn("providerUsage.agentAllowance")(function* (
  input: ProviderAllowanceInput,
) {
  const scope = yield* McpInvocationContext;
  if (!scope.capabilities.has("orchestration"))
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "This thread cannot inspect provider allowance.",
    });
  if (input.allInstances && input.instanceId)
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message: "Choose one provider instance or all instances.",
    });
  const providers = yield* (yield* ProviderRegistry).getProviders;
  const selected = providers.filter(
    (provider) =>
      input.allInstances || provider.instanceId === (input.instanceId ?? scope.providerInstanceId),
  );
  if (!selected.length)
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message: "The selected provider instance is not configured in this environment.",
    });
  const accounts = yield* Effect.forEach(
    selected,
    Effect.fn("providerUsage.agentAccount")(function* (provider) {
      if (
        provider.driver !== "codex" &&
        provider.driver !== "claudeAgent" &&
        provider.driver !== "cursor"
      )
        return allowanceReport(provider, null, yield* Clock.currentTimeMillis);
      const snapshot = yield* getProviderUsage({
        instanceId: provider.instanceId,
        provider:
          provider.driver === "codex"
            ? "codex"
            : provider.driver === "cursor"
              ? "cursor"
              : "claudeAgent",
        forceRefresh: input.forceRefresh,
      }).pipe(
        Effect.mapError(
          () =>
            new OrchestratorMcpFailure({
              code: "orchestration_error",
              message:
                "Provider allowance could not be loaded. Do not assume capacity is available.",
            }),
        ),
      );
      return allowanceReport(provider, snapshot, yield* Clock.currentTimeMillis);
    }),
    { concurrency: 3 },
  );
  const runtime = yield* Effect.serviceOption(ProviderAllowanceRuntime);
  const state = Option.isSome(runtime)
    ? yield* runtime.value.checkThread(
        scope.threadId,
        scope.providerInstanceId,
        scope.providerDriverKind,
      )
    : null;
  return {
    accounts,
    interpretation: ALLOWANCE_INTERPRETATION,
    ...(state
      ? {
          budgets: state.budgets,
          admission: {
            canStart: state.canStart,
            shouldInterrupt: state.shouldInterrupt,
            detail: state.detail,
          },
        }
      : {}),
  };
});

export const allocateAgentAllowance = Effect.fn("providerUsage.allocateAgentAllowance")(function* (
  input: AllocateAgentAllowanceInput,
) {
  const scope = yield* McpInvocationContext;
  if (!scope.capabilities.has("orchestration"))
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "This thread cannot allocate provider allowance.",
    });
  const provider = (yield* (yield* ProviderRegistry).getProviders).find(
    (provider) => provider.instanceId === (input.instanceId ?? scope.providerInstanceId),
  );
  if (!provider)
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message: "The selected provider is not configured.",
    });
  return yield* (yield* ProviderAllowanceRuntime)
    .allocateThread(scope.threadId, provider.instanceId, provider.driver, input)
    .pipe(
      Effect.mapError(
        (error) => new OrchestratorMcpFailure({ code: "invalid_request", message: error.message }),
      ),
    );
});
