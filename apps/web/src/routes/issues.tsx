import { createFileRoute } from "@tanstack/react-router";
import { CircleDotIcon } from "lucide-react";

import { PlaceholderWorkspacePage } from "../components/workspace/PlaceholderWorkspacePage";

function IssuesPage() {
  return (
    <PlaceholderWorkspacePage
      description="Track work, priorities, and progress across your projects."
      icon={CircleDotIcon}
      title="Issues"
    />
  );
}

export const Route = createFileRoute("/issues")({
  component: IssuesPage,
});
