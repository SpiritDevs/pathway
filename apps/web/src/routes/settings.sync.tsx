import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/settings/sync")({
  beforeLoad: () => {
    throw redirect({ to: "/settings/diagnostics", hash: "company-sync", replace: true });
  },
});
