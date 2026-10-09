import type { BrowserLinkTarget, ClientSettings } from "@spiritdevs/contracts";
import { isLoopbackHost } from "@spiritdevs/shared/preview";

/** Where a clicked link opens, per Settings → Browser → Web links and Local URLs. */
export function browserLinkTarget(
  url: string,
  settings: Pick<ClientSettings, "browserWebLinkTarget" | "browserLocalLinkTarget">,
): BrowserLinkTarget {
  if (!URL.canParse(url)) return "external";
  return isLoopbackHost(new URL(url).hostname)
    ? settings.browserLocalLinkTarget
    : settings.browserWebLinkTarget;
}
