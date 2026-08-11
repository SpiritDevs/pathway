import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import { T3ConnectProfileButton } from "../clerk/T3ConnectSidebarSignIn";

export function WorkspaceTopBar() {
  return (
    <header
      className={cn(
        "hidden min-h-11 shrink-0 items-center justify-end bg-sidebar pl-2 pr-4 md:flex",
        isElectron && "drag-region",
      )}
      aria-label="Workspace top bar"
      data-workspace-top-bar=""
    >
      <T3ConnectProfileButton />
    </header>
  );
}
