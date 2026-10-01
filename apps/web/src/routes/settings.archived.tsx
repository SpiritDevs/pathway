import { createFileRoute } from "@tanstack/react-router";

import { ArchivedThreadsPanel } from "../components/settings/SettingsPanels";

export const Route = createFileRoute("/settings/archived")({
  validateSearch: (raw: Record<string, unknown>): { environment?: string | undefined } => ({
    environment: typeof raw.environment === "string" ? raw.environment : undefined,
  }),
  component: ArchivedThreadsPanel,
});
