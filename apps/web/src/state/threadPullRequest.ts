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

// One refresh timer per attached PR, shared by the sidebar and action panel.
// Removing the last observer stops refreshes while the ordinary detail cache remains reusable.
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

export function useAttachedPullRequest(thread: ThreadPullRequestTarget | null) {
  const target = attachedPullRequestQueryTarget(thread);
  const query = useEnvironmentQuery(target ? liveAttachedPullRequestDetail(target) : null);
  const attachment = thread?.attachedPullRequest;
  const matches = attachment && query.data && sameAttachedPullRequest(attachment, query.data);
  return {
    ...query,
    data: matches ? query.data : null,
    error:
      query.error ??
      (attachment && !target
        ? "Live pull request status is unavailable for this attachment."
        : query.data && !matches
          ? "The environment returned a different pull request."
          : null),
  };
}
