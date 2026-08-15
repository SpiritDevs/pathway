import { useCanGoBack, useRouter } from "@tanstack/react-router";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { useEffect, useState } from "react";
import { isElectron } from "../../env";
import { cn, isMacPlatform } from "../../lib/utils";
import { T3ConnectProfileButton } from "../clerk/T3ConnectSidebarSignIn";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SyncStatusIndicator } from "./SyncStatusIndicator";

const NOOP = () => {};

// TanStack Router has no forward-facing counterpart to useCanGoBack, so track a
// high-water mark of the history index: a PUSH truncates the browser's forward
// stack and resets the mark, anything else only moves within it.
function useCanGoForward() {
  const router = useRouter();
  const [canGoForward, setCanGoForward] = useState(false);
  useEffect(() => {
    let maxIndex = router.history.location.state.__TSR_index;
    return router.history.subscribe(({ location, action }) => {
      const index = location.state.__TSR_index;
      maxIndex = action.type === "PUSH" ? index : Math.max(maxIndex, index);
      setCanGoForward(index < maxIndex);
    });
  }, [router]);
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
      <div className="flex items-center gap-2">
        <SyncStatusIndicator />
        <T3ConnectProfileButton />
      </div>
    </header>
  );
}
