// FILE: ComputerPanel.logic.ts
// Purpose: The pieces of Synara's computer pane logic the in-chat preview,
// status badge, and event bridge share: the frame gate, health badge, canvas
// label, action labels, and the stream subscription gate.
// Layer: Web computer surface logic (pure)

import {
  COMPUTER_MAC_BACKEND,
  COMPUTER_NESTED_KWIN_BACKEND,
  type ComputerActionEvent,
  type ComputerAvailability,
  type ComputerFrameHeader,
  type ComputerHealth,
  type ComputerWindow,
  type ThreadComputerState,
} from "@spiritdevs/contracts";

import { COMPUTER_TOOL_TITLES, computerToolName } from "../../lib/computerToolPresentation";

export interface ComputerFrameGateState {
  readonly lastSequence: number | null;
}

export type ComputerFrameGateAction = "ignore" | "drop-stale" | "decode";

export interface ComputerFrameGateStep {
  readonly state: ComputerFrameGateState;
  readonly action: ComputerFrameGateAction;
  readonly requestResync: boolean;
}

const UINT32_MODULUS = 0x1_0000_0000;
const UINT32_HALF_RANGE = 0x8000_0000;

export function createComputerFrameGateState(): ComputerFrameGateState {
  return { lastSequence: null };
}

export function stepComputerFrameGate(
  state: ComputerFrameGateState,
  header: Pick<ComputerFrameHeader, "computerId" | "sequence">,
  expectedComputerId: string,
): ComputerFrameGateStep {
  if (header.computerId !== expectedComputerId) {
    return { state, action: "ignore", requestResync: false };
  }

  if (state.lastSequence === null) {
    return { state: { lastSequence: header.sequence }, action: "decode", requestResync: false };
  }

  const distance = (header.sequence - state.lastSequence + UINT32_MODULUS) % UINT32_MODULUS;
  if (distance === 0 || distance >= UINT32_HALF_RANGE) {
    return { state, action: "drop-stale", requestResync: false };
  }

  return {
    state: { lastSequence: header.sequence },
    action: "decode",
    requestResync: distance > 1,
  };
}

/**
 * A backend that has never connected and never failed is not broken — it is
 * idle. The server does not connect at boot, so after every launch health
 * reads non-connected with a clean record until something uses the desktop.
 */
export function computerBackendIsIdle(health: ComputerHealth | undefined): boolean {
  return (
    health?.status === "unavailable" &&
    health.consecutiveFailures === 0 &&
    health.lastFailure === undefined
  );
}

export interface ComputerHealthBadge {
  readonly label: string;
  readonly title: string;
  readonly tone: "warning" | "danger";
  /** A retry is in flight, which the dot animates; a dead backend is still. */
  readonly pulse: boolean;
}

/**
 * Header indicator for a backend that is not connected, or null while it is.
 * This outranks the lease and agent badges: whoever holds the desktop is beside
 * the point once there is no desktop to hold, and a dead backend explains every
 * failure the other two cannot.
 */
export function resolveComputerHealthBadge(
  health: ComputerHealth | undefined,
): ComputerHealthBadge | null {
  if (!health || health.status === "connected") return null;
  // Opening the pane is itself what engages the backend, and a real failure
  // arrives with a lastFailure to show. Badging the idle state would flash
  // "Desktop unavailable" at every pane open on a perfectly healthy desktop.
  if (computerBackendIsIdle(health)) return null;
  const reconnecting = health.status === "reconnecting";
  return {
    label: reconnecting ? "Reconnecting to desktop" : "Desktop unavailable",
    title: computerHealthDetail(health),
    tone: reconnecting ? "warning" : "danger",
    pulse: reconnecting,
  };
}

export const COMPUTER_RECONNECTING_NOTE =
  "The desktop backend dropped out and is being reconnected.";
const COMPUTER_DISCONNECTED_NOTE = "The desktop backend is not connected.";

/** The note naming what the supervisor last saw fail, or null when nothing has. */
export function computerLastFailureNote(health: ComputerHealth | undefined): string | null {
  return health?.lastFailure ? `Last failure: ${health.lastFailure.message}` : null;
}

/** The note counting reconnects since startup, or null when there were none. */
export function computerReconnectsNote(health: ComputerHealth | undefined): string | null {
  const reconnects = health?.reconnects ?? 0;
  if (reconnects <= 0) return null;
  return `Reconnected ${reconnects === 1 ? "once" : `${reconnects} times`} since startup.`;
}

/** Counters belong in the badge's tooltip, not in chrome of their own. */
function computerHealthDetail(health: ComputerHealth): string {
  const parts = [
    health.status === "reconnecting" ? COMPUTER_RECONNECTING_NOTE : COMPUTER_DISCONNECTED_NOTE,
  ];
  const lastFailure = computerLastFailureNote(health);
  if (lastFailure) parts.push(lastFailure);
  if (health.consecutiveFailures > 0) {
    parts.push(`Failed attempts since the last connection: ${health.consecutiveFailures}.`);
  }
  const reconnects = computerReconnectsNote(health);
  if (reconnects) parts.push(reconnects);
  return parts.join(" ");
}

/**
 * What the canvas is a picture of, for a screen reader: whether the agent is
 * driving a sandbox or the machine the user is sitting at.
 */
export function computerCanvasLabel(input: {
  readonly availability: ComputerAvailability | undefined;
  readonly visibleDesktop: boolean;
}): string {
  const backend = input.availability?.kind === "available" ? input.availability.backend : undefined;
  if (backend === COMPUTER_MAC_BACKEND) return "This Mac's desktop";
  if (backend === COMPUTER_NESTED_KWIN_BACKEND) return "The agent's own desktop";
  if (input.visibleDesktop) return "This computer's desktop";
  return "The agent's desktop";
}

/**
 * The newest desktop action, in the words a person would use. The backend's
 * `action` is a tool-shaped identifier (`computer_click`, `type_text`), so it
 * is spoken rather than printed. A failure keeps its message, because that is
 * the only part of a failed action worth the space.
 */
export function computerActionLabel(
  action: Pick<ComputerActionEvent, "action" | "ok" | "message"> | undefined,
): string | null {
  if (!action) return null;
  const tool = computerToolName(action.action);
  const fallback = action.action
    .replace(/^computer[_.]/, "")
    .replace(/[_.]+/g, " ")
    .trim();
  if (!tool && fallback.length === 0) return null;
  const label = tool
    ? COMPUTER_TOOL_TITLES[tool]
    : `${fallback[0]!.toUpperCase()}${fallback.slice(1)}`;
  if (action.ok) return label;
  return action.message ? `${label} failed: ${action.message}` : `${label} failed`;
}

export function shouldSubscribeToComputerStream(input: {
  readonly runtimeMode: "live" | "preview";
  readonly isVisible: boolean;
  readonly threadState: ThreadComputerState | undefined;
}): boolean {
  return (
    input.runtimeMode === "live" &&
    input.isVisible &&
    input.threadState?.availability.kind === "available"
  );
}

/** The action, target application, and actual delivery mode for the desktop overlay. */
export function computerActionStatusLabel(
  action: ComputerActionEvent | undefined,
  windows: readonly ComputerWindow[] | undefined,
): string | null {
  const label = computerActionLabel(action);
  if (!label) return null;
  const app = windows?.find((window) => window.id === action?.windowId)?.appName;
  const path = action?.delivery?.path;
  const delivery = path
    ? path.includes("foreground")
      ? "Temporary foreground"
      : "Background action"
    : undefined;
  return [label, app, delivery].filter(Boolean).join(" · ");
}
