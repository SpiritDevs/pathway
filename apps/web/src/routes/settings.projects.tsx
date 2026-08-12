import { createFileRoute } from "@tanstack/react-router";

import { ProjectsSettingsIndexPanel } from "../components/settings/ProjectsSettingsIndexPanel";

export const Route = createFileRoute("/settings/projects")({
  component: ProjectsSettingsIndexPanel,
});
