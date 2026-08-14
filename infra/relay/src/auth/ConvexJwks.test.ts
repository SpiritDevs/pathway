import * as NodeCrypto from "node:crypto";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

import * as RelayConfiguration from "../Config.ts";
import * as ConvexJwks from "./ConvexJwks.ts";

const current = NodeCrypto.generateKeyPairSync("ec", {
  namedCurve: "P-256",
  privateKeyEncoding: { format: "pem", type: "pkcs8" },
  publicKeyEncoding: { format: "pem", type: "spki" },
});
const previous = NodeCrypto.generateKeyPairSync("ec", {
  namedCurve: "P-256",
  privateKeyEncoding: { format: "pem", type: "pkcs8" },
  publicKeyEncoding: { format: "pem", type: "spki" },
});

const config = RelayConfiguration.RelayConfiguration.of({
  relayIssuer: "https://relay.example.test",
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
  cloudMintPrivateKey: Redacted.make("legacy-private-key"),
  cloudMintPublicKey: "legacy-public-key",
  managedEndpointBaseDomain: undefined,
  managedEndpointNamespace: undefined,
  cloudSync: {
    serviceTokensEnabled: true,
    convexUrl: "https://convex.example.test",
    signingKey: {
      keyId: "pathway-convex-current",
      privateKey: Redacted.make(current.privateKey),
      publicKey: current.publicKey,
    },
    verificationKeys: [
      { keyId: "pathway-convex-current", publicKey: current.publicKey },
      { keyId: "pathway-convex-previous", publicKey: previous.publicKey },
    ],
    connectGrantIssuer: undefined,
    connectGrantPublicKey: undefined,
  },
});

describe("ConvexJwks", () => {
  it.effect("publishes current and overlap keys without private material", () =>
    Effect.gen(function* () {
      const jwks = yield* ConvexJwks.ConvexJwks;
      expect(jwks.keys.map((key) => key.kid)).toEqual([
        "pathway-convex-current",
        "pathway-convex-previous",
      ]);
      for (const key of jwks.keys) {
        expect(key).toMatchObject({ alg: "ES256", crv: "P-256", kty: "EC", use: "sig" });
        expect(key).not.toHaveProperty("d");
      }
    }).pipe(Effect.provide(ConvexJwks.layer.pipe(Layer.provide(RelayConfiguration.layer(config))))),
  );
});
