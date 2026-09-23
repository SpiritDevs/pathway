import { newCommandId } from "../../lib/utils";
import {
  type EnvironmentId,
  type OrchestrationV2ThreadProjection,
  type ServerProvider,
  type ThreadId,
} from "@spiritdevs/contracts";
import {
  isUsageLimitFailure,
  resolveUsageLimitResetAt,
} from "@spiritdevs/shared/usageLimitRecovery";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@spiritdevs/client-runtime/state/runtime";
import * as DateTime from "effect/DateTime";
import { AlarmClockIcon } from "lucide-react";
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

export function useUsageRecovery(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly projection: OrchestrationV2ThreadProjection | null;
  readonly providerStatuses: ReadonlyArray<ServerProvider>;
  readonly supported: boolean;
}) {
  const key = `${input.environmentId}:${input.threadId}`;
  const [editor, setEditor] = useState<{ key: string; value: string } | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<{ key: string; message: string } | null>(null);
  const busy = busyKey === key;
  const nowMinute = useNowMinute();
  const schedule = useAtomCommand(serverEnvironment.scheduleUsageRecovery, {
    reportFailure: false,
  });
  const cancel = useAtomCommand(serverEnvironment.cancelUsageRecovery, { reportFailure: false });
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
    canSchedule
      ? serverEnvironment.providerUsageLive({
          environmentId: input.environmentId,
          input: {},
        })
      : null,
  );
  const failureText =
    failure?.type === "error" ? failure.failure.message : (childFailure?.result ?? "");
  const failureAt = failure?.updatedAt ?? childFailure?.updatedAt;
  const resetAt = resolveUsageLimitResetAt({
    failureMessage: failureText,
    ...(latest ? { model: latest.modelSelection.model } : {}),
    snapshot: usage.data?.find((entry) => entry.instanceId === provider?.instanceId) ?? null,
    nowMs: failureAt ? DateTime.toEpochMillis(failureAt) : Date.now(),
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
  const canResumeNow = canSchedule && resetPassed && !scheduled && !monitoring;
  const visibleError = error?.key === key ? error.message : query.error;
  const banner: ComposerBannerStackItem | null =
    input.supported && (canSchedule || scheduled || monitoring || failed || error?.key === key)
      ? {
          id: `usage-recovery:${key}`,
          presentation: "lip",
          urgent: scheduled || monitoring || failed,
          variant: failed || visibleError ? "error" : scheduled || monitoring ? "info" : "warning",
          icon: <AlarmClockIcon />,
          title: inherited
            ? "Included in the parent thread’s recovery"
            : scheduled
              ? `Resume thread + children ${new Date(recovery.resumeAt).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}`
              : monitoring
                ? `Resuming thread + children · attempt ${recovery.attempts} of 3`
                : failed
                  ? "Automatic recovery needs attention"
                  : canResumeNow
                    ? "Usage allowance reset"
                    : "Usage limit reached",
          description:
            visibleError ??
            (scheduled || monitoring || failed
              ? recovery?.message
              : canResumeNow
                ? "Resume this thread and its unfinished children now, with their context."
                : "Schedule this thread and its unfinished children to continue after reset."),
          actions: (
            <>
              {canResumeNow ? (
                <Button size="xs" disabled={busy} onClick={() => void resumeNow()}>
                  {busy ? "Resuming…" : "Resume now"}
                </Button>
              ) : (
                (scheduled || canSchedule) &&
                !monitoring &&
                !inherited && (
                  <Button size="xs" disabled={busy} onClick={() => open()}>
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
                  Cancel recovery
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
  return { banner, dialog, open, resumeNow, busy, canSchedule, canResumeNow, supportedProvider };
}
