import type * as Electron from "electron";

// Calls `revoke` when a renderer can no longer undo what it asked for: a full
// main-frame navigation, a renderer crash, or destruction (which also covers the
// window closing or being replaced). Returns the listener cleanup.
export function watchRendererLifetime(
  webContents: Electron.WebContents,
  revoke: () => void,
): () => void {
  const onNavigation = (
    _event: Electron.Event,
    _url: string,
    isInPlace: boolean,
    isMainFrame: boolean,
  ) => {
    if (isMainFrame && !isInPlace) revoke();
  };
  const onGone = () => revoke();
  const dispose = () => {
    webContents.removeListener("did-start-navigation", onNavigation);
    webContents.removeListener("render-process-gone", onGone);
    webContents.removeListener("destroyed", onDestroyed);
  };
  const onDestroyed = () => {
    revoke();
    dispose();
  };
  webContents.on("did-start-navigation", onNavigation);
  webContents.on("render-process-gone", onGone);
  webContents.once("destroyed", onDestroyed);
  return dispose;
}
