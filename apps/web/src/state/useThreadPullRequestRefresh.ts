import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentThreadShell } from "@spiritdevs/client-runtime/state/shell";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { pullRequestEnvironment } from "./pullRequests";
import { useAtomCommand } from "./use-atom-command";
import { vcsActionManager } from "./vcs";
import type { useAttachedPullRequest } from "./threadPullRequest";

export function useThreadPullRequestRefresh(
  thread: EnvironmentThreadShell,
  query: ReturnType<typeof useAttachedPullRequest>,
) {
  const refreshDetail = useAtomCommand(pullRequestEnvironment.refreshDetail, {
    reportFailure: false,
  });
  const key = query.target ? JSON.stringify(query.target) : null;
  const target = useMemo(
    () => (key === null ? null : (JSON.parse(key) as NonNullable<typeof query.target>)),
    [key],
  );
  const [refreshState, setRefreshState] = useState({
    key,
    pending: false,
    error: null as string | null,
  });
  const connected = query.isConnected;
  const refresh = useCallback(async () => {
    if (!target) return;
    if (!connected) {
      setRefreshState({ key, pending: false, error: "The environment is disconnected." });
      return;
    }
    setRefreshState({ key, pending: true, error: null });
    const result = await refreshDetail(target);
    setRefreshState((current) =>
      current.key !== key
        ? current
        : {
            key,
            pending: false,
            error: result._tag === "Failure" ? "Couldn’t refresh pull request status." : null,
          },
    );
  }, [connected, key, target, refreshDetail]);
  const latest = useRef({ refresh, pending: query.isPending, hasData: query.data !== null });
  latest.current = { refresh, pending: query.isPending, hasData: query.data !== null };

  // Returning to the thread/window is a freshness boundary. Initial uncached reads already run.
  useEffect(() => {
    if (!key) return;
    let lastArrival = 0;
    const arrived = () => {
      if (document.visibilityState !== "visible" || Date.now() - lastArrival < 10_000) return;
      lastArrival = Date.now();
      void latest.current.refresh();
    };
    if (latest.current.hasData && !latest.current.pending) arrived();
    window.addEventListener("focus", arrived);
    document.addEventListener("visibilitychange", arrived);
    return () => {
      window.removeEventListener("focus", arrived);
      document.removeEventListener("visibilitychange", arrived);
    };
  }, [key, connected]);

  const action = useAtomValue(
    vcsActionManager.stateAtom({
      environmentId: thread.environmentId,
      cwd: thread.worktreePath ?? query.project?.workspaceRoot ?? null,
    }),
  );
  const completedAt = thread.latestRun?.completedAt ?? null;
  const pushing =
    action.isRunning &&
    action.action !== null &&
    ["push", "commit_push", "commit_push_pr", "create_pr"].includes(action.action);
  const previous = useRef({ key, completedAt, pushing });
  useEffect(() => {
    const last = previous.current;
    previous.current = { key, completedAt, pushing };
    if (last.key !== key) return;
    if (
      (completedAt !== null && completedAt !== last.completedAt) ||
      (last.pushing && !pushing && !action.error)
    )
      void refresh();
  }, [key, completedAt, pushing, action.error, refresh]);

  useEffect(() => {
    if (query.data && !query.error && !query.isPending)
      setRefreshState((current) =>
        current.key === key && current.error ? { ...current, error: null } : current,
      );
  }, [key, query.data, query.error, query.isPending]);

  const state = refreshState.key === key ? refreshState : null;
  return {
    ...query,
    isPending: query.isPending || state?.pending === true,
    error: connected === false ? "The environment is disconnected." : (state?.error ?? query.error),
    refresh: () => {
      void refresh();
    },
  };
}
