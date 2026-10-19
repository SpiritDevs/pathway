import { createFileRoute } from "@tanstack/react-router";

import { CompanyMembersTeamsPanel } from "../components/settings/company/CompanyMembersTeamsPanel";

export const Route = createFileRoute("/settings/members-teams")({
  component: CompanyMembersTeamsPanel,
});
