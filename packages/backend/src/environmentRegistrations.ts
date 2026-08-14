/**
 * How a registered environment's relay token and its Convex registration are matched up.
 *
 * The relay authenticates the environment and mints a `pathway-convex` token bound to the DPoP
 * proof key it saw, recording that key in `cnf.jkt`. Convex trusts the relay's signature, not its
 * choice of key: the registration names the key the company registered, and a token bound to any
 * other key belongs to somebody else's environment.
 *
 * Kept free of Convex imports so both rules can be unit tested without a deployment.
 *
 * @module environmentRegistrations
 */
import type { RoleAssignmentScope } from "./permissions.ts";

/**
 * The `cnf.jkt` confirmation claim of a relay-minted token, or `null` when the token carries no
 * usable one. A token without it is treated as unbound and refused rather than trusted.
 */
export function tokenProofKeyThumbprint(claims: Record<string, unknown>): string | null {
  const cnf = claims["cnf"];
  if (typeof cnf !== "object" || cnf === null) return null;
  const jkt = (cnf as Record<string, unknown>)["jkt"];
  return typeof jkt === "string" && jkt.length > 0 ? jkt : null;
}

/**
 * True when the presented token is bound to the key this registration was registered with.
 *
 * A registration with no recorded thumbprint matches nothing: an environment whose key the company
 * never recorded cannot be told apart from an impostor holding a stolen environment credential.
 */
export function isRegisteredProofKey(input: {
  readonly tokenThumbprint: string | null;
  readonly registeredThumbprint: string;
}): boolean {
  if (input.tokenThumbprint === null || input.registeredThumbprint.length === 0) return false;
  return input.tokenThumbprint === input.registeredThumbprint;
}

/**
 * Scopes a registration's service roles are granted at.
 *
 * An environment registered against specific teams gets those grants team-scoped, so it reaches
 * exactly the teams it was registered for. Only a registration with no teams — the company-wide
 * case — grants company scope; anything else would let an environment registered for one team read
 * every other team's work, and would hand it the company-administration switches that a team-scoped
 * grant deliberately drops.
 */
export function serviceRoleScopes(teamIds: readonly string[]): readonly RoleAssignmentScope[] {
  if (teamIds.length === 0) return [{ kind: "company" }];
  const seen = new Set<string>();
  const scopes: RoleAssignmentScope[] = [];
  for (const teamId of teamIds) {
    if (seen.has(teamId)) continue;
    seen.add(teamId);
    scopes.push({ kind: "team", teamId });
  }
  return scopes;
}
