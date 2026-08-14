import type { UserIdentity } from "convex/server";

import type { QueryCtx } from "../_generated/server.js";
import { backendError } from "./errors.ts";

export const RELAY_CONTROL_PLANE_SUBJECT = "pathway-relay";
export const RELAY_CONTROL_PLANE_TOKEN_KIND = "relay-control-plane";

function isRelayIssuer(identity: UserIdentity): boolean {
  const issuer = process.env.PATHWAY_RELAY_JWT_ISSUER;
  return issuer !== undefined && identity.issuer === issuer;
}

/**
 * Relay storage is not company data and is never callable by a Clerk user or an environment.
 * The Worker mints a short-lived token from its dedicated ES256 key with this reserved subject and
 * explicit kind. Checking both prevents an environment from selecting the reserved subject alone.
 */
export function isRelayControlPlaneIdentity(identity: UserIdentity): boolean {
  return (
    isRelayIssuer(identity) &&
    identity.subject === RELAY_CONTROL_PLANE_SUBJECT &&
    identity.tokenKind === RELAY_CONTROL_PLANE_TOKEN_KIND
  );
}

export async function requireRelayControlPlane(ctx: QueryCtx): Promise<UserIdentity> {
  const identity = await ctx.auth.getUserIdentity();
  if (identity === null || !isRelayControlPlaneIdentity(identity)) {
    throw backendError(
      "permission-denied",
      "This function is reserved for the relay control plane.",
    );
  }
  return identity;
}
