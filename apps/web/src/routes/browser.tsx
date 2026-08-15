import { createFileRoute } from "@tanstack/react-router";

import { BrowserView } from "../components/browser/BrowserView";

export const Route = createFileRoute("/browser")({
  component: BrowserView,
});
