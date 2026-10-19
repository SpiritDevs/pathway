import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/usage")({
  beforeLoad: () => {
    throw redirect({ to: "/settings/usage", replace: true });
  },
});
