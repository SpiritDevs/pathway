import { type RouterHistory, useCanGoBack, useRouter } from "@tanstack/react-router";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { useEffect, useState } from "react";
import { isElectron } from "../../env";
import { cn, isMacPlatform } from "../../lib/utils";
import { T3ConnectProfileButton } from "../clerk/T3ConnectSidebarSignIn";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  createForwardHistoryTracker,
  recordForwardHistoryNavigation,
  type ForwardHistoryTracker,
} from "./workspaceHistory.logic";

const NOOP = () => {};

const forwardHistoryTrackers = new WeakMap<RouterHistory, ForwardHistoryTracker>();

function forwardHistoryTracker(history: RouterHistory): ForwardHistoryTracker {
  const existing = forwardHistoryTrackers.get(history);
  if (existing) return existing;
  const tracker = createForwardHistoryTracker(history.location.state.__TSR_index);
  forwardHistoryTrackers.set(history, tracker);
  return tracker;
}

// TanStack Router has no forward-facing counterpart to useCanGoBack. Keep the
// high-water mark with the history instance so a route-driven remount does not
// forget the forward entries that Back just exposed.
function useCanGoForward() {
  const router = useRouter();
  const history = router.history;
  const tracker = forwardHistoryTracker(history);
  const [canGoForward, setCanGoForward] = useState(() =>
    recordForwardHistoryNavigation(tracker, history.location.state.__TSR_index),
  );
  useEffect(() => {
    setCanGoForward(recordForwardHistoryNavigation(tracker, history.location.state.__TSR_index));
    return history.subscribe(({ location, action }) => {
      setCanGoForward(
        recordForwardHistoryNavigation(tracker, location.state.__TSR_index, action.type),
      );
    });
  }, [history, tracker]);
  return canGoForward;
}

function WorkspaceHistoryControls() {
  const router = useRouter();
  const canGoBack = useCanGoBack();
  const canGoForward = useCanGoForward();
  return (
    <div className="flex items-center gap-0.5" role="group" aria-label="History navigation">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              className="[-webkit-app-region:no-drag]"
              variant="ghost"
              size="icon-xs"
              onClick={canGoBack ? () => router.history.back() : NOOP}
              disabled={!canGoBack}
              aria-label="Back"
              type="button"
            />
          }
        >
          <ArrowLeft />
        </TooltipTrigger>
        <TooltipPopup>Back</TooltipPopup>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              className="[-webkit-app-region:no-drag]"
              variant="ghost"
              size="icon-xs"
              onClick={canGoForward ? () => router.history.forward() : NOOP}
              disabled={!canGoForward}
              aria-label="Forward"
              type="button"
            />
          }
        >
          <ArrowRight />
        </TooltipTrigger>
        <TooltipPopup>Forward</TooltipPopup>
      </Tooltip>
    </div>
  );
}

export function WorkspaceTopBar() {
  const isMacDesktop =
    isElectron && typeof navigator !== "undefined" && isMacPlatform(navigator.platform);

  return (
    <header
      className={cn(
        "hidden min-h-11 shrink-0 items-center justify-between bg-sidebar pr-4 md:flex",
        isMacDesktop ? "pl-8" : "pl-2",
        isElectron && "drag-region",
      )}
      aria-label="Workspace top bar"
      data-workspace-top-bar=""
    >
      <WorkspaceHistoryControls />
      <T3ConnectProfileButton />
    </header>
  );
}
