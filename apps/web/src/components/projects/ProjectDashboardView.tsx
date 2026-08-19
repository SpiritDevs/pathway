import { FolderKanbanIcon } from "lucide-react";

import { useAllEnvironmentShellsBootstrapped } from "~/state/entities";
import { WorkspaceViewFrame } from "../workspace/WorkspaceViewFrame";
import { useWorkspaceProjects } from "./useWorkspaceProjects";

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
          <p className="mt-3 max-w-[52ch] text-sm leading-6 text-muted-foreground sm:text-base">
            {description}
          </p>
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

  return (
    <ProjectDashboardState
      title={selected.displayName}
      heading="Dashboard pending"
      description={`The dashboard for ${selected.displayName} will be built here.`}
    />
  );
}
