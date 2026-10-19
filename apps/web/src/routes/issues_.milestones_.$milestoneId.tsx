import { createFileRoute } from "@tanstack/react-router";

import { MilestoneDetailPage } from "../components/issues/MilestoneDetailPage";

function MilestoneDetailRoute() {
  const { milestoneId } = Route.useParams();
  return <MilestoneDetailPage milestoneId={milestoneId} />;
}

export const Route = createFileRoute("/issues_/milestones_/$milestoneId")({
  component: MilestoneDetailRoute,
});
