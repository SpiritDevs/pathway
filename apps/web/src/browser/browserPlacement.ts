import { useAtomValue } from "@effect/atom-react";
import type { ConnectionTarget } from "@spiritdevs/client-runtime/connection";
import type { EnvironmentId } from "@spiritdevs/contracts";

import { environmentCatalog } from "~/connection/catalog";
import { isDesktopLocalConnectionTarget } from "~/connection/desktopLocal";
import { previewBridge } from "~/components/preview/previewBridge";
import { appAtomRegistry } from "~/rpc/atomRegistry";

/**
 * Where a browser tab runs. A local tab is the desktop's own webview, so its
 * `localhost` is this machine. A remote tab is Chromium on the thread's
 * environment, streamed to the client, so its `localhost` is the environment.
 */
export type BrowserPlacement = "local" | "remote";

/**
 * The streamed environment browser is switched off until the local browser can reach
 * a remote machine's localhost. Flip this to bring every remote entry point back.
 */
export const remoteBrowserEnabled = false;

/** Only the desktop app has a browser of its own. */
export const hasLocalBrowser = previewBridge !== null;

/** The desktop's primary backend and its desktop-local (WSL) backends share this machine. */
export function isThisMachineTarget(target: ConnectionTarget | undefined): boolean {
  return (
    target !== undefined &&
    (target._tag === "PrimaryConnectionTarget" || isDesktopLocalConnectionTarget(target))
  );
}

/**
 * Whether this client's own browser shares `localhost` with the environment.
 * Always false without a local browser, so web and mobile always browse remotely.
 */
export function readEnvironmentOnThisMachine(environmentId: EnvironmentId): boolean {
  const catalog = appAtomRegistry.get(environmentCatalog.catalogValueAtom);
  return hasLocalBrowser && isThisMachineTarget(catalog.entries.get(environmentId)?.target);
}

export function useEnvironmentOnThisMachine(environmentId: EnvironmentId | null): boolean {
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  return (
    hasLocalBrowser &&
    environmentId !== null &&
    isThisMachineTarget(catalog.entries.get(environmentId)?.target)
  );
}

/** Tabs open where `localhost` means the environment: locally only on this machine. */
export function readDefaultBrowserPlacement(environmentId: EnvironmentId): BrowserPlacement {
  return !remoteBrowserEnabled || readEnvironmentOnThisMachine(environmentId) ? "local" : "remote";
}

/** "This Mac" reads better than a hostname for the machine the user is sitting at. */
export function localMachineLabel(): string {
  if (typeof navigator === "undefined") return "This computer";
  return /mac/i.test(navigator.platform) ? "This Mac" : "This computer";
}
