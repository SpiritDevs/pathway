import { useAuth } from "@clerk/react";
import { findErrorTraceId } from "@spiritdevs/client-runtime/errors";
import { normalizeSecureRelayUrl } from "@spiritdevs/shared/relayUrl";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@spiritdevs/client-runtime/state/runtime";
import * as Option from "effect/Option";
import { useEffect, useEffectEvent, useRef, useState, useSyncExternalStore } from "react";

import { toastManager } from "../components/ui/toast";
import { relayEnvironmentDiscovery } from "../state/relay";
import { useAtomCommand } from "../state/use-atom-command";
import { useAtomValue } from "@effect/atom-react";
import {
  linkPrimaryEnvironment as linkPrimaryEnvironmentAtom,
  unlinkPrimaryEnvironment as unlinkPrimaryEnvironmentAtom,
  updatePrimaryEnvironmentPreferences as updatePrimaryEnvironmentPreferencesAtom,
} from "./linkEnvironmentAtoms";
import { usePrimaryCloudLinkState } from "./primaryCloudLinkState";
import {
  hasCloudPublicConfig,
  resolveCloudPublicConfig,
  resolveRelayClerkTokenOptions,
} from "./publicConfig";

// #region DEBUG
function debugAlwaysOnCloudLink(
  event: string,
  fields: Readonly<Record<string, string | number | boolean | null>>,
): void {
  void fetch("/api/__debug/cloud-sync", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hypothesis: "H3", event, fields }),
  }).catch(() => undefined);
}
// #endregion DEBUG

export interface CloudLinkDesiredState {
  readonly managedTunnel: boolean;
  readonly publish: boolean;
}

export const ALWAYS_ON_CLOUD_LINK_STATE = {
  managedTunnel: true,
  publish: true,
} as const satisfies CloudLinkDesiredState;

export const AUTOMATIC_CLOUD_LINK_MAX_ATTEMPTS = 5;

export interface AlwaysOnCloudLinkStatus {
  readonly phase: "idle" | "connecting" | "waiting" | "connected" | "exhausted";
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly error: string | null;
  readonly nextRetryAt: number | null;
  readonly manualRetryRequestId: number;
  readonly manualRelinkRequestId: number;
}

export const CLOUD_ACCOUNT_LINK_CONFLICT_MESSAGE =
  "This environment is already linked to a different cloud account.";

export function isCloudAccountLinkConflict(error: string | null): boolean {
  return error?.includes(CLOUD_ACCOUNT_LINK_CONFLICT_MESSAGE) ?? false;
}

const alwaysOnCloudLinkListeners = new Set<() => void>();
let alwaysOnCloudLinkStatus: AlwaysOnCloudLinkStatus = {
  phase: "idle",
  attempt: 0,
  maxAttempts: AUTOMATIC_CLOUD_LINK_MAX_ATTEMPTS,
  error: null,
  nextRetryAt: null,
  manualRetryRequestId: 0,
  manualRelinkRequestId: 0,
};

function publishAlwaysOnCloudLinkStatus(
  update: Omit<
    AlwaysOnCloudLinkStatus,
    "manualRetryRequestId" | "manualRelinkRequestId" | "maxAttempts"
  >,
): void {
  alwaysOnCloudLinkStatus = {
    ...update,
    maxAttempts: AUTOMATIC_CLOUD_LINK_MAX_ATTEMPTS,
    manualRetryRequestId: alwaysOnCloudLinkStatus.manualRetryRequestId,
    manualRelinkRequestId: alwaysOnCloudLinkStatus.manualRelinkRequestId,
  };
  for (const listener of alwaysOnCloudLinkListeners) listener();
}

function subscribeAlwaysOnCloudLinkStatus(listener: () => void): () => void {
  alwaysOnCloudLinkListeners.add(listener);
  return () => alwaysOnCloudLinkListeners.delete(listener);
}

function readAlwaysOnCloudLinkStatus(): AlwaysOnCloudLinkStatus {
  return alwaysOnCloudLinkStatus;
}

export function requestAlwaysOnCloudLinkRetry(): void {
  if (alwaysOnCloudLinkStatus.phase !== "exhausted") return;
  alwaysOnCloudLinkStatus = {
    ...alwaysOnCloudLinkStatus,
    phase: "connecting",
    attempt: 1,
    error: null,
    nextRetryAt: null,
    manualRetryRequestId: alwaysOnCloudLinkStatus.manualRetryRequestId + 1,
  };
  for (const listener of alwaysOnCloudLinkListeners) listener();
}

export function requestAlwaysOnCloudLinkRelink(): void {
  alwaysOnCloudLinkStatus = {
    ...alwaysOnCloudLinkStatus,
    phase: "connecting",
    attempt: 1,
    error: null,
    nextRetryAt: null,
    manualRelinkRequestId: alwaysOnCloudLinkStatus.manualRelinkRequestId + 1,
  };
  for (const listener of alwaysOnCloudLinkListeners) listener();
}

export function useAlwaysOnCloudLinkStatus(): AlwaysOnCloudLinkStatus {
  return useSyncExternalStore(
    subscribeAlwaysOnCloudLinkStatus,
    readAlwaysOnCloudLinkStatus,
    readAlwaysOnCloudLinkStatus,
  );
}

/**
 * Whether the relay account still owns this environment. Local link secrets
 * only record what the environment was told; the account can revoke the link
 * out of band (another device removes the environment), and nothing informs
 * the environment. `"unknown"` means the account listing has not been
 * established yet and absence must not be inferred from it.
 */
export type CloudAccountMembership = "unknown" | "present" | "absent";

export function resolveCloudAccountMembership(input: {
  readonly listed: boolean;
  readonly hasError: boolean;
  readonly offline: boolean;
  readonly environmentIds: ReadonlyArray<string>;
  readonly environmentId: string | null;
}): CloudAccountMembership {
  if (!input.listed || input.hasError || input.offline || input.environmentId === null) {
    return "unknown";
  }
  return input.environmentIds.includes(input.environmentId) ? "present" : "absent";
}

export function isAlwaysOnCloudLinkState(input: {
  readonly linked: boolean;
  readonly managedTunnelActive: boolean;
  readonly publishAgentActivity: boolean;
  readonly linkedRelayUrl: string | null;
  readonly configuredRelayUrl: string | null;
  readonly accountMembership?: CloudAccountMembership;
}): boolean {
  return (
    input.linked &&
    input.managedTunnelActive &&
    input.publishAgentActivity &&
    // An environment the account no longer lists is unreachable through the
    // relay no matter how healthy its local link and tunnel look, and only a
    // fresh link puts it back. Treat that as unsatisfied so the invariant
    // repairs itself instead of stranding the environment.
    (input.accountMembership ?? "unknown") !== "absent" &&
    input.configuredRelayUrl !== null &&
    normalizeSecureRelayUrl(input.linkedRelayUrl ?? "") === input.configuredRelayUrl
  );
}

export function shouldRelinkCloudEnvironment(input: {
  readonly linked: boolean;
  readonly managedTunnelActive: boolean;
  readonly desiredManagedTunnel: boolean;
  readonly linkedRelayUrl: string | null;
  readonly configuredRelayUrl: string | null;
  readonly accountMembership?: CloudAccountMembership;
}): boolean {
  return (
    !input.linked ||
    input.managedTunnelActive !== input.desiredManagedTunnel ||
    (input.accountMembership ?? "unknown") === "absent" ||
    input.configuredRelayUrl === null ||
    normalizeSecureRelayUrl(input.linkedRelayUrl ?? "") !== input.configuredRelayUrl
  );
}

/**
 * Drives the primary environment's Pathway Connect link. Pathway Connect (managed
 * tunnel) and agent-activity publishing are independent capabilities backed by
 * a single relay link, so consumers express the full desired state and
 * `reconcileCloudState` applies it: unlink when neither is wanted, otherwise
 * (re)link with the mode the managed-tunnel bit implies and set the publish
 * preference. Re-linking only happens when the managed-tunnel mode actually
 * changes, so flipping publish alone is cheap.
 */
export function useCloudLinkController(options: { readonly reportFailures?: boolean } = {}) {
  const { getToken, isSignedIn } = useAuth();
  const refreshRelayEnvironments = useAtomCommand(relayEnvironmentDiscovery.refresh, {
    reportFailure: false,
  });
  const linkPrimaryEnvironment = useAtomCommand(linkPrimaryEnvironmentAtom, {
    reportFailure: false,
  });
  const unlinkPrimaryEnvironment = useAtomCommand(unlinkPrimaryEnvironmentAtom, {
    reportFailure: false,
  });
  const updatePrimaryEnvironmentPreferences = useAtomCommand(
    updatePrimaryEnvironmentPreferencesAtom,
    { reportFailure: false },
  );
  const primaryCloudLinkState = usePrimaryCloudLinkState();
  const relayDiscovery = useAtomValue(relayEnvironmentDiscovery.stateValueAtom);
  const [operationError, setOperationError] = useState<string | null>(null);
  const reportFailures = options.reportFailures ?? true;

  const reportUpdateFailure = (cause: unknown): string => {
    const message =
      cause instanceof Error ? cause.message : "Could not update Pathway Connect access.";
    const traceId = findErrorTraceId(cause);
    const renderedMessage = traceId ? `${message} Trace ID: ${traceId}` : message;
    console.error("[pathway-connect] Could not update Pathway Connect", {
      message,
      traceId,
      cause,
    });
    setOperationError(renderedMessage);
    if (reportFailures) {
      toastManager.add({
        type: "error",
        title: "Could not update Pathway Connect",
        description: message,
        data: traceId
          ? {
              secondaryActionProps: {
                children: "Copy trace ID",
                onClick: () => void navigator.clipboard?.writeText(traceId),
              },
            }
          : undefined,
      });
    }
    return renderedMessage;
  };

  // Older environment servers predate the managedTunnelActive field; for them a
  // link always implies a managed tunnel, so fall back to `linked`.
  const managedTunnelActive =
    primaryCloudLinkState.data?.managedTunnelActive ?? primaryCloudLinkState.data?.linked ?? false;
  const publishAgentActivity = primaryCloudLinkState.data?.publishAgentActivity ?? false;
  const linked = primaryCloudLinkState.data?.linked ?? false;
  const linkedRelayUrl = primaryCloudLinkState.data?.relayUrl ?? null;
  const configuredRelayUrl = resolveCloudPublicConfig().relayUrl;
  const accountMembership = resolveCloudAccountMembership({
    listed: relayDiscovery.listed,
    hasError: Option.isSome(relayDiscovery.error),
    offline: relayDiscovery.offline,
    environmentIds: [...relayDiscovery.environments.keys()],
    environmentId: primaryCloudLinkState.target?.environmentId ?? null,
  });

  const updateCloudState = async (
    desired: CloudLinkDesiredState,
    replaceExistingLink: boolean,
  ): Promise<{ readonly completed: boolean; readonly error: string | null }> => {
    setOperationError(null);
    const target = primaryCloudLinkState.target;
    if (!target) {
      return {
        completed: false,
        error: reportUpdateFailure(new Error("Local environment is not ready yet.")),
      };
    }
    const tokenResult = await settlePromise(() => getToken(resolveRelayClerkTokenOptions()));
    const wantsLink = desired.managedTunnel || desired.publish;

    // A failure after this point may follow a partially applied mutation (e.g.
    // the link succeeded but the preference update did not), so every exit —
    // success or failure — refreshes the rendered state to whatever the server
    // actually holds now.
    if (!wantsLink) {
      // Unlink works without a relay token — a failed token read must not
      // leave the user unable to turn Pathway Connect off.
      const unlinkResult = await unlinkPrimaryEnvironment({
        target,
        clerkToken: tokenResult._tag === "Success" ? (tokenResult.value ?? null) : null,
      });
      if (unlinkResult._tag === "Failure") {
        const error = isAtomCommandInterrupted(unlinkResult)
          ? "Pathway Connect attempt was interrupted."
          : reportUpdateFailure(squashAtomCommandFailure(unlinkResult));
        primaryCloudLinkState.refresh();
        return { completed: false, error };
      }
    } else {
      if (tokenResult._tag === "Failure") {
        return {
          completed: false,
          error: reportUpdateFailure(squashAtomCommandFailure(tokenResult)),
        };
      }
      const clerkToken = tokenResult.value;
      if (!clerkToken) {
        return {
          completed: false,
          error: reportUpdateFailure(new Error("Sign in to Pathway Connect before enabling this.")),
        };
      }
      if (replaceExistingLink && linked) {
        const unlinkResult = await unlinkPrimaryEnvironment({ target, clerkToken });
        if (unlinkResult._tag === "Failure") {
          const error = isAtomCommandInterrupted(unlinkResult)
            ? "Pathway Connect attempt was interrupted."
            : reportUpdateFailure(squashAtomCommandFailure(unlinkResult));
          primaryCloudLinkState.refresh();
          return { completed: false, error };
        }
      }
      if (
        replaceExistingLink ||
        shouldRelinkCloudEnvironment({
          linked,
          managedTunnelActive,
          desiredManagedTunnel: desired.managedTunnel,
          linkedRelayUrl,
          configuredRelayUrl,
          accountMembership,
        })
      ) {
        const linkResult = await linkPrimaryEnvironment({
          target,
          clerkToken,
          mode: desired.managedTunnel ? "managed" : "publish_only",
        });
        if (linkResult._tag === "Failure") {
          const error = isAtomCommandInterrupted(linkResult)
            ? "Pathway Connect attempt was interrupted."
            : reportUpdateFailure(squashAtomCommandFailure(linkResult));
          primaryCloudLinkState.refresh();
          return { completed: false, error };
        }
      }
      const prefResult = await updatePrimaryEnvironmentPreferences({
        target,
        publishAgentActivity: desired.publish,
      });
      if (prefResult._tag === "Failure") {
        const error = isAtomCommandInterrupted(prefResult)
          ? "Pathway Connect attempt was interrupted."
          : reportUpdateFailure(squashAtomCommandFailure(prefResult));
        primaryCloudLinkState.refresh();
        return { completed: false, error };
      }
    }

    primaryCloudLinkState.refresh();
    const refreshResult = await refreshRelayEnvironments();
    if (refreshResult._tag === "Failure" && !isAtomCommandInterrupted(refreshResult)) {
      return {
        completed: false,
        error: reportUpdateFailure(squashAtomCommandFailure(refreshResult)),
      };
    }
    return { completed: true, error: null };
  };

  const reconcileCloudState = (desired: CloudLinkDesiredState) => updateCloudState(desired, false);
  const relinkCloudState = (desired: CloudLinkDesiredState) => updateCloudState(desired, true);

  return {
    isSignedIn,
    linkState: primaryCloudLinkState,
    linked,
    managedTunnelActive,
    publishAgentActivity,
    operationError,
    accountMembership,
    reconcileCloudState,
    relinkCloudState,
  };
}

const AUTOMATIC_LINK_RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000] as const;

export function automaticCloudRetryDelayMs(attempt: number): number {
  const delay =
    AUTOMATIC_LINK_RETRY_DELAYS_MS[
      Math.min(Math.max(0, attempt), AUTOMATIC_LINK_RETRY_DELAYS_MS.length - 1)
    ];
  return delay ?? AUTOMATIC_LINK_RETRY_DELAYS_MS[0];
}

export function shouldScheduleAutomaticCloudRetry(
  attemptsCompleted: number,
  attemptsAllowed = AUTOMATIC_CLOUD_LINK_MAX_ATTEMPTS,
  error: string | null = null,
): boolean {
  return !isCloudAccountLinkConflict(error) && attemptsCompleted < attemptsAllowed;
}

/**
 * Keeps the signed-in primary environment linked with Pathway Connect. This is a runtime
 * invariant rather than a preference: transient relay failures retry without requiring the user
 * to find a settings toggle, and a relink or preference drift is repaired on the next state read.
 */
export function useAlwaysOnCloudLink(): void {
  const controller = useCloudLinkController({ reportFailures: false });
  const cloudConfigured = hasCloudPublicConfig();
  const reconcileCloudState = useEffectEvent(controller.reconcileCloudState);
  const relinkCloudState = useEffectEvent(controller.relinkCloudState);
  const retryStatus = useAlwaysOnCloudLinkStatus();
  const lastHandledManualRetry = useRef(retryStatus.manualRetryRequestId);
  const lastHandledManualRelink = useRef(retryStatus.manualRelinkRequestId);

  const target = controller.linkState.target;
  const isSatisfied = isAlwaysOnCloudLinkState({
    linked: controller.linked,
    managedTunnelActive: controller.managedTunnelActive,
    publishAgentActivity: controller.publishAgentActivity,
    linkedRelayUrl: controller.linkState.data?.relayUrl ?? null,
    configuredRelayUrl: resolveCloudPublicConfig().relayUrl,
    accountMembership: controller.accountMembership,
  });

  const eligible =
    controller.isSignedIn &&
    cloudConfigured &&
    target !== null &&
    controller.linkState.data !== null;

  useEffect(() => {
    // #region DEBUG
    debugAlwaysOnCloudLink("reconcile-effect-entered", {
      eligible: eligible ?? null,
      isSatisfied,
      isSignedIn: controller.isSignedIn ?? null,
      manualRelinkRequestId: retryStatus.manualRelinkRequestId,
      manualRetryRequestId: retryStatus.manualRetryRequestId,
      phase: retryStatus.phase,
      targetReady: target !== null,
    });
    // #endregion DEBUG
    if (!eligible || target === null) {
      publishAlwaysOnCloudLinkStatus({
        phase: "idle",
        attempt: 0,
        error: null,
        nextRetryAt: null,
      });
      return;
    }

    if (isSatisfied) {
      publishAlwaysOnCloudLinkStatus({
        phase: "connected",
        attempt: 0,
        error: null,
        nextRetryAt: null,
      });
      lastHandledManualRetry.current = retryStatus.manualRetryRequestId;
      lastHandledManualRelink.current = retryStatus.manualRelinkRequestId;
      return;
    }

    const isManualRetry = retryStatus.manualRetryRequestId !== lastHandledManualRetry.current;
    const isManualRelink = retryStatus.manualRelinkRequestId !== lastHandledManualRelink.current;
    if (isManualRetry) {
      lastHandledManualRetry.current = retryStatus.manualRetryRequestId;
    }
    if (isManualRelink) {
      lastHandledManualRelink.current = retryStatus.manualRelinkRequestId;
    }

    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let attemptsCompleted = 0;
    const attemptsAllowed = isManualRetry || isManualRelink ? 1 : AUTOMATIC_CLOUD_LINK_MAX_ATTEMPTS;

    const reconcile = async () => {
      const attempt = attemptsCompleted + 1;
      // #region DEBUG
      debugAlwaysOnCloudLink("reconcile-attempt-started", {
        attempt,
        manualRelink: isManualRelink,
        manualRetry: isManualRetry,
      });
      // #endregion DEBUG
      publishAlwaysOnCloudLinkStatus({
        phase: "connecting",
        attempt,
        error: attemptsCompleted === 0 ? null : alwaysOnCloudLinkStatus.error,
        nextRetryAt: null,
      });
      const result = await (isManualRelink ? relinkCloudState : reconcileCloudState)(
        ALWAYS_ON_CLOUD_LINK_STATE,
      );
      // #region DEBUG
      debugAlwaysOnCloudLink("reconcile-attempt-finished", {
        attempt,
        completed: result.completed,
        hasError: result.error !== null,
      });
      // #endregion DEBUG
      if (cancelled) return;
      attemptsCompleted = attempt;
      if (result.completed) {
        publishAlwaysOnCloudLinkStatus({
          phase: "connected",
          attempt: 0,
          error: null,
          nextRetryAt: null,
        });
        return;
      }
      if (!shouldScheduleAutomaticCloudRetry(attemptsCompleted, attemptsAllowed, result.error)) {
        publishAlwaysOnCloudLinkStatus({
          phase: "exhausted",
          attempt: attemptsCompleted,
          error: result.error,
          nextRetryAt: null,
        });
        return;
      }
      const delay = automaticCloudRetryDelayMs(attemptsCompleted - 1);
      publishAlwaysOnCloudLinkStatus({
        phase: "waiting",
        attempt: attemptsCompleted,
        error: result.error,
        nextRetryAt: Date.now() + delay,
      });
      retryTimer = setTimeout(() => void reconcile(), delay);
    };

    void reconcile();
    return () => {
      cancelled = true;
      if (retryTimer !== null) clearTimeout(retryTimer);
    };
  }, [
    cloudConfigured,
    controller.isSignedIn,
    eligible,
    isSatisfied,
    retryStatus.manualRelinkRequestId,
    retryStatus.manualRetryRequestId,
    target?.environmentId,
  ]);
}
