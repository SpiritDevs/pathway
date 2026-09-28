import type {
  ComputerInputModifier,
  ComputerSurfaceInput,
  ComputerSurfaceSessionState,
  ThreadId,
} from "@spiritdevs/contracts";

import { remoteBrowserPoint } from "~/browser/remoteBrowserCoordinates";

/** The pinned CUA host's only computer; `computer.getStatus` reports the same id. */
export const PRIMARY_COMPUTER_ID = "desktop";

export type ComputerControlTone = "agent" | "mine" | "other" | "idle";

export interface ComputerControlView {
  readonly tone: ComputerControlTone;
  readonly label: string;
  /** This connection holds control, so its input reaches the screen. */
  readonly mine: boolean;
}

/** The state header: who holds the screen, from this connection's point of view. */
export function computerControlView(session: ComputerSurfaceSessionState): ComputerControlView {
  const { controller, activeTurns } = session.state;
  switch (controller.kind) {
    case "agent":
      return { tone: "agent", label: "Agent is using the computer", mine: false };
    case "client":
      if (controller.clientId !== session.clientId)
        return { tone: "other", label: "Another device has control", mine: false };
      return {
        tone: "mine",
        label: activeTurns.length > 0 ? "You have control" : "Agent idle — you have control",
        mine: true,
      };
    case "idle":
      return { tone: "idle", label: "Agent idle", mine: false };
  }
}

/**
 * The thread a hand-back follow-up goes to: the agent paused behind this
 * control period, else the thread the view was opened from.
 */
export function computerHandBackThreadId(
  session: ComputerSurfaceSessionState,
  fallback: ThreadId,
): ThreadId {
  const { controller, activeTurns } = session.state;
  if (controller.kind === "agent") return controller.threadId;
  return activeTurns[0]?.threadId ?? fallback;
}

/**
 * Maps a position on the aspect-fitted canvas to primary-display points.
 * `screen` is the frame size in points (encoded pixels / deviceScale), so this
 * is `local / displayed * frame.width / frame.deviceScale` with letterboxing
 * removed. Null outside the image.
 */
export function computerSurfacePoint(input: {
  readonly x: number;
  readonly y: number;
  readonly boxWidth: number;
  readonly boxHeight: number;
  readonly screen: { readonly width: number; readonly height: number };
}): { x: number; y: number } | null {
  return remoteBrowserPoint({
    x: input.x,
    y: input.y,
    boxWidth: input.boxWidth,
    boxHeight: input.boxHeight,
    width: input.screen.width,
    height: input.screen.height,
  });
}

interface ModifierState {
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
}

export function computerModifiers(event: ModifierState): ComputerInputModifier[] {
  const modifiers: ComputerInputModifier[] = [];
  if (event.ctrlKey) modifiers.push("ctrl");
  if (event.altKey) modifiers.push("alt");
  if (event.shiftKey) modifiers.push("shift");
  if (event.metaKey) modifiers.push("meta");
  return modifiers;
}

const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "OS", "Fn", "CapsLock"]);

/**
 * One key-down as a complete Computer input: printable text without a command
 * modifier types, everything else is a key or chord in the Computer spelling
 * (`Enter`, `ArrowUp`, `A`). Escape passes through; the server treats it as the
 * emergency stop and releases control. Lone modifiers and IME composition
 * produce nothing.
 */
export function computerKeyInput(
  event: ModifierState & { readonly key: string; readonly isComposing?: boolean },
): ComputerSurfaceInput | null {
  if (event.isComposing || event.key === "Dead" || event.key === "Unidentified") return null;
  if (MODIFIER_KEYS.has(event.key)) return null;
  const chord = event.ctrlKey || event.metaKey || event.altKey;
  if (event.key.length === 1 && !chord) return { type: "type", text: event.key };
  const key =
    event.key === " " ? "Space" : event.key.length === 1 ? event.key.toUpperCase() : event.key;
  const modifiers = computerModifiers(event);
  return modifiers.length > 0 ? { type: "key", key, modifiers } : { type: "key", key };
}

/** Clicks the host can perform. Middle click is unsupported on the pinned host. */
export function computerPointerButton(button: number): "left" | "right" | null {
  return button === 0 ? "left" : button === 2 ? "right" : null;
}
