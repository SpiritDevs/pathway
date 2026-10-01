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

import { MessageSquareIcon } from "lucide-react";

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
  /** Only the thread details toggle shares the header (the other panel toggles live elsewhere). */
  compactTitlebarControls: boolean;
  retentionControlVisible?: boolean;
  temporary?: boolean;
  onSelectConversation?: () => void;
  onProjectChange: (projectRef: ScopedProjectRef) => void | Promise<void>;
  onOpenThread: (threadId: ThreadId, environmentId?: EnvironmentId) => void;
  onRenameThread?: (title: string) => void;
}

export interface ThreadBreadcrumbAncestor {
  readonly id: ThreadId;
  readonly title: string;
  readonly environmentId: EnvironmentId;
}

export interface ThreadWithLineage extends ThreadBreadcrumbAncestor {
  readonly forkedFrom?: {
    readonly type: string;
    readonly threadId?: ThreadId;
  } | null;
  readonly lineage: {
    readonly parentThreadId: ThreadId | null;
    readonly relationshipToParent?: "fork" | "subagent" | null;
    readonly parentEnvironmentId?: EnvironmentId | undefined;
  };
}

export interface ThreadBreadcrumbParent {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}

/**
 * A fork's source run while it is still a fork, else the lineage parent, which may be on another
 * environment.
 */
export function breadcrumbParent(thread: ThreadWithLineage): ThreadBreadcrumbParent | null {
  if (
    thread.lineage.relationshipToParent === "fork" &&
    thread.forkedFrom?.type === "run" &&
    thread.forkedFrom.threadId !== undefined
  ) {
    return { environmentId: thread.environmentId, threadId: thread.forkedFrom.threadId };
  }
  return thread.lineage.parentThreadId === null
    ? null
    : {
        environmentId: thread.lineage.parentEnvironmentId ?? thread.environmentId,
        threadId: thread.lineage.parentThreadId,
      };
}

/** Walks breadcrumb parents through `lookup`, stopping at a missing parent or a cycle. */
export function walkThreadBreadcrumbAncestors(
  activeThread: ThreadWithLineage,
  lookup: (parent: ThreadBreadcrumbParent) => ThreadWithLineage | undefined,
): ReadonlyArray<ThreadBreadcrumbAncestor> {
  const ancestors: ThreadBreadcrumbAncestor[] = [];
  const key = (ref: ThreadBreadcrumbParent) => `${ref.environmentId}:${ref.threadId}`;
  const visited = new Set([
    key({ environmentId: activeThread.environmentId, threadId: activeThread.id }),
  ]);
  let parentRef = breadcrumbParent(activeThread);

  while (parentRef !== null && !visited.has(key(parentRef))) {
    visited.add(key(parentRef));
    const parent = lookup(parentRef);
    if (parent === undefined) break;
    ancestors.unshift({ id: parent.id, title: parent.title, environmentId: parent.environmentId });
    parentRef = breadcrumbParent(parent);
  }

  return ancestors;
}

export function resolveThreadBreadcrumbAncestors(
  activeThread: ThreadWithLineage | null | undefined,
  threads: ReadonlyArray<ThreadWithLineage>,
): ReadonlyArray<ThreadBreadcrumbAncestor> {
  if (activeThread === null || activeThread === undefined) return [];

  const threadsByKey = new Map(
    threads.map((thread) => [`${thread.environmentId}:${thread.id}`, thread] as const),
  );
  return walkThreadBreadcrumbAncestors(activeThread, (parent) =>
    threadsByKey.get(`${parent.environmentId}:${parent.threadId}`),
  );
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
  compactTitlebarControls,
  onProjectChange,
  onOpenThread,
  onRenameThread,
  retentionControlVisible = false,
  temporary = false,
  onSelectConversation,
}: ChatHeaderProps) {
  const conversationLabel = temporary ? "Temporary conversation" : "Conversation";
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
        retentionControlVisible
          ? compactTitlebarControls
            ? "pr-40"
            : "pr-52"
          : compactTitlebarControls
            ? "pr-10"
            : "pr-24",
      )}
    >
      <nav aria-label="Thread breadcrumb" className="min-w-0 flex-1 overflow-hidden">
        <ol className="m-0 flex min-w-0 list-none items-center gap-2 p-0 sm:gap-3">
          {/* The project always leads the header: knowing which project a
              thread lives in is priority zero, and the thread title alone
              doesn't answer it. */}
          {activeProjectName || activeProjectRef === null ? (
            <li className="inline-flex shrink-0 items-center gap-2">
              {projectSelectionEnabled ? (
                <WorkspaceProjectSelector
                  activeProjectRef={activeProjectRef}
                  activeProjectTitle={activeProjectName ?? conversationLabel}
                  conversationSelected={activeProjectRef === null}
                  onSelectConversation={onSelectConversation}
                  {...(activeProjectRef === null && onSelectConversation === undefined
                    ? { environmentId: activeThreadEnvironmentId }
                    : {})}
                  ariaLabel={
                    activeProjectRef === null && onSelectConversation === undefined
                      ? "Attach project"
                      : "Change project"
                  }
                  triggerClassName="inline-flex min-w-0 cursor-pointer items-center gap-1.5 rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                  menuAlign="start"
                  renderTrigger={(displayName) => (
                    <>
                      {activeProjectRef === null ? (
                        <MessageSquareIcon
                          className="size-3.5"
                          strokeDasharray={temporary ? "3 3" : undefined}
                        />
                      ) : (
                        <ProjectFavicon
                          environmentId={activeThreadEnvironmentId}
                          cwd={activeProjectCwd ?? ""}
                          className="size-3.5"
                        />
                      )}
                      <span className="max-w-56 truncate text-sm font-medium">
                        {activeProjectRef === null ? conversationLabel : displayName}
                      </span>
                    </>
                  )}
                  onSelectProject={onProjectChange}
                />
              ) : (
                <Tooltip>
                  <TooltipTrigger
                    render={<span className="inline-flex min-w-0 items-center gap-1.5" />}
                  >
                    {activeProjectRef === null ? (
                      <MessageSquareIcon
                        className="size-3.5"
                        strokeDasharray={temporary ? "3 3" : undefined}
                      />
                    ) : (
                      <ProjectFavicon
                        environmentId={activeThreadEnvironmentId}
                        cwd={activeProjectCwd ?? ""}
                        className="size-3.5"
                      />
                    )}
                    <span className="max-w-56 truncate text-sm font-medium text-muted-foreground">
                      {activeProjectName ?? conversationLabel}
                    </span>
                  </TooltipTrigger>
                  <TooltipPopup side="top">{activeProjectName ?? conversationLabel}</TooltipPopup>
                </Tooltip>
              )}
              <span aria-hidden className="text-muted-foreground/40">
                /
              </span>
            </li>
          ) : null}
          {threadAncestors.map((ancestor) => (
            <li
              key={`${ancestor.environmentId}:${ancestor.id}`}
              className="inline-flex min-w-0 shrink items-center gap-2"
            >
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label={`Go to ancestor thread ${ancestor.title}`}
                      onClick={() => onOpenThread(ancestor.id, ancestor.environmentId)}
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
                        onRenameThread !== undefined && "cursor-text [-webkit-app-region:no-drag]",
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
