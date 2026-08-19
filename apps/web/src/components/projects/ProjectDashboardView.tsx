import { useAtomValue } from "@effect/atom-react";
import { FolderKanbanIcon, SettingsIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { companyListAtom } from "~/cloud/activeCompany";
import { useAllEnvironmentShellsBootstrapped } from "~/state/entities";
import { todayIssueDate, useIssuesStore } from "~/state/issues";
import { WorkspaceViewFrame } from "../workspace/WorkspaceViewFrame";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { useCompanySettings } from "../settings/company/useCompanySettings";
import { ProjectConfigurationSheet } from "./ProjectConfigurationSheet";
import {
  buildProjectConnectionCatalog,
  deriveProjectConnectionMetadata,
} from "./projectConnectionMetadata";
import {
  summarizeProjectContributors,
  summarizeProjectIssues,
  summarizeProjectMilestones,
  type DashboardIssue,
} from "./projectDashboard.logic";
import {
  IssueRollupTile,
  MilestonesTile,
  PeopleTile,
  PullRequestsTile,
  RecentThreadsTile,
  WhereItLivesTile,
} from "./ProjectDashboardTiles";
import { ProjectUsageTile } from "./ProjectUsageTile";
import { useWorkspaceProjects } from "./useWorkspaceProjects";
import type { WorkspaceProject } from "./workspaceProjects.logic";

function ProjectDashboardState({
  description,
  heading,
  title,
}: {
  description: string;
  heading: string;
  title: string;
}) {
  return (
    <WorkspaceViewFrame title={title}>
      <div className="flex min-h-0 flex-1 items-center justify-center px-6 py-12 sm:px-10">
        <section className="w-full max-w-xl text-left">
          <div className="mb-5 flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <FolderKanbanIcon className="size-4" aria-hidden />
            Project dashboard
          </div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
            {heading}
          </h1>
          <p className="mt-3 max-w-[52ch] text-sm leading-6 text-muted-foreground">{description}</p>
        </section>
      </div>
    </WorkspaceViewFrame>
  );
}

export function ProjectsIndexView() {
  return (
    <ProjectDashboardState
      title="Projects"
      heading="Choose a project"
      description="Select a project from the sidebar to open its dashboard."
    />
  );
}

function ProjectDashboard({ project }: { readonly project: WorkspaceProject }) {
  const store = useIssuesStore();
  const companySettings = useCompanySettings();
  const companies = useAtomValue(companyListAtom);
  const [configOpen, setConfigOpen] = useState(false);
  const today = todayIssueDate();

  const connectionCatalog = useMemo(
    () => buildProjectConnectionCatalog(companySettings.replica?.view.values() ?? []),
    [companySettings.replica],
  );
  const connections = useMemo(
    () =>
      deriveProjectConnectionMetadata({
        members: project.group?.memberProjects ?? [],
        catalog: connectionCatalog,
      }),
    [connectionCatalog, project.group],
  );

  // A logical project answers to several ids — one per checkout, plus the cloud id — and issues
  // filed before the checkouts were grouped still carry the old one. Match on all of them.
  const projectIds = useMemo(() => {
    const ids = new Set<string>();
    if (project.cloudProjectId !== null) ids.add(project.cloudProjectId);
    if (project.group !== null) {
      ids.add(String(project.group.id));
      for (const member of project.group.memberProjects) ids.add(String(member.id));
    }
    return ids;
  }, [project]);

  const issues = useMemo<ReadonlyArray<DashboardIssue>>(
    () =>
      [...store.issuesById.values()]
        .filter((issue) => issue.projectId !== null && projectIds.has(String(issue.projectId)))
        .map((issue) => ({
          id: String(issue.id),
          projectId: issue.projectId === null ? null : String(issue.projectId),
          statusId: issue.statusId === null ? null : String(issue.statusId),
          milestoneId: issue.milestoneId === null ? null : String(issue.milestoneId),
          assignee:
            issue.assignee === null
              ? null
              : {
                  kind: issue.assignee.kind,
                  ...(issue.assignee.kind === "member"
                    ? { id: String(issue.assignee.membershipId) }
                    : {}),
                  ...(issue.assignee.kind === "agent"
                    ? {
                        id: String(issue.assignee.provider),
                        label: String(issue.assignee.provider),
                      }
                    : {}),
                  ...(issue.assignee.kind === "user" ? { label: "You" } : {}),
                },
          dueDate: issue.dueDate,
          triage: issue.triage,
          updatedAt: issue.updatedAt,
        })),
    [projectIds, store.issuesById],
  );

  const statuses = useMemo(
    () => store.statuses.map((status) => ({ id: String(status.id), category: status.category })),
    [store.statuses],
  );
  const milestones = useMemo(
    () =>
      store.milestones
        .filter((milestone) => projectIds.has(String(milestone.projectId)))
        .map((milestone) => ({
          id: String(milestone.id),
          name: milestone.name,
          projectId: String(milestone.projectId),
          targetDate: milestone.targetDate,
        })),
    [projectIds, store.milestones],
  );

  const rollup = useMemo(
    () => summarizeProjectIssues({ issues, statuses, today }),
    [issues, statuses, today],
  );
  const milestoneProgress = useMemo(
    () => summarizeProjectMilestones({ milestones, issues, statuses, today }),
    [issues, milestones, statuses, today],
  );
  const contributors = useMemo(
    () => summarizeProjectContributors({ issues, statuses }),
    [issues, statuses],
  );

  const owners = companies.filter((company) => project.companyIds.includes(String(company.id)));
  const preferredConnection =
    connections.find((connection) => connection.isPreferred) ?? connections[0] ?? null;
  // A one-person workspace has nothing to say about who is doing what.
  const showPeople =
    contributors.length > 1 || contributors.some((load) => load.key !== "unassigned");

  return (
    <>
      <WorkspaceViewFrame
        title={project.displayName}
        actions={
          <Button size="xs" variant="outline" onClick={() => setConfigOpen(true)}>
            <SettingsIcon className="size-3.5" />
            Configure
          </Button>
        }
      >
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6">
          <header className="mb-5 flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold tracking-tight">{project.displayName}</h1>
            {owners.map((company) => (
              <Badge key={company.id} variant="secondary">
                {company.name}
              </Badge>
            ))}
            {project.checkoutCount === 0 ? <Badge variant="outline">No checkout</Badge> : null}
          </header>

          <div className="grid gap-4 lg:grid-cols-2">
            <WhereItLivesTile connections={connections} hasCheckout={project.checkoutCount > 0} />
            <IssueRollupTile rollup={rollup} />
            <MilestonesTile milestones={milestoneProgress} />
            <ProjectUsageTile connections={connections} />
            <RecentThreadsTile project={project} />
            <PullRequestsTile
              environmentId={preferredConnection?.environmentId ?? null}
              projectId={preferredConnection?.localProjectId ?? null}
            />
            {showPeople ? <PeopleTile contributors={contributors} /> : null}
          </div>
        </div>
      </WorkspaceViewFrame>
      <ProjectConfigurationSheet project={project} open={configOpen} onOpenChange={setConfigOpen} />
    </>
  );
}

export function ProjectDashboardView({ projectKey }: { projectKey: string }) {
  const projects = useWorkspaceProjects();
  const bootstrapped = useAllEnvironmentShellsBootstrapped();
  const selected = projects.find((project) => project.projectKey === projectKey) ?? null;

  if (!bootstrapped) {
    return (
      <ProjectDashboardState
        title="Projects"
        heading="Loading project…"
        description="Syncing project details from your connected environments."
      />
    );
  }

  if (selected === null) {
    return (
      <ProjectDashboardState
        title="Projects"
        heading="Project not found"
        description="This project is no longer available. Select another project from the sidebar."
      />
    );
  }

  return <ProjectDashboard project={selected} />;
}
