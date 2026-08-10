import { createFileRoute } from "@tanstack/react-router";

import { UsagePage } from "../components/usage/UsagePage";

export const Route = createFileRoute("/settings/usage")({
  component: () => <UsagePage embedded />,
});
