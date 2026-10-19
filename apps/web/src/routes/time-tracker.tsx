import { createFileRoute } from "@tanstack/react-router";

import { TimeTrackerView } from "../components/timeTracker/TimeTrackerView";

export const Route = createFileRoute("/time-tracker")({
  component: TimeTrackerView,
});
