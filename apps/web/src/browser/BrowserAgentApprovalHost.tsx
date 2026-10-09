import { useSyncExternalStore } from "react";

import {
  AlertDialog,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Button } from "~/components/ui/button";
import { toastManager } from "~/components/ui/toast";

import {
  answerBrowserAgentApproval,
  type BrowserAgentApprovalChoice,
  readBrowserAgentApprovals,
  subscribeBrowserAgentApprovals,
} from "./browserAgentApproval";

/** Shows the oldest unanswered agent approval for the built-in browser. */
export function BrowserAgentApprovalHost() {
  const approvals = useSyncExternalStore(
    subscribeBrowserAgentApprovals,
    readBrowserAgentApprovals,
    readBrowserAgentApprovals,
  );
  const current = approvals[0] ?? null;
  const answer = (choice: BrowserAgentApprovalChoice) => {
    if (!current) return;
    answerBrowserAgentApproval(current.key, choice).catch(() => {
      toastManager.add({ type: "error", title: "Unable to save approval setting" });
    });
  };
  const site = current?.request.kind === "site" ? current.request.origin : null;

  return (
    <AlertDialog
      open={current !== null}
      onOpenChange={(open) => {
        if (!open) answer("deny");
      }}
    >
      <AlertDialogPopup className="max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {site
              ? `Let an agent use ${new URL(site).host}?`
              : "Let an agent read your browsing history?"}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {site
              ? `An agent wants to browse ${site} in the built-in browser. Your agent permissions require approval for this site.`
              : "An agent wants to read the pages visited in the built-in browser. You can change this in Settings → Browser."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <Button variant="outline" onClick={() => answer("deny")}>
            Deny
          </Button>
          <Button variant="outline" onClick={() => answer("session")}>
            Allow until restart
          </Button>
          <Button onClick={() => answer("always")}>Always allow</Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
