import { createFileRoute } from "@tanstack/react-router";
import { TimeTrackerSettingsPanel } from "../components/settings/TimeTrackerSettings";
export const Route = createFileRoute("/settings/time-tracker")({
  component: TimeTrackerSettingsPanel,
});
