import { createFileRoute, redirect } from "@tanstack/react-router";

import { ProjectDashboardView } from "../components/projects/ProjectDashboardView";

export const Route = createFileRoute("/projects/$projectKey")({
  beforeLoad: async ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: () => <ProjectDashboardView projectKey={Route.useParams().projectKey} />,
});
