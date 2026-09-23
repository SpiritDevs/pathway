import {
  AuthAccessWriteScope,
  AuthComputerOperateScope,
  type AuthSessionState,
} from "@spiritdevs/contracts";

/**
 * The server's refusal, word for word, for a device whose pairing leaves it
 * out of Computer: re-pairing fixes it and the chat's toggle does not.
 */
export const COMPUTER_ACCESS_DENIED_HINT =
  "This device isn't allowed to use Computer on this environment. Re-pair it with “Use Computer” enabled, or ask an admin to change the Computer access policy in Settings.";

/**
 * Whether this client's session on the environment cannot use Computer under
 * the default access policy. Unknown (still loading, or an older server that
 * reports no scopes) reads as allowed, so the card never blames the pairing
 * without evidence. Admin sessions pass, as the server lets them.
 */
export function sessionLacksComputerAccess(
  session: Pick<AuthSessionState, "authenticated" | "scopes"> | null | undefined,
): boolean {
  if (!session?.authenticated || session.scopes === undefined) return false;
  return (
    !session.scopes.includes(AuthComputerOperateScope) &&
    !session.scopes.includes(AuthAccessWriteScope)
  );
}
