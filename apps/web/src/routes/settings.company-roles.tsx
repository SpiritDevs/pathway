import { createFileRoute } from "@tanstack/react-router";

import { CompanyRolesPanel } from "../components/settings/company/CompanyTeamsRolesPanel";

export const Route = createFileRoute("/settings/company-roles")({
  component: CompanyRolesPanel,
});
