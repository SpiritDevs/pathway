import {
  RelayConvexAudience,
  RelayConvexControlPlaneSubject,
  RelayConvexControlPlaneTokenClaims,
  RelayConvexControlPlaneTokenKind,
  RelayConvexServiceTokenClaims,
  RelayDpopAccessTokenScope,
  RelayEnvironmentConnectScope,
  RelayEnvironmentStatusScope,
  RelayMobileClientId,
  RelayMobileRegistrationScope,
  RelayWebClientId,
  type RelayPublicClientId,
  type RelayEnvironmentLinkChallengeRequest,
} from "@spiritdevs/contracts/relay";
import { encodeOAuthScope, parseAllowedOAuthScope } from "@spiritdevs/shared/oauthScope";
import {
  normalizeRelayIssuer,
  RELAY_CONVEX_CONTROL_PLANE_TOKEN_TYP,
  RELAY_CONVEX_SERVICE_TOKEN_TYP,
  RelayJwtError,
  signRelayJwt,
  signRelayEs256Jwt,
  verifyRelayJwt,
  verifyRelayEs256Jwt,
} from "@spiritdevs/shared/relayJwt";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import * as RelayConfiguration from "../Config.ts";

const LINK_CHALLENGE_TYP = "t3-link-challenge+jwt";
const ACCESS_TOKEN_TYP = "t3-relay-dpop-access+jwt";
const LINK_CHALLENGE_KIND = "environment_link_challenge";
export const RELAY_DPOP_ACCESS_TOKEN_TTL = "30 minutes";
// Shorter than the client access token: an environment can re-exchange whenever
// it needs one, and a leaked service token is only useful while Convex accepts it.
export const RELAY_CONVEX_SERVICE_TOKEN_TTL = "10 minutes";
export const RELAY_CONVEX_CONTROL_PLANE_TOKEN_TTL = "2 minutes";

const LinkChallengeClaims = Schema.Struct({
  kind: Schema.Literal(LINK_CHALLENGE_KIND),
  iss: Schema.String,
  aud: Schema.String,
  sub: Schema.String,
  jti: Schema.String,
  iat: Schema.Int,
  exp: Schema.Int,
  notificationsEnabled: Schema.Boolean,
  liveActivitiesEnabled: Schema.Boolean,
  managedTunnelsEnabled: Schema.Boolean,
});
export type LinkChallengeClaims = typeof LinkChallengeClaims.Type;

const RelayDpopAccessTokenClaims = Schema.Struct({
  iss: Schema.String,
  aud: Schema.String,
  sub: Schema.String,
  jti: Schema.String,
  iat: Schema.Int,
  exp: Schema.Int,
  client_id: Schema.Literals([RelayMobileClientId, RelayWebClientId]),
  scope: Schema.String,
  cnf: Schema.Struct({ jkt: Schema.String }),
});
export type RelayDpopAccessTokenClaims = Omit<typeof RelayDpopAccessTokenClaims.Type, "scope"> & {
  readonly scope: ReadonlyArray<RelayDpopAccessTokenScope>;
};

const decodeLinkChallengeClaims = Schema.decodeUnknownEffect(LinkChallengeClaims);
const decodeDpopAccessTokenClaims = Schema.decodeUnknownEffect(RelayDpopAccessTokenClaims);
const decodeConvexServiceTokenClaims = Schema.decodeUnknownEffect(RelayConvexServiceTokenClaims);
const decodeConvexControlPlaneTokenClaims = Schema.decodeUnknownEffect(
  RelayConvexControlPlaneTokenClaims,
);

const allowedScopesByClientId: Record<
  RelayPublicClientId,
  ReadonlySet<RelayDpopAccessTokenScope>
> = {
  [RelayMobileClientId]: new Set([
    RelayEnvironmentConnectScope,
    RelayEnvironmentStatusScope,
    RelayMobileRegistrationScope,
  ]),
  [RelayWebClientId]: new Set([RelayEnvironmentConnectScope, RelayEnvironmentStatusScope]),
};

function resolveDpopAccessTokenScopes(input: {
  readonly clientId: RelayPublicClientId;
  readonly scope: string;
}): ReadonlyArray<RelayDpopAccessTokenScope> | null {
  return parseAllowedOAuthScope({
    value: input.scope,
    allowedScopes: allowedScopesByClientId[input.clientId],
  });
}

export class RelayTokens extends Context.Service<
  RelayTokens,
  {
    readonly resolveDpopAccessTokenScopes: typeof resolveDpopAccessTokenScopes;
    readonly issueLinkChallenge: (input: {
      readonly userId: string;
      readonly request: RelayEnvironmentLinkChallengeRequest;
      readonly jti: string;
      readonly issuedAtEpochSeconds: number;
      readonly expiresAtEpochSeconds: number;
    }) => Effect.Effect<string, RelayJwtError>;
    readonly verifyLinkChallenge: (input: {
      readonly token: string;
      readonly userId: string;
      readonly request: RelayEnvironmentLinkChallengeRequest;
      readonly nowEpochSeconds: number;
    }) => Effect.Effect<LinkChallengeClaims | null>;
    readonly issueDpopAccessToken: (input: {
      readonly userId: string;
      readonly proofKeyThumbprint: string;
      readonly jti: string;
      readonly issuedAtEpochSeconds: number;
      readonly expiresAtEpochSeconds: number;
      readonly clientId: RelayPublicClientId;
      readonly scopes: ReadonlyArray<RelayDpopAccessTokenScope>;
    }) => Effect.Effect<string, RelayJwtError>;
    readonly verifyDpopAccessToken: (input: {
      readonly token: string;
      readonly nowEpochSeconds: number;
    }) => Effect.Effect<RelayDpopAccessTokenClaims | null>;
    readonly issueConvexServiceToken: (input: {
      readonly environmentId: string;
      readonly proofKeyThumbprint: string;
      readonly jti: string;
      readonly issuedAtEpochSeconds: number;
      readonly expiresAtEpochSeconds: number;
    }) => Effect.Effect<string, RelayJwtError>;
    readonly verifyConvexServiceToken: (input: {
      readonly token: string;
      readonly nowEpochSeconds: number;
    }) => Effect.Effect<RelayConvexServiceTokenClaims | null>;
    readonly issueConvexControlPlaneToken: (input: {
      readonly jti: string;
      readonly issuedAtEpochSeconds: number;
      readonly expiresAtEpochSeconds: number;
    }) => Effect.Effect<string, RelayJwtError>;
    readonly verifyConvexControlPlaneToken: (input: {
      readonly token: string;
      readonly nowEpochSeconds: number;
    }) => Effect.Effect<RelayConvexControlPlaneTokenClaims | null>;
  }
>()("pathway-relay/auth/RelayTokens") {}

const make = Effect.gen(function* () {
  const config = yield* RelayConfiguration.RelayConfiguration;
  const issuer = normalizeRelayIssuer(config.relayIssuer);

  const issueLinkChallenge: RelayTokens["Service"]["issueLinkChallenge"] = Effect.fn(
    "relay.tokens.issue_link_challenge",
  )(function* (input) {
    return yield* signRelayJwt({
      privateKey: Redacted.value(config.cloudMintPrivateKey),
      typ: LINK_CHALLENGE_TYP,
      payload: {
        kind: LINK_CHALLENGE_KIND,
        iss: issuer,
        aud: issuer,
        sub: input.userId,
        jti: input.jti,
        iat: input.issuedAtEpochSeconds,
        exp: input.expiresAtEpochSeconds,
        ...input.request,
      },
    });
  });

  const verifyLinkChallenge: RelayTokens["Service"]["verifyLinkChallenge"] = Effect.fn(
    "relay.tokens.verify_link_challenge",
  )((input) =>
    verifyRelayJwt({
      publicKey: config.cloudMintPublicKey,
      token: input.token,
      typ: LINK_CHALLENGE_TYP,
      issuer,
      audience: issuer,
      nowEpochSeconds: input.nowEpochSeconds,
    }).pipe(
      Effect.flatMap(decodeLinkChallengeClaims),
      Effect.map((claims) => {
        if (
          claims.sub !== input.userId ||
          (input.request.notificationsEnabled && claims.notificationsEnabled !== true) ||
          (input.request.liveActivitiesEnabled && claims.liveActivitiesEnabled !== true) ||
          (input.request.managedTunnelsEnabled && claims.managedTunnelsEnabled !== true)
        ) {
          return null;
        }
        return claims;
      }),
      Effect.orElseSucceed(() => null),
    ),
  );

  const issueDpopAccessToken: RelayTokens["Service"]["issueDpopAccessToken"] = Effect.fn(
    "relay.tokens.issue_dpop_access_token",
  )(function* (input) {
    return yield* signRelayJwt({
      privateKey: Redacted.value(config.cloudMintPrivateKey),
      typ: ACCESS_TOKEN_TYP,
      payload: {
        iss: issuer,
        aud: issuer,
        sub: input.userId,
        jti: input.jti,
        iat: input.issuedAtEpochSeconds,
        exp: input.expiresAtEpochSeconds,
        client_id: input.clientId,
        scope: encodeOAuthScope(input.scopes),
        cnf: { jkt: input.proofKeyThumbprint },
      },
    });
  });

  const verifyDpopAccessToken: RelayTokens["Service"]["verifyDpopAccessToken"] = Effect.fn(
    "relay.tokens.verify_dpop_access_token",
  )((input) =>
    verifyRelayJwt({
      publicKey: config.cloudMintPublicKey,
      token: input.token,
      typ: ACCESS_TOKEN_TYP,
      issuer,
      audience: issuer,
      nowEpochSeconds: input.nowEpochSeconds,
      maxTokenAge: RELAY_DPOP_ACCESS_TOKEN_TTL,
    }).pipe(
      Effect.tapError((error) =>
        Effect.annotateCurrentSpan(
          "relay.tokens.verification_failure",
          RelayJwtError.diagnosticCode(error),
        ),
      ),
      Effect.flatMap(decodeDpopAccessTokenClaims),
      Effect.map((claims): RelayDpopAccessTokenClaims | null => {
        const scopes = resolveDpopAccessTokenScopes({
          clientId: claims.client_id,
          scope: claims.scope,
        });
        return scopes === null ? null : { ...claims, scope: scopes };
      }),
      Effect.orElseSucceed(() => null),
    ),
  );

  const issueConvexServiceToken: RelayTokens["Service"]["issueConvexServiceToken"] = Effect.fn(
    "relay.tokens.issue_convex_service_token",
  )(function* (input) {
    yield* Effect.annotateCurrentSpan({ "relay.environment_id": input.environmentId });
    const cloudSync = config.cloudSync;
    if (cloudSync === undefined) {
      return yield* new RelayJwtError({
        operation: "sign",
        typ: RELAY_CONVEX_SERVICE_TOKEN_TYP,
        cause: new Error("Relay cloud sync is not configured"),
      });
    }
    return yield* signRelayEs256Jwt({
      privateKey: Redacted.value(cloudSync.signingKey.privateKey),
      keyId: cloudSync.signingKey.keyId,
      typ: RELAY_CONVEX_SERVICE_TOKEN_TYP,
      payload: {
        iss: issuer,
        // The one relay token whose audience is not the relay itself: Convex
        // trusts this issuer as a custom JWT provider and resolves the
        // environment's company registrations from its own records.
        aud: RelayConvexAudience,
        sub: input.environmentId,
        jti: input.jti,
        iat: input.issuedAtEpochSeconds,
        exp: input.expiresAtEpochSeconds,
        environmentId: input.environmentId,
        cnf: { jkt: input.proofKeyThumbprint },
      },
    });
  });

  const verifyConvexServiceToken: RelayTokens["Service"]["verifyConvexServiceToken"] = Effect.fn(
    "relay.tokens.verify_convex_service_token",
  )((input) =>
    config.cloudSync === undefined
      ? Effect.succeed(null)
      : verifyRelayEs256Jwt({
          publicKeys: config.cloudSync.verificationKeys,
          token: input.token,
          typ: RELAY_CONVEX_SERVICE_TOKEN_TYP,
          issuer,
          audience: RelayConvexAudience,
          nowEpochSeconds: input.nowEpochSeconds,
          maxTokenAge: RELAY_CONVEX_SERVICE_TOKEN_TTL,
        }).pipe(
          Effect.tapError((error) =>
            Effect.annotateCurrentSpan(
              "relay.tokens.verification_failure",
              RelayJwtError.diagnosticCode(error),
            ),
          ),
          Effect.flatMap(decodeConvexServiceTokenClaims),
          Effect.map((claims): RelayConvexServiceTokenClaims | null =>
            claims.sub === claims.environmentId ? claims : null,
          ),
          Effect.orElseSucceed(() => null),
        ),
  );

  const issueConvexControlPlaneToken: RelayTokens["Service"]["issueConvexControlPlaneToken"] =
    Effect.fn("relay.tokens.issue_convex_control_plane_token")(function* (input) {
      const cloudSync = config.cloudSync;
      if (cloudSync === undefined) {
        return yield* new RelayJwtError({
          operation: "sign",
          typ: RELAY_CONVEX_CONTROL_PLANE_TOKEN_TYP,
          cause: new Error("Relay cloud sync is not configured"),
        });
      }
      return yield* signRelayEs256Jwt({
        privateKey: Redacted.value(cloudSync.signingKey.privateKey),
        keyId: cloudSync.signingKey.keyId,
        typ: RELAY_CONVEX_CONTROL_PLANE_TOKEN_TYP,
        payload: {
          iss: issuer,
          aud: RelayConvexAudience,
          sub: RelayConvexControlPlaneSubject,
          jti: input.jti,
          iat: input.issuedAtEpochSeconds,
          exp: input.expiresAtEpochSeconds,
          tokenKind: RelayConvexControlPlaneTokenKind,
        },
      });
    });

  const verifyConvexControlPlaneToken: RelayTokens["Service"]["verifyConvexControlPlaneToken"] =
    Effect.fn("relay.tokens.verify_convex_control_plane_token")((input) =>
      config.cloudSync === undefined
        ? Effect.succeed(null)
        : verifyRelayEs256Jwt({
            publicKeys: config.cloudSync.verificationKeys,
            token: input.token,
            typ: RELAY_CONVEX_CONTROL_PLANE_TOKEN_TYP,
            issuer,
            audience: RelayConvexAudience,
            nowEpochSeconds: input.nowEpochSeconds,
            maxTokenAge: RELAY_CONVEX_CONTROL_PLANE_TOKEN_TTL,
          }).pipe(
            Effect.flatMap(decodeConvexControlPlaneTokenClaims),
            Effect.orElseSucceed(() => null),
          ),
    );

  return RelayTokens.of({
    resolveDpopAccessTokenScopes,
    issueLinkChallenge,
    verifyLinkChallenge,
    issueDpopAccessToken,
    verifyDpopAccessToken,
    issueConvexServiceToken,
    verifyConvexServiceToken,
    issueConvexControlPlaneToken,
    verifyConvexControlPlaneToken,
  });
});

export const layer = Layer.effect(RelayTokens, make);
