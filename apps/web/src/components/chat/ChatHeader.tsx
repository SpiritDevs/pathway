import { type EnvironmentId, type ScopedProjectRef, type ThreadId } from "@spiritdevs/contracts";
import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";

import { cn } from "~/lib/utils";
import { ProjectFavicon } from "../ProjectFavicon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { WorkspaceProjectSelector } from "./WorkspaceProjectSelector";

interface ChatHeaderProps {
  activeThreadEnvironmentId: EnvironmentId;
  activeThreadId: ThreadId;
  activeThreadTitle: string;
  activeProjectName: string | undefined;
  activeProjectCwd: string | null;
  activeProjectRef: ScopedProjectRef | null;
  projectSelectionEnabled: boolean;
  threadAncestors: ReadonlyArray<ThreadBreadcrumbAncestor>;
  rightPanelOpen: boolean;
  onProjectChange: (projectRef: ScopedProjectRef) => void | Promise<void>;
  onOpenThread: (threadId: ThreadId) => void;
  onRenameThread?: (title: string) => void;
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
  activeThreadId,
  activeThreadTitle,
  activeProjectName,
  activeProjectCwd,
  activeProjectRef,
  projectSelectionEnabled,
  threadAncestors,
  rightPanelOpen,
  onProjectChange,
  onOpenThread,
  onRenameThread,
}: ChatHeaderProps) {
  const [renaming, setRenaming] = useState<{ threadId: ThreadId; title: string } | null>(null);
  const renamingTitle = renaming?.threadId === activeThreadId ? renaming.title : null;
  const renameCommittedRef = useRef(false);

  useEffect(() => setRenaming(null), [activeThreadId]);

  const commitRename = useCallback(
    (title: string) => {
      setRenaming(null);
      onRenameThread?.(title);
    },
    [onRenameThread],
  );
  const handleTitleDoubleClick = useCallback(
    (event: ReactMouseEvent) => {
      if (
        onRenameThread === undefined ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }
      renameCommittedRef.current = false;
      setRenaming({ threadId: activeThreadId, title: activeThreadTitle });
    },
    [activeThreadId, activeThreadTitle, onRenameThread],
  );
  const handleRenameKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      if (event.nativeEvent.isComposing || event.keyCode === 229) return;
      if (event.key === "Enter") {
        renameCommittedRef.current = true;
        commitRename(event.currentTarget.value);
      } else if (event.key === "Escape") {
        renameCommittedRef.current = true;
        setRenaming(null);
      }
    },
    [commitRename],
  );

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
              {projectSelectionEnabled ? (
                <WorkspaceProjectSelector
                  activeProjectRef={activeProjectRef}
                  activeProjectTitle={activeProjectName}
                  ariaLabel="Change project"
                  triggerClassName="inline-flex min-w-0 cursor-pointer items-center gap-1.5 rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                  menuAlign="start"
                  renderTrigger={(displayName) => (
                    <>
                      <ProjectFavicon
                        environmentId={activeThreadEnvironmentId}
                        cwd={activeProjectCwd ?? ""}
                        className="size-3.5"
                      />
                      <span className="max-w-40 truncate text-sm font-medium">{displayName}</span>
                    </>
                  )}
                  onSelectProject={onProjectChange}
                />
              ) : (
                <Tooltip>
                  <TooltipTrigger
                    render={<span className="inline-flex min-w-0 items-center gap-1.5" />}
                  >
                    <ProjectFavicon
                      environmentId={activeThreadEnvironmentId}
                      cwd={activeProjectCwd ?? ""}
                      className="size-3.5"
                    />
                    <span className="max-w-40 truncate text-sm font-medium text-muted-foreground">
                      {activeProjectName}
                    </span>
                  </TooltipTrigger>
                  <TooltipPopup side="top">{activeProjectName}</TooltipPopup>
                </Tooltip>
              )}
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
            {renamingTitle !== null ? (
              <input
                autoFocus
                aria-label="Thread title"
                className="min-w-0 w-full rounded-sm bg-transparent text-sm font-medium text-foreground outline-none ring-1 ring-ring/50 focus:ring-ring"
                defaultValue={renamingTitle}
                onBlur={(event) => {
                  if (renameCommittedRef.current) return;
                  commitRename(event.currentTarget.value);
                }}
                onFocus={(event) => event.currentTarget.select()}
                onKeyDown={handleRenameKeyDown}
              />
            ) : (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <h2
                      aria-label={activeThreadTitle}
                      role={onRenameThread !== undefined ? "button" : undefined}
                      tabIndex={onRenameThread !== undefined ? 0 : undefined}
                      onDoubleClick={handleTitleDoubleClick}
                      onKeyDown={(event) => {
                        if (
                          onRenameThread !== undefined &&
                          (event.key === "Enter" || event.key === " ")
                        ) {
                          event.preventDefault();
                          renameCommittedRef.current = false;
                          setRenaming({ threadId: activeThreadId, title: activeThreadTitle });
                        }
                      }}
                      className={cn(
                        "min-w-0 truncate text-sm font-medium text-foreground",
                        onRenameThread !== undefined && "cursor-text",
                      )}
                    >
                      {activeThreadTitle}
                    </h2>
                  }
                />
                <TooltipPopup side="top">{activeThreadTitle}</TooltipPopup>
              </Tooltip>
            )}
          </li>
        </ol>
      </nav>
    </div>
  );
});
