import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

import { CalendarPage, parseCalendarSearch } from "../components/calendar/CalendarPage";
import type {
  CalendarSearch,
  CalendarSearchPatch,
} from "../components/calendar/calendarGrid.logic";

function CalendarRoute() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  // Replace rather than push, the way `/issues` and the milestones view do: the mode and the anchor
  // date are one screen's state, and Back should leave the calendar rather than walk the last eight
  // presses of the Next button.
  const onSearch = useCallback(
    (patch: CalendarSearchPatch) => {
      void navigate({
        replace: true,
        search: (current: CalendarSearch) => ({ ...current, ...patch }),
      });
    },
    [navigate],
  );

  return <CalendarPage onSearch={onSearch} search={search} />;
}

export const Route = createFileRoute("/calendar")({
  validateSearch: parseCalendarSearch,
  component: CalendarRoute,
});
