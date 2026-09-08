"use client";

import { parseScopedThreadKey } from "@spiritdevs/client-runtime/environment";
import { squashAtomCommandFailure } from "@spiritdevs/client-runtime/state/runtime";
import {
  FILL_PREVIEW_VIEWPORT,
  type DesktopPreviewBridge,
  type DesktopPreviewPopupRequest,
  type PreviewSessionSnapshot,
  type ScopedThreadRef,
} from "@spiritdevs/contracts";
import { useEffect, useMemo, useRef, useState } from "react";

import { isElectron } from "~/env";
import { useTheme } from "~/hooks/useTheme";
import {
  applyPreviewServerSnapshot,
  beginPreviewSessionClose,
  readThreadPreviewState,
  subscribeThreadPreviewState,
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
  forgetNativePreviewPopup,
  listNativePreviewPopupRecoveries,
  markNativePreviewPopupSessionObserved,
  type NativePreviewPopupRecovery,
  releaseNativePreviewPopup,
  rememberNativePreviewPopup,
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
  readonly forget: (tabId: string) => void;
  readonly isDisposed: () => boolean;
}

export async function coordinateNativePreviewPopup({
  request,
  threadRef,
  desktop,
  openSession,
  closeSession,
  runtimeTabId,
  reconcile,
  openSurface,
  reserve,
  release,
  forget,
  isDisposed,
}: NativePreviewPopupCoordination): Promise<void> {
  const activation = popupActivation(request);
  let opened = false;
  let adoptedRuntimeTabId: string | null = null;
  reserve(request.popupId);
  let cancelled = false;
  const unsubscribe = subscribeThreadPreviewState(threadRef, (state, previous) => {
    if (
      state.suppressedTabIds.has(request.popupId) ||
      (previous.sessions[request.popupId] && !state.sessions[request.popupId]) ||
      (previous.serverEpoch !== null && state.serverEpoch !== previous.serverEpoch)
    ) {
      cancelled = true;
    }
  });
  try {
    const snapshot = await openSession();
    opened = true;
    if (cancelled || isDisposed())
      throw new Error("The desktop popup owner was closed during adoption.");
    adoptedRuntimeTabId = runtimeTabId(snapshot);
    await desktop.adoptPopup(request.popupId, adoptedRuntimeTabId);
    if (cancelled || isDisposed())
      throw new Error("The desktop popup owner was closed during adoption.");
    reconcile(snapshot, activation);
    openSurface(snapshot.tabId, activation === "foreground");
  } catch (error) {
    if (opened) {
      beginPreviewSessionClose(threadRef, request.popupId);
      useRightPanelStore.getState().closeSurface(threadRef, `browser:${request.popupId}`);
    }
    await desktop.discardPopup(request.popupId).catch(() => undefined);
    if (adoptedRuntimeTabId !== null) {
      await desktop.closeTab(adoptedRuntimeTabId).catch(() => undefined);
    }
    if (opened) {
      try {
        await closeSession();
      } catch {
        throw new Error("The popup closed, but its browser session could not be cleaned up.", {
          cause: error,
        });
      }
    }
    forget(request.popupId);
    release(request.popupId);
    throw error;
  } finally {
    unsubscribe();
  }
}

export async function recoverNativePreviewPopup(input: {
  readonly recovery: NativePreviewPopupRecovery;
  readonly desktop: Pick<DesktopPreviewBridge, "closeTab" | "discardPopup">;
  readonly currentServerEpoch: string | null;
  readonly logicalSessionObserved: boolean;
  readonly closeSession: () => Promise<void>;
  readonly forget: (tabId: string) => void;
}): Promise<boolean> {
  const { recovery } = input;
  await input.desktop.discardPopup(recovery.tabId).catch(() => undefined);
  if (recovery.runtimeTabId !== undefined) {
    await input.desktop.closeTab(recovery.runtimeTabId).catch(() => undefined);
  }
  if (
    recovery.serverEpoch !== null &&
    input.currentServerEpoch !== null &&
    recovery.serverEpoch !== input.currentServerEpoch
  ) {
    input.forget(recovery.tabId);
    return true;
  }
  await input.closeSession();
  if (recovery.runtimeTabId === undefined && !input.logicalSessionObserved) return false;
  input.forget(recovery.tabId);
  return true;
}

export const previewServerRevisionChanged = (
  previous: Pick<ReturnType<typeof readThreadPreviewState>, "serverEpoch" | "serverRevision">,
  current: Pick<ReturnType<typeof readThreadPreviewState>, "serverEpoch" | "serverRevision">,
): boolean =>
  previous.serverEpoch !== current.serverEpoch ||
  previous.serverRevision !== current.serverRevision;

export function ElectronBrowserHost() {
  const { resolvedTheme } = useTheme();
  const previewByThreadKey = useActivePreviewSessions();
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: false });
  const closePreview = useAtomCommand(previewEnvironment.close, { reportFailure: false });
  const [threadRecoveryRevision, setThreadRecoveryRevision] = useState(0);
  const storedRecoveryRevision = useNativePreviewPopupStore((state) => state.recoveryRevision);
  const pendingPopupIdsRef = useRef(new Set<string>());
  const ownedPopupIdsRef = useRef(new Set<string>());
  const recoveringPopupIdsRef = useRef(new Set<string>());
  const nativeSessionsRef = useRef(
    new Map<string, { threadRef: ScopedThreadRef; tabId: string }>(),
  );
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
    const unsubscribes = listNativePreviewPopupRecoveries().map((recovery) =>
      subscribeThreadPreviewState(recovery.threadRef, (state, previous) => {
        if (
          state.serverEpoch !== previous.serverEpoch ||
          state.serverRevision !== previous.serverRevision
        ) {
          if (state.sessions[recovery.tabId] !== undefined) {
            markNativePreviewPopupSessionObserved(recovery.tabId);
          }
          setThreadRecoveryRevision((revision) => revision + 1);
        }
      }),
    );
    return () => {
      for (const unsubscribe of unsubscribes) unsubscribe();
    };
  }, [storedRecoveryRevision]);

  useEffect(() => {
    const preview = window.desktopBridge?.preview;
    if (!preview?.onPopupRequest || !preview.onPopupClosed) return;
    let disposed = false;
    const unsubscribeClosed = preview.onPopupClosed(({ runtimeTabId }) => {
      const session = nativeSessionsRef.current.get(runtimeTabId);
      if (!session) return;
      nativeSessionsRef.current.delete(runtimeTabId);
      beginPreviewSessionClose(session.threadRef, session.tabId);
      useRightPanelStore.getState().closeSurface(session.threadRef, `browser:${session.tabId}`);
      ownedPopupIdsRef.current.delete(session.tabId);
      void closePreview({
        environmentId: session.threadRef.environmentId,
        input: { threadId: session.threadRef.threadId, tabId: session.tabId },
      })
        .then((result) => {
          if (result._tag === "Failure") throw squashAtomCommandFailure(result);
          forgetNativePreviewPopup(session.tabId);
        })
        .catch(() => {
          if (!disposed) {
            toastManager.add({ type: "error", title: "Could not close the browser session" });
          }
        });
    });
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
      ownedPopupIdsRef.current.add(request.popupId);
      rememberNativePreviewPopup({
        tabId: request.popupId,
        threadRef,
        serverEpoch: readThreadPreviewState(threadRef).serverEpoch,
      });
      void (async () => {
        let adoptedRuntimeTabId: string | null = null;
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
              const result = await closePreview({
                environmentId: threadRef.environmentId,
                input: { threadId: threadRef.threadId, tabId: request.popupId },
              });
              if (result._tag === "Failure") throw squashAtomCommandFailure(result);
            },
            runtimeTabId: (snapshot) => {
              const state = readThreadPreviewState(threadRef);
              const runtimeTabId = previewRuntimeTabId(
                threadRef,
                state.serverEpoch,
                snapshot.tabId,
              );
              adoptedRuntimeTabId = runtimeTabId;
              nativeSessionsRef.current.set(runtimeTabId, { threadRef, tabId: snapshot.tabId });
              rememberNativePreviewPopup({
                tabId: snapshot.tabId,
                threadRef,
                serverEpoch: state.serverEpoch,
                runtimeTabId,
              });
              return runtimeTabId;
            },
            reconcile: (snapshot, activation) => {
              const latest = readThreadPreviewState(threadRef).sessions[snapshot.tabId] ?? snapshot;
              if (activation === "background") {
                updatePreviewServerSnapshot(threadRef, latest);
              } else {
                applyPreviewServerSnapshot(threadRef, latest);
              }
            },
            openSurface: (tabId, activate) =>
              useRightPanelStore.getState().openBrowser(threadRef, tabId, activate),
            reserve: reserveNativePreviewPopup,
            release: releaseNativePreviewPopup,
            forget: forgetNativePreviewPopup,
            isDisposed: () =>
              disposed ||
              (adoptedRuntimeTabId !== null && !nativeSessionsRef.current.has(adoptedRuntimeTabId)),
          });
        } catch (error) {
          if (adoptedRuntimeTabId !== null) nativeSessionsRef.current.delete(adoptedRuntimeTabId);
          ownedPopupIdsRef.current.delete(request.popupId);
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
      unsubscribeClosed();
      for (const popupId of pendingPopupIdsRef.current) {
        void preview.discardPopup(popupId).catch(() => undefined);
        releaseNativePreviewPopup(popupId);
      }
      pendingPopupIdsRef.current.clear();
    };
  }, [closePreview, openPreview]);

  useEffect(() => {
    const preview = window.desktopBridge?.preview;
    if (!preview) return;
    for (const recovery of listNativePreviewPopupRecoveries()) {
      if (
        ownedPopupIdsRef.current.has(recovery.tabId) ||
        recoveringPopupIdsRef.current.has(recovery.tabId)
      ) {
        continue;
      }
      recoveringPopupIdsRef.current.add(recovery.tabId);
      const previewState = readThreadPreviewState(recovery.threadRef);
      const logicalSessionObserved =
        recovery.logicalSessionObserved === true ||
        previewState.sessions[recovery.tabId] !== undefined;
      if (logicalSessionObserved && recovery.logicalSessionObserved !== true) {
        markNativePreviewPopupSessionObserved(recovery.tabId);
      }
      if (recovery.runtimeTabId !== undefined || logicalSessionObserved) {
        beginPreviewSessionClose(recovery.threadRef, recovery.tabId);
      }
      useRightPanelStore.getState().closeSurface(recovery.threadRef, `browser:${recovery.tabId}`);
      void (async () => {
        await recoverNativePreviewPopup({
          recovery,
          desktop: preview,
          currentServerEpoch: previewState.serverEpoch,
          logicalSessionObserved,
          closeSession: async () => {
            const result = await closePreview({
              environmentId: recovery.threadRef.environmentId,
              input: { threadId: recovery.threadRef.threadId, tabId: recovery.tabId },
            });
            if (result._tag === "Failure") throw squashAtomCommandFailure(result);
          },
          forget: forgetNativePreviewPopup,
        });
      })()
        .catch(() => {
          // Keep the durable reservation so a stale server snapshot cannot mount a replacement.
        })
        .finally(() => {
          recoveringPopupIdsRef.current.delete(recovery.tabId);
          if (
            previewServerRevisionChanged(previewState, readThreadPreviewState(recovery.threadRef))
          ) {
            setThreadRecoveryRevision((revision) => revision + 1);
          }
        });
    }
  }, [closePreview, sessions, storedRecoveryRevision, threadRecoveryRevision]);

  useEffect(() => {
    for (const [runtimeTabId, { threadRef, tabId }] of nativeSessionsRef.current) {
      const previewState = readThreadPreviewState(threadRef);
      if (
        previewState.serverEpoch !== null &&
        previewState.sessions[tabId] === undefined &&
        !pendingPopupIdsRef.current.has(tabId)
      ) {
        nativeSessionsRef.current.delete(runtimeTabId);
        ownedPopupIdsRef.current.delete(tabId);
        if (previewState.suppressedTabIds.has(tabId)) {
          setThreadRecoveryRevision((revision) => revision + 1);
        } else {
          forgetNativePreviewPopup(tabId);
        }
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
