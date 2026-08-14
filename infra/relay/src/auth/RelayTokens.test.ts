import * as NodeCrypto from "node:crypto";

import { describe, expect, it } from "@effect/vitest";
import { decodeRelayJwt, signRelayJwt } from "@t3tools/shared/relayJwt";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

import * as RelayConfiguration from "../Config.ts";
import * as RelayTokens from "./RelayTokens.ts";

const keyPair = NodeCrypto.generateKeyPairSync("ed25519", {
  privateKeyEncoding: { format: "pem", type: "pkcs8" },
  publicKeyEncoding: { format: "pem", type: "spki" },
});

const config = RelayConfiguration.RelayConfiguration.of({
  relayIssuer: "https://relay.example.test/",
  apns: {
    environment: "sandbox",
    teamId: "team-id",
    keyId: "key-id",
    privateKey: Redacted.make("private-key"),
    bundleId: "com.t3tools.pathway.dev",
  },
  apnsDeliveryJobSigningSecret: Redacted.make("job-secret"),
  clerkSecretKey: Redacted.make("clerk-secret"),
  clerkPublishableKey: "pk_test_test",
  clerkJwtAudience: "t3-code-relay",
  cloudMintPrivateKey: Redacted.make(keyPair.privateKey),
  cloudMintPublicKey: keyPair.publicKey,
  managedEndpointBaseDomain: undefined,
  managedEndpointNamespace: undefined,
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
        userId: "user_123",
        proofKeyThumbprint: "proof-key-thumbprint",
        jti: "access-token-1",
        issuedAtEpochSeconds: 100,
        expiresAtEpochSeconds: 1_900,
        clientId: "t3-mobile",
        scopes: ["environment:connect", "environment:status", "mobile:registration"],
      });

      expect(
        yield* relayTokens.verifyDpopAccessToken({ token, nowEpochSeconds: 700 }),
      ).toMatchObject({
        sub: "user_123",
        cnf: { jkt: "proof-key-thumbprint" },
        client_id: "t3-mobile",
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
        userId: "user_123",
        proofKeyThumbprint: "web-proof-key-thumbprint",
        jti: "web-access-token-1",
        issuedAtEpochSeconds: 100,
        expiresAtEpochSeconds: 200,
        clientId: "t3-web",
        scopes: ["environment:connect", "environment:status"],
      });

      expect(
        yield* relayTokens.verifyDpopAccessToken({ token, nowEpochSeconds: 150 }),
      ).toMatchObject({
        client_id: "t3-web",
        scope: ["environment:connect", "environment:status"],
        cnf: { jkt: "web-proof-key-thumbprint" },
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("treats requested scope as an order-independent set", () =>
    Effect.gen(function* () {
      const relayTokens = yield* RelayTokens.RelayTokens;
      expect(
        relayTokens.resolveDpopAccessTokenScopes({
          clientId: "t3-mobile",
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
        typ: "t3-relay-dpop-access+jwt",
        payload: {
          iss: "https://relay.example.test",
          aud: "https://relay.example.test",
          sub: "user_123",
          jti: "access-token-invalid-scope",
          iat: 100,
          exp: 200,
          client_id: "t3-mobile",
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
        typ: "t3-relay-dpop-access+jwt",
        payload: {
          iss: "https://relay.example.test",
          aud: "https://relay.example.test",
          sub: "user_123",
          jti: "web-token-invalid-mobile-scope",
          iat: 100,
          exp: 200,
          client_id: "t3-web",
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
        typ: "t3-relay-convex-service+jwt",
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
      const token = yield* signRelayJwt({
        privateKey: keyPair.privateKey,
        typ: "t3-relay-convex-service+jwt",
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
});
