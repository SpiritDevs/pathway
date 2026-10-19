import * as NodeCrypto from "node:crypto";

import { describe, expect, it } from "@effect/vitest";
import { decodeRelayJwt, signRelayEs256Jwt, signRelayJwt } from "@spiritdevs/shared/relayJwt";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

import * as RelayConfiguration from "../Config.ts";
import * as RelayTokens from "./RelayTokens.ts";

const keyPair = NodeCrypto.generateKeyPairSync("ed25519", {
  privateKeyEncoding: { format: "pem", type: "pkcs8" },
  publicKeyEncoding: { format: "pem", type: "spki" },
});
const convexKeyPair = NodeCrypto.generateKeyPairSync("ec", {
  namedCurve: "P-256",
  privateKeyEncoding: { format: "pem", type: "pkcs8" },
  publicKeyEncoding: { format: "pem", type: "spki" },
});
const convexKeyId = "pathway-convex-test";

const config = RelayConfiguration.RelayConfiguration.of({
  relayIssuer: "https://relay.example.test/",
  apns: {
    environment: "sandbox",
    teamId: "team-id",
    keyId: "key-id",
    privateKey: Redacted.make("private-key"),
    bundleId: "com.spiritdevs.pathway.dev",
  },
  apnsDeliveryJobSigningSecret: Redacted.make("job-secret"),
  clerkSecretKey: Redacted.make("clerk-secret"),
  clerkPublishableKey: "pk_test_test",
  clerkJwtAudience: "pathway-relay",
  cloudMintPrivateKey: Redacted.make(keyPair.privateKey),
  cloudMintPublicKey: keyPair.publicKey,
  managedEndpointBaseDomain: undefined,
  managedEndpointNamespace: undefined,
  cloudSync: {
    serviceTokensEnabled: true,
    convexUrl: "https://convex.example.test",
    signingKey: {
      keyId: convexKeyId,
      privateKey: Redacted.make(convexKeyPair.privateKey),
      publicKey: convexKeyPair.publicKey,
    },
    verificationKeys: [{ keyId: convexKeyId, publicKey: convexKeyPair.publicKey }],
  },
});

const layer = RelayTokens.layer.pipe(Layer.provide(RelayConfiguration.layer(config)));

describe("RelayTokens", () => {
  it.effect("issues a user-bound environment link challenge", () =>
    Effect.gen(function* () {
      const relayTokens = yield* RelayTokens.RelayTokens;
      const token = yield* relayTokens.issueLinkChallenge({
        userId: "user_123",
        request: {
          notificationsEnabled: true,
          liveActivitiesEnabled: true,
          managedTunnelsEnabled: true,
        },
        jti: "challenge-1",
        issuedAtEpochSeconds: 100,
        expiresAtEpochSeconds: 200,
      });

      expect(
        yield* relayTokens.verifyLinkChallenge({
          token,
          userId: "user_123",
          request: {
            notificationsEnabled: true,
            liveActivitiesEnabled: true,
            managedTunnelsEnabled: true,
          },
          nowEpochSeconds: 150,
        }),
      ).toMatchObject({ sub: "user_123", jti: "challenge-1" });
      expect(
        yield* relayTokens.verifyLinkChallenge({
          token,
          userId: "attacker",
          request: {
            notificationsEnabled: true,
            liveActivitiesEnabled: true,
            managedTunnelsEnabled: true,
          },
          nowEpochSeconds: 150,
        }),
      ).toBeNull();
    }).pipe(Effect.provide(layer)),
  );

  it.effect("issues and verifies DPoP access tokens bound to one proof-key thumbprint", () =>
    Effect.gen(function* () {
      const relayTokens = yield* RelayTokens.RelayTokens;
      const token = yield* relayTokens.issueDpopAccessToken({
        subjectId: "user_123",
        subjectKind: "user",
        proofKeyThumbprint: "proof-key-thumbprint",
        jti: "access-token-1",
        issuedAtEpochSeconds: 100,
        expiresAtEpochSeconds: 1_900,
        clientId: "pathway-mobile",
        scopes: ["environment:connect", "environment:status", "mobile:registration"],
      });

      expect(
        yield* relayTokens.verifyDpopAccessToken({ token, nowEpochSeconds: 700 }),
      ).toMatchObject({
        sub: "user_123",
        cnf: { jkt: "proof-key-thumbprint" },
        client_id: "pathway-mobile",
        scope: ["environment:connect", "environment:status", "mobile:registration"],
      });
      expect(
        yield* relayTokens.verifyDpopAccessToken({ token, nowEpochSeconds: 1_961 }),
      ).toBeNull();
    }).pipe(Effect.provide(layer)),
  );

  it.effect("issues tunnel-only DPoP access tokens to web public clients", () =>
    Effect.gen(function* () {
      const relayTokens = yield* RelayTokens.RelayTokens;
      const token = yield* relayTokens.issueDpopAccessToken({
        subjectId: "user_123",
        subjectKind: "user",
        proofKeyThumbprint: "web-proof-key-thumbprint",
        jti: "web-access-token-1",
        issuedAtEpochSeconds: 100,
        expiresAtEpochSeconds: 200,
        clientId: "pathway-web",
        scopes: ["environment:connect", "environment:status"],
      });

      expect(
        yield* relayTokens.verifyDpopAccessToken({ token, nowEpochSeconds: 150 }),
      ).toMatchObject({
        client_id: "pathway-web",
        scope: ["environment:connect", "environment:status"],
        cnf: { jkt: "web-proof-key-thumbprint" },
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("issues environment-subject tokens with only environment connect authority", () =>
    Effect.gen(function* () {
      const relayTokens = yield* RelayTokens.RelayTokens;
      const token = yield* relayTokens.issueDpopAccessToken({
        subjectId: "environment-1",
        subjectKind: "environment",
        proofKeyThumbprint: "environment-proof-key-thumbprint",
        jti: "environment-access-token-1",
        issuedAtEpochSeconds: 100,
        expiresAtEpochSeconds: 200,
        clientId: "pathway-env",
        scopes: ["environment:connect"],
      });

      expect(
        yield* relayTokens.verifyDpopAccessToken({ token, nowEpochSeconds: 150 }),
      ).toMatchObject({
        sub: "environment-1",
        subject_kind: "environment",
        client_id: "pathway-env",
        scope: ["environment:connect"],
        cnf: { jkt: "environment-proof-key-thumbprint" },
      });
      expect(
        relayTokens.resolveDpopAccessTokenScopes({
          clientId: "pathway-env",
          scope: "environment:connect environment:status",
        }),
      ).toBeNull();
    }).pipe(Effect.provide(layer)),
  );

  it.effect("keeps the web and mobile scope allowlists unchanged", () =>
    Effect.gen(function* () {
      const relayTokens = yield* RelayTokens.RelayTokens;
      expect(
        relayTokens.resolveDpopAccessTokenScopes({
          clientId: "pathway-web",
          scope: "environment:connect environment:status",
        }),
      ).toEqual(["environment:connect", "environment:status"]);
      expect(
        relayTokens.resolveDpopAccessTokenScopes({
          clientId: "pathway-mobile",
          scope: "environment:connect environment:status mobile:registration",
        }),
      ).toEqual(["environment:connect", "environment:status", "mobile:registration"]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("treats requested scope as an order-independent set", () =>
    Effect.gen(function* () {
      const relayTokens = yield* RelayTokens.RelayTokens;
      expect(
        relayTokens.resolveDpopAccessTokenScopes({
          clientId: "pathway-mobile",
          scope: "environment:status environment:connect environment:status",
        }),
      ).toEqual(["environment:status", "environment:connect"]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("rejects signed DPoP tokens whose scope is outside the relay policy", () =>
    Effect.gen(function* () {
      const relayTokens = yield* RelayTokens.RelayTokens;
      const token = yield* signRelayJwt({
        privateKey: keyPair.privateKey,
        typ: "pathway-relay-dpop-access+jwt",
        payload: {
          iss: "https://relay.example.test",
          aud: "https://relay.example.test",
          sub: "user_123",
          jti: "access-token-invalid-scope",
          iat: 100,
          exp: 200,
          client_id: "pathway-mobile",
          scope: "environment:admin",
          cnf: { jkt: "proof-key-thumbprint" },
        },
      });

      expect(yield* relayTokens.verifyDpopAccessToken({ token, nowEpochSeconds: 150 })).toBeNull();
    }).pipe(Effect.provide(layer)),
  );

  it.effect("rejects mobile registration scope on a web public client token", () =>
    Effect.gen(function* () {
      const relayTokens = yield* RelayTokens.RelayTokens;
      const token = yield* signRelayJwt({
        privateKey: keyPair.privateKey,
        typ: "pathway-relay-dpop-access+jwt",
        payload: {
          iss: "https://relay.example.test",
          aud: "https://relay.example.test",
          sub: "user_123",
          jti: "web-token-invalid-mobile-scope",
          iat: 100,
          exp: 200,
          client_id: "pathway-web",
          scope: "environment:connect mobile:registration",
          cnf: { jkt: "proof-key-thumbprint" },
        },
      });

      expect(yield* relayTokens.verifyDpopAccessToken({ token, nowEpochSeconds: 150 })).toBeNull();
    }).pipe(Effect.provide(layer)),
  );

  it.effect("issues Convex-audience service tokens bound to an environment and proof key", () =>
    Effect.gen(function* () {
      const relayTokens = yield* RelayTokens.RelayTokens;
      const token = yield* relayTokens.issueConvexServiceToken({
        environmentId: "environment-1",
        proofKeyThumbprint: "environment-proof-key-thumbprint",
        jti: "convex-service-token-1",
        issuedAtEpochSeconds: 100,
        expiresAtEpochSeconds: 700,
      });

      expect(decodeRelayJwt(token)).toMatchObject({
        iss: "https://relay.example.test",
        aud: "pathway-convex",
        sub: "environment-1",
        jti: "convex-service-token-1",
        iat: 100,
        exp: 700,
        environmentId: "environment-1",
        cnf: { jkt: "environment-proof-key-thumbprint" },
      });
      expect(
        yield* relayTokens.verifyConvexServiceToken({ token, nowEpochSeconds: 300 }),
      ).toMatchObject({
        aud: "pathway-convex",
        environmentId: "environment-1",
        cnf: { jkt: "environment-proof-key-thumbprint" },
      });
      expect(
        yield* relayTokens.verifyConvexServiceToken({ token, nowEpochSeconds: 800 }),
      ).toBeNull();
    }).pipe(Effect.provide(layer)),
  );

  it.effect("rejects self-audienced relay tokens presented as Convex service tokens", () =>
    Effect.gen(function* () {
      const relayTokens = yield* RelayTokens.RelayTokens;
      const token = yield* signRelayJwt({
        privateKey: keyPair.privateKey,
        typ: "pathway-relay-convex-service+jwt",
        payload: {
          iss: "https://relay.example.test",
          aud: "https://relay.example.test",
          sub: "environment-1",
          jti: "convex-service-token-wrong-audience",
          iat: 100,
          exp: 700,
          environmentId: "environment-1",
          cnf: { jkt: "environment-proof-key-thumbprint" },
        },
      });

      expect(
        yield* relayTokens.verifyConvexServiceToken({ token, nowEpochSeconds: 300 }),
      ).toBeNull();
    }).pipe(Effect.provide(layer)),
  );

  it.effect("rejects Convex service tokens whose subject is not the environment", () =>
    Effect.gen(function* () {
      const relayTokens = yield* RelayTokens.RelayTokens;
      const token = yield* signRelayEs256Jwt({
        privateKey: convexKeyPair.privateKey,
        keyId: convexKeyId,
        typ: "pathway-relay-convex-service+jwt",
        payload: {
          iss: "https://relay.example.test",
          aud: "pathway-convex",
          sub: "environment-2",
          jti: "convex-service-token-subject-mismatch",
          iat: 100,
          exp: 700,
          environmentId: "environment-1",
          cnf: { jkt: "environment-proof-key-thumbprint" },
        },
      });

      expect(
        yield* relayTokens.verifyConvexServiceToken({ token, nowEpochSeconds: 300 }),
      ).toBeNull();
    }).pipe(Effect.provide(layer)),
  );

  it.effect("issues a distinct short-lived control-plane identity for relay persistence", () =>
    Effect.gen(function* () {
      const relayTokens = yield* RelayTokens.RelayTokens;
      const token = yield* relayTokens.issueConvexControlPlaneToken({
        jti: "relay-control-token-1",
        issuedAtEpochSeconds: 100,
        expiresAtEpochSeconds: 220,
      });

      expect(decodeRelayJwt(token)).toMatchObject({
        iss: "https://relay.example.test",
        aud: "pathway-convex",
        sub: "pathway-relay",
        tokenKind: "relay-control-plane",
        jti: "relay-control-token-1",
      });
      expect(
        yield* relayTokens.verifyConvexControlPlaneToken({ token, nowEpochSeconds: 150 }),
      ).toMatchObject({ sub: "pathway-relay", tokenKind: "relay-control-plane" });
      expect(
        yield* relayTokens.verifyConvexControlPlaneToken({ token, nowEpochSeconds: 400 }),
      ).toBeNull();
    }).pipe(Effect.provide(layer)),
  );
});
