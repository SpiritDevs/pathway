/**
 * Two issuers reach this deployment, and only two.
 *
 * Humans arrive through Clerk, which stays the mandatory user identity but owns none of the
 * company model. Pathway servers arrive through the existing relay: they already hold a
 * DPoP-bound environment credential, so the relay exchanges it for a short-lived bearer JWT with
 * `aud=pathway-convex` rather than us standing up a second identity service. Convex validates the
 * relay as a custom JWT issuer; company registrations and service-role permissions are resolved
 * from Convex, never from the token.
 *
 * @see https://docs.convex.dev/auth/clerk
 * @module auth.config
 */

/** The audience the relay mints for. Environment tokens for any other audience are not accepted. */
export const CONVEX_ENVIRONMENT_AUDIENCE = "pathway-convex";

const relayIssuer = process.env.PATHWAY_RELAY_JWT_ISSUER;
const relayJwks = process.env.PATHWAY_RELAY_JWKS_URL;

if (relayIssuer === undefined || relayJwks === undefined) {
  throw new Error(
    "PATHWAY_RELAY_JWT_ISSUER and PATHWAY_RELAY_JWKS_URL are required for relay persistence and environment authentication.",
  );
}

/**
 * The relay Worker must publish its JWKS before this configuration is deployed. The Worker can
 * start without calling Convex; after both variables are set, deploying Convex enables its
 * persistence calls and environment service tokens together.
 */
const relayProvider = {
  type: "customJwt" as const,
  applicationID: CONVEX_ENVIRONMENT_AUDIENCE,
  issuer: relayIssuer,
  jwks: relayJwks,
  /** Dedicated P-256 key; Convex custom JWT providers support ES256, not Ed25519. */
  algorithm: "ES256" as const,
};

export default {
  providers: [
    {
      domain: process.env.CLERK_JWT_ISSUER_DOMAIN,
      applicationID: "convex",
    },
    relayProvider,
  ],
};
