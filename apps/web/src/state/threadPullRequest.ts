import type {
  EnvironmentId,
  OrchestrationV2PullRequestAttachment,
  ProjectId,
  PullRequestRef,
} from "@spiritdevs/contracts";
import { Atom } from "effect/unstable/reactivity";
import { parseChangeRequestUrl } from "../lib/openPullRequestLink";
import { pullRequestEnvironment } from "./pullRequests";
import { useEnvironmentQuery } from "./query";
import { useEnvironment } from "./environments";

export interface ThreadPullRequestTarget {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId | null;
  readonly attachedPullRequest: OrchestrationV2PullRequestAttachment | null | undefined;
}

export function attachedPullRequestQueryTarget(thread: ThreadPullRequestTarget | null) {
  const attachment = thread?.attachedPullRequest;
  const link = attachment ? parseChangeRequestUrl(attachment.url) : null;
  if (!thread?.projectId || !link || link.number !== attachment?.number) return null;
  return {
    environmentId: thread.environmentId,
    input: { projectId: thread.projectId, repository: link.repository, number: link.number },
  };
}

export function sameAttachedPullRequest(
  attachment: OrchestrationV2PullRequestAttachment,
  result: OrchestrationV2PullRequestAttachment,
): boolean {
  const expected = parseChangeRequestUrl(attachment.url);
  const actual = parseChangeRequestUrl(result.url);
  return Boolean(
    expected &&
    actual &&
    expected.host === actual.host &&
    expected.repository === actual.repository &&
    expected.number === actual.number &&
    attachment.number === result.number,
  );
}

export interface ThreadChangeRequestState {
  readonly source: string;
  readonly state: "open" | "closed" | "merged" | null;
}

export function threadChangeRequestSource(
  thread: Pick<ThreadPullRequestTarget, "projectId" | "attachedPullRequest"> & {
    readonly branch: string | null;
    readonly worktreePath: string | null;
  },
) {
  return JSON.stringify([
    thread.projectId,
    thread.branch,
    thread.worktreePath,
    thread.attachedPullRequest?.url,
    thread.attachedPullRequest?.number,
  ]);
}

export function currentThreadChangeRequestState(
  thread: Parameters<typeof threadChangeRequestSource>[0],
  cached: ThreadChangeRequestState | undefined,
) {
  return cached?.source === threadChangeRequestSource(thread) ? cached.state : null;
}

// Only focused-thread observers opt into a timer. Other rows reuse the detail cache.
// Removing the last focused observer stops refreshes even while sidebar rows remain mounted.
const liveDetail = Atom.family((key: string) => {
  const target = JSON.parse(key) as { environmentId: EnvironmentId; input: PullRequestRef };
  return pullRequestEnvironment
    .detail(target)
    .pipe(Atom.withRefresh("30 seconds"), Atom.setIdleTTL(0));
});

export const liveAttachedPullRequestDetail = (target: {
  environmentId: EnvironmentId;
  input: PullRequestRef;
}) => liveDetail(JSON.stringify(target));

export function useAttachedPullRequest(
  thread: ThreadPullRequestTarget | null,
  { poll = false }: { poll?: boolean } = {},
) {
  const environment = useEnvironment(thread?.environmentId ?? null);
  const supported = environment?.descriptor?.capabilities?.pullRequests === true;
  const target = attachedPullRequestQueryTarget(thread);
  const query = useEnvironmentQuery(
    supported && target
      ? poll
        ? liveAttachedPullRequestDetail(target)
        : pullRequestEnvironment.detail(target)
      : null,
  );
  const attachment = thread?.attachedPullRequest;
  const matches = attachment && query.data && sameAttachedPullRequest(attachment, query.data);
  return {
    ...query,
    data: matches ? query.data : null,
    error:
      query.error ??
      (supported && attachment && !target
        ? "Live pull request status is unavailable for this attachment."
        : query.data && !matches
          ? "The environment returned a different pull request."
          : null),
  };
}
