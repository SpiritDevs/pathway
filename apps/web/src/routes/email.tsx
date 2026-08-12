import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

import { EmailView } from "../components/email/EmailView";
import {
  parseEmailSearch,
  type EmailSearch,
  type EmailSearchPatch,
} from "../components/email/emailView.logic";

function EmailRoute() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  // Replace rather than push: the inbox, the open message, and the tab are one screen's state, and
  // Back should leave Email rather than walk the last eight messages somebody read.
  const onSearch = useCallback(
    (patch: EmailSearchPatch) => {
      void navigate({
        replace: true,
        search: (current: EmailSearch) => ({ ...current, ...patch }),
      });
    },
    [navigate],
  );

  return <EmailView onSearch={onSearch} search={search} />;
}

export const Route = createFileRoute("/email")({
  validateSearch: parseEmailSearch,
  component: EmailRoute,
});
