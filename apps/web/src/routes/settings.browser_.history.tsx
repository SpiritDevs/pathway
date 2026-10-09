import { createFileRoute } from "@tanstack/react-router";

import { BrowserHistorySettings } from "../components/settings/browser/BrowserHistorySettings";
import { requireDesktopBrowserSettings } from "../components/settings/browser/requireDesktop";

export const Route = createFileRoute("/settings/browser_/history")({
  beforeLoad: requireDesktopBrowserSettings,
  component: BrowserHistorySettings,
});
