import { AnimatedHeight } from "../AnimatedHeight";
import { PathwayConnectProfileButton } from "../clerk/PathwayConnectSidebarSignIn";
import { TimeTrackerIndicator } from "../timeTracker/TimeTrackerIndicator";
import { StorageStatusIndicator } from "./StorageStatusIndicator";
import { SyncStatusIndicator } from "./SyncStatusIndicator";

/**
 * The rail's bottom corner: status indicators stacked above the profile button. Indicators come and
 * go with the state they report, and the pill grows and shrinks upward around them.
 */
export function RailAccountPill() {
  return (
    <div
      className="mt-1 w-10 rounded-full border border-sidebar-border bg-sidebar-foreground/4 p-0.5 [-webkit-app-region:no-drag] [&:not(:has(button))]:hidden"
      data-rail-account-pill=""
    >
      {/* The profile button stays put; indicators grow out of the top. */}
      <AnimatedHeight anchor="bottom">
        <div className="flex flex-col items-center gap-1.5">
          <StorageStatusIndicator />
          <SyncStatusIndicator />
          <TimeTrackerIndicator />
          <PathwayConnectProfileButton />
        </div>
      </AnimatedHeight>
    </div>
  );
}
