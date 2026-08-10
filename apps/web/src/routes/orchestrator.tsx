import { createFileRoute } from "@tanstack/react-router";
import { BotIcon } from "lucide-react";

import { PlaceholderWorkspacePage } from "../components/workspace/PlaceholderWorkspacePage";

function OrchestratorPage() {
  return (
    <PlaceholderWorkspacePage
      description="Coordinate your AI agents, tasks, and workflows from here."
      icon={BotIcon}
      title="Orchestrator AI"
    />
  );
}

export const Route = createFileRoute("/orchestrator")({
  component: OrchestratorPage,
});
