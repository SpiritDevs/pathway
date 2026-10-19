// The single "Set up computer control" command, shared by the chat's setup card
// and the Computer settings panel. Provisioning changes the machine (installs
// packages, builds a helper, raises an OS permission dialog), so there must be
// exactly one in flight per environment and one account of what happened.

import type {
  ComputerPermission,
  ComputerProvisionResult,
  EnvironmentId,
} from "@spiritdevs/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@spiritdevs/client-runtime/state/runtime";
import { useCallback, useState, useSyncExternalStore } from "react";

import { toastManager } from "../components/ui/toast";
import { computerEnvironmentFence, useComputerStateStore } from "../computerStateStore";
import { isElectron } from "../env";
import {
  computerProvisionErrorToast,
  computerProvisionNote,
  computerProvisionOutcome,
  computerProvisionResultToast,
  computerProvisionStartToast,
  readLocalComputerPermissionBridge,
} from "../lib/computerProvisioning";
import { computerEnvironment } from "../state/computer";
import { usePrimaryEnvironmentId } from "../state/environments";
import { useAtomCommand } from "../state/use-atom-command";

/**
 * Environments with a provision in flight, shared by every mounted surface so
 * the card and the panel agree on "Setting up…" and a second press is refused.
 */
const pendingProvisions = new Set<string>();
const pendingListeners = new Set<() => void>();

function setProvisionPending(environmentId: string, pending: boolean): void {
  if (pending) pendingProvisions.add(environmentId);
  else pendingProvisions.delete(environmentId);
  for (const listener of pendingListeners) listener();
}

function subscribePendingProvisions(listener: () => void): () => void {
  pendingListeners.add(listener);
  return () => pendingListeners.delete(listener);
}

export function isComputerProvisionPending(environmentId: string): boolean {
  return pendingProvisions.has(environmentId);
}

export interface UseProvisionComputerResult {
  /**
   * Starts a provision, or does nothing while one is already running. Settles
   * once the attempt is accounted for.
   */
  readonly provision: () => Promise<void>;
  readonly isPending: boolean;
  /** The settings panel's inline account of the attempt; undefined when there is nothing to say. */
  readonly note: string | undefined;
}

type ProvisionAttempt =
  | { readonly kind: "idle" }
  | { readonly kind: "success"; readonly result: ComputerProvisionResult }
  | { readonly kind: "error"; readonly error: unknown };

const IDLE_ATTEMPT: ProvisionAttempt = { kind: "idle" };

export function useProvisionComputer(
  environmentId: EnvironmentId | null,
  options?: {
    /** The grants the OS is withholding, so the opening toast can name them. */
    readonly missing?: readonly ComputerPermission[];
    /**
     * Toasts are how a transcript card reports; the settings panel keeps the
     * same words inline instead and would otherwise say everything twice.
     */
    readonly notify?: boolean;
    /** Ran once, after a provision that left nothing to set up. */
    readonly onReady?: (result: ComputerProvisionResult) => void;
  },
): UseProvisionComputerResult {
  const notify = options?.notify ?? false;
  const missing = options?.missing;
  const onReady = options?.onReady;
  // The desktop app's native grant guide speaks for its own primary environment
  // whichever surface started setup. It can push later grants while the RPC
  // returns, so the RPC's status snapshot is re-read instead of trusted.
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const nativePermissionSetup =
    readLocalComputerPermissionBridge({
      environmentIsDesktopPrimary:
        isElectron && environmentId !== null && environmentId === primaryEnvironmentId,
    }) !== null;
  const provisionCommand = useAtomCommand(computerEnvironment.provision, { reportFailure: false });
  const refreshStatus = useAtomCommand(computerEnvironment.refreshStatus, {
    reportFailure: false,
  });
  const [attempt, setAttempt] = useState<ProvisionAttempt>(IDLE_ATTEMPT);
  const isPending = useSyncExternalStore(
    subscribePendingProvisions,
    () => environmentId !== null && pendingProvisions.has(environmentId),
    () => false,
  );

  const provision = useCallback(() => {
    // A second provision would re-enter the installer and re-arm the permission
    // prompt behind the dialog the user is already looking at.
    if (environmentId === null || pendingProvisions.has(environmentId)) return Promise.resolve();
    if (notify) toastManager.add(computerProvisionStartToast(missing));
    setProvisionPending(environmentId, true);
    setAttempt(IDLE_ATTEMPT);
    const isCurrent = computerEnvironmentFence(environmentId);
    return provisionCommand({ environmentId, input: {} })
      .then(async (outcome) => {
        if (outcome._tag === "Success") {
          const result = outcome.value;
          const setStatus = useComputerStateStore.getState().setStatus;
          if (nativePermissionSetup) {
            // Do not overwrite a newer grant push with the RPC's earlier snapshot.
            const refreshed = await refreshStatus({ environmentId, input: {} });
            if (refreshed._tag === "Success" && isCurrent()) {
              setStatus(environmentId, refreshed.value);
            }
          } else if (isCurrent()) {
            setStatus(environmentId, result.status);
          }
          setAttempt({ kind: "success", result });
          const ready = computerProvisionOutcome(result) === "ready";
          if (notify && (!nativePermissionSetup || ready)) {
            toastManager.add(computerProvisionResultToast(result));
          }
          if (ready) onReady?.(result);
          return;
        }
        if (isAtomCommandInterrupted(outcome)) return;
        const error = squashAtomCommandFailure(outcome);
        setAttempt({ kind: "error", error });
        if (notify) toastManager.add(computerProvisionErrorToast(error));
      })
      .finally(() => setProvisionPending(environmentId, false));
  }, [
    environmentId,
    missing,
    nativePermissionSetup,
    notify,
    onReady,
    provisionCommand,
    refreshStatus,
  ]);

  return {
    provision,
    isPending,
    note: computerProvisionNote({
      isPending,
      ...(missing ? { missing } : {}),
      error: attempt.kind === "error" ? attempt.error : undefined,
      result: attempt.kind === "success" && !nativePermissionSetup ? attempt.result : undefined,
    }),
  };
}
