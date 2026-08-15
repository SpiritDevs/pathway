import { createFileRoute } from "@tanstack/react-router";

import { CompanyEnvironmentsPanel } from "../components/settings/company/CompanyEnvironmentsPanel";

export const Route = createFileRoute("/settings/environments")({
  component: CompanyEnvironmentsPanel,
});
