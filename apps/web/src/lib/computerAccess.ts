import {
  canUseComputer,
  type AuthSessionState,
  type ComputerAccessPolicy,
} from "@spiritdevs/contracts";

/**
 * Whether this client's session may use Computer on an environment under its
 * access policy. Unknown (still loading, or a server that predates scope
 * reporting) reads as allowed: the server is authoritative, and a guess must
 * never blame the pairing without evidence.
 */
export function sessionCanUseComputer(
  policy: ComputerAccessPolicy,
  session: Pick<AuthSessionState, "authenticated" | "scopes"> | null | undefined,
): boolean {
  if (!session?.authenticated || session.scopes === undefined) return true;
  return canUseComputer(policy, session.scopes);
}

/**
 * Whether the session is known to be admitted. The chat setting's implicit
 * intent needs this evidence: an unknown session sends ordinary messages
 * without Computer rather than risk a refusal.
 */
export function sessionKnownToUseComputer(
  policy: ComputerAccessPolicy,
  session: Pick<AuthSessionState, "authenticated" | "scopes"> | null | undefined,
): boolean {
  return (
    session?.authenticated === true &&
    session.scopes !== undefined &&
    canUseComputer(policy, session.scopes)
  );
}
