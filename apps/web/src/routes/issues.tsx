import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

import { IssuesListPage } from "../components/issues/IssuesListPage";
import {
  parseIssuesSearch,
  type IssuesSearch,
  type IssuesSearchPatch,
} from "../components/issues/issuesList.logic";

function IssuesRoute() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  // Replace rather than push: tabs, filters, and the detail sheet are all one screen's state, and
  // Back should leave the tracker rather than walk the last eight rows somebody looked at.
  const onSearch = useCallback(
    (patch: IssuesSearchPatch) => {
      void navigate({
        replace: true,
        search: (current: IssuesSearch) => ({ ...current, ...patch }),
      });
    },
    [navigate],
  );

  return <IssuesListPage onSearch={onSearch} search={search} />;
}

export const Route = createFileRoute("/issues")({
  validateSearch: parseIssuesSearch,
  component: IssuesRoute,
});
