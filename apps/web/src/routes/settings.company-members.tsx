import { createFileRoute } from "@tanstack/react-router";

import { CompanyMembersPanel } from "../components/settings/company/CompanyMembersPanel";

export const Route = createFileRoute("/settings/company-members")({
  component: CompanyMembersPanel,
});
