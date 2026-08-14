import { TriangleAlertIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { isElectron } from "../../env";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { cn } from "../../lib/utils";
import { ensureLocalApi } from "../../localApi";
import { useDesktopUpdateState } from "../../state/desktopUpdate";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  canCheckForUpdate,
  getArm64IntelBuildWarningDescription,
  getDesktopUpdateActionError,
  getDesktopUpdateButtonTooltip,
  getDesktopUpdateInstallConfirmationMessage,
  isDesktopUpdateButtonDisabled,
  resolveDesktopUpdateButtonAction,
  shouldShowArm64IntelBuildWarning,
  shouldToastDesktopUpdateActionResult,
} from "../desktopUpdate.logic";
import { showDesktopUpdateDownloadedToast } from "../desktopUpdate.toast";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Separator } from "../ui/separator";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  DesktopUpdateStatusIcon,
  shouldContinueDesktopUpdateCheckAnimation,
  shouldShowDesktopUpdateCheckIcon,
} from "./DesktopUpdateStatusIcon";

function resolveSidebarUpdatePresentation({
  action,
  isDownloading,
  showCheckIcon,
}: {
  readonly action: ReturnType<typeof resolveDesktopUpdateButtonAction>;
  readonly isDownloading: boolean;
  readonly showCheckIcon: boolean;
}) {
  const showUpdateDetails = action !== "none" || isDownloading;
  const iconStatus = showCheckIcon
    ? "checking"
    : action === "install"
      ? "downloaded"
      : isDownloading
        ? "downloading"
        : action === "download"
          ? "available"
          : "idle";

  return {
    iconStatus,
    showUpdateDetails,
    showUpdateIconState: showUpdateDetails && !showCheckIcon,
  } as const;
}

function keyReleaseNoteItems(items: ReadonlyArray<string>) {
  const occurrences = new Map<string, number>();
  return items.map((item) => {
    const occurrence = occurrences.get(item) ?? 0;
    occurrences.set(item, occurrence + 1);
    return { item, key: JSON.stringify([item, occurrence]) };
  });
}

function SidebarUpdateReleaseNotesTooltip({
  state,
  tooltip,
}: {
  readonly state: NonNullable<ReturnType<typeof useDesktopUpdateState>>;
  readonly tooltip: string;
}) {
  if (state.channel !== "nightly" || state.releaseNotes.length === 0) {
    return <>{tooltip}</>;
  }

  return (
    <div className="w-120 max-w-[calc(100vw-2rem)] text-left">
      <div className="px-1">
        <div className="text-sm leading-5 font-medium">{tooltip}</div>
      </div>
      <div className="max-h-[min(28rem,calc(100vh-6rem))] overflow-y-auto px-1 pt-4 pb-1">
        {state.releaseNotes.map((releaseNote, index) => (
          <div key={releaseNote.version}>
            {index > 0 && <Separator className="my-3 bg-border/60" />}
            <section>
              <h3 className="text-muted-foreground text-xs leading-4 font-semibold">
                {index === 0 ? "What's changed" : `Changes in ${releaseNote.version}`}
              </h3>
              <ul className="mt-2 space-y-1.5 pl-4 text-xs leading-5 text-popover-foreground/90">
                {keyReleaseNoteItems(releaseNote.items).map(({ item, key }) => (
                  <li className="list-disc break-words" key={key}>
                    {item}
                  </li>
                ))}
              </ul>
            </section>
          </div>
        ))}
      </div>
    </div>
  );
}

export function SidebarUpdatePill({ expanded }: { readonly expanded: boolean }) {
  const state = useDesktopUpdateState();
  const [dismissed, setDismissed] = useState(false);
  const [isActionPending, setIsActionPending] = useState(false);
  const [checkAnimationKey, setCheckAnimationKey] = useState(0);
  const [isCheckAnimationLatched, setIsCheckAnimationLatched] = useState(false);
  const prefersReducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");

  useEffect(() => {
    if (prefersReducedMotion) {
      setIsCheckAnimationLatched(false);
    } else if (state?.status === "checking") {
      setIsCheckAnimationLatched(true);
    }
  }, [prefersReducedMotion, state?.status]);

  const action = state ? resolveDesktopUpdateButtonAction(state) : "none";
  const isDownloading = state?.status === "downloading";
  const showCheckIcon = shouldShowDesktopUpdateCheckIcon({
    isAnimationLatched: isCheckAnimationLatched,
    isChecking: state?.status === "checking",
    prefersReducedMotion,
  });
  const { iconStatus, showUpdateDetails, showUpdateIconState } = resolveSidebarUpdatePresentation({
    action,
    isDownloading,
    showCheckIcon,
  });
  const tooltip = showUpdateDetails
    ? state
      ? getDesktopUpdateButtonTooltip(state)
      : "Update available"
    : showCheckIcon
      ? "Checking for updates…"
      : "Check for updates";
  const disabled = showCheckIcon
    ? true
    : showUpdateDetails
      ? isDesktopUpdateButtonDisabled(state)
      : !canCheckForUpdate(state);
  const visible = isElectron && (!dismissed || !showUpdateDetails);
  const showArm64Warning = isElectron && shouldShowArm64IntelBuildWarning(state);
  const arm64Description =
    state && showArm64Warning ? getArm64IntelBuildWarningDescription(state) : null;

  const handleAction = useCallback(async () => {
    const bridge = window.desktopBridge;
    if (!bridge || !state) return;
    if (disabled || isActionPending) return;

    setIsActionPending(true);

    if (action === "download") {
      void bridge
        .downloadUpdate()
        .then((result) => {
          if (result.completed) {
            showDesktopUpdateDownloadedToast(bridge, result.state);
          }
          if (!shouldToastDesktopUpdateActionResult(result)) return;
          const actionError = getDesktopUpdateActionError(result);
          if (!actionError) return;
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not download update",
              description: actionError,
            }),
          );
        })
        .catch((error) => {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not start update download",
              description: error instanceof Error ? error.message : "An unexpected error occurred.",
            }),
          );
        })
        .finally(() => setIsActionPending(false));
      return;
    }

    if (action === "install") {
      let confirmed = false;
      try {
        confirmed = await ensureLocalApi().dialogs.confirm(
          getDesktopUpdateInstallConfirmationMessage(state),
        );
      } catch (error) {
        setIsActionPending(false);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not confirm update",
            description: error instanceof Error ? error.message : "Update confirmation failed.",
          }),
        );
        return;
      }
      if (!confirmed) {
        setIsActionPending(false);
        return;
      }
      void bridge
        .installUpdate()
        .then((result) => {
          if (!shouldToastDesktopUpdateActionResult(result)) return;
          const actionError = getDesktopUpdateActionError(result);
          if (!actionError) return;
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not install update",
              description: actionError,
            }),
          );
        })
        .catch((error) => {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not install update",
              description: error instanceof Error ? error.message : "An unexpected error occurred.",
            }),
          );
        })
        .finally(() => setIsActionPending(false));
      return;
    }

    if (!prefersReducedMotion) {
      setIsCheckAnimationLatched(true);
      setCheckAnimationKey((key) => key + 1);
    }
    void bridge
      .checkForUpdate()
      .then((result) => {
        if (result.checked) return;
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not check for updates",
            description:
              result.state.message ?? "Automatic updates are not available in this build.",
          }),
        );
      })
      .catch((error) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not check for updates",
            description: error instanceof Error ? error.message : "Update check failed.",
          }),
        );
      })
      .finally(() => setIsActionPending(false));
  }, [action, disabled, isActionPending, prefersReducedMotion, state]);

  const handleCheckAnimationIteration = useCallback(() => {
    setIsCheckAnimationLatched(
      shouldContinueDesktopUpdateCheckAnimation({
        isChecking: state?.status === "checking",
        prefersReducedMotion,
      }),
    );
  }, [prefersReducedMotion, state?.status]);

  if (!visible && !showArm64Warning) return null;

  return (
    <div className={cn("flex flex-col gap-1", expanded ? "w-full" : "items-center")}>
      {showArm64Warning && arm64Description && expanded ? (
        <Alert variant="warning" className="rounded-2xl border-warning/40 bg-warning/8 text-xs">
          <TriangleAlertIcon />
          <AlertTitle>Intel build on Apple Silicon</AlertTitle>
          <AlertDescription>{arm64Description}</AlertDescription>
        </Alert>
      ) : showArm64Warning && arm64Description ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <div
                aria-label={arm64Description}
                className="flex size-9 items-center justify-center rounded-md bg-warning/12 text-warning"
                role="status"
                tabIndex={0}
              >
                <TriangleAlertIcon className="size-4" />
              </div>
            }
          />
          <TooltipPopup side="right" sideOffset={8}>
            {arm64Description}
          </TooltipPopup>
        </Tooltip>
      ) : null}
      {visible && (
        <div
          className={cn(
            "group/update relative flex items-center text-xs font-medium",
            showUpdateIconState
              ? "bg-update-surface text-update-foreground"
              : "text-[var(--sidebar-icon-color)]",
            expanded ? "h-7 w-full rounded-lg" : "size-9 rounded-md",
            disabled && "cursor-not-allowed opacity-60",
          )}
        >
          <div
            className={cn(
              "pointer-events-none absolute inset-0 rounded-[inherit] transition-colors",
              showUpdateIconState
                ? "group-has-[button.update-main:hover]/update:bg-update/12"
                : "group-has-[button.update-main:hover]/update:bg-sidebar-row-hover",
            )}
          />
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label={tooltip}
                  aria-disabled={disabled || isActionPending || undefined}
                  disabled={disabled || isActionPending}
                  className={cn(
                    "update-main relative flex h-full flex-1 items-center enabled:cursor-pointer",
                    expanded ? "gap-2 px-2" : "justify-center px-0",
                  )}
                  onClick={handleAction}
                >
                  <DesktopUpdateStatusIcon
                    key={showCheckIcon ? checkAnimationKey : iconStatus}
                    downloadPercent={state?.downloadPercent ?? null}
                    isCheckAnimating={showCheckIcon && !prefersReducedMotion}
                    onCheckAnimationIteration={handleCheckAnimationIteration}
                    status={iconStatus}
                  />
                  {expanded ? (
                    <span>
                      {action === "install"
                        ? "Restart to update"
                        : isDownloading
                          ? `Downloading${
                              typeof state?.downloadPercent === "number"
                                ? ` (${Math.floor(state.downloadPercent)}%)`
                                : "…"
                            }`
                          : action === "download"
                            ? "Update available"
                            : showCheckIcon
                              ? "Checking for updates…"
                              : "Check for updates"}
                    </span>
                  ) : null}
                </button>
              }
            />
            <TooltipPopup
              align="start"
              className={
                showUpdateDetails && state?.channel === "nightly" && state.releaseNotes.length > 0
                  ? // pointer-events-auto overrides the positioner's pointer-events-none so the
                    // release notes stay open (and scrollable) when the cursor moves into them.
                    "pointer-events-auto max-w-none text-balance"
                  : undefined
              }
              side={expanded ? "top" : "right"}
              sideOffset={expanded ? 0 : 8}
            >
              {showUpdateDetails && state ? (
                <SidebarUpdateReleaseNotesTooltip state={state} tooltip={tooltip} />
              ) : (
                tooltip
              )}
            </TooltipPopup>
          </Tooltip>
          {expanded && action === "download" && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label="Dismiss update"
                    className="mr-1 inline-flex size-5 items-center justify-center rounded-md text-update-foreground transition-colors"
                    onClick={() => setDismissed(true)}
                  >
                    <XIcon className="size-3.5" />
                  </button>
                }
              />
              <TooltipPopup side="top">Dismiss until next launch</TooltipPopup>
            </Tooltip>
          )}
        </div>
      )}
    </div>
  );
}
