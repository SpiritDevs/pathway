import { createFileRoute } from "@tanstack/react-router";

import { CompanyCalendarsPanel } from "../components/settings/company/CompanyCalendarsPanel";

export const Route = createFileRoute("/settings/calendars")({
  component: CompanyCalendarsPanel,
});
