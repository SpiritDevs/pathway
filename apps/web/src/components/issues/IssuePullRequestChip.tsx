import type { IssuePullRequest } from "@t3tools/contracts";
import { ExternalLinkIcon } from "lucide-react";
import type { MouseEvent, PointerEvent } from "react";

import { cn } from "~/lib/utils";
import { getSourceControlPresentationForKind } from "~/sourceControlPresentation";

const STATE_CLASS: Readonly<Record<IssuePullRequest["state"], string>> = {
  open: "text-emerald-600 dark:text-emerald-300/90",
  merged: "text-violet-600 dark:text-violet-300/90",
  closed: "text-red-600 dark:text-red-300/90",
};

function stopRowClick(event: MouseEvent | PointerEvent) {
  event.stopPropagation();
}

/** One durable PR badge shared by the detail rail, list row, and kanban card. */
export function IssuePullRequestChip({
  pullRequest,
  compact = false,
  className,
}: {
  pullRequest: IssuePullRequest;
  compact?: boolean;
  className?: string;
}) {
  const presentation = getSourceControlPresentationForKind(pullRequest.provider);
  const { Icon, terminology } = presentation;
  const state = pullRequest.state.charAt(0).toUpperCase() + pullRequest.state.slice(1);
  const label = `${terminology.shortLabel} #${pullRequest.number}`;

  return (
    <a
      aria-label={`Open ${label}: ${pullRequest.title}`}
      className={cn(
        "min-w-0 items-center gap-1.5 border border-border/60 outline-none hover:border-border hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring",
        compact
          ? "inline-flex max-w-28 rounded-full px-1.5 py-px text-[11px]"
          : "flex w-full rounded-md px-2 py-1.5 text-[12px]",
        className,
      )}
      href={pullRequest.url}
      onClick={stopRowClick}
      onPointerDown={stopRowClick}
      rel="noreferrer"
      target="_blank"
      title={`${label} · ${state}: ${pullRequest.title}`}
    >
      <Icon className={cn("size-3.5 shrink-0", STATE_CLASS[pullRequest.state])} />
      <span className="shrink-0 font-medium text-foreground">{label}</span>
      {compact ? null : (
        <>
          <span aria-hidden className="text-muted-foreground/50">
            ·
          </span>
          <span className="min-w-0 flex-1 truncate text-muted-foreground">{pullRequest.title}</span>
          <span className={cn("shrink-0 text-[10px]", STATE_CLASS[pullRequest.state])}>
            {state}
          </span>
          <ExternalLinkIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
        </>
      )}
    </a>
  );
}
