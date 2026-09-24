import {
  canUseComputer,
  type AuthSessionState,
  type ComputerAccessPolicy,
} from "@spiritdevs/contracts";

/**
 * Whether this client's session may use Computer on an environment under its
 * access policy. Unknown (still loading, or a server that predates scope
 * reporting) reads as allowed: the server is authoritative, and a guess must
 * never blame the pairing or drop the user's intent without evidence.
 */
export function sessionCanUseComputer(
  policy: ComputerAccessPolicy,
  session: Pick<AuthSessionState, "authenticated" | "scopes"> | null | undefined,
): boolean {
  if (!session?.authenticated || session.scopes === undefined) return true;
  return canUseComputer(policy, session.scopes);
}
