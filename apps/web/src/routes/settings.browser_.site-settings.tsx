import { createFileRoute } from "@tanstack/react-router";

import { BrowserSiteSettings } from "../components/settings/browser/BrowserSiteSettings";
import { requireDesktopBrowserSettings } from "../components/settings/browser/requireDesktop";

export const Route = createFileRoute("/settings/browser_/site-settings")({
  beforeLoad: requireDesktopBrowserSettings,
  component: BrowserSiteSettings,
});
