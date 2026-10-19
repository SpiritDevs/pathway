import { DownloadIcon, XIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { isDesktopLocalConnectionTarget } from "~/connection/desktopLocal";
import { useDismissedProviderUpdateNotificationKeys } from "~/providerUpdateDismissal";
import { useEnvironments } from "~/state/environments";
import { ProviderUpdateEnvironmentRows } from "./ProviderUpdateEnvironmentRows";
import { useLocalEnvironmentUpdateGroups } from "./ProviderUpdateLaunchNotification.environments";
import {
  collectProviderUpdateCandidates,
  environmentGroupsWithUpdates,
  localEnvironmentUpdateNotificationKey,
} from "./ProviderUpdateLaunchNotification.logic";
import { ProviderUpdatePrimaryNotification } from "./ProviderUpdatePrimaryNotification";
import { Popover, PopoverPopup, PopoverTrigger } from "./ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

const SETTLING_GRACE_MS = 30_000;

function useHasLocalSecondaryEnvironment(): boolean {
  const { environments } = useEnvironments();
  return useMemo(
    () =>
      environments.some((environment) => isDesktopLocalConnectionTarget(environment.entry.target)),
    [environments],
  );
}

/** The compact provider-update control mounted beside sync status and profile. */
export function ProviderUpdateLaunchNotification() {
  return useHasLocalSecondaryEnvironment() ? (
    <ProviderUpdateEnvironmentsNotification />
  ) : (
    <ProviderUpdatePrimaryNotification />
  );
}

/**
 * Multiple local backends need an environment choice, but the title-bar
 * footprint remains the same. The detail is disclosed only after clicking the
 * compact update control instead of occupying the workspace as a toast.
 */
function ProviderUpdateEnvironmentsNotification() {
  const { groups, isAnySettling } = useLocalEnvironmentUpdateGroups();
  const { dismissedNotificationKeys, dismissNotificationKey } =
    useDismissedProviderUpdateNotificationKeys();
  const updateGroups = useMemo(() => environmentGroupsWithUpdates(groups), [groups]);
  const notificationKey = useMemo(() => localEnvironmentUpdateNotificationKey(groups), [groups]);
  const providers = useMemo(
    () => collectProviderUpdateCandidates(updateGroups.flatMap((group) => group.candidates)),
    [updateGroups],
  );
  const [settleGraceElapsed, setSettleGraceElapsed] = useState(false);

  useEffect(() => {
    if (!isAnySettling) {
      setSettleGraceElapsed(false);
      return;
    }
    const timer = window.setTimeout(() => setSettleGraceElapsed(true), SETTLING_GRACE_MS);
    return () => window.clearTimeout(timer);
  }, [isAnySettling]);

  if (
    (isAnySettling && !settleGraceElapsed) ||
    notificationKey === null ||
    dismissedNotificationKeys.has(notificationKey) ||
    providers.length === 0
  ) {
    return null;
  }

  const label = providers.length === 1 ? "Provider update" : `${providers.length} updates`;

  return (
    <div
      className="[-webkit-app-region:no-drag] flex h-7 items-center overflow-hidden rounded-md border border-border/70 bg-background/55 text-xs text-muted-foreground"
      data-provider-update-notice=""
    >
      <Popover>
        <PopoverTrigger
          render={
            <button
              type="button"
              className="flex h-full items-center gap-1.5 px-2 transition-colors hover:bg-accent hover:text-foreground"
            >
              <DownloadIcon aria-hidden="true" className="size-3" />
              <span>{label}</span>
            </button>
          }
        />
        <PopoverPopup align="end" className="w-72 p-2" side="bottom" sideOffset={6}>
          <ProviderUpdateEnvironmentRows />
        </PopoverPopup>
      </Popover>
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
        <TooltipPopup side="bottom">Dismiss until the available updates change</TooltipPopup>
      </Tooltip>
    </div>
  );
}
