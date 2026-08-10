import { createFileRoute } from "@tanstack/react-router";
import { CalendarDaysIcon } from "lucide-react";

import { PlaceholderWorkspacePage } from "../components/workspace/PlaceholderWorkspacePage";

function CalendarPage() {
  return (
    <PlaceholderWorkspacePage
      description="Your calendar and upcoming schedule will appear here."
      icon={CalendarDaysIcon}
      title="Calendar"
    />
  );
}

export const Route = createFileRoute("/calendar")({
  component: CalendarPage,
});
