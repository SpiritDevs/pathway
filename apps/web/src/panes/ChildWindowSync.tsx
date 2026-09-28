import { useRouterState } from "@tanstack/react-router";
import { useEffect } from "react";

import { announcePageWindow } from "./pageWindows";
import { describePaneLocation } from "./paneDestinations";
import { childWindowId } from "./windowMode";

/**
 * Keeps a torn-out window's title on its page: "Email - Pathway". The desktop
 * shell mirrors `document.title` onto the native window; a web popup also
 * announces its page and title, and its closing, to the tab that opened it.
 * Mount only in a torn-out window.
 */
export function ChildWindowSync({ appName }: { readonly appName: string }) {
  const href = useRouterState({ select: (state) => state.location.href });
  const title = `${describePaneLocation(href)} - ${appName}`;

  useEffect(() => {
    document.title = title;
    if (childWindowId) announcePageWindow({ type: "state", id: childWindowId, href, title });
  }, [href, title]);

  useEffect(() => {
    const id = childWindowId;
    if (!id) return;
    const onPageHide = () => announcePageWindow({ type: "closed", id });
    window.addEventListener("pagehide", onPageHide);
    return () => window.removeEventListener("pagehide", onPageHide);
  }, []);

  return null;
}
