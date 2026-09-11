import type {
  EnvironmentId,
  OrchestrationV2PullRequestAttachment,
  ProjectId,
  PullRequestRef,
} from "@spiritdevs/contracts";
import { useAtomValue } from "@effect/atom-react";
import { threadPullRequestAttachments } from "@spiritdevs/shared/sourceControl";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import type { EnvironmentProject } from "@spiritdevs/client-runtime/state/shell";
import { useProjects } from "./entities";
import { environmentProjects } from "./projects";
import { findProjectForChangeRequest, parseChangeRequestUrl } from "../lib/openPullRequestLink";
import { pullRequestEnvironment } from "./pullRequests";
import { useEnvironmentQuery } from "./query";
import { useEnvironment } from "./environments";

export interface ThreadPullRequestTarget {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId | null;
  readonly attachedPullRequests?: ReadonlyArray<OrchestrationV2PullRequestAttachment> | undefined;
  readonly detachedPullRequestUrls?: ReadonlyArray<string> | undefined;
  readonly attachedPullRequest: OrchestrationV2PullRequestAttachment | null | undefined;
}

export function attachedPullRequestProject(
  thread: ThreadPullRequestTarget | null,
  projects: ReadonlyArray<EnvironmentProject>,
) {
  const attachment = thread?.attachedPullRequest;
  const link = attachment ? parseChangeRequestUrl(attachment.url) : null;
  if (!thread || !link || link.number !== attachment?.number) return null;
  const candidates = projects.filter((project) => project.environmentId === thread.environmentId);
  return (
    findProjectForChangeRequest(
      candidates.filter((project) => project.id === thread.projectId),
      link,
    ) ??
    findProjectForChangeRequest(candidates, link) ??
    null
  );
}

export function attachedPullRequestQueryTarget(
  thread: ThreadPullRequestTarget | null,
  projects: ReadonlyArray<EnvironmentProject>,
) {
  const attachment = thread?.attachedPullRequest;
  const link = attachment ? parseChangeRequestUrl(attachment.url) : null;
  const project = attachedPullRequestProject(thread, projects);
  if (!thread || !link || !project) return null;
  return {
    environmentId: thread.environmentId,
    input: { projectId: project.id, repository: link.repository, number: link.number },
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
  thread: Pick<
    ThreadPullRequestTarget,
    "projectId" | "attachedPullRequest" | "attachedPullRequests" | "detachedPullRequestUrls"
  > & {
    readonly branch: string | null;
    readonly worktreePath: string | null;
  },
) {
  return JSON.stringify([
    thread.projectId,
    thread.branch,
    thread.worktreePath,
    threadPullRequestAttachments(thread),
    thread.detachedPullRequestUrls,
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
  const projects = useProjects();
  const project = attachedPullRequestProject(thread, projects);
  const target = attachedPullRequestQueryTarget(thread, projects);
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
    target: supported ? target : null,
    isConnected: environment?.connection?.phase === "connected",
    project,
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

export function aggregateThreadPullRequestState(
  states: ReadonlyArray<"open" | "closed" | "merged" | null>,
) {
  if (states.length === 0) return null;
  if (states.every((state) => state === "merged")) return "merged";
  if (states.includes("open")) return "open";
  if (states.includes("closed")) return "closed";
  return null;
}

export const attachedPullRequestsAtom = Atom.family((key: string) =>
  Atom.make((get) => {
    const { thread, poll, supported } = JSON.parse(key) as {
      thread: ThreadPullRequestTarget | null;
      poll: boolean;
      supported: boolean;
    };
    if (!thread) return [];
    const projects = get(environmentProjects.projectsAtom);
    return threadPullRequestAttachments(thread).map((attachment) => {
      const target = attachedPullRequestQueryTarget(
        {
          ...thread,
          attachedPullRequest: attachment,
        },
        projects,
      );
      const result =
        supported && target
          ? get(
              poll ? liveAttachedPullRequestDetail(target) : pullRequestEnvironment.detail(target),
            )
          : null;
      const value = result ? Option.getOrNull(AsyncResult.value(result)) : null;
      const data = value && sameAttachedPullRequest(attachment, value) ? value : null;
      return {
        attachment,
        data,
        isPending: result?.waiting ?? false,
        error:
          result?._tag === "Failure" || (value && !data)
            ? "Could not refresh pull request status."
            : supported && !target
              ? "Live pull request status is unavailable for this attachment."
              : null,
      };
    });
  }),
);

export function useAttachedPullRequests(
  thread: ThreadPullRequestTarget | null,
  { poll = false }: { poll?: boolean } = {},
) {
  const environment = useEnvironment(thread?.environmentId ?? null);
  return useAtomValue(
    attachedPullRequestsAtom(
      JSON.stringify({
        thread: thread
          ? {
              environmentId: thread.environmentId,
              projectId: thread.projectId,
              attachedPullRequests: threadPullRequestAttachments(thread),
            }
          : null,
        poll,
        supported: environment?.descriptor?.capabilities?.pullRequests === true,
      }),
    ),
  );
}
