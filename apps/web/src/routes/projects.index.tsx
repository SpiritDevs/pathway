import { createFileRoute } from "@tanstack/react-router";

import { ProjectsIndexView } from "../components/projects/ProjectDashboardView";

export const Route = createFileRoute("/projects/")({
  component: ProjectsIndexView,
});
