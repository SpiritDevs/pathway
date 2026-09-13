import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import { threadQueueEntriesAtom, threadQueueDestinationsAtom } from "../cloud/threadQueueState";
import { useThreadRefs } from "../state/entities";

export function QueuedThreadSidebar(props: {
  scopedProjectKeys: ReadonlySet<string> | null;
  includeConversations: boolean;
}) {
  const entries = useAtomValue(threadQueueEntriesAtom);
  const refs = useThreadRefs();
  const destinations = useAtomValue(threadQueueDestinationsAtom);
  const existing = new Set(refs.map((ref) => `${ref.environmentId}:${ref.threadId}`));
  const visible = entries.filter(
    (row) =>
      !existing.has(`${row.environmentId}:${row.threadId}`) &&
      (row.localProjectId === null
        ? props.includeConversations
        : props.scopedProjectKeys === null ||
          props.scopedProjectKeys.has(`${row.environmentId}:${row.localProjectId}`)),
  );
  return (
    <>
      {visible.map((row) => {
        const environment = destinations.find(
          (destination) => destination.environmentId === row.environmentId,
        );
        const project = environment?.projects.find(
          (project) => project.localProjectId === row.localProjectId,
        );
        const workspace = row.launch?.workspaceStrategy;
        const branch =
          workspace?.type === "worktree"
            ? (workspace.branch ?? workspace.baseRef)
            : workspace?.branch;
        return (
          <li
            key={row.queueId ?? `${row.environmentId}:${row.threadId}`}
            className="list-none py-0.5"
          >
            <Link
              to="/threads/$environmentId/$threadId"
              params={{ environmentId: row.environmentId, threadId: row.threadId }}
              search={row.queueId ? { queueId: row.queueId } : {}}
              activeProps={{ className: "bg-sidebar-row-active" }}
              title={environment?.label}
              className="block rounded-md px-[var(--sidebar-row-content-inset)] py-[var(--sidebar-content-inset)] hover:bg-sidebar-row-hover"
            >
              <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                <span className="truncate">
                  {row.localProjectId === null
                    ? "Conversation"
                    : (project?.title ?? "Agent thread")}
                </span>
                <span className="shrink-0">
                  {row.waitingToSync
                    ? "Waiting to sync"
                    : row.state === "blocked"
                      ? "Needs attention"
                      : row.state === "accepted"
                        ? "Starting"
                        : row.state === "canceled"
                          ? "Canceled"
                          : "Queued"}
                </span>
              </div>
              <p className="truncate text-sm font-medium">{row.title}</p>
              <p className="mt-1 truncate text-xs text-muted-foreground">
                {[branch, environment?.label].filter(Boolean).join(" · ")}
              </p>
            </Link>
          </li>
        );
      })}
    </>
  );
}
