import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/settings/company-teams")({
  beforeLoad: () => {
    throw redirect({ to: "/settings/members-teams", hash: "company-teams", replace: true });
  },
});
