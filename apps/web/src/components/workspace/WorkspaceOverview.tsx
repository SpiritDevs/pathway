import { Link } from "@tanstack/react-router";
import { ActivityIcon, FolderIcon, MessagesSquareIcon } from "lucide-react";
import { useMemo } from "react";

import { useThreadShells } from "~/state/entities";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { DashboardTile } from "../projects/ProjectDashboardTiles";
import { useWorkspaceProjects } from "../projects/useWorkspaceProjects";
import { Button } from "../ui/button";
import { WorkspaceViewFrame } from "./WorkspaceViewFrame";

export function WorkspaceOverview({ orchestrator = false }: { readonly orchestrator?: boolean }) {
  const threads = useThreadShells();
  const projects = useWorkspaceProjects();
  const visible = useMemo(
    () =>
      threads
        .filter((thread) => thread.archivedAt === null && thread.deletedAt === null)
        .toSorted((left, right) => (right.updatedAt ?? "").localeCompare(left.updatedAt ?? "")),
    [threads],
  );
  const attention = visible.filter(
    (thread) =>
      thread.hasPendingApprovals ||
      thread.hasPendingUserInput ||
      thread.hasActionableProposedPlan ||
      Boolean(thread.source.lastError),
  );
  const running = visible.filter((thread) => thread.source.activeRunId !== null);
  const groups = [
    { title: "Needs attention", rows: attention },
    { title: "Running agents", rows: running },
    { title: "Recent activity", rows: visible.slice(0, 30) },
  ];

  return (
    <WorkspaceViewFrame
      title={orchestrator ? "Orchestrator" : "Dashboard"}
      actions={
        <Button render={<Link to="/threads" />} size="sm">
          New agent thread
        </Button>
      }
    >
      <main className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
        <div className="mx-auto grid max-w-6xl gap-4 lg:grid-cols-2">
          {groups.map(({ title, rows }) => (
            <DashboardTile key={title} title={`${title} (${rows.length})`} icon={<ActivityIcon />}>
              {rows.length === 0 ? (
                <p className="text-sm text-muted-foreground">No {title.toLowerCase()}.</p>
              ) : (
                <ul className="max-h-96 overflow-y-auto divide-y divide-border/60">
                  {rows.map((thread) => (
                    <li key={`${thread.environmentId}:${thread.id}`}>
                      <Link
                        to="/threads/$environmentId/$threadId"
                        params={{ environmentId: thread.environmentId, threadId: thread.id }}
                        className="flex min-h-12 items-center gap-3 rounded-md px-2 py-2 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <MessagesSquareIcon
                          aria-hidden
                          className="size-4 shrink-0 text-muted-foreground"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">
                            {thread.title || "Untitled thread"}
                          </span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {thread.branch ?? "Working tree"} ·{" "}
                            {formatRelativeTimeLabel(thread.updatedAt ?? "")}
                          </span>
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </DashboardTile>
          ))}
          {!orchestrator && (
            <DashboardTile title={`Projects (${projects.length})`} icon={<FolderIcon />}>
              {projects.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  Connect an environment or create a project to begin.
                </p>
              ) : (
                <ul className="max-h-96 overflow-y-auto divide-y divide-border/60">
                  {projects.map((project) => (
                    <li key={project.projectKey}>
                      <Link
                        to="/projects/$projectKey"
                        params={{ projectKey: project.projectKey }}
                        className="block rounded-md px-2 py-3 text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        {project.displayName}
                        <span className="ml-2 text-xs text-muted-foreground">
                          {project.checkoutCount} checkouts
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </DashboardTile>
          )}
        </div>
      </main>
    </WorkspaceViewFrame>
  );
}
