import * as NodeCrypto from "node:crypto";

import { createClerkClient, verifyToken } from "@clerk/backend";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import * as Tracer from "effect/Tracer";
import * as HttpEffect from "effect/unstable/http/HttpEffect";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { EnvironmentId } from "@spiritdevs/contracts";
import {
  RelayAccessTokenType,
  RelayConvexAudience,
  RelayDpopTokenExchangeGrantType,
  RelayEnvironmentClientId,
  RelayEnvironmentAuth,
  RELAY_ENVIRONMENT_DPOP_ACCESS_ASSERTION_TYP,
  RelayEnvironmentCredentialTokenType,
  RelayEnvironmentConnectScope,
  type RelayConvexServiceTokenRequest,
  type RelayEnvironmentDpopAccessTokenRequest,
} from "@spiritdevs/contracts/relay";
import { computeDpopJwkThumbprint, type DpopPublicJwk } from "@spiritdevs/shared/dpop";
import { decodeRelayJwt } from "@spiritdevs/shared/relayJwt";

import {
  RELAY_REQUEST_DEADLINE_MS,
  authorizeEnvironmentConnectPrincipal,
  exchangeConvexServiceToken,
  exchangeEnvironmentDpopAccessToken,
  relayCors,
  relayCorsPreflightResponse,
  relayDocsRedirectRoute,
  relayEnvironmentAuthLayer,
  relayNotFoundRoute,
  revokeEnvironmentLinkRecord,
  traceRelayHttpRequestWith,
  unlinkEnvironmentRecord,
  validatePresentedConnectGrant,
  verifyRelayClientBearerToken,
  withoutCapturedParentSpan,
} from "./Api.ts";
import * as DpopProofs from "../auth/DpopProofs.ts";
import * as ConvexConnectGrants from "../auth/ConvexConnectGrants.ts";
import * as RelayTokens from "../auth/RelayTokens.ts";
import * as RelayConfiguration from "../Config.ts";
import * as RelayDb from "../db.ts";
import * as EnvironmentCredentials from "../environments/EnvironmentCredentials.ts";
import * as EnvironmentLinks from "../environments/EnvironmentLinks.ts";
import * as ManagedEndpointProvider from "../environments/ManagedEndpointProvider.ts";

vi.mock("@clerk/backend", () => ({
  createClerkClient: vi.fn(),
  verifyToken: vi.fn(),
}));

const relaySettings: RelayConfiguration.RelayConfiguration["Service"] = {
  relayIssuer: "https://relay.example.test",
  apns: {
    teamId: "apns-team",
    keyId: "apns-key",
    privateKey: Redacted.make("apns-private-key"),
    bundleId: "com.example.pathway",
    environment: "sandbox",
  },
  clerkSecretKey: Redacted.make("clerk-secret-key"),
  clerkPublishableKey: "pk_test_test",
  clerkJwtAudience: "pathway-relay",
  apnsDeliveryJobSigningSecret: Redacted.make("apns-delivery-secret"),
  cloudMintPrivateKey: Redacted.make("cloud-mint-private-key"),
  cloudMintPublicKey: "cloud-mint-public-key",
  managedEndpointBaseDomain: undefined,
  managedEndpointNamespace: undefined,
};

describe("relay client authentication", () => {
  it.effect("preserves the existing Clerk session JWT path", () =>
    Effect.gen(function* () {
      vi.mocked(verifyToken).mockResolvedValue({
        sub: "user_session",
        aud: relaySettings.clerkJwtAudience,
      } as never);

      expect(yield* verifyRelayClientBearerToken(relaySettings, "session-token")).toEqual({
        sub: "user_session",
        mode: "clerk_session_bearer",
      });
      expect(verifyToken).toHaveBeenCalledWith("session-token", {
        secretKey: "clerk-secret-key",
        audience: relaySettings.clerkJwtAudience,
      });
      expect(createClerkClient).not.toHaveBeenCalled();
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          vi.mocked(verifyToken).mockReset();
          vi.mocked(createClerkClient).mockReset();
        }),
      ),
    ),
  );

  it.effect("falls back to Clerk OAuth token verification for the headless CLI", () =>
    Effect.gen(function* () {
      vi.mocked(verifyToken).mockRejectedValue(new Error("not a session JWT"));
      vi.mocked(createClerkClient).mockReturnValue({
        authenticateRequest: vi.fn().mockResolvedValue({
          isAuthenticated: true,
          toAuth: () => ({ userId: "user_oauth" }),
        }),
      } as never);

      expect(yield* verifyRelayClientBearerToken(relaySettings, "oauth-token")).toEqual({
        sub: "user_oauth",
        mode: "clerk_oauth_bearer",
      });
      expect(createClerkClient).toHaveBeenCalledWith({
        secretKey: "clerk-secret-key",
        publishableKey: "pk_test_test",
      });
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          vi.mocked(verifyToken).mockReset();
          vi.mocked(createClerkClient).mockReset();
        }),
      ),
    ),
  );
});

describe("relay environment connect grants", () => {
  it.effect("returns accepted grant identity to the connect path", () => {
    const identity = {
      environmentId: "environment-1" as never,
      membershipId: "membership-1" as never,
      permission: "remoteAgents.control" as const,
    };
    return Effect.gen(function* () {
      expect(
        yield* validatePresentedConnectGrant({
          connectGrant: "accepted-grant",
          environmentId: "environment-1",
        }),
      ).toEqual(identity);
    }).pipe(
      Effect.provideService(
        ConvexConnectGrants.ConvexConnectGrants,
        ConvexConnectGrants.ConvexConnectGrants.of({
          validateConnectGrant: () => Effect.succeed(identity),
        }),
      ),
    );
  });

  it.effect("refuses a connect when a presented grant is not accepted", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        validatePresentedConnectGrant({
          connectGrant: "refused-grant",
          environmentId: "environment-1",
        }),
      );

      expect(error).toMatchObject({
        _tag: "EnvironmentConnectNotAuthorized",
        environmentId: "environment-1",
        operation: "connect",
        reason: "connect_grant_refused",
      });
    }).pipe(
      Effect.provideService(
        ConvexConnectGrants.ConvexConnectGrants,
        ConvexConnectGrants.ConvexConnectGrants.of({
          validateConnectGrant: () => Effect.succeed(null),
        }),
      ),
    ),
  );

  it.effect("leaves the existing no-grant connect path untouched", () =>
    Effect.gen(function* () {
      expect(
        yield* validatePresentedConnectGrant({ environmentId: "environment-1" }),
      ).toBeUndefined();
    }).pipe(
      Effect.provideService(
        ConvexConnectGrants.ConvexConnectGrants,
        ConvexConnectGrants.ConvexConnectGrants.of({
          validateConnectGrant: () => Effect.die("grant validation must not run"),
        }),
      ),
    ),
  );

  it.effect("requires a connect grant for environment-subject connects", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        authorizeEnvironmentConnectPrincipal({
          subject: { _tag: "Environment", environmentId: EnvironmentId.make("environment-1") },
          targetEnvironmentId: "environment-2",
        }),
      );

      expect(error).toMatchObject({
        _tag: "EnvironmentConnectNotAuthorized",
        operation: "connect",
        reason: "connect_grant_refused",
      });
    }).pipe(
      Effect.provideService(
        ConvexConnectGrants.ConvexConnectGrants,
        ConvexConnectGrants.ConvexConnectGrants.of({
          validateConnectGrant: () => Effect.die("missing grant must not be validated"),
        }),
      ),
    ),
  );

  it.effect("accepts an environment-subject connect only with a validated grant", () => {
    const identity = {
      environmentId: EnvironmentId.make("environment-2"),
      membershipId: "membership-1" as never,
      permission: "remoteAgents.control" as const,
    };
    return Effect.gen(function* () {
      expect(
        yield* authorizeEnvironmentConnectPrincipal({
          subject: { _tag: "Environment", environmentId: EnvironmentId.make("environment-1") },
          targetEnvironmentId: "environment-2",
          connectGrant: "accepted-grant",
        }),
      ).toEqual({
        initiatingEnvironmentId: "environment-1",
        connectGrant: identity,
      });
    }).pipe(
      Effect.provideService(
        ConvexConnectGrants.ConvexConnectGrants,
        ConvexConnectGrants.ConvexConnectGrants.of({
          validateConnectGrant: () => Effect.succeed(identity),
        }),
      ),
    );
  });

  it.effect("refuses an environment connecting to itself before consuming a grant", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        authorizeEnvironmentConnectPrincipal({
          subject: { _tag: "Environment", environmentId: EnvironmentId.make("environment-1") },
          targetEnvironmentId: "environment-1",
          connectGrant: "must-not-be-consumed",
        }),
      );

      expect(error).toMatchObject({
        _tag: "EnvironmentConnectNotAuthorized",
        operation: "connect",
        reason: "self_connect_refused",
      });
    }).pipe(
      Effect.provideService(
        ConvexConnectGrants.ConvexConnectGrants,
        ConvexConnectGrants.ConvexConnectGrants.of({
          validateConnectGrant: () => Effect.die("self-connect must not consume a grant"),
        }),
      ),
    ),
  );
});

describe("relay environment authentication", () => {
  it.effect("preserves credential lookup persistence failures as internal errors", () => {
    const failure = new EnvironmentCredentials.EnvironmentCredentialAuthenticatePersistenceError({
      stage: "lookup-credential",
      cause: "database unavailable",
    });
    const credentials: EnvironmentCredentials.EnvironmentCredentials["Service"] = {
      create: () => Effect.die("unused create"),
      replaceLinkAndCreate: () => Effect.die("unused replaceLinkAndCreate"),
      authenticate: () => Effect.fail(failure),
      revokeForEnvironmentPublicKey: () => Effect.die("unused revoke"),
    };

    return Effect.gen(function* () {
      const auth = yield* RelayEnvironmentAuth;
      const error = yield* Effect.flip(
        auth.environmentBearer(Effect.succeed(HttpServerResponse.empty()), {
          credential: Redacted.make("environment-credential"),
          endpoint: {} as never,
          group: {} as never,
        }),
      );

      expect(Predicate.isTagged(error, "RelayInternalError")).toBe(true);
      if (Predicate.isTagged(error, "RelayInternalError")) {
        expect(error.reason).toBe("persistence_failed");
      }
    }).pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        HttpServerRequest.fromWeb(new Request("https://relay.test/v1/server/link")),
      ),
      Effect.provideService(HttpServerRequest.ParsedSearchParams, {}),
      Effect.provideService(HttpRouter.RouteContext, {
        params: {},
        route: {} as never,
      }),
      Effect.provide(
        relayEnvironmentAuthLayer.pipe(
          Layer.provide(Layer.succeed(EnvironmentCredentials.EnvironmentCredentials, credentials)),
        ),
      ),
      Effect.scoped,
    );
  });
});

function relayUnlinkTestLayer(input?: {
  readonly revoke?: (
    args: unknown,
  ) => Effect.Effect<
    { readonly linkRevoked: boolean; readonly credentialsRevoked: boolean },
    RelayDb.RelayConvexClientError
  >;
  readonly getForUser?: EnvironmentLinks.EnvironmentLinks["Service"]["getForUser"];
  readonly prepareDeprovision?: ManagedEndpointProvider.ManagedEndpointProvider["Service"]["prepareDeprovision"];
  readonly deprovision?: ManagedEndpointProvider.ManagedEndpointProvider["Service"]["deprovision"];
}) {
  return Layer.mergeAll(
    Layer.succeed(
      RelayDb.RelayConvexClient,
      RelayDb.RelayConvexClient.of({
        query: () => Effect.die("unused query"),
        mutation: (_reference: unknown, args: unknown) =>
          (
            input?.revoke ??
            (() => Effect.succeed({ linkRevoked: false, credentialsRevoked: false }))
          )(args),
      } as unknown as RelayDb.RelayConvexClient["Service"]),
    ),
    Layer.succeed(
      EnvironmentLinks.EnvironmentLinks,
      EnvironmentLinks.EnvironmentLinks.of({
        upsert: () => Effect.die("unused upsert"),
        listUsersForEnvironment: () => Effect.die("unused listUsersForEnvironment"),
        listDeliveryUsersForEnvironment: () => Effect.die("unused listDeliveryUsersForEnvironment"),
        listPublicKeysForEnvironment: () => Effect.die("unused listPublicKeysForEnvironment"),
        listForUser: () => Effect.die("unused listForUser"),
        getForUser: input?.getForUser ?? (() => Effect.succeed(null)),
        revokeForUser: () => Effect.die("unused revokeForUser"),
      }),
    ),
    Layer.succeed(
      ManagedEndpointProvider.ManagedEndpointProvider,
      ManagedEndpointProvider.ManagedEndpointProvider.of({
        provision: () => Effect.die("unused provision"),
        prepareDeprovision: input?.prepareDeprovision ?? (() => Effect.succeed(null)),
        deprovision: input?.deprovision ?? (() => Effect.void),
        release: () => Effect.die("unused release"),
      }),
    ),
  );
}

const linkedEnvironmentRecord = {
  environmentId: EnvironmentId.make("environment-1"),
  label: "Environment 1",
  endpoint: {
    httpBaseUrl: "https://environment-1.example.test/",
    wsBaseUrl: "wss://environment-1.example.test/ws",
    providerKind: "cloudflare_tunnel",
  },
  environmentPublicKey: "public-key",
  linkedAt: "2026-07-28T00:00:00.000Z",
} as const;

describe("relay environment unlink", () => {
  it.effect("revokes the link and its credentials with one atomic Convex mutation", () => {
    let mutationArgs: unknown = null;
    return Effect.gen(function* () {
      expect(
        yield* revokeEnvironmentLinkRecord({
          userId: "user-1",
          environmentId: "environment-1",
          environmentPublicKey: "public-key",
        }),
      ).toBe(true);
      expect(mutationArgs).toMatchObject({
        userId: "user-1",
        environmentId: "environment-1",
        now: "1970-01-01T00:00:00.000Z",
      });
    }).pipe(
      Effect.provide(
        relayUnlinkTestLayer({
          revoke: (args) =>
            Effect.sync(() => {
              mutationArgs = args;
              return { linkRevoked: true, credentialsRevoked: true };
            }),
        }),
      ),
    );
  });

  it.effect("commits database revocation before deprovisioning the managed endpoint", () => {
    const calls: Array<string> = [];
    const deprovisionTarget = {
      userId: "user-1",
      environmentId: "environment-1",
      hostname: "environment-1.example.test",
      tunnelId: "tunnel-1",
      tunnelName: "environment-1-tunnel",
      dnsRecordId: "dns-1",
      readyAt: "2026-07-28T00:00:00.000Z",
      updatedAt: "generation-before-unlink",
    } satisfies ManagedEndpointProvider.ManagedEndpointDeprovisionTarget;

    return Effect.gen(function* () {
      expect(
        yield* unlinkEnvironmentRecord({
          userId: "user-1",
          environmentId: "environment-1",
        }),
      ).toBe(true);
      expect(calls).toEqual(["prepare", "lookup", "mutation", "deprovision"]);
    }).pipe(
      Effect.provide(
        relayUnlinkTestLayer({
          getForUser: () =>
            Effect.sync(() => {
              calls.push("lookup");
              return linkedEnvironmentRecord;
            }),
          revoke: () =>
            Effect.sync(() => {
              calls.push("mutation");
              return { linkRevoked: true, credentialsRevoked: true };
            }),
          prepareDeprovision: () =>
            Effect.sync(() => {
              calls.push("prepare");
              return deprovisionTarget;
            }),
          deprovision: (request) =>
            Effect.sync(() => {
              expect(request.target).toBe(deprovisionTarget);
              calls.push("deprovision");
            }),
        }),
      ),
    );
  });

  it.effect("does not deprovision when database revocation fails", () => {
    const calls: Array<string> = [];
    const failure = new RelayDb.RelayConvexClientError({
      operation: "mutation",
      cause: "database unavailable",
    });

    return Effect.gen(function* () {
      expect(
        yield* Effect.flip(
          unlinkEnvironmentRecord({
            userId: "user-1",
            environmentId: "environment-1",
          }),
        ),
      ).toMatchObject({
        _tag: "EnvironmentLinkRevokePersistenceError",
        userId: "user-1",
        environmentId: "environment-1",
        cause: failure,
      });
      expect(calls).toEqual(["prepare", "mutation"]);
    }).pipe(
      Effect.provide(
        relayUnlinkTestLayer({
          getForUser: () => Effect.succeed(linkedEnvironmentRecord),
          revoke: () =>
            Effect.sync(() => {
              calls.push("mutation");
            }).pipe(Effect.andThen(Effect.fail(failure))),
          prepareDeprovision: () =>
            Effect.sync(() => {
              calls.push("prepare");
              return null;
            }),
          deprovision: () =>
            Effect.sync(() => {
              calls.push("deprovision");
            }),
        }),
      ),
    );
  });

  it.effect("retries deprovisioning after the link is already revoked", () => {
    const calls: Array<string> = [];
    return Effect.gen(function* () {
      expect(
        yield* unlinkEnvironmentRecord({
          userId: "user-1",
          environmentId: "environment-1",
        }),
      ).toBe(false);
      expect(calls).toEqual(["prepare", "deprovision"]);
    }).pipe(
      Effect.provide(
        relayUnlinkTestLayer({
          prepareDeprovision: () =>
            Effect.sync(() => {
              calls.push("prepare");
              return null;
            }),
          deprovision: () =>
            Effect.sync(() => {
              calls.push("deprovision");
            }),
        }),
      ),
    );
  });
});

const convexMintKeyPair = NodeCrypto.generateKeyPairSync("ec", {
  namedCurve: "P-256",
  privateKeyEncoding: { format: "pem", type: "pkcs8" },
  publicKeyEncoding: { format: "pem", type: "spki" },
});

const enabledCloudSync = {
  serviceTokensEnabled: true,
  convexUrl: "https://convex.example.test",
  signingKey: {
    keyId: "relay-convex-test",
    privateKey: Redacted.make(convexMintKeyPair.privateKey),
    publicKey: convexMintKeyPair.publicKey,
  },
  verificationKeys: [{ keyId: "relay-convex-test", publicKey: convexMintKeyPair.publicKey }],
} satisfies RelayConfiguration.RelayCloudSyncConfiguration;

// The request URL the relay reconstructs from the incoming host header, which is
// what the DPoP proof's `htu` has to match.
const convexTokenUrl = "http://relay.example.test/v1/environment/convex-token";

// The link key the relay stored for environment-1, which the key-binding
// assertion is verified against.
const convexEnvironmentKeyPair = NodeCrypto.generateKeyPairSync("ed25519", {
  privateKeyEncoding: { format: "pem", type: "pkcs8" },
  publicKeyEncoding: { format: "pem", type: "spki" },
});

const environmentPrincipal: EnvironmentCredentials.EnvironmentCredentialPrincipal = {
  credentialId: "credential-1",
  environmentId: "environment-1",
  environmentPublicKey: convexEnvironmentKeyPair.publicKey,
};

function signConvexKeyBinding(input: {
  readonly jkt: string;
  readonly privateKey?: string;
  readonly claims?: Record<string, unknown>;
}) {
  const header = Buffer.from(
    JSON.stringify({ alg: "EdDSA", typ: "pathway-env-convex-key-binding+jwt" }),
  ).toString("base64url");
  // it.effect runs on the TestClock, which starts at the epoch.
  const payload = Buffer.from(
    JSON.stringify({
      iss: "pathway-env:environment-1",
      aud: "https://relay.example.test",
      sub: "environment-1",
      jti: `key-binding-${input.jkt}`,
      iat: 0,
      exp: 600,
      environmentId: "environment-1",
      jkt: input.jkt,
      ...input.claims,
    }),
  ).toString("base64url");
  const signature = NodeCrypto.sign(
    null,
    Buffer.from(`${header}.${payload}`),
    NodeCrypto.createPrivateKey(input.privateKey ?? convexEnvironmentKeyPair.privateKey),
  ).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

function convexServiceTokenPayload(keyBinding: string): RelayConvexServiceTokenRequest {
  return {
    grant_type: RelayDpopTokenExchangeGrantType,
    subject_token: "pathwayenv_environment-1_secret",
    subject_token_type: RelayEnvironmentCredentialTokenType,
    requested_token_type: RelayAccessTokenType,
    audience: RelayConvexAudience,
    key_binding: keyBinding,
  };
}

function makeConvexExchangeDpopProof(jti: string) {
  const { privateKey, publicKey } = NodeCrypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const publicJwk = publicKey.export({ format: "jwk" }) as DpopPublicJwk;
  const header = Buffer.from(
    JSON.stringify({ typ: "dpop+jwt", alg: "ES256", jwk: publicJwk }),
  ).toString("base64url");
  // it.effect runs on the TestClock, which starts at the epoch.
  const payload = Buffer.from(
    JSON.stringify({ htm: "POST", htu: convexTokenUrl, jti, iat: 0 }),
  ).toString("base64url");
  const signature = NodeCrypto.sign("sha256", Buffer.from(`${header}.${payload}`), {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  }).toString("base64url");
  return {
    proof: `${header}.${payload}.${signature}`,
    thumbprint: computeDpopJwkThumbprint(publicJwk),
  };
}

function convexExchangeTestLayer(input: {
  readonly cloudSync?: RelayConfiguration.RelayCloudSyncConfiguration | undefined;
  readonly authenticate?: EnvironmentCredentials.EnvironmentCredentials["Service"]["authenticate"];
  readonly consumedProofs: Set<string>;
}) {
  const settings: RelayConfiguration.RelayConfiguration["Service"] = {
    ...relaySettings,
    cloudMintPrivateKey: Redacted.make(convexMintKeyPair.privateKey),
    cloudMintPublicKey: convexMintKeyPair.publicKey,
    cloudSync: input.cloudSync,
  };
  const fakeClient = RelayDb.RelayConvexClient.of({
    query: () => Effect.die("unused query"),
    mutation: (_reference: unknown, args: unknown) =>
      Effect.sync(() => {
        const values = args as { readonly thumbprint: string; readonly jti: string };
        const key = `${values.thumbprint}:${values.jti}`;
        if (input.consumedProofs.has(key)) return false;
        input.consumedProofs.add(key);
        return true;
      }),
  } as unknown as RelayDb.RelayConvexClient["Service"]);

  const configLayer = RelayConfiguration.layer(settings);
  return Layer.mergeAll(
    configLayer,
    RelayTokens.layer.pipe(Layer.provide(configLayer)),
    DpopProofs.layer.pipe(Layer.provide(Layer.succeed(RelayDb.RelayConvexClient, fakeClient))),
    Layer.succeed(
      EnvironmentCredentials.EnvironmentCredentials,
      EnvironmentCredentials.EnvironmentCredentials.of({
        create: () => Effect.die("unused create"),
        replaceLinkAndCreate: () => Effect.die("unused replaceLinkAndCreate"),
        authenticate:
          input.authenticate ?? (() => Effect.succeed(Option.some(environmentPrincipal))),
        revokeForEnvironmentPublicKey: () => Effect.die("unused revoke"),
      }),
    ),
    Layer.succeed(
      Crypto.Crypto,
      Crypto.make({
        randomBytes: (size) => new Uint8Array(size),
        digest: (_algorithm, data) => Effect.succeed(data),
      }),
    ),
  );
}

function convexExchangeRequest(proof: string) {
  return HttpServerRequest.fromWeb(
    new Request(convexTokenUrl, {
      method: "POST",
      headers: { dpop: proof, host: "relay.example.test" },
    }),
  );
}

describe("relay Convex service token exchange", () => {
  it.effect("issues a pathway-convex token bound to the environment and proof key", () => {
    const consumedProofs = new Set<string>();
    const proof = makeConvexExchangeDpopProof("convex-exchange-proof-1");

    return Effect.gen(function* () {
      const response = yield* exchangeConvexServiceToken(
        convexServiceTokenPayload(signConvexKeyBinding({ jkt: proof.thumbprint })),
      );

      expect(response).toMatchObject({
        issued_token_type: RelayAccessTokenType,
        token_type: "Bearer",
        expires_in: 600,
        audience: "pathway-convex",
      });
      expect(decodeRelayJwt(response.access_token)).toMatchObject({
        iss: "https://relay.example.test",
        aud: "pathway-convex",
        sub: "environment-1",
        environmentId: "environment-1",
        cnf: { jkt: proof.thumbprint },
        iat: 0,
        exp: 600,
      });
      expect(consumedProofs.size).toBe(1);
    }).pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        convexExchangeRequest(proof.proof),
      ),
      Effect.provide(
        convexExchangeTestLayer({
          consumedProofs,
          cloudSync: enabledCloudSync,
        }),
      ),
    );
  });

  it.effect("refuses to exchange while the cloud-sync capability is disabled", () => {
    const consumedProofs = new Set<string>();
    const proof = makeConvexExchangeDpopProof("convex-exchange-proof-disabled");

    return Effect.gen(function* () {
      const error = yield* Effect.flip(
        exchangeConvexServiceToken(
          convexServiceTokenPayload(signConvexKeyBinding({ jkt: proof.thumbprint })),
        ),
      );

      expect(Predicate.isTagged(error, "RelayAuthInvalidError")).toBe(true);
      if (Predicate.isTagged(error, "RelayAuthInvalidError")) {
        expect(error.reason).toBe("not_authorized");
      }
      expect(consumedProofs.size).toBe(0);
    }).pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        convexExchangeRequest(proof.proof),
      ),
      Effect.provide(convexExchangeTestLayer({ consumedProofs, cloudSync: undefined })),
    );
  });

  it.effect("rejects a revoked environment credential without burning the DPoP proof", () => {
    const consumedProofs = new Set<string>();
    const proof = makeConvexExchangeDpopProof("convex-exchange-proof-revoked");

    return Effect.gen(function* () {
      const error = yield* Effect.flip(
        exchangeConvexServiceToken(
          convexServiceTokenPayload(signConvexKeyBinding({ jkt: proof.thumbprint })),
        ),
      );

      expect(Predicate.isTagged(error, "RelayAuthInvalidError")).toBe(true);
      if (Predicate.isTagged(error, "RelayAuthInvalidError")) {
        expect(error.reason).toBe("invalid_bearer");
      }
      expect(consumedProofs.size).toBe(0);
    }).pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        convexExchangeRequest(proof.proof),
      ),
      Effect.provide(
        convexExchangeTestLayer({
          consumedProofs,
          authenticate: () => Effect.succeed(Option.none()),
          cloudSync: enabledCloudSync,
        }),
      ),
    );
  });

  it.effect("rejects a replayed DPoP proof on a second exchange", () => {
    const consumedProofs = new Set<string>();
    const proof = makeConvexExchangeDpopProof("convex-exchange-proof-replayed");

    return Effect.gen(function* () {
      yield* exchangeConvexServiceToken(
        convexServiceTokenPayload(signConvexKeyBinding({ jkt: proof.thumbprint })),
      );
      const error = yield* Effect.flip(
        exchangeConvexServiceToken(
          convexServiceTokenPayload(signConvexKeyBinding({ jkt: proof.thumbprint })),
        ),
      );

      expect(Predicate.isTagged(error, "Unauthorized")).toBe(true);
      expect(consumedProofs.size).toBe(1);
    }).pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        convexExchangeRequest(proof.proof),
      ),
      Effect.provide(
        convexExchangeTestLayer({
          consumedProofs,
          cloudSync: enabledCloudSync,
        }),
      ),
    );
  });

  it.effect("refuses to mint against a DPoP key the environment never authorized", () => {
    const consumedProofs = new Set<string>();
    // A caller holding a stolen environment credential proves possession of a
    // key of their own; the binding the environment signed names a different one.
    const stolenProof = makeConvexExchangeDpopProof("convex-exchange-proof-foreign-key");
    const authorized = makeConvexExchangeDpopProof("convex-exchange-proof-authorized");

    return Effect.gen(function* () {
      const error = yield* Effect.flip(
        exchangeConvexServiceToken(
          convexServiceTokenPayload(signConvexKeyBinding({ jkt: authorized.thumbprint })),
        ),
      );

      expect(Predicate.isTagged(error, "Unauthorized")).toBe(true);
      // The mismatch is caught before the jti is spent, so the attacker cannot
      // burn proofs the environment might still want to use.
      expect(consumedProofs.size).toBe(0);
    }).pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        convexExchangeRequest(stolenProof.proof),
      ),
      Effect.provide(
        convexExchangeTestLayer({
          consumedProofs,
          cloudSync: enabledCloudSync,
        }),
      ),
    );
  });

  it.effect("rejects a key binding signed by anything but the environment's link key", () => {
    const consumedProofs = new Set<string>();
    const proof = makeConvexExchangeDpopProof("convex-exchange-proof-forged-binding");
    const forger = NodeCrypto.generateKeyPairSync("ed25519", {
      privateKeyEncoding: { format: "pem", type: "pkcs8" },
      publicKeyEncoding: { format: "pem", type: "spki" },
    });

    return Effect.gen(function* () {
      const error = yield* Effect.flip(
        exchangeConvexServiceToken(
          convexServiceTokenPayload(
            signConvexKeyBinding({ jkt: proof.thumbprint, privateKey: forger.privateKey }),
          ),
        ),
      );

      expect(Predicate.isTagged(error, "RelayAuthInvalidError")).toBe(true);
      if (Predicate.isTagged(error, "RelayAuthInvalidError")) {
        expect(error.reason).toBe("invalid_bearer");
      }
      expect(consumedProofs.size).toBe(0);
    }).pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        convexExchangeRequest(proof.proof),
      ),
      Effect.provide(
        convexExchangeTestLayer({
          consumedProofs,
          cloudSync: enabledCloudSync,
        }),
      ),
    );
  });

  it.effect("rejects a key binding issued for another environment", () => {
    const consumedProofs = new Set<string>();
    const proof = makeConvexExchangeDpopProof("convex-exchange-proof-wrong-environment");

    return Effect.gen(function* () {
      const error = yield* Effect.flip(
        exchangeConvexServiceToken(
          convexServiceTokenPayload(
            signConvexKeyBinding({
              jkt: proof.thumbprint,
              claims: { environmentId: "environment-2" },
            }),
          ),
        ),
      );

      expect(Predicate.isTagged(error, "RelayAuthInvalidError")).toBe(true);
      expect(consumedProofs.size).toBe(0);
    }).pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        convexExchangeRequest(proof.proof),
      ),
      Effect.provide(
        convexExchangeTestLayer({
          consumedProofs,
          cloudSync: enabledCloudSync,
        }),
      ),
    );
  });
});

const environmentDpopTokenUrl = "http://relay.example.test/v1/environment/dpop-token";
const environmentAccessMintKeyPair = NodeCrypto.generateKeyPairSync("ed25519", {
  privateKeyEncoding: { format: "pem", type: "pkcs8" },
  publicKeyEncoding: { format: "pem", type: "spki" },
});

function makeEnvironmentExchangeDpopProof(jti: string) {
  const { privateKey, publicKey } = NodeCrypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const publicJwk = publicKey.export({ format: "jwk" }) as DpopPublicJwk;
  const header = Buffer.from(
    JSON.stringify({ typ: "dpop+jwt", alg: "ES256", jwk: publicJwk }),
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ htm: "POST", htu: environmentDpopTokenUrl, jti, iat: 0 }),
  ).toString("base64url");
  const signature = NodeCrypto.sign("sha256", Buffer.from(`${header}.${payload}`), {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  }).toString("base64url");
  return {
    proof: `${header}.${payload}.${signature}`,
    thumbprint: computeDpopJwkThumbprint(publicJwk),
  };
}

function signEnvironmentAccessAssertion(input: {
  readonly jkt: string;
  readonly privateKey?: string;
}) {
  const header = Buffer.from(
    JSON.stringify({ alg: "EdDSA", typ: RELAY_ENVIRONMENT_DPOP_ACCESS_ASSERTION_TYP }),
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      iss: "pathway-env:environment-1",
      aud: "https://relay.example.test",
      sub: "environment-1",
      jti: `relay-access-${input.jkt}`,
      iat: 0,
      exp: 600,
      environmentId: "environment-1",
      jkt: input.jkt,
    }),
  ).toString("base64url");
  const signature = NodeCrypto.sign(
    null,
    Buffer.from(`${header}.${payload}`),
    NodeCrypto.createPrivateKey(input.privateKey ?? convexEnvironmentKeyPair.privateKey),
  ).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

function environmentDpopTokenPayload(assertion: string): RelayEnvironmentDpopAccessTokenRequest {
  return {
    grant_type: RelayDpopTokenExchangeGrantType,
    subject_token: assertion,
    subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
    requested_token_type: RelayAccessTokenType,
    resource: "https://relay.example.test",
    scope: RelayEnvironmentConnectScope,
    client_id: RelayEnvironmentClientId,
  };
}

function environmentExchangeTestLayer(input: {
  readonly activePublicKeys: ReadonlyArray<string>;
  readonly consumedProofs: Set<string>;
}) {
  const settings: RelayConfiguration.RelayConfiguration["Service"] = {
    ...relaySettings,
    cloudMintPrivateKey: Redacted.make(environmentAccessMintKeyPair.privateKey),
    cloudMintPublicKey: environmentAccessMintKeyPair.publicKey,
  };
  const fakeClient = RelayDb.RelayConvexClient.of({
    query: () => Effect.die("unused query"),
    mutation: (_reference: unknown, args: unknown) =>
      Effect.sync(() => {
        const values = args as { readonly thumbprint: string; readonly jti: string };
        const key = `${values.thumbprint}:${values.jti}`;
        if (input.consumedProofs.has(key)) return false;
        input.consumedProofs.add(key);
        return true;
      }),
  } as unknown as RelayDb.RelayConvexClient["Service"]);
  const environmentLinks = EnvironmentLinks.EnvironmentLinks.of({
    upsert: () => Effect.die("unused upsert"),
    listUsersForEnvironment: () => Effect.die("unused listUsersForEnvironment"),
    listDeliveryUsersForEnvironment: () => Effect.die("unused listDeliveryUsersForEnvironment"),
    listPublicKeysForEnvironment: () => Effect.succeed(input.activePublicKeys),
    listForUser: () => Effect.die("unused listForUser"),
    getForUser: () => Effect.die("unused getForUser"),
    revokeForUser: () => Effect.die("unused revokeForUser"),
  });
  const configLayer = RelayConfiguration.layer(settings);
  return Layer.mergeAll(
    configLayer,
    RelayTokens.layer.pipe(Layer.provide(configLayer)),
    DpopProofs.layer.pipe(Layer.provide(Layer.succeed(RelayDb.RelayConvexClient, fakeClient))),
    Layer.succeed(EnvironmentLinks.EnvironmentLinks, environmentLinks),
    Layer.succeed(
      Crypto.Crypto,
      Crypto.make({
        randomBytes: (size) => new Uint8Array(size),
        digest: (_algorithm, data) => Effect.succeed(data),
      }),
    ),
  );
}

function environmentExchangeRequest(proof: string) {
  return HttpServerRequest.fromWeb(
    new Request(environmentDpopTokenUrl, {
      method: "POST",
      headers: { dpop: proof, host: "relay.example.test" },
    }),
  );
}

describe("relay environment DPoP access token exchange", () => {
  it.effect("issues a DPoP-bound environment token with exactly environment connect scope", () => {
    const consumedProofs = new Set<string>();
    const proof = makeEnvironmentExchangeDpopProof("environment-exchange-proof-1");
    return Effect.gen(function* () {
      const response = yield* exchangeEnvironmentDpopAccessToken(
        environmentDpopTokenPayload(signEnvironmentAccessAssertion({ jkt: proof.thumbprint })),
      );

      expect(response).toMatchObject({
        issued_token_type: RelayAccessTokenType,
        token_type: "DPoP",
        scope: "environment:connect",
      });
      expect(decodeRelayJwt(response.access_token)).toMatchObject({
        sub: "environment-1",
        client_id: "pathway-env",
        subject_kind: "environment",
        scope: "environment:connect",
        cnf: { jkt: proof.thumbprint },
      });
      expect(consumedProofs.size).toBe(1);
    }).pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        environmentExchangeRequest(proof.proof),
      ),
      Effect.provide(
        environmentExchangeTestLayer({
          activePublicKeys: [convexEnvironmentKeyPair.publicKey],
          consumedProofs,
        }),
      ),
    );
  });

  it.effect("uniformly refuses an unlinked or revoked environment", () => {
    const consumedProofs = new Set<string>();
    const proof = makeEnvironmentExchangeDpopProof("environment-exchange-proof-unlinked");
    return Effect.gen(function* () {
      const error = yield* Effect.flip(
        exchangeEnvironmentDpopAccessToken(
          environmentDpopTokenPayload(signEnvironmentAccessAssertion({ jkt: proof.thumbprint })),
        ),
      );
      expect(error).toMatchObject({ _tag: "RelayAuthInvalidError", reason: "invalid_bearer" });
      expect(consumedProofs.size).toBe(0);
    }).pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        environmentExchangeRequest(proof.proof),
      ),
      Effect.provide(environmentExchangeTestLayer({ activePublicKeys: [], consumedProofs })),
    );
  });

  it.effect("refuses an assertion signed by a key outside the active link record", () => {
    const consumedProofs = new Set<string>();
    const proof = makeEnvironmentExchangeDpopProof("environment-exchange-proof-wrong-key");
    const wrongKey = NodeCrypto.generateKeyPairSync("ed25519", {
      privateKeyEncoding: { format: "pem", type: "pkcs8" },
      publicKeyEncoding: { format: "pem", type: "spki" },
    });
    return Effect.gen(function* () {
      const error = yield* Effect.flip(
        exchangeEnvironmentDpopAccessToken(
          environmentDpopTokenPayload(
            signEnvironmentAccessAssertion({
              jkt: proof.thumbprint,
              privateKey: wrongKey.privateKey,
            }),
          ),
        ),
      );
      expect(error).toMatchObject({ _tag: "RelayAuthInvalidError", reason: "invalid_bearer" });
      expect(consumedProofs.size).toBe(0);
    }).pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        environmentExchangeRequest(proof.proof),
      ),
      Effect.provide(
        environmentExchangeTestLayer({
          activePublicKeys: [convexEnvironmentKeyPair.publicKey],
          consumedProofs,
        }),
      ),
    );
  });

  it.effect("refuses a replayed environment exchange DPoP proof", () => {
    const consumedProofs = new Set<string>();
    const proof = makeEnvironmentExchangeDpopProof("environment-exchange-proof-replayed");
    const payload = environmentDpopTokenPayload(
      signEnvironmentAccessAssertion({ jkt: proof.thumbprint }),
    );
    return Effect.gen(function* () {
      yield* exchangeEnvironmentDpopAccessToken(payload);
      const error = yield* Effect.flip(exchangeEnvironmentDpopAccessToken(payload));
      expect(Predicate.isTagged(error, "Unauthorized")).toBe(true);
      expect(consumedProofs.size).toBe(1);
    }).pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        environmentExchangeRequest(proof.proof),
      ),
      Effect.provide(
        environmentExchangeTestLayer({
          activePublicKeys: [convexEnvironmentKeyPair.publicKey],
          consumedProofs,
        }),
      ),
    );
  });
});

describe("relay request tracing", () => {
  it.effect(
    "does not parent endpoint spans to an ambient parent captured while building handlers",
    () =>
      Effect.gen(function* () {
        const spans: Array<Tracer.NativeSpan> = [];
        const tracer = Tracer.make({
          span: (options) => {
            const span = new Tracer.NativeSpan(options);
            spans.push(span);
            return span;
          },
        });
        const ambientParent = Tracer.externalSpan({
          traceId: "00000000000000000000000000000001",
          spanId: "0000000000000001",
          sampled: true,
        });
        const endpoint = yield* withoutCapturedParentSpan(
          Effect.context<never>().pipe(
            Effect.map((capturedContext: Context.Context<never>) =>
              Effect.succeed(HttpServerResponse.empty({ status: 204 })).pipe(
                Effect.withSpan("relay.test.endpoint"),
                Effect.provideContext(capturedContext),
              ),
            ),
          ),
        ).pipe(Effect.provideService(Tracer.ParentSpan, ambientParent));
        const request = HttpServerRequest.fromWeb(
          new Request("https://relay.test/v1/mobile/devices?client=mobile", {
            method: "POST",
            headers: {
              authorization: "Bearer secret",
              dpop: "signed-proof",
            },
          }),
        );

        yield* traceRelayHttpRequestWith(endpoint, Layer.succeed(Tracer.Tracer, tracer)).pipe(
          Effect.provideService(HttpServerRequest.HttpServerRequest, request),
        );

        expect(spans.map((span) => span.name)).toEqual(["http.server POST", "relay.test.endpoint"]);
        expect(spans[0]?.kind).toBe("server");
        expect(spans[0]?.attributes.get("url.path")).toBe("/v1/mobile/devices");
        expect(spans[0]?.attributes.get("http.response.status_code")).toBe(204);
        expect(spans[0]?.attributes.get("http.request.header.authorization")).toBe("<redacted>");
        expect(spans[0]?.attributes.get("http.request.header.dpop")).toBe("<redacted>");
        expect(Option.isNone(spans[0]!.parent)).toBe(true);
        expect(Option.getOrUndefined(spans[1]!.parent)?.spanId).toBe(spans[0]?.spanId);
      }),
  );

  it.effect("fails hung requests with a 504 before the client's 10s abort", () =>
    Effect.gen(function* () {
      const spans: Array<Tracer.NativeSpan> = [];
      const tracer = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          spans.push(span);
          return span;
        },
      });
      const request = HttpServerRequest.fromWeb(
        new Request("https://relay.test/v1/mobile/devices", { method: "POST" }),
      );

      const fiber = yield* traceRelayHttpRequestWith(
        Effect.never,
        Layer.succeed(Tracer.Tracer, tracer),
      ).pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, request), Effect.forkChild);
      yield* TestClock.adjust(Duration.millis(RELAY_REQUEST_DEADLINE_MS));
      const response = yield* Fiber.join(fiber);

      expect(response.status).toBe(504);
      expect(spans[0]?.attributes.get("relay.request.deadline_exceeded")).toBe(true);
      expect(spans[0]?.attributes.get("http.response.status_code")).toBe(504);
    }),
  );
});

describe("relay routing fallback", () => {
  it("builds browser preflight responses without the relay runtime", () => {
    const response = HttpServerResponse.toWeb(relayCorsPreflightResponse());

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("access-control-allow-headers")).toBe(
      "authorization,b3,traceparent,content-type,dpop",
    );
    expect(response.headers.get("access-control-allow-methods")).toBe("GET, POST, DELETE, OPTIONS");
    expect(response.headers.get("access-control-max-age")).toBe("86400");
  });

  it.effect("redirects the relay root to the API docs", () =>
    Effect.gen(function* () {
      const httpEffect = yield* HttpRouter.toHttpEffect(
        Layer.mergeAll(relayDocsRedirectRoute, relayNotFoundRoute, relayCors),
      );
      const response = yield* Effect.promise(() =>
        HttpEffect.toWebHandler(httpEffect)(new Request("https://relay.test/")),
      );

      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/docs");
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
    }).pipe(Effect.scoped),
  );

  it.effect("returns a CORS-compatible 404 response for unmatched paths", () =>
    Effect.gen(function* () {
      const httpEffect = yield* HttpRouter.toHttpEffect(Layer.merge(relayNotFoundRoute, relayCors));
      const response = yield* Effect.promise(() =>
        HttpEffect.toWebHandler(httpEffect)(
          new Request("https://relay.test/v1/environmentsd", { method: "GET" }),
        ),
      );

      expect(response.status).toBe(404);
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
    }).pipe(Effect.scoped),
  );
});
