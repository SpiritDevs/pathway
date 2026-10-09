import { createFileRoute } from "@tanstack/react-router";

import { BrowserPasswordsPage } from "../components/settings/browser/BrowserPasswordsPage";
import { requireDesktopBrowserSettings } from "../components/settings/browser/requireDesktop";

export const Route = createFileRoute("/settings/browser_/passwords")({
  beforeLoad: requireDesktopBrowserSettings,
  component: BrowserPasswordsPage,
});
