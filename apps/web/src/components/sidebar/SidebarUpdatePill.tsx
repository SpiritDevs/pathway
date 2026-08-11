import { DownloadIcon, RotateCwIcon, TriangleAlertIcon, XIcon } from "lucide-react";
import { useCallback, useState } from "react";
import { isElectron } from "../../env";
import { ensureLocalApi } from "../../localApi";
import { useDesktopUpdateState } from "../../state/desktopUpdate";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  getArm64IntelBuildWarningDescription,
  getDesktopUpdateActionError,
  getDesktopUpdateButtonTooltip,
  getDesktopUpdateInstallConfirmationMessage,
  isDesktopUpdateButtonDisabled,
  resolveDesktopUpdateButtonAction,
  shouldShowArm64IntelBuildWarning,
  shouldShowDesktopUpdateButton,
  shouldToastDesktopUpdateActionResult,
} from "../desktopUpdate.logic";
import { showDesktopUpdateDownloadedToast } from "../desktopUpdate.toast";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Separator } from "../ui/separator";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "../../lib/utils";

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

  const visible = isElectron && shouldShowDesktopUpdateButton(state) && !dismissed;
  const tooltip = state ? getDesktopUpdateButtonTooltip(state) : "Update available";
  const disabled = isDesktopUpdateButtonDisabled(state);
  const action = state ? resolveDesktopUpdateButtonAction(state) : "none";

  const showArm64Warning = isElectron && shouldShowArm64IntelBuildWarning(state);
  const arm64Description =
    state && showArm64Warning ? getArm64IntelBuildWarningDescription(state) : null;

  const handleAction = useCallback(async () => {
    const bridge = window.desktopBridge;
    if (!bridge || !state) return;
    if (disabled || action === "none" || isActionPending) return;

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
          getDesktopUpdateInstallConfirmationMessage(state, navigator.platform),
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
    }
  }, [action, disabled, isActionPending, state]);

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
            "group/update relative flex items-center bg-update-surface text-xs font-medium text-update-foreground",
            expanded ? "h-7 w-full rounded-lg" : "size-9 rounded-md",
            disabled && "cursor-not-allowed opacity-60",
          )}
        >
          <div className="pointer-events-none absolute inset-0 rounded-[inherit] transition-colors group-has-[button.update-main:hover]/update:bg-update/12" />
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
                  {action === "install" ? (
                    <>
                      <RotateCwIcon className={expanded ? "size-3.5" : "size-4"} />
                      {expanded ? <span>Restart to update</span> : null}
                    </>
                  ) : state?.status === "downloading" ? (
                    <>
                      <DownloadIcon className={expanded ? "size-3.5" : "size-4"} />
                      {expanded ? (
                        <span>
                          Downloading
                          {typeof state.downloadPercent === "number"
                            ? ` (${Math.floor(state.downloadPercent)}%)`
                            : "…"}
                        </span>
                      ) : null}
                    </>
                  ) : (
                    <>
                      <DownloadIcon className={expanded ? "size-3.5" : "size-4"} />
                      {expanded ? <span>Update available</span> : null}
                    </>
                  )}
                </button>
              }
            />
            <TooltipPopup
              align="start"
              className={
                state?.channel === "nightly" && state.releaseNotes.length > 0
                  ? // pointer-events-auto overrides the positioner's pointer-events-none so the
                    // release notes stay open (and scrollable) when the cursor moves into them.
                    "pointer-events-auto max-w-none text-balance"
                  : undefined
              }
              side={expanded ? "top" : "right"}
              sideOffset={expanded ? 0 : 8}
            >
              {state ? (
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
