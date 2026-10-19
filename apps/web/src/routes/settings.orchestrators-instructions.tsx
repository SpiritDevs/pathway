import { createFileRoute } from "@tanstack/react-router";
import { OrchestratorSettings } from "../components/orchestrator/OrchestratorSettings";
export const Route = createFileRoute("/settings/orchestrators-instructions")({
  component: () => <OrchestratorSettings section="instructions" />,
});
