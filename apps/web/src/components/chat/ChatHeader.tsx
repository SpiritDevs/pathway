import { type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import { memo } from "react";

import { cn } from "~/lib/utils";
import { ProjectFavicon } from "../ProjectFavicon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

interface ChatHeaderProps {
  activeThreadEnvironmentId: EnvironmentId;
  activeThreadTitle: string;
  activeProjectName: string | undefined;
  activeProjectCwd: string | null;
  threadAncestors: ReadonlyArray<ThreadBreadcrumbAncestor>;
  rightPanelOpen: boolean;
  onNewThreadInProject: () => void;
  onOpenThread: (threadId: ThreadId) => void;
}

export interface ThreadBreadcrumbAncestor {
  readonly id: ThreadId;
  readonly title: string;
}

interface ThreadWithLineage extends ThreadBreadcrumbAncestor {
  readonly environmentId: EnvironmentId;
  readonly forkedFrom?: {
    readonly type: string;
    readonly threadId?: ThreadId;
  } | null;
  readonly lineage: {
    readonly parentThreadId: ThreadId | null;
  };
}

function breadcrumbParentThreadId(thread: ThreadWithLineage): ThreadId | null {
  return thread.forkedFrom?.type === "run" && thread.forkedFrom.threadId !== undefined
    ? thread.forkedFrom.threadId
    : thread.lineage.parentThreadId;
}

export function resolveThreadBreadcrumbAncestors(
  activeThread: ThreadWithLineage | null | undefined,
  threads: ReadonlyArray<ThreadWithLineage>,
): ReadonlyArray<ThreadBreadcrumbAncestor> {
  if (activeThread === null || activeThread === undefined) return [];

  const threadsById = new Map(
    threads
      .filter((thread) => thread.environmentId === activeThread.environmentId)
      .map((thread) => [thread.id, thread] as const),
  );
  const ancestors: ThreadBreadcrumbAncestor[] = [];
  const visited = new Set<ThreadId>([activeThread.id]);
  let parentThreadId = breadcrumbParentThreadId(activeThread);

  while (parentThreadId !== null && !visited.has(parentThreadId)) {
    visited.add(parentThreadId);
    const parent = threadsById.get(parentThreadId);
    if (parent === undefined) break;
    ancestors.unshift({ id: parent.id, title: parent.title });
    parentThreadId = breadcrumbParentThreadId(parent);
  }

  return ancestors;
}

export const ChatHeader = memo(function ChatHeader({
  activeThreadEnvironmentId,
  activeThreadTitle,
  activeProjectName,
  activeProjectCwd,
  threadAncestors,
  rightPanelOpen,
  onNewThreadInProject,
  onOpenThread,
}: ChatHeaderProps) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-1 items-center gap-2 sm:gap-3",
        rightPanelOpen ? "pr-10" : "pr-24",
      )}
    >
      <nav aria-label="Thread breadcrumb" className="min-w-0 flex-1 overflow-hidden">
        <ol className="m-0 flex min-w-0 list-none items-center gap-2 p-0 sm:gap-3">
          {/* The project always leads the header: knowing which project a
              thread lives in is priority zero, and the thread title alone
              doesn't answer it. */}
          {activeProjectName ? (
            <li className="inline-flex shrink-0 items-center gap-2">
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label={`New thread in ${activeProjectName}`}
                      onClick={onNewThreadInProject}
                      className="inline-flex min-w-0 cursor-pointer items-center gap-1.5 rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                    />
                  }
                >
                  <ProjectFavicon
                    environmentId={activeThreadEnvironmentId}
                    cwd={activeProjectCwd ?? ""}
                    className="size-3.5"
                  />
                  <span className="max-w-40 truncate text-sm font-medium">{activeProjectName}</span>
                </TooltipTrigger>
                <TooltipPopup side="top">New thread in {activeProjectName}</TooltipPopup>
              </Tooltip>
              <span aria-hidden className="text-muted-foreground/40">
                /
              </span>
            </li>
          ) : null}
          {threadAncestors.map((ancestor) => (
            <li key={ancestor.id} className="inline-flex min-w-0 shrink items-center gap-2">
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label={`Go to ancestor thread ${ancestor.title}`}
                      onClick={() => onOpenThread(ancestor.id)}
                      className="min-w-0 max-w-40 cursor-pointer truncate rounded-sm text-sm font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                    />
                  }
                >
                  {ancestor.title}
                </TooltipTrigger>
                <TooltipPopup side="top">Go to {ancestor.title}</TooltipPopup>
              </Tooltip>
              <span aria-hidden className="shrink-0 text-muted-foreground/40">
                /
              </span>
            </li>
          ))}
          <li aria-current="page" className="min-w-0 flex-1">
            <Tooltip>
              <TooltipTrigger
                render={
                  <h2
                    aria-label={activeThreadTitle}
                    className="min-w-0 truncate text-sm font-medium text-foreground"
                  >
                    {activeThreadTitle}
                  </h2>
                }
              />
              <TooltipPopup side="top">{activeThreadTitle}</TooltipPopup>
            </Tooltip>
          </li>
        </ol>
      </nav>
    </div>
  );
});
