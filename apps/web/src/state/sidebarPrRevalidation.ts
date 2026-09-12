import { RegistryContext } from "@effect/atom-react";
import { scopeThreadRef, scopedThreadKey } from "@spiritdevs/client-runtime/environment";
import type { EnvironmentThreadShell } from "@spiritdevs/client-runtime/state/models";
import type { EnvironmentProject } from "@spiritdevs/client-runtime/state/shell";
import { executeAtomQuery, runAtomCommand } from "@spiritdevs/client-runtime/state/runtime";
import { threadPullRequestAttachments } from "@spiritdevs/shared/sourceControl";
import { useContext, useEffect, useRef, type ContextType } from "react";
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
const HISTORY_FRESHNESS_MS = 5 * 60_000;

interface RevalidationInput {
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly retainedStates: ReadonlyMap<string, ThreadChangeRequestState>;
  readonly onResult: (key: string, value: ThreadChangeRequestState, failed?: boolean) => void;
}

// Share both concurrent and completed reads during a pass; failed reads remain retryable.
function shareSuccessfulReads<Input, Result extends { readonly _tag: string }>(
  read: (input: Input) => Promise<Result>,
) {
  const reads = new Map<string, { expiresAt: number; promise: Promise<Result> }>();
  return (input: Input): Promise<Result> => {
    const key = JSON.stringify(input);
    const previous = reads.get(key);
    if (previous && previous.expiresAt > Date.now()) return previous.promise;
    const entry = {
      expiresAt: Infinity,
      promise: read(input).then(
        (result) => {
          if (result._tag === "Success") entry.expiresAt = Date.now() + HISTORY_FRESHNESS_MS;
          else reads.delete(key);
          return result;
        },
        (error: unknown) => {
          reads.delete(key);
          throw error;
        },
      ),
    };
    reads.set(key, entry);
    return entry.promise;
  };
}

// Owns one mounted sidebar's finite work. update also handles disconnect/reconnect while reads
// are in flight; attempts are retained only while their source remains eligible.
export function createSidebarPrRevalidation(registry: ContextType<typeof RegistryContext>) {
  let active = true;
  let latest: RevalidationInput;
  type Candidate = {
    thread: EnvironmentThreadShell;
    key: string;
    source: string;
    cwd: string | null | undefined;
  };
  let eligible = new Map<string, Candidate>();
  let pending = new Map<string, Candidate>();
  const attempted = new Set<string>();
  const inFlight = new Set<string>();
  const workers = new Set<Promise<void>>();
  const refreshStatus = shareSuccessfulReads(
    (input: { environmentId: EnvironmentThreadShell["environmentId"]; input: { cwd: string } }) =>
      runAtomCommand(registry, vcsEnvironment.refreshStatus, input, quiet),
  );
  const refreshAttachment = shareSuccessfulReads(
    async (target: NonNullable<ReturnType<typeof attachedPullRequestQueryTarget>>) => {
      const invalidated = await runAtomCommand(
        registry,
        pullRequestEnvironment.invalidate,
        {
          environmentId: target.environmentId,
          input: { reference: target.input },
        },
        quiet,
      );
      if (invalidated._tag === "Failure") return invalidated;
      return executeAtomQuery(registry, pullRequestEnvironment.detail(target), {
        ...quiet,
        refresh: true,
      });
    },
  );

  const work = async () => {
    while (true) {
      if (!active) return;
      let next: [string, Candidate] | undefined;
      for (const entry of pending) {
        if (!inFlight.has(entry[0])) {
          next = entry;
          break;
        }
      }
      if (!next) return;
      const [token, { thread, key, source, cwd }] = next;
      pending.delete(token);
      attempted.add(token);
      inFlight.add(token);
      const projects = latest.projects;
      const states: ThreadChangeRequestState["state"][] = [];
      let failed = Boolean(thread.branch && !cwd);
      try {
        if (thread.branch && cwd) {
          const result = await refreshStatus({
            environmentId: thread.environmentId,
            input: { cwd },
          });
          failed ||= result._tag === "Failure";
          const pr =
            result._tag === "Success"
              ? resolveThreadPr({ threadBranch: thread.branch, gitStatus: result.value })
              : null;
          if (pr && !thread.detachedPullRequestUrls?.includes(pr.url)) states.push(pr.state);
        }
        for (const attachment of threadPullRequestAttachments(thread)) {
          if (!active) break;
          const target = attachedPullRequestQueryTarget(
            { ...thread, attachedPullRequest: attachment },
            projects,
          );
          if (!target) {
            failed = true;
            continue;
          }
          const result = await refreshAttachment(target);
          if (result._tag === "Success" && sameAttachedPullRequest(attachment, result.value))
            states.push(result.value.state);
          else failed = true;
        }
      } catch {
        failed = true;
      } finally {
        inFlight.delete(token);
      }
      if (active && eligible.has(token))
        latest.onResult(
          key,
          {
            source,
            state: aggregateThreadPullRequestState(states),
            ...(failed ? {} : { checkedAt: Date.now() }),
          },
          failed,
        );
    }
  };

  return {
    update(input: RevalidationInput): Promise<void> {
      if (!active) return Promise.resolve();
      latest = input;
      eligible = new Map(
        input.threads.map((thread) => {
          const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
          const source = threadChangeRequestSource(thread);
          const project = input.projects.find(
            (candidate) =>
              candidate.environmentId === thread.environmentId && candidate.id === thread.projectId,
          );
          const cwd = thread.worktreePath ?? project?.workspaceRoot;
          return [JSON.stringify([key, source, cwd]), { thread, key, source, cwd }];
        }),
      );
      for (const token of attempted) if (!eligible.has(token)) attempted.delete(token);
      pending = new Map(
        [...eligible].filter(([token, { key, source }]) => {
          if (attempted.has(token)) return false;
          const retained = input.retainedStates.get(key);
          return (
            retained?.source === source &&
            (retained.checkedAt === undefined ||
              Date.now() - retained.checkedAt >= HISTORY_FRESHNESS_MS)
          );
        }),
      );
      for (let count = workers.size; count < 4 && pending.size > 0; count++) {
        const worker = work();
        workers.add(worker);
        void worker.finally(() => workers.delete(worker));
      }
      return Promise.all(workers).then(() => undefined);
    },
    stop() {
      active = false;
      pending.clear();
    },
  };
}

// Retain classification during finite background checks, without hidden rows or polling timers.
export function useSidebarPrRevalidation(
  scope: string,
  threads: RevalidationInput["threads"],
  projects: RevalidationInput["projects"],
  retainedStates: RevalidationInput["retainedStates"],
  onResult: RevalidationInput["onResult"],
) {
  const registry = useContext(RegistryContext);
  const pass = useRef<ReturnType<typeof createSidebarPrRevalidation> | null>(null);
  useEffect(() => {
    const current = createSidebarPrRevalidation(registry);
    pass.current = current;
    return () => current.stop();
  }, [scope, registry]);
  useEffect(() => {
    void pass.current?.update({ threads, projects, retainedStates, onResult });
  }, [scope, threads, projects, retainedStates, onResult, registry]);
}
