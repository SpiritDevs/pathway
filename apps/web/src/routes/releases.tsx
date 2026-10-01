import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

import { parseReleasesSearch, type ReleasesSearch } from "../components/releases/Releases.logic";
import { ReleasesView } from "../components/releases/ReleasesView";

function ReleasesRoute() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  // Tabs and the confirmation are one screen's state, so they replace rather than push.
  const onSearch = useCallback(
    (patch: Partial<ReleasesSearch>) => {
      void navigate({
        replace: true,
        search: (current: ReleasesSearch) => ({ ...current, ...patch }),
      });
    },
    [navigate],
  );

  return <ReleasesView onSearch={onSearch} search={search} />;
}

export const Route = createFileRoute("/releases")({
  validateSearch: parseReleasesSearch,
  component: ReleasesRoute,
});
