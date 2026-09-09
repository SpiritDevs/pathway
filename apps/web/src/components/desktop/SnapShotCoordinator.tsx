import { useUser } from "@clerk/react";
import { bindSnapShotAccount } from "../../lib/snapShotAccount";
import { useAtomValue } from "@effect/atom-react";
import { activeCompanyIdAtom } from "../../cloud/activeCompany";
import {
  type DesktopPendingSnapShot,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type ScopedThreadRef,
} from "@spiritdevs/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useActiveEnvironmentId } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { shouldResumeSnapShotSetupOnStartup } from "../../lib/snapShotSetupResume";

import {
  type DraftId,
  type PersistedComposerImageAttachment,
  useComposerDraftStore,
} from "../../composerDraftStore";
import { useHandleNewThread } from "../../hooks/useHandleNewThread";
import { useClientSettings } from "../../hooks/useSettings";
import { readThreadShell } from "../../state/entities";
import { compressImageToByteLimit, dataUrlToFile } from "../../lib/imageCompression";
import { resolveThreadActionProjectRef } from "../../lib/chatThreadActions";
import {
  beginSnapShotAnimation,
  dismissAllSnapShotAnimations,
  dismissSnapShotAnimation,
  finishSnapShotAnimation,
  getPendingSnapShotAnimations,
  updateSnapShotAnimationSource,
  waitForSnapShotAnimationDestination,
} from "../../lib/snapShotAnimation";
import { resizeSnapShotSource } from "../../lib/snapShotSource";
import { playSnapShotSound } from "../../lib/snapShotSound";
import {
  dispatchSnapShotComposerFocus,
  getDesktopSnapShotBridge,
  type DesktopSnapShotBridge,
} from "../../lib/desktopSnapShot";
import { readFileAsDataUrl } from "../ChatView.logic";
import { stackedThreadToast, toastManager } from "../ui/toast";

type CaptureTarget = DraftId | ScopedThreadRef;

export function resolveExistingSnapShotTarget(
  target: CaptureTarget,
  routeThreadRef: ScopedThreadRef | null,
): CaptureTarget | null {
  const store = useComposerDraftStore.getState();
  if (typeof target === "string") {
    const draftSession = store.getDraftSession(target);
    if (draftSession?.promotedTo) return draftSession.promotedTo;
    return draftSession ? target : null;
  }
  const targetIsCurrentRoute =
    routeThreadRef !== null &&
    routeThreadRef.environmentId === target.environmentId &&
    routeThreadRef.threadId === target.threadId;
  return targetIsCurrentRoute ||
    store.getDraftSessionByRef(target) !== null ||
    readThreadShell(target) !== null
    ? target
    : null;
}

const NEXT_PAINT_FALLBACK_MS = 100;

export async function beginSnapShotAnimationWhenReady(
  id: string,
  target: Promise<CaptureTarget | null>,
  pendingStarts: Set<string>,
): Promise<void> {
  pendingStarts.add(id);
  try {
    const resolvedTarget = await target;
    if (pendingStarts.delete(id) && resolvedTarget) {
      beginSnapShotAnimation(id, resolvedTarget);
    }
  } finally {
    pendingStarts.delete(id);
  }
}

export function dismissFailedSnapShot(
  id: string | undefined,
  soundedIds: Set<string>,
  pendingStarts: Set<string>,
): void {
  if (id) {
    pendingStarts.delete(id);
    soundedIds.delete(id);
    void dismissSnapShotAnimation(id);
  } else {
    pendingStarts.clear();
    soundedIds.clear();
    dismissAllSnapShotAnimations();
  }
}

export function resolveSnapShotTargetOnce(
  resolutionRef: { current: Promise<CaptureTarget | null> | null },
  resolveTarget: () => Promise<CaptureTarget | null>,
): Promise<CaptureTarget | null> {
  if (resolutionRef.current) return resolutionRef.current;
  const resolution = resolveTarget().finally(() => {
    if (resolutionRef.current === resolution) resolutionRef.current = null;
  });
  resolutionRef.current = resolution;
  return resolution;
}

// A capture keeps its destination even after its animation unmounts or the window blurs.
export function resolveSnapShotDeliveryTarget(
  targets: Map<string, Promise<CaptureTarget | null>>,
  id: string,
  resolveTarget: () => Promise<CaptureTarget | null>,
): Promise<CaptureTarget | null> {
  const existing = targets.get(id);
  if (existing) return existing;
  const target = resolveTarget().catch(() => null);
  targets.set(id, target);
  void target.then((resolved) => {
    if (!resolved && targets.get(id) === target) targets.delete(id);
  });
  return target;
}

export async function resolvePendingSnapShotTarget(
  targets: Map<string, Promise<CaptureTarget | null>>,
  id: string,
  resolveTarget: () => Promise<CaptureTarget | null>,
  routeThreadRef: ScopedThreadRef | null,
): Promise<CaptureTarget | null> {
  const capturedTarget = await resolveSnapShotDeliveryTarget(targets, id, resolveTarget);
  const target = capturedTarget
    ? resolveExistingSnapShotTarget(capturedTarget, routeThreadRef)
    : null;
  if (!target) targets.delete(id);
  return target;
}

async function afterNextPaint(): Promise<void> {
  await new Promise<void>((resolve) => {
    const fallback = window.setTimeout(resolve, NEXT_PAINT_FALLBACK_MS);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        window.clearTimeout(fallback);
        resolve();
      });
    });
  });
}

export async function deliverSnapShot(
  bridge: DesktopSnapShotBridge,
  item: DesktopPendingSnapShot,
  target: CaptureTarget,
  isAccountCurrent: () => boolean,
): Promise<void> {
  const assertAccountCurrent = () => {
    if (!isAccountCurrent())
      throw new Error("Capture delivery cancelled because the account changed.");
  };
  assertAccountCurrent();
  const store = useComposerDraftStore.getState();
  updateSnapShotAnimationSource(item.id, item.source);
  const capture = await bridge.readSnapShot(item.id);
  assertAccountCurrent();
  const original = dataUrlToFile(capture.dataUrl, capture.name, capture.mimeType);
  const compressed = await compressImageToByteLimit(original, PROVIDER_SEND_TURN_MAX_IMAGE_BYTES);
  if (!compressed.ok) {
    finishSnapShotAnimation(item.id);
    throw new Error("The captured window is too large to attach.");
  }
  const file = compressed.file;
  const source = resizeSnapShotSource(capture.source, compressed.imageSize);
  const dataUrl = compressed.recompressed ? await readFileAsDataUrl(file) : capture.dataUrl;
  assertAccountCurrent();
  if (typeof target === "string") {
    const resolvedTarget = resolveExistingSnapShotTarget(target, null);
    if (!resolvedTarget)
      throw new Error(
        "The destination conversation closed. Open a conversation, then retry the saved capture.",
      );
    target = resolvedTarget;
  }
  const alreadyAttached =
    store.getComposerDraft(target)?.images.some(({ id }) => id === capture.id) ?? false;
  if (
    !alreadyAttached &&
    !store.addImage(target, {
      type: "image",
      id: capture.id,
      name: file.name,
      mimeType: file.type,
      sizeBytes: file.size,
      previewUrl: dataUrl,
      file,
      source,
    })
  ) {
    throw new Error("Remove an attachment, then retry to attach the saved capture.");
  }
  const persisted: PersistedComposerImageAttachment = {
    id: capture.id,
    name: file.name,
    mimeType: file.type,
    sizeBytes: file.size,
    dataUrl,
    source,
  };
  const persistedAttachments =
    store
      .getComposerDraft(target)
      ?.persistedAttachments.filter((attachment) => attachment.id !== capture.id) ?? [];
  await store.syncPersistedAttachments(target, [...persistedAttachments, persisted]);
  if (!store.getComposerDraft(target)?.persistedAttachments.some(({ id }) => id === capture.id)) {
    throw new Error("The captured window could not be saved to the draft.");
  }

  // Reveal the attachment under the flying capture before the desktop tears the overlay down,
  // otherwise the tile is missing for the frames between the landing and its first paint.
  if (getPendingSnapShotAnimations().some((animation) => animation.id === capture.id)) {
    await afterNextPaint();
    await waitForSnapShotAnimationDestination(capture.id).catch(() => undefined);
    finishSnapShotAnimation(capture.id);
    await afterNextPaint();
  }
  assertAccountCurrent();
  await bridge.acknowledgeSnapShot(capture.id);
  if (isAccountCurrent()) dispatchSnapShotComposerFocus();
}

export function SnapShotCoordinator() {
  const { isLoaded, isSignedIn, user } = useUser();
  const accountId = isLoaded && isSignedIn ? user.id : null;
  const currentAccountRef = useRef(accountId);
  currentAccountRef.current = accountId;
  const [binding, setBinding] = useState<ReturnType<typeof bindSnapShotAccount> | null>(null);
  useEffect(() => {
    const bridge = getDesktopSnapShotBridge();
    if (!bridge) return;
    let mounted = true;
    const session = bindSnapShotAccount(bridge, accountId);
    setBinding(null);
    void session.ready
      .then(() => {
        if (mounted && currentAccountRef.current === accountId) setBinding(session);
      })
      .catch((error: unknown) => {
        if (mounted)
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Couldn't connect SnapShots to your account",
              description:
                error instanceof Error ? error.message : "Restart Pathway and try again.",
            }),
          );
      });
    return () => {
      mounted = false;
      void session.release();
    };
  }, [accountId]);
  if (!binding || binding.accountId !== accountId || !binding.isCurrent()) return null;
  return (
    <SnapShotAccountCoordinator
      key={accountId}
      isAccountCurrent={() => binding.isCurrent() && currentAccountRef.current === accountId}
    />
  );
}

function SnapShotAccountCoordinator({ isAccountCurrent }: { isAccountCurrent: () => boolean }) {
  const navigate = useNavigate();
  const activeEnvironmentId = useActiveEnvironmentId();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const defaultEnvironmentId = activeEnvironmentId ?? primaryEnvironmentId;
  useEffect(() => {
    if (getDesktopSnapShotBridge() && shouldResumeSnapShotSetupOnStartup()) {
      void navigate({ to: "/settings/snap-shot" });
    }
  }, [navigate]);
  const {
    activeDraftThread,
    activeThread,
    defaultProjectRef,
    handleNewThread,
    routeDraftId: rawRouteDraftId,
    routeThreadRef: rawRouteThreadRef,
  } = useHandleNewThread();
  // A profile switch can leave another profile's thread in the URL.
  const routeThreadRef = activeThread || activeDraftThread ? rawRouteThreadRef : null;
  const routeDraftId = activeDraftThread ? rawRouteDraftId : null;
  const activeCompanyId = useAtomValue(activeCompanyIdAtom);
  const lastCompanyIdRef = useRef(activeCompanyId);
  const lastEnvironmentIdRef = useRef(activeEnvironmentId);
  const captureSound = useClientSettings((settings) =>
    settings.snapShotPlaySound ? settings.snapShotSound : null,
  );
  const animateCaptures = useClientSettings((settings) => settings.snapShotAnimations);
  const captureTargetsRef = useRef(new Map<string, Promise<CaptureTarget | null>>());
  const lastTargetRef = useRef<CaptureTarget | null>(null);
  const targetResolutionRef = useRef<Promise<CaptureTarget | null> | null>(null);
  const targetContextVersionRef = useRef(0);
  const drainingRef = useRef<Promise<void> | null>(null);
  const rerunRequestedRef = useRef(false);
  const soundedCaptureIdsRef = useRef(new Set<string>());
  const pendingAnimationStartsRef = useRef(new Set<string>());

  if (
    lastCompanyIdRef.current !== activeCompanyId ||
    lastEnvironmentIdRef.current !== activeEnvironmentId
  ) {
    lastCompanyIdRef.current = activeCompanyId;
    lastEnvironmentIdRef.current = activeEnvironmentId;
    lastTargetRef.current = null;
    targetResolutionRef.current = null;
    targetContextVersionRef.current += 1;
  }
  const currentTarget = routeThreadRef ?? routeDraftId;
  if (currentTarget) lastTargetRef.current = currentTarget;

  const resolveTarget = useCallback(async (): Promise<CaptureTarget | null> => {
    const targetContextVersion = targetContextVersionRef.current;
    const lastTarget = lastTargetRef.current;
    if (lastTarget) {
      const existingTarget = resolveExistingSnapShotTarget(lastTarget, routeThreadRef);
      if (existingTarget) {
        lastTargetRef.current = existingTarget;
        return existingTarget;
      }
      lastTargetRef.current = null;
    }
    const projectRef = resolveThreadActionProjectRef({
      activeDraftThread,
      activeThread: activeThread ?? undefined,
      defaultProjectRef:
        defaultProjectRef?.environmentId === defaultEnvironmentId ? defaultProjectRef : null,
      handleNewThread,
    });
    const destination =
      projectRef ??
      (defaultEnvironmentId ? { environmentId: defaultEnvironmentId, projectId: null } : null);
    if (!destination) return null;
    const created = await handleNewThread(destination);
    if (!created) return null;
    if (targetContextVersionRef.current === targetContextVersion) {
      lastTargetRef.current = created.draftId;
    }
    return created.draftId;
  }, [
    activeDraftThread,
    activeThread,
    defaultProjectRef,
    defaultEnvironmentId,
    handleNewThread,
    routeThreadRef,
  ]);

  const latestResolveTargetRef = useRef(resolveTarget);
  latestResolveTargetRef.current = resolveTarget;
  const resolveCaptureTarget = useCallback(
    () => resolveSnapShotTargetOnce(targetResolutionRef, () => latestResolveTargetRef.current()),
    [],
  );

  const playCaptureSound = useCallback(
    (id: string) => {
      if (!captureSound || soundedCaptureIdsRef.current.has(id)) return;
      soundedCaptureIdsRef.current.add(id);
      try {
        playSnapShotSound(captureSound);
      } catch {}
    },
    [captureSound],
  );

  const drain = useCallback(async (): Promise<void> => {
    const bridge = getDesktopSnapShotBridge();
    if (!bridge || !isAccountCurrent()) return;
    if (drainingRef.current) {
      rerunRequestedRef.current = true;
      return drainingRef.current;
    }

    const operation = (async () => {
      do {
        rerunRequestedRef.current = false;
        const pending = await bridge.listPendingSnapShots();
        for (const item of pending) {
          if (!isAccountCurrent()) return;
          playCaptureSound(item.id);
          const target = await resolvePendingSnapShotTarget(
            captureTargetsRef.current,
            item.id,
            resolveCaptureTarget,
            routeThreadRef,
          );
          if (!target) {
            await dismissSnapShotAnimation(item.id);
            soundedCaptureIdsRef.current.delete(item.id);
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "Snapshot saved, but no conversation is available",
                description: "Open a conversation or project, then retry to attach this capture.",
                actionProps: { children: "Retry", onClick: () => void drain() },
              }),
            );
            continue;
          }

          try {
            await deliverSnapShot(bridge, item, target, isAccountCurrent);
            captureTargetsRef.current.delete(item.id);
            soundedCaptureIdsRef.current.delete(item.id);
          } catch (error) {
            if (!isAccountCurrent()) return;
            await dismissSnapShotAnimation(item.id);
            soundedCaptureIdsRef.current.delete(item.id);
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "Snapshot failed",
                description:
                  error instanceof Error
                    ? error.message
                    : "The capture is saved and can be retried.",
                actionProps: { children: "Retry", onClick: () => void drain() },
              }),
            );
          }
        }
      } while (rerunRequestedRef.current);
    })()
      .catch((error: unknown) => {
        if (!isAccountCurrent()) return;
        dismissAllSnapShotAnimations();
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Snapshot failed",
            description: error instanceof Error ? error.message : "Try the capture again.",
          }),
        );
      })
      .finally(() => {
        drainingRef.current = null;
      });
    drainingRef.current = operation;
    return operation;
  }, [isAccountCurrent, playCaptureSound, resolveCaptureTarget, routeThreadRef]);

  useEffect(() => {
    const bridge = getDesktopSnapShotBridge();
    if (!bridge) return;
    void drain();
    const unsubscribe = bridge.onSnapShotEvent((event) => {
      switch (event.type) {
        case "requested": {
          const current = lastTargetRef.current;
          const target = current ? resolveExistingSnapShotTarget(current, routeThreadRef) : null;
          // Creating a new draft would navigate the renderer before a self-capture finishes.
          // Pin existing drafts now; create a destination after acquisition when none exists.
          if (target) {
            void resolveSnapShotDeliveryTarget(captureTargetsRef.current, event.id, () =>
              Promise.resolve(target),
            );
          }
          return;
        }
        case "started": {
          playCaptureSound(event.id);
          if (animateCaptures && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
            void beginSnapShotAnimationWhenReady(
              event.id,
              resolveSnapShotDeliveryTarget(
                captureTargetsRef.current,
                event.id,
                resolveCaptureTarget,
              ),
              pendingAnimationStartsRef.current,
            );
          }
          return;
        }
        case "ready":
          void drain();
          return;
        case "failed": {
          if (event.id) captureTargetsRef.current.delete(event.id);
          dismissFailedSnapShot(
            event.id,
            soundedCaptureIdsRef.current,
            pendingAnimationStartsRef.current,
          );
          void bridge
            .getSnapShotState()
            .then((state) => {
              toastManager.add(
                stackedThreadToast({
                  type: "error",
                  title: "Snapshot failed",
                  description: state.message ?? "Try the capture again.",
                }),
              );
            })
            .catch((error: unknown) => {
              toastManager.add(
                stackedThreadToast({
                  type: "error",
                  title: "Snapshot failed",
                  description:
                    error instanceof Error ? error.message : "Reconnect Pathway and try again.",
                }),
              );
            });
          return;
        }
        case "shortcut-changed":
          return;
      }
    });
    return () => {
      unsubscribe();
      dismissAllSnapShotAnimations();
    };
  }, [animateCaptures, drain, playCaptureSound, resolveCaptureTarget, routeThreadRef]);

  useEffect(() => {
    const dismissOnBlur = () => {
      pendingAnimationStartsRef.current.clear();
      dismissAllSnapShotAnimations();
    };
    const drainOnFocus = () => void drain();
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") dismissOnBlur();
      else void drain();
    };
    window.addEventListener("blur", dismissOnBlur);
    window.addEventListener("focus", drainOnFocus);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("blur", dismissOnBlur);
      window.removeEventListener("focus", drainOnFocus);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [drain]);

  return null;
}
