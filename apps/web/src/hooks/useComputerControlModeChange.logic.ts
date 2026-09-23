import type {
  ComputerControlEnabledResult,
  ComputerControlMode,
  DesktopComputerBridge,
  DesktopComputerHelperState,
  DesktopComputerPermissionKind,
  EnvironmentId,
} from "@spiritdevs/contracts";
import {
  COMPUTER_PERMISSIONS,
  missingComputerHelperPermissions,
} from "@spiritdevs/shared/computerGrants";
import { resolveComputerInvocationMode } from "@spiritdevs/shared/computerInvocation";

import type { ComposerComputerControlMode } from "../computerControlMode";

/** Every grant Computer asks for, in the native guide's setup order. */
export const COMPUTER_PERMISSION_KINDS: readonly DesktopComputerPermissionKind[] =
  COMPUTER_PERMISSIONS;

export type ComputerPermissionBridge = Pick<
  DesktopComputerBridge,
  "getState" | "startPermissionSetup"
>;

/**
 * The desktop's permission bridge, only when the thread's environment is this
 * desktop's own server. A remote environment's grants live on its host.
 */
export function readLocalComputerPermissionBridge(input: {
  readonly environmentId: EnvironmentId | null;
  readonly localEnvironmentId: EnvironmentId | null;
  readonly bridge: ComputerPermissionBridge | undefined;
}): ComputerPermissionBridge | null {
  if (!input.bridge || input.environmentId === null) return null;
  return input.environmentId === input.localEnvironmentId ? input.bridge : null;
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
  if (!state.supported) return true;
  if (missingComputerHelperPermissions(state).length === 0) return true;
  await input.startPermissionSetup(COMPUTER_PERMISSION_KINDS);
  return false; // Preserve the draft; granting access never auto-sends the task.
}

export interface ComputerControlModeChangeToast {
  readonly title: string;
  readonly description: string;
  readonly type: "error";
}

/**
 * Applies one explicit Computer mode change for a thread: tells the server,
 * records the mode and generation it answered with, and on the local desktop
 * opens the permission guide before handing focus back to the composer.
 */
export async function runComputerControlModeChange(
  mode: ComposerComputerControlMode,
  deps: {
    readonly setControlEnabled: (enabled: boolean) => Promise<ComputerControlEnabledResult>;
    readonly setMode: (
      mode: ComposerComputerControlMode,
      options: { readonly generation: number },
    ) => void;
    readonly permissionBridge: ComputerPermissionBridge | null;
    readonly focusComposer: () => void;
    readonly isCurrent: () => boolean;
    readonly notify: (toast: ComputerControlModeChangeToast) => void;
  },
): Promise<void> {
  let settingUp = false;
  try {
    const result = await deps.setControlEnabled(mode !== "off");
    if (!deps.isCurrent()) return;
    deps.setMode(result.enabled ? mode : "off", { generation: result.generation ?? 0 });
    // Enabling against a reset server generation leaves control off: the
    // intent it would have armed is stale, so say so plainly.
    if (mode !== "off" && !result.enabled && deps.isCurrent()) {
      deps.notify({
        title: "Computer control was reset",
        description: "Control was reset — invoke /computer-use again for a new task.",
        type: "error",
      });
    }
    const bridge = deps.permissionBridge;
    if (result.enabled && bridge) {
      settingUp = true;
      const ready = await prepareComputerPermissionGuide({
        getPermissionState: (kinds) => bridge.getState(kinds),
        startPermissionSetup: (kinds) => bridge.startPermissionSetup(kinds),
        isCurrent: deps.isCurrent,
      });
      if (!ready) return; // Keep Settings/its floating guide in front.
    }
    if (deps.isCurrent()) deps.focusComposer();
  } catch (error) {
    if (!deps.isCurrent()) return;
    deps.notify({
      title: settingUp
        ? "Computer permission setup could not start"
        : "Computer control could not be changed",
      description: error instanceof Error ? error.message : String(error),
      type: "error",
    });
  }
}

/**
 * The Computer intent one user send carries. The setting enables the whole
 * chat; otherwise a leading `/computer-use` enables only this request. The
 * generation pins the intent to the control epoch it was made in, so a Stop
 * or revoke that lands first invalidates it.
 */
export function resolveComputerControlForSend(input: {
  readonly messageText: string;
  readonly computerControlEnabled: boolean;
  readonly generation: number | undefined;
}): {
  readonly mode: ComputerControlMode;
  readonly fields: {
    readonly enableComputerControl?: true;
    readonly computerControlGeneration?: number;
  };
} {
  const mode = resolveComputerInvocationMode({
    messageText: input.messageText,
    enableComputerControl: input.computerControlEnabled,
  });
  if (mode === "off") return { mode, fields: {} };
  return {
    mode,
    fields: {
      ...(input.computerControlEnabled ? { enableComputerControl: true as const } : {}),
      computerControlGeneration: input.generation ?? 0,
    },
  };
}
