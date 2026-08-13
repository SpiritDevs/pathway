import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

import {
  MilestonesOverviewPage,
  parseMilestonesOverviewSearch,
} from "../components/issues/MilestonesOverviewPage";
import type {
  MilestonesOverviewSearch,
  MilestonesOverviewSearchPatch,
} from "../components/issues/milestonesOverview.logic";

function MilestonesRoute() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  // Replace rather than push, the way `/issues` does: the mode and the project filter are one
  // screen's state, and Back should leave milestones rather than walk a toggle press at a time.
  const onSearch = useCallback(
    (patch: MilestonesOverviewSearchPatch) => {
      void navigate({
        replace: true,
        search: (current: MilestonesOverviewSearch) => ({ ...current, ...patch }),
      });
    },
    [navigate],
  );

  return <MilestonesOverviewPage onSearch={onSearch} search={search} />;
}

export const Route = createFileRoute("/issues_/milestones")({
  validateSearch: parseMilestonesOverviewSearch,
  component: MilestonesRoute,
});
