import { isElectron } from "../../env";
import { cn } from "../../lib/utils";

export function WorkspaceTopBar() {
  return (
    <header
      className={cn("hidden min-h-11 shrink-0 bg-sidebar md:block", isElectron && "drag-region")}
      aria-label="Workspace top bar"
      data-workspace-top-bar=""
    />
  );
}
