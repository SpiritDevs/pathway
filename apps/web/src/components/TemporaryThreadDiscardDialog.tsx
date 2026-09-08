import { useSyncExternalStore } from "react";
import {
  AlertDialog,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import { Button } from "./ui/button";

type DiscardChoice = "review" | "cancel" | "discard";
type Request = { title: string; resolve: (choice: DiscardChoice) => void };
const requests: Request[] = [];
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const snapshot = () => requests[0] ?? null;

/** Serializes bulk settlement warnings so each discard applies to one named thread. */
export function requestTemporaryThreadDiscard(title: string): Promise<DiscardChoice> {
  return new Promise((resolve) => {
    requests.push({ title, resolve });
    notify();
  });
}

function respond(choice: DiscardChoice) {
  requests.shift()?.resolve(choice);
  notify();
}

export function TemporaryThreadDiscardDialog() {
  const request = useSyncExternalStore(subscribe, snapshot, snapshot);
  return (
    <AlertDialog
      open={request !== null}
      onOpenChange={(open) => {
        if (!open) respond("cancel");
      }}
    >
      <AlertDialogPopup className="max-w-lg">
        <AlertDialogHeader>
          <AlertDialogTitle>Delete “{request?.title}” with unfinished Git work?</AlertDialogTitle>
          <AlertDialogDescription>
            This temporary thread has uncommitted changes or unpushed commits. Review and push the
            work to keep it, or discard it and delete the thread and its working folders. Committing
            alone does not preserve unpushed work.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <Button variant="outline" onClick={() => respond("review")}>
            Review changes
          </Button>
          <Button variant="outline" onClick={() => respond("cancel")}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={() => respond("discard")}>
            Discard and delete
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
