"use client";

import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  FILL_PREVIEW_VIEWPORT,
  type DesktopPreviewBridge,
  type DesktopPreviewPopupRequest,
  type PreviewSessionSnapshot,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { useEffect, useMemo, useRef } from "react";

import { isElectron } from "~/env";
import { useTheme } from "~/hooks/useTheme";
import {
  applyPreviewServerSnapshot,
  readThreadPreviewState,
  updatePreviewServerSnapshot,
  useActivePreviewSessions,
} from "~/previewStateStore";
import { useRightPanelStore } from "~/rightPanelStore";
import { previewEnvironment } from "~/state/preview";
import { useAtomCommand } from "~/state/use-atom-command";
import { toastManager } from "~/components/ui/toast";

import { readPreviewAnnotationTheme } from "./annotationTheme";
import { useBrowserPointerStore } from "./browserPointerStore";
import { HostedBrowserWebview } from "./HostedBrowserWebview";
import {
  releaseNativePreviewPopup,
  reserveNativePreviewPopup,
  useNativePreviewPopupStore,
} from "./nativePreviewPopupStore";
import { previewRuntimeTabId } from "./previewRuntimeTabId";

export const popupActivation = (
  request: Pick<DesktopPreviewPopupRequest, "disposition">,
): "foreground" | "background" =>
  request.disposition === "background-tab" ? "background" : "foreground";

export const popupServerSeedUrl = (rawUrl: string): string | undefined => {
  try {
    const url = new URL(rawUrl);
    return url.protocol === "http:" || url.protocol === "https:" ? rawUrl : undefined;
  } catch {
    return undefined;
  }
};

interface NativePreviewPopupCoordination {
  readonly request: DesktopPreviewPopupRequest;
  readonly threadRef: ScopedThreadRef;
  readonly desktop: Pick<DesktopPreviewBridge, "adoptPopup" | "closeTab" | "discardPopup">;
  readonly openSession: () => Promise<PreviewSessionSnapshot>;
  readonly closeSession: () => Promise<void>;
  readonly runtimeTabId: (snapshot: PreviewSessionSnapshot) => string;
  readonly reconcile: (
    snapshot: PreviewSessionSnapshot,
    activation: "foreground" | "background",
  ) => void;
  readonly openSurface: (tabId: string, activate: boolean) => void;
  readonly reserve: (tabId: string) => void;
  readonly release: (tabId: string) => void;
  readonly isDisposed: () => boolean;
}

export async function coordinateNativePreviewPopup({
  request,
  desktop,
  openSession,
  closeSession,
  runtimeTabId,
  reconcile,
  openSurface,
  reserve,
  release,
  isDisposed,
}: NativePreviewPopupCoordination): Promise<void> {
  const activation = popupActivation(request);
  let opened = false;
  let adoptedRuntimeTabId: string | null = null;
  reserve(request.popupId);
  try {
    const snapshot = await openSession();
    opened = true;
    if (isDisposed()) throw new Error("The desktop popup owner was closed during adoption.");
    adoptedRuntimeTabId = runtimeTabId(snapshot);
    await desktop.adoptPopup(request.popupId, adoptedRuntimeTabId);
    if (isDisposed()) throw new Error("The desktop popup owner was closed during adoption.");
    reconcile(snapshot, activation);
    openSurface(snapshot.tabId, activation === "foreground");
  } catch (error) {
    await desktop.discardPopup(request.popupId).catch(() => undefined);
    if (adoptedRuntimeTabId !== null) {
      await desktop.closeTab(adoptedRuntimeTabId).catch(() => undefined);
    }
    release(request.popupId);
    if (opened) await closeSession().catch(() => undefined);
    throw error;
  }
}

export function ElectronBrowserHost() {
  const { resolvedTheme } = useTheme();
  const previewByThreadKey = useActivePreviewSessions();
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: false });
  const closePreview = useAtomCommand(previewEnvironment.close, { reportFailure: false });
  const pendingPopupIdsRef = useRef(new Set<string>());
  const sessions = useMemo(
    () =>
      Object.entries(previewByThreadKey).flatMap(([threadKey, previewState]) => {
        const threadRef = parseScopedThreadKey(threadKey);
        return threadRef
          ? Object.values(previewState.sessions).map((snapshot) => ({
              threadRef,
              snapshot,
              runtimeTabId: previewRuntimeTabId(
                threadRef,
                previewState.serverEpoch,
                snapshot.tabId,
              ),
              zoomFactor: previewState.desktopByTabId[snapshot.tabId]?.zoomFactor ?? 1,
            }))
          : [];
      }),
    [previewByThreadKey],
  );
  const sourceByRuntimeTabId = useMemo(
    () => new Map(sessions.map((session) => [session.runtimeTabId, session.threadRef] as const)),
    [sessions],
  );
  const sourceByRuntimeTabIdRef = useRef(sourceByRuntimeTabId);
  sourceByRuntimeTabIdRef.current = sourceByRuntimeTabId;

  useEffect(() => {
    const preview = window.desktopBridge?.preview;
    if (!preview) return;
    let disposed = false;
    const unsubscribe = preview.onPopupRequest((request) => {
      if (
        pendingPopupIdsRef.current.has(request.popupId) ||
        useNativePreviewPopupStore.getState().tabIds.has(request.popupId)
      ) {
        return;
      }
      const threadRef = sourceByRuntimeTabIdRef.current.get(request.sourceRuntimeTabId);
      if (!threadRef) {
        void preview.discardPopup(request.popupId).catch(() => undefined);
        return;
      }
      pendingPopupIdsRef.current.add(request.popupId);
      void (async () => {
        try {
          const seedUrl = popupServerSeedUrl(request.url);
          await coordinateNativePreviewPopup({
            request,
            threadRef,
            desktop: preview,
            openSession: async () => {
              const result = await openPreview({
                environmentId: threadRef.environmentId,
                input: {
                  threadId: threadRef.threadId,
                  requestedTabId: request.popupId,
                  activation: popupActivation(request),
                  ...(seedUrl === undefined ? {} : { url: seedUrl }),
                },
              });
              if (result._tag === "Failure") throw squashAtomCommandFailure(result);
              return result.value;
            },
            closeSession: async () => {
              await closePreview({
                environmentId: threadRef.environmentId,
                input: { threadId: threadRef.threadId, tabId: request.popupId },
              });
            },
            runtimeTabId: (snapshot) => {
              const state = readThreadPreviewState(threadRef);
              return previewRuntimeTabId(threadRef, state.serverEpoch, snapshot.tabId);
            },
            reconcile: (snapshot, activation) => {
              if (activation === "background") {
                updatePreviewServerSnapshot(threadRef, snapshot);
              } else {
                applyPreviewServerSnapshot(threadRef, snapshot);
              }
            },
            openSurface: (tabId, activate) =>
              useRightPanelStore.getState().openBrowser(threadRef, tabId, activate),
            reserve: reserveNativePreviewPopup,
            release: releaseNativePreviewPopup,
            isDisposed: () => disposed,
          });
        } catch (error) {
          if (!disposed) {
            toastManager.add({
              type: "error",
              title: "Unable to open browser popup",
              description:
                error instanceof Error ? error.message : "The popup could not be adopted.",
            });
          }
        } finally {
          pendingPopupIdsRef.current.delete(request.popupId);
        }
      })();
    });
    return () => {
      disposed = true;
      unsubscribe();
      for (const popupId of pendingPopupIdsRef.current) {
        void preview.discardPopup(popupId).catch(() => undefined);
        releaseNativePreviewPopup(popupId);
      }
      pendingPopupIdsRef.current.clear();
    };
  }, [closePreview, openPreview]);

  useEffect(() => {
    const liveServerTabIds = new Set(sessions.map(({ snapshot }) => snapshot.tabId));
    for (const popupTabId of useNativePreviewPopupStore.getState().tabIds) {
      if (!liveServerTabIds.has(popupTabId) && !pendingPopupIdsRef.current.has(popupTabId)) {
        releaseNativePreviewPopup(popupTabId);
      }
    }
  }, [sessions]);

  useEffect(() => {
    const preview = window.desktopBridge?.preview;
    if (!preview) return;

    let lastSerializedTheme = "";
    const syncTheme = () => {
      const theme = readPreviewAnnotationTheme();
      const serializedTheme = JSON.stringify(theme);
      if (serializedTheme === lastSerializedTheme) return;
      lastSerializedTheme = serializedTheme;
      void preview.setAnnotationTheme(theme).catch(() => {
        lastSerializedTheme = "";
      });
    };
    const frameId = window.requestAnimationFrame(syncTheme);
    const observer = new MutationObserver(syncTheme);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style"],
    });
    const headObserver = new MutationObserver(syncTheme);
    headObserver.observe(document.head, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    return () => {
      window.cancelAnimationFrame(frameId);
      observer.disconnect();
      headObserver.disconnect();
    };
  }, [resolvedTheme]);

  useEffect(() => {
    const preview = window.desktopBridge?.preview;
    if (!preview) return;
    return preview.onPointerEvent((event) => {
      useBrowserPointerStore.getState().apply(event);
    });
  }, []);

  if (!isElectron) return null;
  return (
    <div className="contents" data-electron-browser-host>
      {sessions.map(({ threadRef, snapshot, runtimeTabId, zoomFactor }) => {
        const url = snapshot.navStatus._tag === "Idle" ? null : snapshot.navStatus.url;
        return (
          <HostedBrowserWebview
            key={runtimeTabId}
            threadRef={threadRef}
            tabId={snapshot.tabId}
            runtimeTabId={runtimeTabId}
            initialUrl={url}
            viewport={snapshot.viewport ?? FILL_PREVIEW_VIEWPORT}
            zoomFactor={zoomFactor}
          />
        );
      })}
    </div>
  );
}
