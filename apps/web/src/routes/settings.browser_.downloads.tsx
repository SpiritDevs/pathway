import { createFileRoute } from "@tanstack/react-router";

import { BrowserDownloadsSettings } from "../components/settings/browser/BrowserDownloadsSettings";
import { requireDesktopBrowserSettings } from "../components/settings/browser/requireDesktop";

export const Route = createFileRoute("/settings/browser_/downloads")({
  beforeLoad: requireDesktopBrowserSettings,
  component: BrowserDownloadsSettings,
});
