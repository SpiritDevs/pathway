/**
 * The cards on a project dashboard.
 *
 * Each tile reads one existing data source and says something a person could act on. A tile with
 * nothing to report says so in a sentence rather than rendering an empty frame, because a grid of
 * blank cards reads as breakage.
 *
 * @module components/projects/ProjectDashboardTiles
 */
import { useAtomValue } from "@effect/atom-react";
import { ProjectId, type EnvironmentId } from "@spiritdevs/contracts";
import {
  CircleDotIcon,
  ClockIcon,
  FlagIcon,
  GitPullRequestIcon,
  MessagesSquareIcon,
  MonitorIcon,
  ServerIcon,
  UsersRoundIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { useMemo } from "react";

import { formatRelativeTimeLabel } from "~/timestampFormat";
import { useThreadShellsForProjectRefs } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { primaryEnvironmentIdAtom } from "~/state/primaryEnvironment";
import { cn } from "~/lib/utils";
import { Badge } from "../ui/badge";
import {
  projectConnectionPlatformLabel,
  type ProjectConnectionMetadata,
} from "./projectConnectionMetadata";
import type { ContributorLoad, IssueRollup, MilestoneProgress } from "./projectDashboard.logic";
import type { WorkspaceProject } from "./workspaceProjects.logic";

export function DashboardTile({
  children,
  icon,
  title,
  action,
  className,
}: {
  readonly children: ReactNode;
  readonly icon: ReactNode;
  readonly title: string;
  readonly action?: ReactNode;
  readonly className?: string;
}) {
  return (
    <section
      className={cn("rounded-xl border border-border/70 bg-card p-4", className)}
      aria-label={title}
    >
      <header className="mb-3 flex items-center gap-2">
        <span className="text-muted-foreground [&>svg]:size-4">{icon}</span>
        <h2 className="text-sm font-medium">{title}</h2>
        {action ? <div className="ms-auto">{action}</div> : null}
      </header>
      {children}
    </section>
  );
}

function TileEmpty({ children }: { readonly children: ReactNode }) {
  return <p className="text-xs leading-5 text-muted-foreground">{children}</p>;
}

function Stat({
  label,
  value,
  tone = "default",
}: {
  readonly label: string;
  readonly value: number | string;
  readonly tone?: "default" | "warning";
}) {
  return (
    <div>
      <p
        className={cn(
          "text-2xl font-semibold tabular-nums tracking-tight",
          tone === "warning" && value !== 0 ? "text-warning" : "text-foreground",
        )}
      >
        {value}
      </p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  );
}

/** Answers "which machines is this on, and where" — the question the sidebar's bare count did not. */
export function WhereItLivesTile({
  connections,
  hasCheckout,
}: {
  readonly connections: ReadonlyArray<ProjectConnectionMetadata>;
  readonly hasCheckout: boolean;
}) {
  return (
    <DashboardTile icon={<ServerIcon />} title="Where it lives">
      {connections.length === 0 ? (
        <TileEmpty>
          {hasCheckout
            ? "This project has a checkout, but no environment has reported it yet."
            : "No machine has a checkout of this project. You can plan and file issues here; attach a directory to run agents."}
        </TileEmpty>
      ) : (
        <ul className="space-y-2.5">
          {connections.map((connection) => (
            <li
              key={`${connection.environmentId}:${connection.localProjectId}`}
              className="flex items-start gap-2.5"
            >
              <MonitorIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-1.5 text-sm">
                  <span className="truncate font-medium">{connection.environmentLabel}</span>
                  {connection.isPreferred ? <Badge variant="secondary">Default</Badge> : null}
                  {connection.bindingStatus === "missing" ? (
                    <Badge variant="warning">Directory missing</Badge>
                  ) : null}
                </p>
                <p className="truncate font-mono text-xs text-muted-foreground">
                  {connection.directory ?? "No directory"}
                </p>
                <p className="text-[11px] text-muted-foreground/80">
                  {[
                    projectConnectionPlatformLabel(connection.platform),
                    connection.serverVersion === null
                      ? null
                      : `Pathway ${connection.serverVersion}`,
                    connection.lastSeenAt === null
                      ? null
                      : `Seen ${formatRelativeTimeLabel(new Date(connection.lastSeenAt).toISOString())}`,
                  ]
                    .filter((part): part is string => part !== null && part !== "")
                    .join(" · ")}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </DashboardTile>
  );
}

export function IssueRollupTile({ rollup }: { readonly rollup: IssueRollup }) {
  const percent = rollup.total === 0 ? 0 : Math.round((rollup.done / rollup.total) * 100);
  return (
    <DashboardTile icon={<CircleDotIcon />} title="Issues">
      {rollup.total === 0 ? (
        <TileEmpty>No issues yet. File one to start tracking work here.</TileEmpty>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Stat label="Total" value={rollup.total} />
            <Stat label="In progress" value={rollup.inProgress} />
            <Stat label="Not started" value={rollup.notStarted} />
            <Stat label="Overdue" value={rollup.overdue} tone="warning" />
          </div>
          <div className="mt-4">
            <div className="mb-1.5 flex items-baseline justify-between text-xs text-muted-foreground">
              <span>
                {rollup.done} of {rollup.total} done
              </span>
              <span className="tabular-nums">{percent}%</span>
            </div>
            <div
              className="h-1.5 overflow-hidden rounded-full bg-muted"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
              aria-label="Issues completed"
            >
              <div className="h-full rounded-full bg-success" style={{ width: `${percent}%` }} />
            </div>
          </div>
        </>
      )}
    </DashboardTile>
  );
}

/** "Are we behind" — stated only where a target date has actually been agreed and missed. */
export function MilestonesTile({
  milestones,
}: {
  readonly milestones: ReadonlyArray<MilestoneProgress>;
}) {
  const behindCount = milestones.filter((milestone) => milestone.behind).length;
  return (
    <DashboardTile
      icon={<FlagIcon />}
      title="Milestones"
      action={
        behindCount > 0 ? (
          <Badge variant="warning">{behindCount} behind</Badge>
        ) : milestones.length > 0 ? (
          <Badge variant="success">On track</Badge>
        ) : null
      }
    >
      {milestones.length === 0 ? (
        <TileEmpty>No milestones. Add one to track a date rather than a pile of issues.</TileEmpty>
      ) : (
        <ul className="space-y-3">
          {milestones.slice(0, 4).map((milestone) => {
            const percent =
              milestone.total === 0 ? 0 : Math.round((milestone.done / milestone.total) * 100);
            return (
              <li key={milestone.id}>
                <div className="mb-1 flex items-baseline justify-between gap-3 text-xs">
                  <span className="truncate font-medium text-foreground">{milestone.name}</span>
                  <span
                    className={cn(
                      "shrink-0 tabular-nums",
                      milestone.behind ? "text-warning" : "text-muted-foreground",
                    )}
                  >
                    {milestone.targetDate === null
                      ? "No date"
                      : milestone.behind
                        ? `${Math.abs(milestone.daysRemaining ?? 0)}d overdue`
                        : `${milestone.daysRemaining ?? 0}d left`}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                    <div
                      className={cn(
                        "h-full rounded-full",
                        milestone.behind ? "bg-warning" : "bg-success",
                      )}
                      style={{ width: `${percent}%` }}
                    />
                  </div>
                  <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                    {milestone.done}/{milestone.total}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </DashboardTile>
  );
}

export function PeopleTile({
  contributors,
}: {
  readonly contributors: ReadonlyArray<ContributorLoad>;
}) {
  return (
    <DashboardTile icon={<UsersRoundIcon />} title="People">
      {contributors.length === 0 ? (
        <TileEmpty>Nothing assigned yet.</TileEmpty>
      ) : (
        <ul className="space-y-2">
          {contributors.slice(0, 6).map((contributor) => (
            <li key={contributor.key} className="flex items-center justify-between gap-3 text-sm">
              <span
                className={cn(
                  "min-w-0 truncate",
                  contributor.key === "unassigned" && "text-muted-foreground",
                )}
              >
                {contributor.label}
              </span>
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                {contributor.open} open · {contributor.done} done
              </span>
            </li>
          ))}
        </ul>
      )}
    </DashboardTile>
  );
}

export function RecentThreadsTile({ project }: { readonly project: WorkspaceProject }) {
  const refs = useMemo(() => project.group?.memberProjectRefs ?? [], [project.group]);
  const threads = useThreadShellsForProjectRefs(refs);
  const recent = useMemo(
    () =>
      [...threads]
        .filter((thread) => thread.archivedAt === null)
        .toSorted((left, right) => (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""))
        .slice(0, 5),
    [threads],
  );

  return (
    <DashboardTile icon={<MessagesSquareIcon />} title="Recent activity">
      {recent.length === 0 ? (
        <TileEmpty>
          {refs.length === 0
            ? "Agent work needs a checkout. Attach a directory to start a thread here."
            : "No threads yet."}
        </TileEmpty>
      ) : (
        <ul className="space-y-2">
          {recent.map((thread) => (
            <li key={`${thread.environmentId}:${thread.id}`} className="flex items-start gap-2">
              <ClockIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm">{thread.title ?? "Untitled thread"}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {[
                    thread.branch,
                    thread.updatedAt === null ? null : formatRelativeTimeLabel(thread.updatedAt),
                  ]
                    .filter((part): part is string => Boolean(part))
                    .join(" · ")}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </DashboardTile>
  );
}

export function PullRequestsTile({
  environmentId,
  projectId,
}: {
  readonly environmentId: EnvironmentId | null;
  readonly projectId: string | null;
}) {
  const primaryEnvironmentId = useAtomValue(primaryEnvironmentIdAtom);
  const targetEnvironmentId = environmentId ?? primaryEnvironmentId;
  const listQuery = useEnvironmentQuery(
    targetEnvironmentId === null || projectId === null
      ? null
      : pullRequestEnvironment.list({
          environmentId: targetEnvironmentId,
          input: {
            state: "open",
            involvement: "all",
            limit: 5,
            projectId: ProjectId.make(projectId),
          },
        }),
  );
  const pullRequests = listQuery.data?.entries ?? [];

  return (
    <DashboardTile icon={<GitPullRequestIcon />} title="Open pull requests">
      {projectId === null || targetEnvironmentId === null ? (
        <TileEmpty>Attach a checkout to see this project&rsquo;s pull requests.</TileEmpty>
      ) : listQuery.isPending ? (
        <TileEmpty>Loading…</TileEmpty>
      ) : pullRequests.length === 0 ? (
        <TileEmpty>Nothing open.</TileEmpty>
      ) : (
        <ul className="space-y-2">
          {pullRequests.map((pullRequest) => (
            <li key={`${pullRequest.host}:${pullRequest.number}`} className="min-w-0 text-sm">
              <p className="truncate">{pullRequest.title}</p>
              <p className="truncate text-xs text-muted-foreground">
                #{pullRequest.number}
                {pullRequest.author === null ? "" : ` · ${pullRequest.author.login}`}
              </p>
            </li>
          ))}
        </ul>
      )}
    </DashboardTile>
  );
}
