// FILE: computerPreviewStore.ts
// Purpose: Per-thread session state behind the in-chat computer preview popover.
// Layer: Web UI state store
// Exports: useComputerPreviewStore, selectThreadComputerPreview* selectors
// Depends on: ComputerPreviewPopover.logic phase transitions
//
// The session machine is the popover's memory: a surface request or a drive
// turn arms the owning thread whether or not its chat is on screen, so
// background agent work never steals the user's current chat: it only waits
// for that thread to be viewed. Every record is keyed by `scopedThreadKey`, so
// two environments' threads never share a session.

import { scopedThreadKey } from "@spiritdevs/client-runtime/environment";
import type { EnvironmentId, ScopedThreadRef, ThreadComputerState } from "@spiritdevs/contracts";
import { create } from "zustand";

import {
  computerPreviewAgentActive,
  computerPreviewPhaseOnAgentEdge,
  computerPreviewPhaseOnHide,
  computerPreviewPhaseOnSurfaceRequest,
  computerPreviewPhaseOnViewed,
  type ComputerPreviewPhase,
  type ComputerPreviewSession,
} from "./components/chat/ComputerPreviewPopover.logic";

interface ComputerPreviewRecords {
  sessionsByThreadKey: Record<string, ComputerPreviewSession | undefined>;
  /** Last observed drive state per thread; its edges arm and end sessions. */
  agentActiveByThreadKey: Record<string, boolean | undefined>;
  /**
   * Live layout footprint per thread, published by the mounted card: whether
   * a real frame or a first-frame error is visible, plus the fitted card width.
   */
  previewLayoutByThreadKey: Record<string, ComputerPreviewLayout | undefined>;
  /**
   * Detached card position per thread, in viewport CSS pixels. A thread with
   * an entry renders the preview as a draggable floating card instead of in
   * the rail.
   */
  floatingByThreadKey: Record<string, ComputerPreviewFloatingPosition | undefined>;
}

interface ComputerPreviewStore extends ComputerPreviewRecords {
  /** `computer.open-pane-requested` arrived for this thread's own lease. */
  requestPreviewSurface: (ref: ScopedThreadRef) => void;
  /** Any thread-state write (push or seed); edges are detected inside. */
  noteThreadComputerState: (environmentId: EnvironmentId, state: ThreadComputerState) => void;
  /** Newest spoken action label; an action is itself evidence of driving. */
  noteThreadActionLabel: (ref: ScopedThreadRef, label: string) => void;
  /** The owning thread's chat surface is rendering the popover. */
  markPreviewLive: (ref: ScopedThreadRef) => void;
  /** The user closed the preview; it stays hidden until the task ends. */
  hidePreviewForTask: (ref: ScopedThreadRef) => void;
  /** The mounted card's live footprint; identity-stable when unchanged. */
  notePreviewLayout: (ref: ScopedThreadRef, layout: ComputerPreviewLayout) => void;
  /**
   * Detach the card at `position` (viewport px), or re-dock it in the rail
   * when `position` is null. Clearing also happens on session removal.
   */
  setPreviewFloating: (
    ref: ScopedThreadRef,
    position: ComputerPreviewFloatingPosition | null,
  ) => void;
  /** Drag update for a detached card; a no-op while the thread is docked. */
  movePreviewFloating: (ref: ScopedThreadRef, position: ComputerPreviewFloatingPosition) => void;
  removePreviewSession: (ref: ScopedThreadRef) => void;
  /** Drop every session of one environment (disconnect or server restart). */
  clearEnvironment: (environmentId: EnvironmentId) => void;
  clear: () => void;
}

export interface ComputerPreviewLayout {
  readonly hasFrame: boolean;
  /** A first-frame error is visible content too, without claiming a decoded frame. */
  readonly hasVisibleStatus?: boolean | undefined;
  readonly width: number;
  /** True while the card floats detached. */
  readonly floating?: boolean | undefined;
}

/** Top-left of a detached card in viewport CSS pixels. */
export interface ComputerPreviewFloatingPosition {
  readonly x: number;
  readonly y: number;
}

const EMPTY_RECORDS: ComputerPreviewRecords = {
  sessionsByThreadKey: {},
  agentActiveByThreadKey: {},
  previewLayoutByThreadKey: {},
  floatingByThreadKey: {},
};

function sessionWithPhase(
  session: ComputerPreviewSession | undefined,
  ref: ScopedThreadRef,
  phase: ComputerPreviewPhase,
): ComputerPreviewSession {
  if (!session) {
    return { threadId: ref.threadId, phase };
  }
  return { ...session, phase };
}

function updateSessionPhase(
  current: ComputerPreviewStore,
  ref: ScopedThreadRef,
  nextPhase: (phase: ComputerPreviewPhase | undefined) => ComputerPreviewPhase | undefined,
): ComputerPreviewStore {
  const key = scopedThreadKey(ref);
  const session = current.sessionsByThreadKey[key];
  const phase = nextPhase(session?.phase);
  if (phase === undefined || phase === session?.phase) {
    return current;
  }
  return {
    ...current,
    sessionsByThreadKey: {
      ...current.sessionsByThreadKey,
      [key]: sessionWithPhase(session, ref, phase),
    },
  };
}

function withoutKeys<T>(
  record: Record<string, T>,
  drop: (key: string) => boolean,
): Record<string, T> {
  let changed = false;
  const next: Record<string, T> = {};
  for (const [key, value] of Object.entries(record)) {
    if (drop(key)) changed = true;
    else next[key] = value;
  }
  return changed ? next : record;
}

function removeRecords(
  current: ComputerPreviewStore,
  drop: (key: string) => boolean,
): ComputerPreviewStore {
  const sessionsByThreadKey = withoutKeys(current.sessionsByThreadKey, drop);
  const agentActiveByThreadKey = withoutKeys(current.agentActiveByThreadKey, drop);
  const previewLayoutByThreadKey = withoutKeys(current.previewLayoutByThreadKey, drop);
  const floatingByThreadKey = withoutKeys(current.floatingByThreadKey, drop);
  if (
    sessionsByThreadKey === current.sessionsByThreadKey &&
    agentActiveByThreadKey === current.agentActiveByThreadKey &&
    previewLayoutByThreadKey === current.previewLayoutByThreadKey &&
    floatingByThreadKey === current.floatingByThreadKey
  ) {
    return current;
  }
  return {
    ...current,
    sessionsByThreadKey,
    agentActiveByThreadKey,
    previewLayoutByThreadKey,
    floatingByThreadKey,
  };
}

export const useComputerPreviewStore = create<ComputerPreviewStore>()((set) => ({
  ...EMPTY_RECORDS,
  requestPreviewSurface: (ref) =>
    set((current) => updateSessionPhase(current, ref, computerPreviewPhaseOnSurfaceRequest)),
  noteThreadComputerState: (environmentId, state) =>
    set((current) => {
      const ref = { environmentId, threadId: state.threadId };
      const key = scopedThreadKey(ref);
      const active = computerPreviewAgentActive(state);
      const wasActive = current.agentActiveByThreadKey[key] ?? false;
      if (active === wasActive) {
        return current;
      }
      const next: ComputerPreviewStore = {
        ...current,
        agentActiveByThreadKey: { ...current.agentActiveByThreadKey, [key]: active },
      };
      return updateSessionPhase(next, ref, (phase) =>
        computerPreviewPhaseOnAgentEdge(phase, active ? "rose" : "fell"),
      );
    }),
  noteThreadActionLabel: (ref, label) =>
    set((current) => {
      const key = scopedThreadKey(ref);
      const session = current.sessionsByThreadKey[key];
      if (session?.lastActionLabel === label) {
        return current;
      }
      const nextSession: ComputerPreviewSession = session
        ? { ...session, lastActionLabel: label }
        : // An attributed action is itself proof the thread is driving, so it
          // arms like a surface request when nothing has arrived yet.
          { threadId: ref.threadId, phase: "armed", lastActionLabel: label };
      return {
        ...current,
        sessionsByThreadKey: { ...current.sessionsByThreadKey, [key]: nextSession },
      };
    }),
  markPreviewLive: (ref) =>
    set((current) => updateSessionPhase(current, ref, computerPreviewPhaseOnViewed)),
  hidePreviewForTask: (ref) =>
    set((current) => updateSessionPhase(current, ref, computerPreviewPhaseOnHide)),
  notePreviewLayout: (ref, layout) =>
    set((current) => {
      const key = scopedThreadKey(ref);
      const previous = current.previewLayoutByThreadKey[key];
      if (
        previous?.hasFrame === layout.hasFrame &&
        previous?.hasVisibleStatus === layout.hasVisibleStatus &&
        previous?.width === layout.width &&
        previous?.floating === layout.floating
      ) {
        return current;
      }
      return {
        ...current,
        previewLayoutByThreadKey: { ...current.previewLayoutByThreadKey, [key]: layout },
      };
    }),
  setPreviewFloating: (ref, position) =>
    set((current) => {
      const key = scopedThreadKey(ref);
      if (position === null) {
        if (!Object.hasOwn(current.floatingByThreadKey, key)) {
          return current;
        }
        const floatingByThreadKey = { ...current.floatingByThreadKey };
        delete floatingByThreadKey[key];
        return { ...current, floatingByThreadKey };
      }
      const previous = current.floatingByThreadKey[key];
      if (previous?.x === position.x && previous?.y === position.y) {
        return current;
      }
      return {
        ...current,
        floatingByThreadKey: { ...current.floatingByThreadKey, [key]: position },
      };
    }),
  movePreviewFloating: (ref, position) =>
    set((current) => {
      const key = scopedThreadKey(ref);
      const previous = current.floatingByThreadKey[key];
      if (previous === undefined || (previous.x === position.x && previous.y === position.y)) {
        return current;
      }
      return {
        ...current,
        floatingByThreadKey: { ...current.floatingByThreadKey, [key]: position },
      };
    }),
  removePreviewSession: (ref) =>
    set((current) => {
      const target = scopedThreadKey(ref);
      return removeRecords(current, (key) => key === target);
    }),
  clearEnvironment: (environmentId) =>
    set((current) => {
      const prefix = `${environmentId}:`;
      return removeRecords(current, (key) => key.startsWith(prefix));
    }),
  clear: () => set(EMPTY_RECORDS),
}));

export function selectThreadComputerPreviewSession(
  ref: ScopedThreadRef,
): (store: ComputerPreviewStore) => ComputerPreviewSession | undefined {
  const key = scopedThreadKey(ref);
  return (store) => store.sessionsByThreadKey[key];
}

export function selectThreadComputerPreviewLayout(
  ref: ScopedThreadRef,
): (store: ComputerPreviewStore) => ComputerPreviewLayout | undefined {
  const key = scopedThreadKey(ref);
  return (store) => store.previewLayoutByThreadKey[key];
}

export function selectThreadComputerPreviewFloating(
  ref: ScopedThreadRef,
): (store: ComputerPreviewStore) => ComputerPreviewFloatingPosition | undefined {
  const key = scopedThreadKey(ref);
  return (store) => store.floatingByThreadKey[key];
}
