import { resolveUsageLimitResetAt } from "@t3tools/client-runtime/state/usage-limit-recovery";
import type {
  EnvironmentId,
  ModelSelection,
  OrchestrationV2TurnItem,
  RunId,
  ServerProvider,
} from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import { AlarmClockIcon, ArrowRightLeftIcon } from "lucide-react";
import { useMemo } from "react";

import { serverEnvironment } from "~/state/server";
import { useEnvironmentQuery } from "~/state/query";
import { formatShortTimestamp } from "../../timestampFormat";
import type { HandoffTimelineRun } from "./V2LifecycleRow";
import { Button } from "../ui/button";

const USAGE_PROVIDERS = new Set(["codex", "claudeAgent", "cursor"]);

export function UsageLimitRecoveryActionsPresentation(props: {
  readonly resetAt: string | null;
  readonly timestampFormat: TimestampFormat;
  readonly disabled?: boolean;
  readonly waiting?: boolean;
  readonly canWaitUntilReset?: boolean;
  readonly onRecover: () => void;
  readonly onWaitUntilReset: () => void;
}) {
  const resetLabel = props.resetAt
    ? `Wait until ${formatShortTimestamp(props.resetAt, props.timestampFormat)}`
    : "Reset time unavailable";
  return (
    <div className="flex flex-wrap items-center gap-2" data-usage-limit-recovery="true">
      <Button size="xs" onClick={props.onRecover} disabled={props.disabled || props.waiting}>
        <ArrowRightLeftIcon />
        Try another model
      </Button>
      <Button
        size="xs"
        variant="outline"
        onClick={props.onWaitUntilReset}
        disabled={
          props.disabled ||
          props.waiting ||
          props.resetAt === null ||
          props.canWaitUntilReset === false
        }
        title={
          props.resetAt === null ? "The provider did not report when this limit resets." : undefined
        }
      >
        <AlarmClockIcon />
        {props.waiting ? "Working…" : resetLabel}
      </Button>
    </div>
  );
}

export function UsageLimitRecoveryActions(props: {
  readonly environmentId: EnvironmentId;
  readonly item: Extract<OrchestrationV2TurnItem, { readonly type: "error" }>;
  readonly providerStatuses: ReadonlyArray<ServerProvider>;
  readonly runs: ReadonlyArray<HandoffTimelineRun>;
  readonly timestampFormat: TimestampFormat;
  readonly disabled?: boolean;
  readonly waiting?: boolean;
  readonly canWaitUntilReset?: boolean;
  readonly onRecover: (input: {
    readonly runId: RunId;
    readonly sourceModelSelection: ModelSelection;
  }) => void;
  readonly onWaitUntilReset: (resetAt: string) => void;
}) {
  const run =
    props.item.runId === null
      ? undefined
      : props.runs.find((entry) => entry.id === props.item.runId);
  const provider =
    run === undefined
      ? undefined
      : props.providerStatuses.find((entry) => entry.instanceId === run.providerInstanceId);
  const usageTarget = useMemo(() => {
    if (!provider || !USAGE_PROVIDERS.has(provider.driver)) return null;
    return serverEnvironment.providerUsage({
      environmentId: props.environmentId,
      input: {
        instanceId: provider.instanceId,
        provider: provider.driver as "codex" | "claudeAgent" | "cursor",
      },
    });
  }, [props.environmentId, provider]);
  const usage = useEnvironmentQuery(usageTarget);
  const resetAt = resolveUsageLimitResetAt({
    failureMessage: props.item.failure.message,
    snapshot: usage.data,
    nowMs: Date.now(),
  });

  if (run === undefined) return null;
  return (
    <UsageLimitRecoveryActionsPresentation
      resetAt={resetAt}
      timestampFormat={props.timestampFormat}
      disabled={props.disabled === true}
      waiting={props.waiting === true}
      canWaitUntilReset={props.canWaitUntilReset !== false}
      onRecover={() => props.onRecover({ runId: run.id, sourceModelSelection: run.modelSelection })}
      onWaitUntilReset={() => {
        if (resetAt !== null) props.onWaitUntilReset(resetAt);
      }}
    />
  );
}
