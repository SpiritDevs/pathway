import type { ScopedThreadRef } from "@spiritdevs/contracts";
import { squashAtomCommandFailure } from "@spiritdevs/client-runtime/state/runtime";
import { useState } from "react";

import { randomUUID } from "../lib/utils";
import { terminalEnvironment } from "../state/terminal";
import { useAtomCommand } from "../state/use-atom-command";
import { useTerminalUiStateStore } from "../terminalUiStateStore";
import { Button } from "./ui/button";

/** The original folder stays accessible even when its Git repositories are nested inside it. */
export function ConversationFolderReview({
  threadRef,
  conversationPath,
}: {
  threadRef: ScopedThreadRef;
  conversationPath: string;
}) {
  const openTerminal = useAtomCommand(terminalEnvironment.open, { reportFailure: false });
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reviewInTerminal = async () => {
    if (opening) return;
    setOpening(true);
    setError(null);
    // A fresh terminal starts at the original path even if an earlier one changed directories.
    const terminalId = `conversation-review-${randomUUID()}`;
    const result = await openTerminal({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, terminalId, cwd: conversationPath },
    });
    if (result._tag === "Failure") {
      const failure = squashAtomCommandFailure(result);
      setError(
        failure instanceof Error ? failure.message : "Could not open the conversation folder.",
      );
    } else {
      useTerminalUiStateStore
        .getState()
        .ensureTerminal(threadRef, terminalId, { active: true, open: true });
    }
    setOpening(false);
  };
  return (
    <div className="shrink-0 space-y-1 border-b border-border/70 px-3 py-2 text-xs text-muted-foreground">
      <p className="font-medium">Original conversation folder</p>
      <p className="break-all">{conversationPath}</p>
      <p>Review any repositories inside this folder before deleting it.</p>
      <Button
        size="xs"
        variant="outline"
        disabled={opening}
        onClick={() => void reviewInTerminal()}
      >
        {opening ? "Opening terminal…" : "Open terminal in conversation folder"}
      </Button>
      {error ? (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
