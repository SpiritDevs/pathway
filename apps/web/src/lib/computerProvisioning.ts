// One vocabulary for "set up computer control": the toasts the chat card raises,
// the inline note the settings panel renders, and the rule for what counts as
// done. Pure so every surface can be pinned by tests. The state machine lives in
// `useProvisionComputer`; the words live here.

import {
  type ComputerAvailability,
  type ComputerHealth,
  type ComputerPermission,
  type ComputerProvisionResult,
  type ComputerStatusResult,
  type DesktopComputerBridge,
  type DesktopComputerHelperState,
  type DesktopComputerPermissionKind,
} from "@spiritdevs/contracts";
import {
  COMPUTER_PERMISSIONS,
  listComputerPermissions,
  missingComputerHelperPermissions,
} from "@spiritdevs/shared/computerGrants";

import {
  COMPUTER_RECONNECTING_NOTE,
  computerBackendIsIdle,
} from "../components/computer/ComputerPanel.logic";

/** The grant set the native helper is asked about for Computer control. */
export const COMPUTER_PERMISSION_KINDS: readonly DesktopComputerPermissionKind[] =
  COMPUTER_PERMISSIONS;

/**
 * The desktop app's native permission surface, when it can speak for the
 * environment's host. Grants belong to the machine running the server, so only
 * the desktop app's own primary environment qualifies; a remote environment,
 * an SSH or WSL backend, or a plain browser sets its grants up on its host.
 */
export function readLocalComputerPermissionBridge(input: {
  readonly environmentIsDesktopPrimary: boolean;
}): DesktopComputerBridge | null {
  if (!input.environmentIsDesktopPrimary) return null;
  return globalThis.window?.desktopBridge?.computer ?? null;
}

export function computerPermissionSetupSupported(
  state: DesktopComputerHelperState | null,
): boolean {
  return state?.supported === true;
}

/** One fresh, explicit activation check; ordinary sends do not call this. */
export async function prepareComputerPermissionGuide(input: {
  readonly getPermissionState?: (
    permissions: readonly DesktopComputerPermissionKind[],
  ) => Promise<DesktopComputerHelperState>;
  readonly startPermissionSetup?: (
    permissions: readonly DesktopComputerPermissionKind[],
  ) => Promise<unknown>;
  readonly isCurrent: () => boolean;
}): Promise<boolean> {
  if (!input.getPermissionState || !input.startPermissionSetup) return input.isCurrent();
  if (!input.isCurrent()) return false;
  const state = await input.getPermissionState(COMPUTER_PERMISSION_KINDS);
  if (!input.isCurrent()) return false;
  if (!computerPermissionSetupSupported(state)) return true;
  if (missingComputerHelperPermissions(state).length === 0) return true;
  await input.startPermissionSetup(COMPUTER_PERMISSION_KINDS);
  return false; // Preserve the draft; granting access never auto-sends the task.
}

export type ComputerAvailabilityView = {
  readonly kind: "checking" | "ready" | "blocked";
  readonly title: string;
  readonly description: string;
};

/**
 * `grantsConfirmed` is fresh evidence from the OS itself (the desktop app's
 * native grant check) that every permission is granted. The server cannot know
 * that before its backend starts, which happens only when something uses the
 * desktop, so without it an idle backend stays "not checked".
 */
export function resolveComputerAvailabilityView(
  availability: ComputerAvailability | undefined,
  health?: ComputerHealth,
  grantsConfirmed = false,
): ComputerAvailabilityView {
  // A pending retry is not a dead desktop: one of the two states ends by itself.
  if (health?.status === "reconnecting") {
    return {
      kind: "checking",
      title: "Reconnecting to the desktop",
      description: health.lastFailure ? health.lastFailure.message : COMPUTER_RECONNECTING_NOTE,
    };
  }
  if (!availability) {
    return {
      kind: "checking",
      title: "Checking computer availability",
      description: "Waiting for the desktop backend.",
    };
  }
  if (availability.kind === "available") {
    if (grantsConfirmed && computerBackendIsIdle(health)) {
      return {
        kind: "ready",
        title: "All permissions granted",
        description: "Pathway connects to the desktop the next time an agent uses it.",
      };
    }
    if (health && health.status !== "connected") {
      return {
        kind: "checking",
        title: "Computer access has not been checked",
        description: "Choose Set up to check that Pathway can see and control the desktop.",
      };
    }
    if (health?.captureAvailable === false) {
      return {
        kind: "blocked",
        title: "Screen capture is unavailable",
        description:
          "Desktop input is connected, but Pathway cannot take screenshots. Choose Set up to check access.",
      };
    }
    return {
      kind: "ready",
      title: "Connected to the desktop",
      description: "Pathway can see and control the desktop through its computer tools.",
    };
  }
  if (availability.kind === "unsupported-platform") {
    return {
      kind: "blocked",
      title: "Computer control is unavailable",
      description: `This server is running on ${availability.platform}. Computer control needs macOS, or a Wayland desktop on Linux — KWin or Hyprland, or Pathway's own nested desktop.`,
    };
  }
  // A withheld grant is the one blocked state with a name and a fix, so the
  // title says which permission.
  if (availability.kind === "permission-required") {
    return {
      kind: "blocked",
      title: `Computer control needs ${listComputerPermissions(availability.missing)}`,
      description: availability.message,
    };
  }
  return {
    kind: "blocked",
    title: "Computer control is unavailable",
    description: availability.message,
  };
}

export type ComputerSetupProbe = Pick<
  ComputerStatusResult,
  "availability" | "health" | "capabilities" | "provisionable"
>;

/**
 * Whether this desktop still needs something installed or granted: the test
 * behind the settings panel's "Set up" button and the chat setup card's "did
 * that work?" answer, which must agree. Keyed on live state, never on the
 * static capability flags alone.
 */
export function computerStatusNeedsSetup(
  status: ComputerSetupProbe | undefined,
  grantsConfirmed = false,
): boolean {
  if (!status) return false;
  if (status.availability.kind === "unsupported-platform") return false;
  // An idle backend's placeholder health proves nothing either way; only the
  // OS's own answer that every grant is in place lets it skip Set up.
  const idle = grantsConfirmed && computerBackendIsIdle(status.health);
  return (
    (status.provisionable === true && status.health.status !== "connected" && !idle) ||
    status.availability.kind === "backend-unavailable" ||
    status.availability.kind === "permission-required" ||
    (status.health.captureAvailable === false && !idle) ||
    !status.capabilities.input ||
    !status.capabilities.capture
  );
}

/** What the server's answer means for the user, once. */
export type ComputerProvisionOutcome = "ready" | "incomplete";

export function computerProvisionOutcome(
  result: ComputerProvisionResult,
): ComputerProvisionOutcome {
  return result.status.availability.kind === "available" &&
    result.status.health.status === "connected" &&
    !computerStatusNeedsSetup(result.status)
    ? "ready"
    : "incomplete";
}

export interface ComputerProvisionToast {
  readonly type: "info" | "success" | "warning" | "error";
  readonly title: string;
  readonly description: string;
}

/**
 * Raised as the call starts, because its visible effect is a macOS dialog over
 * Pathway and the user needs to know Pathway asked for it. Grants are named via
 * `listComputerPermissions` so the ordering matches every other surface.
 */
export function computerProvisionStartToast(
  missing: readonly ComputerPermission[] = [],
): ComputerProvisionToast {
  const labels = listComputerPermissions(missing);
  return {
    type: "info",
    title: "Setting up computer control",
    description:
      labels.length > 0
        ? `macOS may ask to allow ${labels} for Pathway.`
        : "Setting up the desktop may require installing a helper or allowing the permissions Pathway needs.",
  };
}

/** The one answer, whichever surface asked. */
export function computerProvisionResultToast(
  result: ComputerProvisionResult,
): ComputerProvisionToast {
  return computerProvisionOutcome(result) === "ready"
    ? { type: "success", title: "Computer control is ready", description: result.summary }
    : {
        type: "warning",
        title: "Computer control still needs setup",
        description: result.summary,
      };
}

export function computerProvisionErrorToast(error: unknown): ComputerProvisionToast {
  return {
    type: "error",
    title: "Couldn't set up computer control",
    description: provisionErrorMessage(error),
  };
}

export function provisionErrorMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0
    ? error.message
    : "The server gave no reason.";
}

/**
 * The settings panel's inline status line: the same three states the toasts
 * describe, for a surface that has room to keep them on screen.
 */
export function computerProvisionNote(state: {
  readonly isPending: boolean;
  readonly missing?: readonly ComputerPermission[];
  readonly error?: unknown;
  readonly result?: ComputerProvisionResult | undefined;
}): string | undefined {
  if (state.isPending) {
    if (state.missing?.length) {
      return `Checking ${listComputerPermissions(state.missing)}. Allow access in the macOS prompt or System Settings, then return to Pathway.`;
    }
    return (
      "Setting up the agent's desktop. This installs or builds whatever this machine still needs, " +
      "and may ask for your password or for desktop permissions. The first run can take a few minutes."
    );
  }
  if (state.error !== undefined && state.error !== null) {
    return `Setting up failed. ${provisionErrorMessage(state.error)}`;
  }
  return state.result?.summary;
}
