import { scopedThreadKey } from "@spiritdevs/client-runtime/environment";
import {
  environmentBrowserHostClientId,
  type EnvironmentId,
  type OrchestrationV2ThreadPreviewActivity,
  type ScopedThreadRef,
} from "@spiritdevs/contracts";
import { useEffect, useRef } from "react";

import { openRemoteBrowser, useRemoteBrowserStore } from "~/browser/remoteBrowserStore";
import { usePreviewMiniPlayerStore } from "~/previewMiniPlayerStore";
import { isRemoteBrowserSurface, useRightPanelStore } from "~/rightPanelStore";

/** The remote tab the agent is using, when its browsing runs in the environment's browser. */
export function remoteAgentBrowserTabId(
  activity: OrchestrationV2ThreadPreviewActivity | null | undefined,
  environmentId: EnvironmentId,
): string | null {
  return activity?.tabId && activity.hostClientId === environmentBrowserHostClientId(environmentId)
    ? activity.tabId
    : null;
}

export type RemoteAgentBrowserRevealTarget = "panel" | "select" | "mini-player" | null;

/**
 * Mirrors the desktop host's "present" reveal for the environment browser: follow
 * inside an open remote panel, switch an open panel to it, or float it in the
 * mini-player when the panel is closed.
 */
export function resolveRemoteAgentBrowserReveal(input: {
  readonly tabId: string;
  readonly panelOpen: boolean;
  readonly panelShowsRemoteBrowser: boolean;
  readonly remoteSelectedTabId: string | null;
  readonly miniPlayerTabId: string | null;
}): RemoteAgentBrowserRevealTarget {
  if (input.panelOpen) {
    if (!input.panelShowsRemoteBrowser) return "panel";
    return input.remoteSelectedTabId === input.tabId ? null : "select";
  }
  return input.miniPlayerTabId === input.tabId ? null : "mini-player";
}

/**
 * Surfaces the agent's remote tab whenever its browsing moves: a new run,
 * provider session, or tab. The server only records activity when one of those
 * changes, so each change is a fresh "the agent is browsing here" signal. The
 * activity already present when the thread opens is history and is not revealed.
 */
export function useRemoteAgentBrowserReveal(
  threadRef: ScopedThreadRef | null,
  activity: OrchestrationV2ThreadPreviewActivity | null | undefined,
): void {
  const threadKey = threadRef ? scopedThreadKey(threadRef) : null;
  const activityKey =
    activity === undefined
      ? undefined
      : activity === null
        ? null
        : `${activity.runId}\u0000${activity.providerSessionId}\u0000${activity.hostClientId}\u0000${activity.tabId}`;
  const seen = useRef<{ threadKey: string | null; activityKey: string | null } | null>(null);
  const tabId = threadRef ? remoteAgentBrowserTabId(activity, threadRef.environmentId) : null;

  useEffect(() => {
    // Undefined means the thread projection has not loaded yet.
    if (!threadRef || activityKey === undefined) return;
    const previous = seen.current;
    seen.current = { threadKey, activityKey };
    if (previous?.threadKey !== threadKey || previous.activityKey === activityKey) return;
    if (tabId === null) return;
    const panel = useRightPanelStore.getState().byThreadKey[threadKey ?? ""] ?? null;
    const activeSurface =
      panel?.surfaces.find((surface) => surface.id === panel.activeSurfaceId) ?? null;
    const target = resolveRemoteAgentBrowserReveal({
      tabId,
      panelOpen: panel?.isOpen ?? false,
      panelShowsRemoteBrowser: isRemoteBrowserSurface(activeSurface),
      remoteSelectedTabId:
        useRemoteBrowserStore.getState().byThreadKey[threadKey ?? ""]?.selectedTabId ?? null,
      miniPlayerTabId:
        usePreviewMiniPlayerStore.getState().byThreadKey[threadKey ?? ""]?.tabId ?? null,
    });
    if (target === "panel" || target === "select") {
      openRemoteBrowser(threadRef, { tabId });
      usePreviewMiniPlayerStore.getState().close(threadRef);
    } else if (target === "mini-player") {
      usePreviewMiniPlayerStore.getState().open(threadRef, tabId, "remote");
    }
    // threadKey stands in for threadRef, whose identity churns on every thread update.
  }, [activityKey, tabId, threadKey]);
}
