import { createFileRoute } from "@tanstack/react-router";
import { OrchestratorFullView } from "../components/orchestrator/OrchestratorConversation";

export const Route = createFileRoute("/orchestrator")({
  component: OrchestratorFullView,
});
