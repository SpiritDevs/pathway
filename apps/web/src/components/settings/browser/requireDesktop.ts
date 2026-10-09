import { redirect } from "@tanstack/react-router";

import { isElectron } from "~/env";

/** Route guard for Settings → Browser: only the desktop app has a built-in browser. */
export function requireDesktopBrowserSettings(): void {
  if (!isElectron) {
    throw redirect({ to: "/settings/general", replace: true });
  }
}
