import { createFileRoute } from "@tanstack/react-router";

import { BrowserExtensionsSettings } from "../components/settings/browser/BrowserExtensionsSettings";
import { requireDesktopBrowserSettings } from "../components/settings/browser/requireDesktop";

export const Route = createFileRoute("/settings/browser_/extensions")({
  beforeLoad: requireDesktopBrowserSettings,
  component: BrowserExtensionsSettings,
});
