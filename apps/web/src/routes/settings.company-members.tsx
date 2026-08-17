import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/settings/company-members")({
  beforeLoad: () => {
    throw redirect({ to: "/settings/members-teams", hash: "company-members", replace: true });
  },
});
