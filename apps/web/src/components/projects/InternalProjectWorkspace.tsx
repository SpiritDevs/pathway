import { FolderIcon, UnplugIcon } from "lucide-react";
import { useState } from "react";
import { projectEnvironment } from "~/state/projects";
import { shellEnvironment } from "~/state/shell";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LINK_SPLIT_GROUP_CLASS,
  THREAD_DETAILS_PANEL_LINK_SPLIT_PRIMARY_CLASS,
  THREAD_DETAILS_PANEL_LINK_SPLIT_ACTION_CLASS,
} from "../chat/threadDetailsPanelStyles";
import type { ProjectWorkspaceTarget } from "./projectWorkspace.logic";
import { requestProjectWorkspace } from "./projectWorkspacePrompt";

export function InternalProjectWorkspace({
  project,
  onOpenDirectory,
}: {
  project: ProjectWorkspaceTarget;
  onOpenDirectory?: ((cwd: string) => void) | undefined;
}) {
  const update = useAtomCommand(projectEnvironment.update);
  const openInEditor = useAtomCommand(shellEnvironment.openInEditor);
  const [disconnecting, setDisconnecting] = useState(false);
  const internalRoot = project.internalWorkspaceRoot;
  const attached = project.workspaceRoot !== null && project.workspaceRoot !== internalRoot;
  if (!internalRoot && attached) return null;
  return (
    <div className={THREAD_DETAILS_PANEL_LINK_SPLIT_GROUP_CLASS}>
      <Button
        variant="ghost"
        type="button"
        className={`${THREAD_DETAILS_PANEL_LINK_SPLIT_PRIMARY_CLASS} pr-0`}
        title={
          internalRoot
            ? `${internalRoot} — Click to browse files; Cmd/Ctrl-click to open in your file manager`
            : undefined
        }
        disabled={!internalRoot}
        onClick={(event) => {
          if (!internalRoot) return;
          if (event.metaKey || event.ctrlKey) {
            event.preventDefault();
            void openInEditor({
              environmentId: project.environmentId,
              input: { cwd: internalRoot, editor: "file-manager" },
            });
          } else {
            onOpenDirectory?.(internalRoot);
          }
        }}
      >
        <FolderIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} />
        <span className="truncate">Temporary directory</span>
      </Button>
      {attached ? (
        <Button
          variant="ghost"
          className={THREAD_DETAILS_PANEL_LINK_SPLIT_ACTION_CLASS}
          disabled={disconnecting}
          aria-label="Disconnect temporary directory"
          title="Disconnect temporary directory. Files are preserved."
          onClick={() => {
            setDisconnecting(true);
            void update({
              environmentId: project.environmentId,
              input: { projectId: project.id, disconnectInternalWorkspace: true },
            }).finally(() => setDisconnecting(false));
          }}
        >
          <UnplugIcon className="size-4" />
        </Button>
      ) : (
        <Button
          variant="ghost"
          className={THREAD_DETAILS_PANEL_LINK_SPLIT_ACTION_CLASS}
          onClick={() => {
            void requestProjectWorkspace({ project, reason: null });
          }}
        >
          Add directory
        </Button>
      )}
    </div>
  );
}
