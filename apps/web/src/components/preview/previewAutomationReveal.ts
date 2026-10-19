export type PreviewAutomationRevealMode = "present" | "follow";

export type PreviewAutomationRevealTarget = "panel" | "mini-player" | null;

const browserSurfaceId = (tabId: string): string => `browser:${tabId}`;

const isBrowserPanelSurfaceId = (surfaceId: string | null): boolean =>
  surfaceId !== null && surfaceId.startsWith("browser:");

/**
 * Where to surface the tab the agent is automating so its cursor and activity
 * stay visible. "present" is an explicit open/show request from the agent and
 * prefers the thread's browser panel when it is open; "follow" runs on
 * interactive operations and only retargets a browser surface the user is
 * already watching — it never opens UI the user has closed.
 */
export function resolvePreviewAutomationRevealTarget(input: {
  readonly mode: PreviewAutomationRevealMode;
  readonly tabId: string;
  readonly panelOpen: boolean;
  readonly panelActiveSurfaceId: string | null;
  readonly miniPlayerTabId: string | null;
}): PreviewAutomationRevealTarget {
  const targetSurfaceId = browserSurfaceId(input.tabId);
  if (input.mode === "present") {
    if (input.panelOpen) {
      return input.panelActiveSurfaceId === targetSurfaceId ? null : "panel";
    }
    return input.miniPlayerTabId === input.tabId ? null : "mini-player";
  }
  if (input.panelOpen && isBrowserPanelSurfaceId(input.panelActiveSurfaceId)) {
    return input.panelActiveSurfaceId === targetSurfaceId ? null : "panel";
  }
  if (input.miniPlayerTabId !== null && input.miniPlayerTabId !== input.tabId) {
    return "mini-player";
  }
  return null;
}
