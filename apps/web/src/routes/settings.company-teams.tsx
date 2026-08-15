import { createFileRoute } from "@tanstack/react-router";

import { CompanyTeamsRolesPanel } from "../components/settings/company/CompanyTeamsRolesPanel";

export const Route = createFileRoute("/settings/company-teams")({
  component: CompanyTeamsRolesPanel,
});
