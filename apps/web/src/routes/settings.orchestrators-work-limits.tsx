import { createFileRoute } from "@tanstack/react-router";
import { OrchestratorSettings } from "../components/orchestrator/OrchestratorSettings";
export const Route = createFileRoute("/settings/orchestrators-work-limits")({
  component: () => <OrchestratorSettings section="work-limits" />,
});
