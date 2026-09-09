import type { StorageThreadRow, StorageWorktreeRow } from "./storageDashboard.logic";
import { formatStorageBytes } from "../../lib/storagePresentation";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";

/** This preview is mandatory even when ordinary conversation deletion confirmations are disabled. */
export function ConversationFolderDeleteDialog({
  environmentLabel,
  thread,
  worktree,
  busy,
  onClose,
  onDelete,
}: {
  environmentLabel: string;
  thread: StorageThreadRow;
  worktree: StorageWorktreeRow;
  busy: boolean;
  onClose: () => void;
  onDelete: () => void;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogPopup className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Delete conversation and working folder?</DialogTitle>
          <DialogDescription>
            This permanently deletes the conversation history and its entire working folder,
            including ignored files such as local configuration and databases.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <div className="rounded-lg border p-4 text-sm">
            <p className="font-medium">{thread.title}</p>
            <p className="mt-1 text-muted-foreground">{environmentLabel}</p>
            <p className="mt-3 break-all font-mono text-xs">{worktree.path}</p>
            <p className="mt-3 text-muted-foreground">
              Working folder: {formatStorageBytes(worktree.estimatedBytes)}
              {worktree.measuredAt
                ? ` · Estimated ${formatRelativeTimeLabel(worktree.measuredAt)}`
                : ""}
            </p>
            <p className="mt-1 text-muted-foreground">
              Conversation estimate: {formatStorageBytes(thread.threadDataBytes)}
            </p>
          </div>
          <p className="text-sm text-destructive">
            This folder has no Git branch from which to recreate its files. Deletion cannot be
            undone.
          </p>
          <p className="text-xs text-muted-foreground">
            Sizes are estimates. Deleting history does not guarantee immediate database-space
            recovery.
          </p>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="destructive" disabled={busy} onClick={onDelete}>
            {busy ? "Deleting…" : "Delete conversation and folder"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
