import { createFileRoute } from "@tanstack/react-router";
import { LayoutDashboardIcon } from "lucide-react";

import { PlaceholderWorkspacePage } from "../components/workspace/PlaceholderWorkspacePage";

function DashboardPage() {
  return (
    <PlaceholderWorkspacePage
      description="Your workspace overview will appear here as Pathway grows."
      icon={LayoutDashboardIcon}
      title="Dashboard"
    />
  );
}

export const Route = createFileRoute("/")({
  component: DashboardPage,
});
