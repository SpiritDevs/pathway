import { createFileRoute } from "@tanstack/react-router";

import { BrowserContactInfoSettings } from "../components/settings/browser/BrowserContactInfoSettings";
import { requireDesktopBrowserSettings } from "../components/settings/browser/requireDesktop";

export const Route = createFileRoute("/settings/browser_/contact-info")({
  beforeLoad: requireDesktopBrowserSettings,
  component: BrowserContactInfoSettings,
});
