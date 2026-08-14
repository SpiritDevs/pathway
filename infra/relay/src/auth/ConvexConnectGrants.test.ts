import * as NodeCrypto from "node:crypto";

import { describe, expect, it } from "@effect/vitest";
import { RELAY_CONVEX_CONNECT_GRANT_TYP, signRelayJwt } from "@t3tools/shared/relayJwt";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

import * as RelayConfiguration from "../Config.ts";
import * as ConvexConnectGrants from "./ConvexConnectGrants.ts";

const relayKeyPair = NodeCrypto.generateKeyPairSync("ed25519", {
  privateKeyEncoding: { format: "pem", type: "pkcs8" },
  publicKeyEncoding: { format: "pem", type: "spki" },
});
const convexKeyPair = NodeCrypto.generateKeyPairSync("ed25519", {
  privateKeyEncoding: { format: "pem", type: "pkcs8" },
  publicKeyEncoding: { format: "pem", type: "spki" },
});
const attackerKeyPair = NodeCrypto.generateKeyPairSync("ed25519", {
  privateKeyEncoding: { format: "pem", type: "pkcs8" },
  publicKeyEncoding: { format: "pem", type: "spki" },
});

const CONVEX_ISSUER = "https://convex.example.test/";
const RELAY_ISSUER = "https://relay.example.test/";

const makeConfig = (cloudSync: RelayConfiguration.RelayCloudSyncConfiguration | undefined) =>
  RelayConfiguration.RelayConfiguration.of({
    relayIssuer: RELAY_ISSUER,
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
    cloudMintPrivateKey: Redacted.make(relayKeyPair.privateKey),
    cloudMintPublicKey: relayKeyPair.publicKey,
    managedEndpointBaseDomain: undefined,
    managedEndpointNamespace: undefined,
    cloudSync,
  });

const configuredLayer = ConvexConnectGrants.layer.pipe(
  Layer.provide(
    RelayConfiguration.layer(
      makeConfig({
        serviceTokensEnabled: true,
        connectGrantIssuer: CONVEX_ISSUER,
        connectGrantPublicKey: convexKeyPair.publicKey,
      }),
    ),
  ),
);

const unconfiguredLayer = ConvexConnectGrants.layer.pipe(
  Layer.provide(RelayConfiguration.layer(makeConfig(undefined))),
);

const signGrant = (input: {
  readonly privateKey?: string;
  readonly issuer?: string;
  readonly audience?: string;
  readonly environmentId?: string;
  readonly userId?: string;
  readonly permission?: string;
  readonly jti?: string;
  readonly issuedAtEpochSeconds?: number;
  readonly expiresAtEpochSeconds?: number;
}) =>
  signRelayJwt({
    privateKey: input.privateKey ?? convexKeyPair.privateKey,
    typ: RELAY_CONVEX_CONNECT_GRANT_TYP,
    payload: {
      iss: input.issuer ?? "https://convex.example.test",
      aud: input.audience ?? "https://relay.example.test",
      sub: input.userId ?? "user_123",
      jti: input.jti ?? "connect-grant-1",
      iat: input.issuedAtEpochSeconds ?? 100,
      exp: input.expiresAtEpochSeconds ?? 400,
      environmentId: input.environmentId ?? "environment-1",
      permission: input.permission ?? "environments.read",
    },
  });

const verifyDefaults = {
  environmentId: "environment-1",
  userId: "user_123",
  requiredPermission: "environments.read",
} as const;

describe("ConvexConnectGrants", () => {
  it.effect("reports itself disabled until an issuer and public key are configured", () =>
    Effect.gen(function* () {
      expect((yield* ConvexConnectGrants.ConvexConnectGrants).enabled).toBe(false);
    }).pipe(Effect.provide(unconfiguredLayer)),
  );

  it.effect("rejects every grant while the Convex issuer is unconfigured", () =>
    Effect.gen(function* () {
      const grants = yield* ConvexConnectGrants.ConvexConnectGrants;
      const grant = yield* signGrant({});

      expect(
        yield* grants.verifyConnectGrant({ ...verifyDefaults, grant, nowEpochSeconds: 200 }),
      ).toBeNull();
    }).pipe(Effect.provide(unconfiguredLayer)),
  );

  it.effect("accepts a valid grant from the configured Convex issuer", () =>
    Effect.gen(function* () {
      const grants = yield* ConvexConnectGrants.ConvexConnectGrants;
      expect(grants.enabled).toBe(true);
      const grant = yield* signGrant({});

      expect(
        yield* grants.verifyConnectGrant({ ...verifyDefaults, grant, nowEpochSeconds: 200 }),
      ).toMatchObject({
        sub: "user_123",
        jti: "connect-grant-1",
        environmentId: "environment-1",
        permission: "environments.read",
      });
    }).pipe(Effect.provide(configuredLayer)),
  );

  it.effect("rejects an expired grant", () =>
    Effect.gen(function* () {
      const grants = yield* ConvexConnectGrants.ConvexConnectGrants;
      const grant = yield* signGrant({});

      expect(
        yield* grants.verifyConnectGrant({ ...verifyDefaults, grant, nowEpochSeconds: 600 }),
      ).toBeNull();
    }).pipe(Effect.provide(configuredLayer)),
  );

  it.effect("rejects a grant hoarded past the maximum token age", () =>
    Effect.gen(function* () {
      const grants = yield* ConvexConnectGrants.ConvexConnectGrants;
      const grant = yield* signGrant({
        issuedAtEpochSeconds: 100,
        expiresAtEpochSeconds: 100_000,
      });

      expect(
        yield* grants.verifyConnectGrant({ ...verifyDefaults, grant, nowEpochSeconds: 5_000 }),
      ).toBeNull();
    }).pipe(Effect.provide(configuredLayer)),
  );

  it.effect("rejects a grant claiming a different issuer", () =>
    Effect.gen(function* () {
      const grants = yield* ConvexConnectGrants.ConvexConnectGrants;
      const grant = yield* signGrant({ issuer: "https://convex.attacker.test" });

      expect(
        yield* grants.verifyConnectGrant({ ...verifyDefaults, grant, nowEpochSeconds: 200 }),
      ).toBeNull();
    }).pipe(Effect.provide(configuredLayer)),
  );

  it.effect("rejects a grant signed by a key the configured issuer does not hold", () =>
    Effect.gen(function* () {
      const grants = yield* ConvexConnectGrants.ConvexConnectGrants;
      const grant = yield* signGrant({ privateKey: attackerKeyPair.privateKey });

      expect(
        yield* grants.verifyConnectGrant({ ...verifyDefaults, grant, nowEpochSeconds: 200 }),
      ).toBeNull();
    }).pipe(Effect.provide(configuredLayer)),
  );

  it.effect("rejects a grant addressed to another relay", () =>
    Effect.gen(function* () {
      const grants = yield* ConvexConnectGrants.ConvexConnectGrants;
      const grant = yield* signGrant({ audience: "https://relay.other.test" });

      expect(
        yield* grants.verifyConnectGrant({ ...verifyDefaults, grant, nowEpochSeconds: 200 }),
      ).toBeNull();
    }).pipe(Effect.provide(configuredLayer)),
  );

  it.effect("rejects a grant whose environment, user, or permission does not match", () =>
    Effect.gen(function* () {
      const grants = yield* ConvexConnectGrants.ConvexConnectGrants;
      const grant = yield* signGrant({});

      expect(
        yield* grants.verifyConnectGrant({
          ...verifyDefaults,
          environmentId: "environment-2",
          grant,
          nowEpochSeconds: 200,
        }),
      ).toBeNull();
      expect(
        yield* grants.verifyConnectGrant({
          ...verifyDefaults,
          userId: "user_attacker",
          grant,
          nowEpochSeconds: 200,
        }),
      ).toBeNull();
      expect(
        yield* grants.verifyConnectGrant({
          ...verifyDefaults,
          requiredPermission: "environments.manage",
          grant,
          nowEpochSeconds: 200,
        }),
      ).toBeNull();
    }).pipe(Effect.provide(configuredLayer)),
  );
});
