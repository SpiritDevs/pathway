/**
 * The destructive half of retention: wipe an inbox now instead of waiting for the caps.
 *
 * Clearing deletes the rows, the raw `.eml` files, and the attachments server-side, so the dialog
 * is explicit about the blast radius. The button reports what actually happened — the server's
 * cleared count — rather than assuming.
 *
 * @module components/email/ClearInboxButton
 */
import type { EmailInboxScope, EnvironmentId } from "@spiritdevs/contracts";
import { useState } from "react";

import { useClearEmailInbox } from "~/state/email";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { reportEmailWriteFailure } from "./emailWrites";

export function ClearInboxButton({
  scope,
  inboxName,
  label = "Clear inbox",
  environmentId,
}: {
  scope: EmailInboxScope;
  inboxName: string;
  label?: string;
  environmentId?: EnvironmentId;
}) {
  const clearInbox = useClearEmailInbox(environmentId);
  const [open, setOpen] = useState(false);
  const [clearing, setClearing] = useState(false);

  const handleClear = async () => {
    setClearing(true);
    try {
      const result = await clearInbox({ scope });
      if (!reportEmailWriteFailure("Could not clear inbox", result)) return;
      if (result._tag === "Success") {
        toastManager.add(
          stackedThreadToast({
            type: "success",
            title:
              result.value.clearedCount === 1
                ? "Cleared 1 message"
                : `Cleared ${result.value.clearedCount} messages`,
            description: inboxName,
          }),
        );
      }
    } finally {
      setClearing(false);
      setOpen(false);
    }
  };

  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        {label}
      </Button>
      <AlertDialog
        open={open}
        onOpenChange={(nextOpen) => {
          if (clearing) return;
          setOpen(nextOpen);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Clear {inboxName}?</AlertDialogTitle>
            <AlertDialogDescription>
              Every captured message in this inbox is deleted, along with its raw source and
              attachments on disk. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button disabled={clearing} variant="destructive" onClick={() => void handleClear()}>
              {clearing ? "Clearing…" : "Clear inbox"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
