import { readLocalApi } from "~/localApi";

let pendingConfirmations = 0;

/** Whether a terminal-close confirmation is currently waiting on the user. */
export function isTerminalCloseConfirmPending(): boolean {
  return pendingConfirmations > 0;
}

export interface TerminalCloseTarget {
  readonly label: string;
  /** Whether a command is running in the shell; idle shells close without asking. */
  readonly running: boolean;
}

/**
 * Confirmation for terminal close actions: drawer buttons, panel buttons, the
 * `terminal.close` keybinding, and single or bulk closes from the tab strip.
 * Only terminals with a running command are named; with none, it resolves at once.
 * Auto-exit cleanup skips this path and closes directly.
 */
export async function confirmTerminalClose(
  terminals: ReadonlyArray<TerminalCloseTarget>,
): Promise<boolean> {
  const labels = terminals.filter((terminal) => terminal.running).map((terminal) => terminal.label);
  if (labels.length === 0) return true;
  const localApi = readLocalApi();
  if (!localApi) return true;
  pendingConfirmations += 1;
  try {
    return await localApi.dialogs.confirm(
      labels.length === 1
        ? [
            `Close terminal "${labels[0]}"?`,
            "This stops the running process and clears its history.",
          ].join("\n")
        : [
            `Close ${labels.length} terminals?`,
            `This stops their running processes and clears their histories: ${labels
              .map((label) => `"${label}"`)
              .join(", ")}.`,
          ].join("\n"),
      { variant: "destructive" },
    );
  } catch {
    return false;
  } finally {
    pendingConfirmations -= 1;
  }
}
