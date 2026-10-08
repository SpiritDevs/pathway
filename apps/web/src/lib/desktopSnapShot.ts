import type { DesktopBridge, ScopedThreadRef } from "@spiritdevs/contracts";
import type { DraftId } from "../composerDraftStore";

const SNAP_SHOT_FOCUS_EVENT = "pathway:focus-composer";

export function dispatchSnapShotComposerFocus(target?: ScopedThreadRef | DraftId): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(SNAP_SHOT_FOCUS_EVENT, { detail: target }));
}

export function subscribeSnapShotComposerFocus(
  listener: (target?: ScopedThreadRef | DraftId) => void,
): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = (event: Event) =>
    listener((event as CustomEvent<ScopedThreadRef | DraftId>).detail);
  window.addEventListener(SNAP_SHOT_FOCUS_EVENT, handler);
  return () => window.removeEventListener(SNAP_SHOT_FOCUS_EVENT, handler);
}

type SnapShotMethods =
  | "setSnapShotAccount"
  | "requestSnapShotPermissions"
  | "getSnapShotState"
  | "checkSnapShotShortcut"
  | "setSnapShotShortcutSuppressed"
  | "listPendingSnapShots"
  | "readSnapShot"
  | "acknowledgeSnapShot"
  | "onSnapShotEvent";

export type DesktopSnapShotBridge = DesktopBridge & Required<Pick<DesktopBridge, SnapShotMethods>>;

export function getDesktopSnapShotBridge(): DesktopSnapShotBridge | undefined {
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge;
  if (
    typeof bridge?.setSnapShotAccount !== "function" ||
    typeof bridge.requestSnapShotPermissions !== "function" ||
    typeof bridge?.getSnapShotState !== "function" ||
    typeof bridge.checkSnapShotShortcut !== "function" ||
    typeof bridge.setSnapShotShortcutSuppressed !== "function" ||
    typeof bridge.listPendingSnapShots !== "function" ||
    typeof bridge.readSnapShot !== "function" ||
    typeof bridge.acknowledgeSnapShot !== "function" ||
    typeof bridge.onSnapShotEvent !== "function"
  ) {
    return undefined;
  }

  return bridge as DesktopSnapShotBridge;
}
