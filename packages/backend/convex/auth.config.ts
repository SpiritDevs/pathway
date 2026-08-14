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

export default {
  providers: [
    {
      domain: process.env.CLERK_JWT_ISSUER_DOMAIN,
      applicationID: "convex",
    },
    {
      type: "customJwt",
      applicationID: CONVEX_ENVIRONMENT_AUDIENCE,
      issuer: process.env.PATHWAY_RELAY_JWT_ISSUER,
      jwks: process.env.PATHWAY_RELAY_JWKS_URL,
      /**
       * The relay's minting key is Ed25519, matching the environment credentials it already
       * signs. TODO(phase 2): confirm the deployment accepts EdDSA custom JWTs; if it does not,
       * the relay mints a separate ES256 key for this audience only.
       */
      algorithm: "EdDSA",
    },
  ],
};
