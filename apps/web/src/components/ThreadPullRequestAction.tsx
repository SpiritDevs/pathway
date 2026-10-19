import { useThreadPullRequestRefresh } from "../state/useThreadPullRequestRefresh";
import { scopeThreadRef } from "@spiritdevs/client-runtime/environment";
import type { EnvironmentThreadShell } from "@spiritdevs/client-runtime/state/shell";
import { useOpenPrLink } from "../lib/openPullRequestLink";
import { useAttachedPullRequest } from "../state/threadPullRequest";
import { threadPullRequestAttachments } from "@spiritdevs/shared/sourceControl";
import type { OrchestrationV2PullRequestAttachment } from "@spiritdevs/contracts";
import { useServerConfigs } from "../state/entities";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { ThreadDetailsPrRow } from "./chat/ThreadDetailsPrRow";
import { Button } from "./ui/button";
import { Popover, PopoverTrigger, PopoverPopup } from "./ui/popover";
import { GitPullRequestIcon, GitPullRequestArrowIcon } from "lucide-react";
import { resolveThreadPrBadge, type ThreadPr } from "./ThreadStatusIndicators";

export function ThreadPullRequestAction({
  thread,
  isPanel,
  branchPullRequest = null,
}: {
  thread: EnvironmentThreadShell;
  isPanel: boolean;
  branchPullRequest?: ThreadPr;
}) {
  const openPrLink = useOpenPrLink(scopeThreadRef(thread.environmentId, thread.id));
  const attachments = threadPullRequestAttachments(thread);
  const linked =
    branchPullRequest &&
    !thread.detachedPullRequestUrls?.includes(branchPullRequest.url) &&
    !attachments.some((pr) => pr.url === branchPullRequest.url)
      ? [...attachments, branchPullRequest]
      : attachments;
  if (linked.length === 0) return null;
  const rows = (
    <div className="flex w-full min-w-0 flex-col">
      {linked.map((attachment) => (
        <ThreadPullRequestRow
          key={attachment.url}
          thread={thread}
          attachment={attachment}
          branchPullRequest={branchPullRequest}
        />
      ))}
    </div>
  );
  if (isPanel) return rows;
  if (linked.length === 1)
    return (
      <Button size="xs" variant="ghost" onClick={(event) => openPrLink(event, linked[0]!.url)}>
        <GitPullRequestIcon className="size-3" />#{linked[0]!.number}
      </Button>
    );
  return (
    <Popover>
      <PopoverTrigger
        render={<Button size="xs" variant="ghost" />}
        aria-label={`${linked.length} pull requests`}
      >
        <GitPullRequestArrowIcon className="size-3" />
        {linked.length} PRs
      </PopoverTrigger>
      <PopoverPopup className="w-80" viewportClassName="p-1">
        {rows}
      </PopoverPopup>
    </Popover>
  );
}

function ThreadPullRequestRow({
  thread,
  attachment,
  branchPullRequest,
}: {
  thread: EnvironmentThreadShell;
  attachment: OrchestrationV2PullRequestAttachment;
  branchPullRequest: ThreadPr;
}) {
  const attachedQuery = useAttachedPullRequest(
    { ...thread, attachedPullRequest: attachment },
    { poll: true },
  );
  const query = useThreadPullRequestRefresh(thread, attachedQuery);
  const openPrLink = useOpenPrLink(scopeThreadRef(thread.environmentId, thread.id));
  const project = query.project;
  const configs = useServerConfigs();
  const detach = useAtomCommand(threadEnvironment.detachPullRequest);
  const badge = resolveThreadPrBadge({
    attachedPullRequest: attachment,
    attachedDetail: query.data,
    attachedError: query.error,
    branchPullRequest,
    provider: undefined,
  })!;
  const detail = query.data;
  const pr = {
    ...attachment,
    title: detail?.title ?? "",
    state: badge.changeRequestState ?? "open",
    headRef: detail?.headBranch ?? "",
    baseRef: detail?.baseBranch ?? "",
  };
  return (
    <ThreadDetailsPrRow
      environmentId={thread.environmentId}
      project={project ?? null}
      pr={pr}
      detailQuery={query}
      status={badge.status}
      label={`#${attachment.number}${pr.title ? `: ${pr.title}` : ` · ${badge.status.label.replace(/^(PR|MR) /, "")}`}`}
      openAriaLabel={badge.status.tooltip}
      onOpen={(event) => openPrLink(event, attachment.url)}
      onUnlink={
        configs.get(thread.environmentId)?.environment.capabilities.threadPullRequestAttachments
          ? () => {
              void detach({
                environmentId: thread.environmentId,
                input: { threadId: thread.id, pullRequest: attachment },
              });
            }
          : undefined
      }
    />
  );
}
