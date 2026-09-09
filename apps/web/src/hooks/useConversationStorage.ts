import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { EnvironmentId, StorageJob, ThreadId } from "@spiritdevs/contracts";
import { squashAtomCommandFailure } from "@spiritdevs/client-runtime/state/runtime";
import { serverEnvironment } from "../state/server";
import { useEnvironmentQuery } from "../state/query";
import { useAtomCommand } from "../state/use-atom-command";
import { storageMeasurementIsFresh, storagePressure } from "../lib/storagePresentation";

export function useConversationStorage(input: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  enabled: boolean;
}) {
  const { environmentId, threadId, enabled } = input;
  const snapshot = useEnvironmentQuery(
    enabled ? serverEnvironment.storageSnapshot({ environmentId, input: {} }) : null,
  );
  const pressure = snapshot.error ? "unknown" : storagePressure(snapshot.data);
  const scope = `${environmentId}:${threadId}`;
  const [allowedScope, setAllowedScope] = useState<string | null>(null);
  const [error, setError] = useState<{ scope: string; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [startedJob, setStartedJob] = useState<{ scope: string; job: StorageJob } | null>(null);
  const inFlight = useRef(false);
  const worktreeIds = useMemo(() => {
    const criticalVolumes = new Set(
      snapshot.data?.volumes
        .filter(
          (volume) => volume.pressure === "critical" && storageMeasurementIsFresh(volume.sampledAt),
        )
        .map((volume) => volume.id),
    );
    return (
      snapshot.data?.worktrees
        .filter(
          (worktree) =>
            !worktree.removed &&
            worktree.kind === "worktree" &&
            worktree.volumeId !== null &&
            criticalVolumes.has(worktree.volumeId),
        )
        .map((worktree) => worktree.id) ?? []
    );
  }, [snapshot.data]);
  const preview = useEnvironmentQuery(
    enabled && pressure === "critical"
      ? serverEnvironment.storagePreview({
          environmentId,
          input: { worktreeIds, mode: "emergency" },
        })
      : null,
  );
  const start = useAtomCommand(serverEnvironment.storageStart, { reportFailure: false });
  const cancel = useAtomCommand(serverEnvironment.storageCancel, { reportFailure: false });
  const recreate = useAtomCommand(serverEnvironment.storageRecreate, { reportFailure: false });
  const job =
    startedJob?.scope === scope
      ? (snapshot.data?.jobs.find((candidate) => candidate.id === startedJob.job.id) ??
        startedJob.job)
      : null;
  const running = busy || job?.status === "running";
  const reclaimed =
    snapshot.data?.threads.find((thread) => thread.threadId === threadId)?.reclaimedAt != null;

  const canSend = !reclaimed && (pressure !== "critical" || allowedScope === scope);
  const checkCanSend = useCallback(
    (onBlocked: (reclaimed: boolean) => void) => {
      if (canSend) return true;
      onBlocked(reclaimed);
      return false;
    },
    [canSend, reclaimed],
  );

  useEffect(() => {
    if (pressure === "healthy" || pressure === "warning") setAllowedScope(null);
  }, [pressure]);
  useEffect(() => {
    if (!enabled) return;
    const timer = window.setInterval(snapshot.refresh, job?.status === "running" ? 2_000 : 30_000);
    return () => window.clearInterval(timer);
  }, [enabled, job?.status, snapshot.refresh]);

  const cleanup = useCallback(
    async (retryIds?: ReadonlyArray<string>) => {
      if (!enabled || inFlight.current || !preview.data || preview.isPending || preview.error)
        return;
      // The click authorizes exactly the eligible worktrees shown in this preview.
      // The environment rechecks them and stops once sufficient space is available.
      const boundedIds = preview.data.items
        .filter((item) => item.eligible && (!retryIds || retryIds.includes(item.worktreeId)))
        .map((item) => item.worktreeId);
      if (boundedIds.length === 0) return;
      inFlight.current = true;
      setBusy(true);
      setError(null);
      try {
        const result = await start({
          environmentId,
          input: { worktreeIds: boundedIds, mode: "emergency" },
        });
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        setStartedJob({ scope, job: result.value });
        snapshot.refresh();
        preview.refresh();
      } catch (cause) {
        setError({
          scope,
          message: cause instanceof Error ? cause.message : "Could not start storage cleanup.",
        });
      } finally {
        inFlight.current = false;
        setBusy(false);
      }
    },
    [enabled, environmentId, preview, scope, snapshot, start],
  );

  const recreateWorktree = useCallback(async () => {
    if (!enabled || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await recreate({ environmentId, input: { threadId } });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      snapshot.refresh();
    } catch (cause) {
      setError({
        scope,
        message: cause instanceof Error ? cause.message : "Could not recreate the worktree.",
      });
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }, [enabled, environmentId, recreate, snapshot, threadId, scope]);

  const cancelCleanup = useCallback(async () => {
    if (!enabled || !job || job.status !== "running") return;
    const result = await cancel({ environmentId, input: { jobId: job.id } });
    if (result._tag === "Failure") {
      const cause = squashAtomCommandFailure(result);
      setError({
        scope,
        message: cause instanceof Error ? cause.message : "Could not cancel storage cleanup.",
      });
    }
    snapshot.refresh();
  }, [cancel, enabled, environmentId, job, snapshot, scope]);

  return {
    pressure,
    preview,
    job,
    running,
    reclaimed,
    error: error?.scope === scope ? error.message : preview.error,
    allowed: allowedScope === scope,
    canSend,
    checkCanSend,
    allow: () => setAllowedScope(scope),
    cleanup,
    cancelCleanup,
    recreateWorktree,
    retryCleanup: () =>
      cleanup(
        job?.items.filter((item) => item.status === "failed").map((item) => item.worktreeId) ?? [],
      ),
    dismissResult: () => {
      setStartedJob(null);
      setError(null);
    },
    refresh: snapshot.refresh,
  };
}

export type ConversationStorage = ReturnType<typeof useConversationStorage>;
