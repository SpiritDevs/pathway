// Transcript card that shows the desktop's current permission state and an
// explicit setup action, raised when an agent reached for Computer and the
// desktop was not ready.

import type {
  ComputerBuildSignature,
  ComputerPermission,
  ComputerStatusResult,
  EnvironmentId,
} from "@spiritdevs/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@spiritdevs/client-runtime/state/runtime";
import {
  computerStaleGrantAdvice,
  listComputerPermissions,
} from "@spiritdevs/shared/computerGrants";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";

import { useCachedComputerStatus, useComputerStateStore } from "~/computerStateStore";
import { useComputerStatusRefresh } from "~/hooks/useComputerStatusRefresh";
import { useProvisionComputer } from "~/hooks/useProvisionComputer";
import {
  computerStatusNeedsSetup,
  resolveComputerAvailabilityView,
} from "~/lib/computerProvisioning";
import { computerEnvironment } from "~/state/computer";
import { useAtomCommand } from "~/state/use-atom-command";
import { ComputerActionCard } from "./ComputerActionCard";

export function ComputerSetupRequiredCard({
  missing,
  buildSignature,
  bundleId,
  computerControlReady,
  status,
  statusError,
  isPending = false,
  onSetUp,
  onRecheck,
  onOpenSettings,
}: {
  /**
   * The grants the OS is withholding. Naming them is most of this card's value:
   * "a permission Pathway needs" sends the user hunting through Privacy &
   * Security, while "Accessibility" tells them exactly which switch to find.
   * Empty when the backend refused without naming one.
   */
  readonly missing?: readonly ComputerPermission[] | undefined;
  /**
   * How this Pathway is signed. On a locally built copy the missing grant may be
   * one macOS still lists as given — pinned to a binary a rebuild replaced —
   * which is the difference between "grant it" and "the switch lies to you".
   */
  readonly buildSignature?: ComputerBuildSignature | undefined;
  /**
   * The app macOS files this Pathway's grants against, as the server reported
   * it. The stale-grant advice names it in a `tccutil reset`, and there is no
   * safe default: dev and release builds are separate bundle identifiers, so a
   * guess could revoke a different Pathway's working permissions. Absent means
   * the advice omits the command entirely.
   */
  readonly bundleId?: string | undefined;
  // Live setup state, derived from the desktop's current availability rather
  // than remembered from a button press: once the grants land — including when
  // the user simply allows the dialog macOS already showed — the card flips to a
  // confirmation instead of offering a button that would do nothing.
  readonly computerControlReady?: boolean;
  readonly status?: ComputerStatusResult | undefined;
  readonly statusError?: string | undefined;
  readonly isPending?: boolean;
  readonly onSetUp?: (() => void) | undefined;
  readonly onRecheck?: (() => void) | undefined;
  /** Opens Settings → Computer. */
  readonly onOpenSettings?: (() => void) | undefined;
}) {
  const ready =
    !statusError &&
    (status
      ? status.availability.kind === "available" &&
        status.health.status === "connected" &&
        !computerStatusNeedsSetup(status)
      : computerControlReady === true);
  const availability = status?.availability;
  const livePermission = availability?.kind === "permission-required" ? availability : undefined;
  const currentMissing = statusError
    ? []
    : status
      ? (livePermission?.missing ?? [])
      : (missing ?? []);
  const missingLabels = listComputerPermissions(currentMissing);
  const currentSignature = status ? livePermission?.buildSignature : buildSignature;
  const currentBundleId = status ? livePermission?.bundleId : bundleId;
  const availabilityView = status
    ? resolveComputerAvailabilityView(status.availability, status.health)
    : undefined;
  const title = statusError
    ? "Computer status is unavailable"
    : ready
      ? "Computer control is ready"
      : missingLabels
        ? `Computer control needs ${missingLabels}`
        : (availabilityView?.title ?? "Computer control needs setup");
  const description = statusError
    ? statusError
    : ready
      ? "Send a message and the agent will pick up where it left off."
      : missingLabels
        ? "Choose Set up to request missing permissions or open System Settings. Allow access for this Pathway app, then return here to recheck."
        : (availabilityView?.description ??
          "Choose Set up to check permissions and prepare computer control.");
  const canSetUp =
    !ready &&
    !statusError &&
    availability?.kind !== "unsupported-platform" &&
    status?.provisionable !== false;
  // Only ever non-null on a locally built copy with a grant outstanding: on a
  // signed build the switch in System Settings means what it says, and the
  // extra paragraph would be a red herring.
  const staleGrantAdvice =
    !ready && currentSignature
      ? computerStaleGrantAdvice(currentMissing, currentSignature, currentBundleId)
      : null;
  return (
    <ComputerActionCard
      tone={statusError ? "error" : ready ? "success" : "warning"}
      title={title}
      action={
        onSetUp && canSetUp
          ? { label: isPending ? "Setting up…" : "Set up", disabled: isPending, onClick: onSetUp }
          : statusError && onRecheck
            ? { label: "Recheck", onClick: onRecheck }
            : undefined
      }
    >
      <p>{description}</p>
      {staleGrantAdvice ? <p>{staleGrantAdvice}</p> : null}
      {onOpenSettings && !ready ? (
        <p>
          <button
            type="button"
            className="font-medium text-foreground underline-offset-4 hover:underline"
            onClick={onOpenSettings}
          >
            Open Computer settings
          </button>
        </p>
      ) : null}
    </ComputerActionCard>
  );
}

type ConnectedProps = Pick<
  Parameters<typeof ComputerSetupRequiredCard>[0],
  "missing" | "buildSignature" | "bundleId" | "onOpenSettings"
> & { readonly environmentId: EnvironmentId };

/**
 * The desktop is shared by every chat on the environment, so the card reads
 * the environment's live status rather than the notice's snapshot.
 */
export function ConnectedComputerSetupRequiredCard({ environmentId, ...props }: ConnectedProps) {
  const navigate = useNavigate();
  const openSettings = useCallback(() => {
    void navigate({ to: "/settings/computer" });
  }, [navigate]);
  const status = useCachedComputerStatus(environmentId);
  const refreshStatus = useAtomCommand(computerEnvironment.refreshStatus, {
    reportFailure: false,
  });
  const [statusError, setStatusError] = useState<string | undefined>(undefined);
  const recheck = useCallback(() => {
    void refreshStatus({ environmentId, input: {} }).then((outcome) => {
      if (outcome._tag === "Success") {
        useComputerStateStore.getState().setStatus(environmentId, outcome.value);
        setStatusError(undefined);
        return;
      }
      if (isAtomCommandInterrupted(outcome)) return;
      const error = squashAtomCommandFailure(outcome);
      setStatusError(
        error instanceof Error && error.message
          ? error.message
          : "Could not check computer access. Try again.",
      );
    });
  }, [environmentId, refreshStatus]);
  const hasStatus = status !== undefined;
  // Read once when no other surface has asked yet; after that the 10-second
  // refresh and pushed status events keep it current.
  useEffect(() => {
    if (!hasStatus) recheck();
  }, [hasStatus, recheck]);
  const ready =
    status !== undefined &&
    status.availability.kind === "available" &&
    status.health.status === "connected" &&
    !computerStatusNeedsSetup(status);
  useComputerStatusRefresh({
    refreshStatus: recheck,
    paused: ready || statusError !== undefined,
  });
  const missing = status
    ? status.availability.kind === "permission-required"
      ? status.availability.missing
      : []
    : props.missing;
  const setup = useProvisionComputer(environmentId, {
    ...(missing ? { missing } : {}),
    notify: true,
  });
  return (
    <ComputerSetupRequiredCard
      onOpenSettings={openSettings}
      {...props}
      status={status}
      statusError={statusError}
      isPending={setup.isPending}
      onSetUp={setup.provision}
      onRecheck={recheck}
    />
  );
}
