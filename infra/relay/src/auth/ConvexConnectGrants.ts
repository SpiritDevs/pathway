import {
  RelayConvexConnectGrantClaims,
  type RelayConvexConnectGrantPermission,
} from "@spiritdevs/contracts/relay";
import {
  normalizeRelayIssuer,
  RELAY_CONVEX_CONNECT_GRANT_TYP,
  RelayJwtError,
  verifyRelayJwt,
} from "@spiritdevs/shared/relayJwt";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as RelayConfiguration from "../Config.ts";

// Grants are minted per connect attempt, so anything older than this is a
// replayed or hoarded grant regardless of the expiry Convex chose.
const CONNECT_GRANT_MAX_TOKEN_AGE = "10 minutes";

const decodeConnectGrantClaims = Schema.decodeUnknownEffect(RelayConvexConnectGrantClaims);

/**
 * Validates Convex-issued connect grants. The relay stays a credential broker:
 * it only checks that a trusted Convex issuer vouched for this user, this
 * environment, and this permission. The target environment re-checks the actor's
 * company permissions against its own synced replica before minting anything.
 */
export class ConvexConnectGrants extends Context.Service<
  ConvexConnectGrants,
  {
    /** False until a deployment configures the Convex issuer and its public key. */
    readonly enabled: boolean;
    readonly verifyConnectGrant: (input: {
      readonly grant: string;
      readonly environmentId: string;
      readonly userId: string;
      readonly requiredPermission: RelayConvexConnectGrantPermission;
      readonly nowEpochSeconds: number;
    }) => Effect.Effect<RelayConvexConnectGrantClaims | null>;
  }
>()("pathway-relay/auth/ConvexConnectGrants") {}

const make = Effect.gen(function* () {
  const config = yield* RelayConfiguration.RelayConfiguration;
  const audience = normalizeRelayIssuer(config.relayIssuer);
  const convexIssuer = config.cloudSync?.connectGrantIssuer;
  const convexPublicKey = config.cloudSync?.connectGrantPublicKey;
  const enabled = convexIssuer !== undefined && convexPublicKey !== undefined;

  const verifyConnectGrant: ConvexConnectGrants["Service"]["verifyConnectGrant"] = Effect.fn(
    "relay.convex_connect_grants.verify",
  )(function* (input) {
    yield* Effect.annotateCurrentSpan({
      "relay.environment_id": input.environmentId,
      "relay.convex.connect_grant_required_permission": input.requiredPermission,
    });
    if (convexIssuer === undefined || convexPublicKey === undefined) {
      // Fail closed: an unconfigured relay cannot tell a forged grant from a
      // real one, so it accepts none.
      yield* Effect.annotateCurrentSpan(
        "relay.convex.connect_grant_rejection",
        "issuer_not_configured",
      );
      return null;
    }
    return yield* verifyRelayJwt({
      publicKey: convexPublicKey,
      token: input.grant,
      typ: RELAY_CONVEX_CONNECT_GRANT_TYP,
      issuer: normalizeRelayIssuer(convexIssuer),
      audience,
      nowEpochSeconds: input.nowEpochSeconds,
      maxTokenAge: CONNECT_GRANT_MAX_TOKEN_AGE,
    }).pipe(
      Effect.tapError((error) =>
        Effect.annotateCurrentSpan(
          "relay.convex.connect_grant_rejection",
          RelayJwtError.diagnosticCode(error),
        ),
      ),
      Effect.flatMap(decodeConnectGrantClaims),
      Effect.map((claims): RelayConvexConnectGrantClaims | null =>
        claims.environmentId === input.environmentId &&
        claims.sub === input.userId &&
        claims.permission === input.requiredPermission
          ? claims
          : null,
      ),
      Effect.tap((claims) =>
        claims === null
          ? Effect.annotateCurrentSpan("relay.convex.connect_grant_rejection", "claims_mismatch")
          : Effect.void,
      ),
      Effect.orElseSucceed(() => null),
    );
  });

  return ConvexConnectGrants.of({
    enabled,
    verifyConnectGrant,
  });
});

export const layer = Layer.effect(ConvexConnectGrants, make);
