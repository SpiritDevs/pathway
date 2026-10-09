import { createFileRoute } from "@tanstack/react-router";

import { BrowserSettings } from "../components/settings/browser/BrowserSettings";
import { requireDesktopBrowserSettings } from "../components/settings/browser/requireDesktop";

export const Route = createFileRoute("/settings/browser")({
  beforeLoad: requireDesktopBrowserSettings,
  component: BrowserSettings,
});
