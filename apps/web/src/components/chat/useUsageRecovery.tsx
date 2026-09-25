import { newCommandId } from "../../lib/utils";
import {
  type EnvironmentId,
  type OrchestrationV2ThreadProjection,
  type ServerProvider,
  type ThreadId,
} from "@spiritdevs/contracts";
import {
  findTightestUsageLimit,
  isUsageLimitFailure,
  LOW_USAGE_REMAINING_PERCENT,
  resolveUsageLimitResetAt,
} from "@spiritdevs/shared/usageLimitRecovery";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@spiritdevs/client-runtime/state/runtime";
import * as DateTime from "effect/DateTime";
import { AlarmClockIcon, GaugeIcon, PauseIcon } from "lucide-react";
import { useState } from "react";
import { useNowMinute } from "../../hooks/useNowMinute";
import { useAtomCommand } from "../../state/use-atom-command";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
} from "../ui/dialog";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

export function recoveryLocalInput(timestamp: number) {
  const date = new Date(Math.ceil(timestamp / 60_000) * 60_000);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Resets reported within this of a dismissed one belong to the same usage window. */
const LOW_USAGE_DISMISS_DRIFT_MS = 60 * 60_000;
const WORKING_RUN_STATUSES = new Set(["queued", "preparing", "starting", "running", "waiting"]);

const formatRecoveryTime = (at: string | number) =>
  new Date(at).toLocaleString([], { dateStyle: "short", timeStyle: "short" });

/** The usage menu's thread action. A disabled action explains why in `disabledReason`. */
export interface UsageThreadAction {
  readonly label: string;
  readonly disabledReason: string | null;
  readonly onSelect: () => void;
}

export function useUsageRecovery(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly projection: OrchestrationV2ThreadProjection | null;
  readonly providerStatuses: ReadonlyArray<ServerProvider>;
  readonly supported: boolean;
  /** The environment can pause running work until the allowance resets. */
  readonly pauseSupported: boolean;
}) {
  const key = `${input.environmentId}:${input.threadId}`;
  const [editor, setEditor] = useState<{ key: string; value: string } | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<{ key: string; message: string } | null>(null);
  // Window key -> the reset that was showing when the warning was dismissed.
  const [dismissedLowUsage, setDismissedLowUsage] = useState<ReadonlyMap<string, number>>(
    new Map(),
  );
  const busy = busyKey === key;
  const nowMinute = useNowMinute();
  const schedule = useAtomCommand(serverEnvironment.scheduleUsageRecovery, {
    reportFailure: false,
  });
  const cancel = useAtomCommand(serverEnvironment.cancelUsageRecovery, { reportFailure: false });
  const pause = useAtomCommand(serverEnvironment.pauseUsageRecovery, { reportFailure: false });
  const query = useEnvironmentQuery(
    input.supported
      ? serverEnvironment.usageRecoveryLive({
          environmentId: input.environmentId,
          input: { threadId: input.threadId },
        })
      : null,
  );
  const recovery = query.data?.recovery ?? null;
  const inherited = recovery !== null && recovery.threadId !== input.threadId;
  const latest = input.projection?.runs.toSorted((a, b) => b.ordinal - a.ordinal)[0];
  const provider = input.providerStatuses.find(
    (entry) => entry.instanceId === latest?.providerInstanceId,
  );
  const supportedProvider = provider?.driver === "claudeAgent" || provider?.driver === "codex";
  const failure = input.projection?.turnItems.findLast(
    (item) =>
      item.type === "error" && item.runId === latest?.id && isUsageLimitFailure(item.failure),
  );
  const childFailure = input.projection?.subagents.find(
    (task) =>
      task.status === "failed" &&
      isUsageLimitFailure({
        class: "provider_error",
        code: null,
        message: task.result ?? "",
        retryable: null,
      }) &&
      latest !== undefined &&
      (task.runId === latest.id ||
        DateTime.toEpochMillis(task.updatedAt) >= DateTime.toEpochMillis(latest.requestedAt)),
  );
  const canSchedule =
    input.supported &&
    !inherited &&
    supportedProvider &&
    latest !== undefined &&
    (latest.status === "failed" || latest.status === "completed") &&
    query.data?.eligibility != null;
  const usage = useEnvironmentQuery(
    input.supported && supportedProvider
      ? serverEnvironment.providerUsageLive({
          environmentId: input.environmentId,
          input: {},
        })
      : null,
  );
  const failureText =
    failure?.type === "error" ? failure.failure.message : (childFailure?.result ?? "");
  const failureAt = failure?.updatedAt ?? childFailure?.updatedAt;
  const usageSnapshot =
    usage.data?.find((entry) => entry.instanceId === provider?.instanceId) ?? null;
  const resetAt = resolveUsageLimitResetAt({
    failureMessage: failureText,
    ...(latest ? { model: latest.modelSelection.model } : {}),
    snapshot: usageSnapshot,
    nowMs: failureAt ? DateTime.toEpochMillis(failureAt) : Date.now(),
  });
  const tightest = findTightestUsageLimit({
    ...(latest ? { model: latest.modelSelection.model } : {}),
    snapshot: usageSnapshot,
    nowMs: Date.parse(`${nowMinute}:00Z`),
  });
  const reportedReset = query.data?.eligibility?.resetAt ?? resetAt;
  // Minute-quantized so the banner flips on the shared clock tick once the reset passes.
  const resetPassed =
    reportedReset != null && Date.parse(reportedReset) <= Date.parse(`${nowMinute}:00Z`);
  const open = (suggestedReset?: string) => {
    const defaultAt =
      recovery?.status === "scheduled"
        ? Date.parse(recovery.resumeAt)
        : query.data?.eligibility?.suggestedResumeAt
          ? Date.parse(query.data.eligibility.suggestedResumeAt)
          : suggestedReset || resetAt
            ? Date.parse(suggestedReset ?? resetAt!) + 60_000
            : Date.now() + 60_000;
    setError(null);
    setEditor({ key, value: recoveryLocalInput(Math.max(defaultAt, Date.now() + 60_000)) });
  };
  const report = (cause: unknown) =>
    setError({ key, message: cause instanceof Error ? cause.message : String(cause) });
  const scheduleAt = async (resumeMs: number) => {
    if (busy || !latest) return;
    setBusyKey(key);
    setError(null);
    try {
      const result = await schedule({
        environmentId: input.environmentId,
        input: {
          commandId: newCommandId(),
          threadId: input.threadId,
          sourceRunId: latest.id,
          resumeAt: new Date(resumeMs).toISOString(),
        },
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) report(squashAtomCommandFailure(result));
      } else setEditor(null);
    } finally {
      setBusyKey(null);
    }
  };
  const submit = () => {
    if (editor?.key !== key) return;
    const resumeMs = Date.parse(editor.value);
    if (!Number.isFinite(resumeMs) || resumeMs <= Date.now()) {
      report("Choose a future recovery time.");
      return;
    }
    return scheduleAt(resumeMs);
  };
  /** The server starts a recovery whose time has already passed on its next tick. */
  const resumeNow = () => scheduleAt(Date.now());
  const cancelTimer = async () => {
    if (busy) return;
    setBusyKey(key);
    setError(null);
    try {
      const result = await cancel({
        environmentId: input.environmentId,
        input: { threadId: input.threadId },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result))
        report(squashAtomCommandFailure(result));
    } finally {
      setBusyKey(null);
    }
  };
  const scheduled = recovery?.status === "scheduled";
  const monitoring = recovery?.status === "monitoring";
  const failed = recovery?.status === "failed";
  const paused = recovery?.reason === "pause" && !inherited;
  // A pause still waiting for its run to reach the next step boundary.
  const pausing = paused && scheduled && !recovery.pausedAt;
  const canResumeNow = canSchedule && resetPassed && !scheduled && !monitoring;
  const visibleError = error?.key === key ? error.message : query.error;
  const working = latest !== undefined && WORKING_RUN_STATUSES.has(latest.status);
  const pauseResumeAt = tightest ? Date.parse(tightest.resetsAt) + 60_000 : null;
  const pauseUnavailableReason = !input.pauseSupported
    ? "Update this environment to pause until reset."
    : inherited || scheduled || monitoring
      ? "A recovery timer is already set for this thread."
      : !working
        ? "Available while the agent is working."
        : latest.status === "queued"
          ? "Send or remove queued messages before pausing."
          : pauseResumeAt === null
            ? "The provider has not reported when usage resets."
            : null;
  const pauseUntilReset = async () => {
    if (busy || pauseResumeAt === null) return;
    setBusyKey(key);
    setError(null);
    try {
      const result = await pause({
        environmentId: input.environmentId,
        input: {
          commandId: newCommandId(),
          threadId: input.threadId,
          resumeAt: new Date(pauseResumeAt).toISOString(),
        },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result))
        report(squashAtomCommandFailure(result));
    } finally {
      setBusyKey(null);
    }
  };
  const menuAction: UsageThreadAction | null =
    !input.supported || !supportedProvider
      ? null
      : pausing
        ? { label: "Cancel pause", disabledReason: null, onSelect: () => void cancelTimer() }
        : paused && scheduled
          ? { label: "Resume now", disabledReason: null, onSelect: () => void resumeNow() }
          : {
              label: "Pause until reset",
              disabledReason: pauseUnavailableReason,
              onSelect: () => void pauseUntilReset(),
            };
  const lowUsageKey = tightest
    ? `${key}:${tightest.limit.window}:${tightest.limit.scope ?? ""}`
    : null;
  const dismissedResetAt = lowUsageKey === null ? undefined : dismissedLowUsage.get(lowUsageKey);
  // Relative resets ("resets in N seconds") drift on every refresh; only a later window re-warns.
  const lowUsageDismissed =
    dismissedResetAt !== undefined &&
    tightest !== null &&
    Date.parse(tightest.resetsAt) < dismissedResetAt + LOW_USAGE_DISMISS_DRIFT_MS;
  const lowUsageBanner: ComposerBannerStackItem | null =
    input.supported &&
    tightest !== null &&
    lowUsageKey !== null &&
    tightest.remainingPercent < LOW_USAGE_REMAINING_PERCENT &&
    !lowUsageDismissed &&
    !canSchedule &&
    !scheduled &&
    !monitoring
      ? {
          id: `usage-low:${lowUsageKey}`,
          presentation: "lip",
          variant: "warning",
          icon: <GaugeIcon />,
          title: `Usage almost used up · ${tightest.remainingPercent < 1 ? "<1" : Math.floor(tightest.remainingPercent)}% left`,
          description:
            visibleError ??
            `${tightest.limit.scope ? `${tightest.limit.window} · ${tightest.limit.scope}` : tightest.limit.window} resets ${formatRecoveryTime(tightest.resetsAt)}.${working && pauseUnavailableReason === null ? " Pause to stop after the current step and continue after the reset." : ""}`,
          actions:
            working && pauseUnavailableReason === null ? (
              <Button size="xs" disabled={busy} onClick={() => void pauseUntilReset()}>
                {busy ? "Pausing…" : "Pause until reset"}
              </Button>
            ) : undefined,
          dismissLabel: "Dismiss usage warning",
          onDismiss: () =>
            setDismissedLowUsage((dismissed) =>
              new Map(dismissed).set(lowUsageKey, Date.parse(tightest.resetsAt)),
            ),
        }
      : null;
  const banner: ComposerBannerStackItem | null =
    input.supported && (canSchedule || scheduled || monitoring || failed || error?.key === key)
      ? {
          id: `usage-recovery:${key}`,
          presentation: "lip",
          urgent: scheduled || monitoring || failed,
          variant: failed || visibleError ? "error" : scheduled || monitoring ? "info" : "warning",
          icon: paused ? <PauseIcon /> : <AlarmClockIcon />,
          // Up to three actions; stacking them keeps the status readable on phone widths.
          actionClassName: "max-sm:flex-col max-sm:items-stretch",
          title: inherited
            ? "Included in the parent thread’s recovery"
            : pausing
              ? "Pausing after the current step"
              : paused && scheduled
                ? `Paused until ${formatRecoveryTime(recovery.resumeAt)}`
                : scheduled
                  ? `Resume thread + children ${formatRecoveryTime(recovery.resumeAt)}`
                  : monitoring
                    ? `${paused ? "Resuming paused work" : "Resuming thread + children"} · attempt ${recovery.attempts} of 3`
                    : failed
                      ? "Automatic recovery needs attention"
                      : canResumeNow
                        ? "Usage allowance reset"
                        : "Usage limit reached",
          description:
            visibleError ??
            (pausing
              ? `Then it continues ${formatRecoveryTime(recovery.resumeAt)}, after the allowance resets.`
              : scheduled || monitoring || failed
                ? recovery?.message
                : canResumeNow
                  ? "Resume this thread and its unfinished children now, with their context."
                  : "Schedule this thread and its unfinished children to continue after reset."),
          actions: (
            <>
              {paused && scheduled && !pausing && (
                <Button size="xs" disabled={busy} onClick={() => void resumeNow()}>
                  {busy ? "Resuming…" : "Resume now"}
                </Button>
              )}
              {canResumeNow ? (
                <Button size="xs" disabled={busy} onClick={() => void resumeNow()}>
                  {busy ? "Resuming…" : "Resume now"}
                </Button>
              ) : (
                (scheduled || canSchedule) &&
                !monitoring &&
                !inherited && (
                  <Button
                    size="xs"
                    // Resume now is the primary action once the pause has taken effect.
                    variant={paused && !pausing ? "outline" : "default"}
                    disabled={busy}
                    onClick={() => open()}
                  >
                    {scheduled ? "Change time" : "Resume after reset"}
                  </Button>
                )
              )}
              {(scheduled || monitoring) && !inherited && (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void cancelTimer()}
                >
                  {paused ? "Cancel pause" : "Cancel recovery"}
                </Button>
              )}
            </>
          ),
        }
      : null;
  const dialog = (
    <Dialog
      open={editor?.key === key}
      onOpenChange={(isOpen) => {
        if (!isOpen && !busy) setEditor(null);
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Resume thread and children</DialogTitle>
          <DialogDescription>
            Continue after your allowance resets, with up to three recovery attempts. Completed work
            is preserved.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <label className="flex flex-col gap-2 text-sm">
            Resume at
            <Input
              type="datetime-local"
              value={editor?.key === key ? editor.value : ""}
              onChange={(event) => setEditor({ key, value: event.target.value })}
              disabled={busy}
            />
          </label>
          <p className="mt-2 text-xs text-muted-foreground">
            {Intl.DateTimeFormat().resolvedOptions().timeZone}. When a reset time is available, the
            suggestion includes a one-minute margin. Otherwise, choose the reset time yourself. Your
            environment must be running; if it is offline, recovery starts when it returns.
          </p>
          {visibleError && (
            <p className="mt-2 text-sm text-destructive" role="alert">
              {visibleError}
            </p>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => setEditor(null)}>
            Close
          </Button>
          <Button disabled={busy || !latest} onClick={() => void submit()}>
            {busy ? "Scheduling…" : "Schedule recovery"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
  return {
    banner,
    lowUsageBanner,
    menuAction,
    dialog,
    open,
    resumeNow,
    busy,
    canSchedule,
    canResumeNow,
    supportedProvider,
  };
}
