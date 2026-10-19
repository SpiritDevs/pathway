import { createFileRoute } from "@tanstack/react-router";
import { WorkspaceOverview } from "../components/workspace/WorkspaceOverview";

export const Route = createFileRoute("/")({ component: WorkspaceOverview });
