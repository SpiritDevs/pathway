/**
 * One place to report a failed capture write.
 *
 * Every capture write sends the whole settings document, so a rejection ("that mail slug is taken",
 * "the port is in use") is the server explaining something the user typed. It belongs on screen
 * rather than in the console, and it reads the same wherever the edit was made.
 *
 * @module components/email/emailWrites
 */
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";

import { stackedThreadToast, toastManager } from "../ui/toast";

/** True when the write landed; false after raising the toast, so callers can keep a form open. */
export function reportEmailWriteFailure(
  title: string,
  result: AtomCommandResult<unknown, unknown>,
): boolean {
  if (result._tag !== "Failure") return true;
  // An interrupt is a newer write superseding this one, which is not a failure anybody should read.
  if (isAtomCommandInterrupted(result)) return false;
  const error = squashAtomCommandFailure(result);
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : String(error),
    }),
  );
  return false;
}
