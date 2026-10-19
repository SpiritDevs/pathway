import { createFileRoute } from "@tanstack/react-router";

import { CompanyTeamsPanel } from "../components/settings/company/CompanyTeamsRolesPanel";

export const Route = createFileRoute("/settings/company-teams")({
  component: CompanyTeamsPanel,
});
