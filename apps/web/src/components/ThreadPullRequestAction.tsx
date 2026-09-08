import { scopeThreadRef } from "@spiritdevs/client-runtime/environment";
import type { EnvironmentThreadShell } from "@spiritdevs/client-runtime/state/shell";
import { getChangeRequestTerminologyFromUrl } from "@spiritdevs/shared/sourceControl";
import { useOpenPrLink } from "../lib/openPullRequestLink";
import { cn } from "../lib/utils";
import { sameAttachedPullRequest, useAttachedPullRequest } from "../state/threadPullRequest";
import { Button } from "./ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import {
  ChangeRequestStatusIcon,
  PrStatusTooltipContent,
  resolveThreadPrBadge,
  type ThreadPr,
} from "./ThreadStatusIndicators";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_ROW_CLASS,
} from "./chat/threadDetailsPanelStyles";

export function ThreadPullRequestAction({
  thread,
  isPanel,
  branchPullRequest = null,
}: {
  thread: EnvironmentThreadShell;
  isPanel: boolean;
  branchPullRequest?: ThreadPr;
}) {
  const query = useAttachedPullRequest(thread, { poll: true });
  const openPrLink = useOpenPrLink(scopeThreadRef(thread.environmentId, thread.id));
  const badge = resolveThreadPrBadge({
    attachedPullRequest: thread.attachedPullRequest,
    attachedDetail: query.data,
    attachedError: query.error,
    branchPullRequest: null,
    provider: undefined,
  });
  if (
    !badge ||
    (branchPullRequest && sameAttachedPullRequest(badge.pullRequest, branchPullRequest))
  ) {
    return null;
  }
  const terminology = getChangeRequestTerminologyFromUrl(badge.pullRequest.url);
  const stateLabel = badge.status.label.replace(/^(PR|MR) /, "");
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="xs"
            variant={isPanel ? "ghost" : "outline"}
            className={cn(isPanel && THREAD_DETAILS_PANEL_ROW_CLASS, badge.status.colorClass)}
            aria-label={badge.status.tooltip}
            onClick={(event) => openPrLink(event, badge.pullRequest.url)}
          />
        }
      >
        <ChangeRequestStatusIcon
          className={cn(
            isPanel ? THREAD_DETAILS_PANEL_ICON_CLASS : "size-3.5",
            badge.status.colorClass,
          )}
        />
        <span>
          {terminology.shortLabel} #{badge.pullRequest.number}
        </span>
        <span className="ml-auto truncate pl-2 text-xs">
          {query.isPending && !query.data
            ? "Checking status"
            : stateLabel.charAt(0).toUpperCase() + stateLabel.slice(1)}
        </span>
      </TooltipTrigger>
      <TooltipPopup side="left">
        <PrStatusTooltipContent status={badge.status} />
      </TooltipPopup>
    </Tooltip>
  );
}
