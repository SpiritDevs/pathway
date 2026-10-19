/**
 * What a failed tracker write says.
 *
 * There is no optimistic overlay anywhere in the issues UI: a write that fails leaves the row
 * exactly as it was, which is indistinguishable from a press that never registered. So every
 * mutation has to report, and reporting the same way from the list, the sheet, and the three
 * settings panels is what makes a refused status change read the same wherever it happened.
 *
 * @module components/issues/issueWriteFeedback
 */
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@spiritdevs/client-runtime/state/runtime";

import { stackedThreadToast, toastManager } from "../ui/toast";

/**
 * True when the write did not succeed, so a caller can bail before its own success path.
 *
 * An interrupted command is silent: the writes are serial per environment, so an interruption
 * means a later press superseded this one rather than that anything went wrong.
 */
export function reportIssueWriteFailure(
  title: string,
  result: AtomCommandResult<unknown, unknown>,
): boolean {
  if (result._tag !== "Failure") return false;
  if (isAtomCommandInterrupted(result)) return true;
  const error = squashAtomCommandFailure(result);
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "An error occurred.",
    }),
  );
  return true;
}
