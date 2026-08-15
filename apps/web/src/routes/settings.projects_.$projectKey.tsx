import { createFileRoute } from "@tanstack/react-router";

import { ProjectSettingsPanel } from "../components/settings/ProjectSettingsPanel";

// Escaped from the index route (`projects_`) so the subpage renders the panel on its own rather
// than nesting inside the list.
function SettingsProjectDetailRoute() {
  const { projectKey } = Route.useParams();
  return <ProjectSettingsPanel projectKey={projectKey} />;
}

export const Route = createFileRoute("/settings/projects_/$projectKey")({
  component: SettingsProjectDetailRoute,
});
