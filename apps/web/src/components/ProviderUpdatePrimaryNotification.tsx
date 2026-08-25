import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { PROVIDER_DISPLAY_NAMES } from "@spiritdevs/contracts";
import { LoaderIcon, XIcon } from "lucide-react";
import { useMemo, useRef, useState } from "react";

import { useDismissedProviderUpdateNotificationKeys } from "../providerUpdateDismissal";
import { usePrimaryEnvironment } from "../state/environments";
import { primaryServerProvidersAtom, serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import {
  canOneClickUpdateProviderCandidate,
  collectProviderUpdateCandidates,
  providerUpdateNotificationKey,
} from "./ProviderUpdateLaunchNotification.logic";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

/**
 * A deliberately quiet provider-update prompt for the workspace title bar.
 *
 * The provider status is already explained in Settings, so this surface only
 * exposes the two decisions that matter here: install or dismiss. It stays
 * inside the existing title-bar height and leaves update progress/results to
 * the provider state and the navigation-rail status pill.
 */
export function ProviderUpdatePrimaryNotification() {
  const navigate = useNavigate();
  const providers = useAtomValue(primaryServerProvidersAtom);
  const primaryEnvironment = usePrimaryEnvironment();
  const updateProvider = useAtomCommand(serverEnvironment.updateProvider, {
    reportFailure: false,
  });
  const { dismissedNotificationKeys, dismissNotificationKey } =
    useDismissedProviderUpdateNotificationKeys();
  const [isUpdating, setIsUpdating] = useState(false);
  const inFlightRef = useRef(false);

  const updateProviders = useMemo(() => collectProviderUpdateCandidates(providers), [providers]);
  const notificationKey = useMemo(
    () => providerUpdateNotificationKey(updateProviders),
    [updateProviders],
  );
  const oneClickProviders = useMemo(
    () =>
      updateProviders.filter((provider) => canOneClickUpdateProviderCandidate(provider, providers)),
    [providers, updateProviders],
  );

  if (
    notificationKey === null ||
    dismissedNotificationKeys.has(notificationKey) ||
    updateProviders.length === 0
  ) {
    return null;
  }

  const providerLabel =
    updateProviders.length === 1
      ? (PROVIDER_DISPLAY_NAMES[updateProviders[0]!.driver] ?? updateProviders[0]!.driver)
      : `${updateProviders.length} providers`;
  const canUpdate = oneClickProviders.length > 0 && primaryEnvironment !== null;
  const actionLabel = isUpdating ? `Updating ${providerLabel}` : `Update ${providerLabel}`;
  const tooltip =
    updateProviders.length === 1
      ? `${providerLabel} ${updateProviders[0]!.versionAdvisory.latestVersion} is available`
      : `${updateProviders.length} provider updates are available`;

  const runUpdates = async () => {
    if (!canUpdate || inFlightRef.current || primaryEnvironment === null) {
      void navigate({ to: "/settings/providers" });
      return;
    }

    inFlightRef.current = true;
    setIsUpdating(true);
    try {
      for (const provider of oneClickProviders) {
        await updateProvider({
          environmentId: primaryEnvironment.environmentId,
          input: {
            provider: provider.driver,
            instanceId: provider.instanceId,
          },
        });
      }
    } finally {
      inFlightRef.current = false;
      setIsUpdating(false);
    }
  };

  return (
    <div
      aria-label={tooltip}
      className="[-webkit-app-region:no-drag] flex h-7 max-w-56 items-center overflow-hidden rounded-md border border-border/70 bg-background/55 text-xs text-muted-foreground"
      data-provider-update-notice=""
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              className="flex h-full min-w-0 items-center gap-1.5 px-2 transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none"
              disabled={isUpdating}
              onClick={() => void runUpdates()}
            >
              {isUpdating ? (
                <LoaderIcon aria-hidden="true" className="size-3 animate-spin" />
              ) : (
                <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-update" />
              )}
              <span className="truncate">
                {canUpdate ? actionLabel : `Review ${providerLabel}`}
              </span>
            </button>
          }
        />
        <TooltipPopup side="bottom">{tooltip}</TooltipPopup>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label="Dismiss provider update notice"
              className="flex size-7 shrink-0 items-center justify-center border-l border-border/60 opacity-60 transition-colors hover:bg-accent hover:text-foreground hover:opacity-100"
              onClick={() => dismissNotificationKey(notificationKey)}
            >
              <XIcon aria-hidden="true" className="size-3" />
            </button>
          }
        />
        <TooltipPopup side="bottom">Dismiss until the available update changes</TooltipPopup>
      </Tooltip>
    </div>
  );
}
