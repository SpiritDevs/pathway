import { RegistryContext } from "@effect/atom-react";
import { scopeThreadRef, scopedThreadKey } from "@spiritdevs/client-runtime/environment";
import type { EnvironmentThreadShell } from "@spiritdevs/client-runtime/state/models";
import type { EnvironmentProject } from "@spiritdevs/client-runtime/state/shell";
import { executeAtomQuery, runAtomCommand } from "@spiritdevs/client-runtime/state/runtime";
import { threadPullRequestAttachments } from "@spiritdevs/shared/sourceControl";
import { useContext, useEffect, useRef } from "react";
import { resolveThreadPr } from "../components/ThreadStatusIndicators";
import { pullRequestEnvironment } from "./pullRequests";
import { vcsEnvironment } from "./vcs";
import {
  aggregateThreadPullRequestState,
  attachedPullRequestQueryTarget,
  sameAttachedPullRequest,
  threadChangeRequestSource,
  type ThreadChangeRequestState,
} from "./threadPullRequest";

const quiet = { reportFailure: false, reportDefect: false };

// Revisit retained, collapsed history once per navigation, with at most four host reads at once.
// No row components, ongoing VCS subscriptions, or polling timers are needed for this pass.
export function useSidebarPrRevalidation(
  scope: string,
  threads: ReadonlyArray<EnvironmentThreadShell>,
  projects: ReadonlyArray<EnvironmentProject>,
  onResult: (key: string, value: ThreadChangeRequestState, failed?: boolean) => void,
) {
  const registry = useContext(RegistryContext);
  const latest = useRef({ threads, projects, onResult });
  latest.current = { threads, projects, onResult };
  const pass = useRef({ scope, active: true, running: 0, seen: new Set<string>() });
  useEffect(() => {
    const current = { scope, active: true, running: 0, seen: new Set<string>() };
    pass.current = current;
    return () => {
      current.active = false;
    };
  }, [scope]);
  useEffect(() => {
    const current = pass.current;
    const drain = () => {
      if (!current.active) return;
      for (const thread of latest.current.threads) {
        if (current.running >= 4) break;
        const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
        const source = threadChangeRequestSource(thread);
        const token = JSON.stringify([key, source]);
        if (current.seen.has(token)) continue;
        current.seen.add(token);
        current.running++;
        void (async () => {
          const states: ThreadChangeRequestState["state"][] = [];
          let failed = false;
          const project = latest.current.projects.find(
            (candidate) =>
              candidate.environmentId === thread.environmentId && candidate.id === thread.projectId,
          );
          const cwd = thread.worktreePath ?? project?.workspaceRoot;
          if (thread.branch && cwd) {
            const result = await runAtomCommand(
              registry,
              vcsEnvironment.refreshStatus,
              {
                environmentId: thread.environmentId,
                input: { cwd },
              },
              quiet,
            );
            failed ||= result._tag === "Failure";
            const pr =
              result._tag === "Success"
                ? resolveThreadPr({ threadBranch: thread.branch, gitStatus: result.value })
                : null;
            if (pr && !thread.detachedPullRequestUrls?.includes(pr.url)) states.push(pr.state);
          }
          for (const attachment of threadPullRequestAttachments(thread)) {
            const target = attachedPullRequestQueryTarget(
              { ...thread, attachedPullRequest: attachment },
              latest.current.projects,
            );
            if (!target) {
              failed = true;
              continue;
            }
            const invalidated = await runAtomCommand(
              registry,
              pullRequestEnvironment.invalidate,
              {
                environmentId: target.environmentId,
                input: { reference: target.input },
              },
              quiet,
            );
            if (invalidated._tag === "Failure") {
              failed = true;
              continue;
            }
            const result = await executeAtomQuery(registry, pullRequestEnvironment.detail(target), {
              ...quiet,
              refresh: true,
            });
            if (result._tag === "Success" && sameAttachedPullRequest(attachment, result.value))
              states.push(result.value.state);
            else failed = true;
          }
          if (current.active)
            latest.current.onResult(
              key,
              {
                source,
                state: aggregateThreadPullRequestState(states),
              },
              failed,
            );
        })()
          .catch(() => {
            if (current.active) latest.current.onResult(key, { source, state: null }, true);
          })
          .finally(() => {
            current.running--;
            drain();
          });
      }
    };
    drain();
  }, [scope, threads, projects, registry]);
}
