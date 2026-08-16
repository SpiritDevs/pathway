import * as NodeCrypto from "node:crypto";
import { computeDpopJwkThumbprint, DpopPublicJwk } from "@spiritdevs/shared/dpop";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import type { DpopKeyPair } from "./convexServiceToken.ts";

const CLOUD_LINK_KEY_PAIR = "cloud-link-ed25519-key-pair";
const CLOUD_LINK_PRIVATE_KEY = "cloud-link-ed25519-private-key";
const CLOUD_LINK_PUBLIC_KEY = "cloud-link-ed25519-public-key";
const CLOUD_SYNC_DPOP_KEY_PAIR = "cloud-sync-dpop-key-pair";

const EnvironmentKeyPair = Schema.Struct({
  privateKey: Schema.String,
  publicKey: Schema.String,
});
type EnvironmentKeyPair = typeof EnvironmentKeyPair.Type;

const EnvironmentKeyPairJson = Schema.fromJsonString(EnvironmentKeyPair);
const decodeEnvironmentKeyPair = Schema.decodeUnknownEffect(EnvironmentKeyPairJson);
const encodeEnvironmentKeyPair = Schema.encodeEffect(EnvironmentKeyPairJson);

const PersistedDpopKeyPair = Schema.Struct({
  privateKey: Schema.String,
  publicJwk: DpopPublicJwk,
});
const PersistedDpopKeyPairJson = Schema.fromJsonString(PersistedDpopKeyPair);
const decodePersistedDpopKeyPair = Schema.decodeUnknownEffect(PersistedDpopKeyPairJson);
const encodePersistedDpopKeyPair = Schema.encodeEffect(PersistedDpopKeyPairJson);

function bytesToString(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function stringToBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

const KEY_PAIR_RESOURCE = "environment signing key pair";
const DPOP_KEY_PAIR_RESOURCE = "cloud sync proof key pair";

const keyPairDecodeError = (cause: unknown): ServerSecretStore.SecretStoreDecodeError =>
  new ServerSecretStore.SecretStoreDecodeError({ resource: KEY_PAIR_RESOURCE, cause });

const keyPairEncodeError = (cause: unknown): ServerSecretStore.SecretStoreEncodeError =>
  new ServerSecretStore.SecretStoreEncodeError({ resource: KEY_PAIR_RESOURCE, cause });

const keyPairConcurrentReadError = (): ServerSecretStore.SecretStoreConcurrentReadError =>
  new ServerSecretStore.SecretStoreConcurrentReadError({ resource: KEY_PAIR_RESOURCE });

const dpopKeyPairDecodeError = (cause: unknown): ServerSecretStore.SecretStoreDecodeError =>
  new ServerSecretStore.SecretStoreDecodeError({ resource: DPOP_KEY_PAIR_RESOURCE, cause });

const dpopKeyPairEncodeError = (cause: unknown): ServerSecretStore.SecretStoreEncodeError =>
  new ServerSecretStore.SecretStoreEncodeError({ resource: DPOP_KEY_PAIR_RESOURCE, cause });

const dpopKeyPairConcurrentReadError = (): ServerSecretStore.SecretStoreConcurrentReadError =>
  new ServerSecretStore.SecretStoreConcurrentReadError({ resource: DPOP_KEY_PAIR_RESOURCE });

const readEnvironmentKeyPair = Effect.fn("readEnvironmentKeyPair")(function* (
  secrets: ServerSecretStore.ServerSecretStore["Service"],
) {
  const encoded = yield* secrets.get(CLOUD_LINK_KEY_PAIR);
  if (Option.isNone(encoded)) {
    return Option.none<EnvironmentKeyPair>();
  }
  const decoded = yield* decodeEnvironmentKeyPair(bytesToString(encoded.value)).pipe(
    Effect.mapError(keyPairDecodeError),
  );
  return Option.some(decoded);
});

const persistEnvironmentKeyPair = Effect.fn("persistEnvironmentKeyPair")(function* (
  secrets: ServerSecretStore.ServerSecretStore["Service"],
  keyPair: EnvironmentKeyPair,
) {
  const encoded = yield* encodeEnvironmentKeyPair(keyPair).pipe(
    Effect.mapError(keyPairEncodeError),
  );
  return yield* secrets.create(CLOUD_LINK_KEY_PAIR, stringToBytes(encoded)).pipe(
    Effect.as(keyPair),
    Effect.catchIf(ServerSecretStore.isSecretStoreError, (error) =>
      ServerSecretStore.isSecretAlreadyExistsError(error)
        ? readEnvironmentKeyPair(secrets).pipe(
            Effect.flatMap(
              Option.match({
                onSome: Effect.succeed,
                onNone: () => Effect.fail(keyPairConcurrentReadError()),
              }),
            ),
          )
        : Effect.fail(error),
    ),
  );
});

export const getOrCreateEnvironmentKeyPairFromSecretStore = Effect.fn(function* (
  secrets: ServerSecretStore.ServerSecretStore["Service"],
) {
  const existing = yield* readEnvironmentKeyPair(secrets);
  if (Option.isSome(existing)) {
    return existing.value;
  }

  const existingPrivate = yield* secrets.get(CLOUD_LINK_PRIVATE_KEY);
  const existingPublic = yield* secrets.get(CLOUD_LINK_PUBLIC_KEY);
  if (Option.isSome(existingPrivate) && Option.isSome(existingPublic)) {
    return yield* persistEnvironmentKeyPair(secrets, {
      privateKey: bytesToString(existingPrivate.value),
      publicKey: bytesToString(existingPublic.value),
    });
  }

  const keyPair = NodeCrypto.generateKeyPairSync("ed25519", {
    privateKeyEncoding: { format: "pem", type: "pkcs8" },
    publicKeyEncoding: { format: "pem", type: "spki" },
  });
  return yield* persistEnvironmentKeyPair(secrets, {
    privateKey: keyPair.privateKey,
    publicKey: keyPair.publicKey,
  });
});

function hydratedDpopKeyPair(value: typeof PersistedDpopKeyPair.Type): DpopKeyPair {
  const privateKey = NodeCrypto.createPrivateKey(value.privateKey);
  const publicJwk = NodeCrypto.createPublicKey(privateKey).export({ format: "jwk" });
  if (
    publicJwk.kty !== value.publicJwk.kty ||
    publicJwk.crv !== value.publicJwk.crv ||
    publicJwk.x !== value.publicJwk.x ||
    publicJwk.y !== value.publicJwk.y
  ) {
    throw new Error("The persisted cloud sync proof key does not match its public JWK.");
  }
  return {
    privateKey,
    publicJwk: value.publicJwk,
    thumbprint: computeDpopJwkThumbprint(value.publicJwk),
  };
}

const readCloudSyncDpopKeyPair = Effect.fn("readCloudSyncDpopKeyPair")(function* (
  secrets: ServerSecretStore.ServerSecretStore["Service"],
) {
  const encoded = yield* secrets.get(CLOUD_SYNC_DPOP_KEY_PAIR);
  if (Option.isNone(encoded)) return Option.none<DpopKeyPair>();
  const persisted = yield* decodePersistedDpopKeyPair(bytesToString(encoded.value)).pipe(
    Effect.mapError(dpopKeyPairDecodeError),
  );
  const keyPair = yield* Effect.try({
    try: () => hydratedDpopKeyPair(persisted),
    catch: dpopKeyPairDecodeError,
  });
  return Option.some(keyPair);
});

const persistCloudSyncDpopKeyPair = Effect.fn("persistCloudSyncDpopKeyPair")(function* (
  secrets: ServerSecretStore.ServerSecretStore["Service"],
  keyPair: DpopKeyPair,
) {
  const privateKey = keyPair.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const encoded = yield* encodePersistedDpopKeyPair({
    privateKey,
    publicJwk: keyPair.publicJwk,
  }).pipe(Effect.mapError(dpopKeyPairEncodeError));
  return yield* secrets.create(CLOUD_SYNC_DPOP_KEY_PAIR, stringToBytes(encoded)).pipe(
    Effect.as(keyPair),
    Effect.catchIf(ServerSecretStore.isSecretStoreError, (error) =>
      ServerSecretStore.isSecretAlreadyExistsError(error)
        ? readCloudSyncDpopKeyPair(secrets).pipe(
            Effect.flatMap(
              Option.match({
                onSome: Effect.succeed,
                onNone: () => Effect.fail(dpopKeyPairConcurrentReadError()),
              }),
            ),
          )
        : Effect.fail(error),
    ),
  );
});

/** The stable proof identity named by this environment's Convex registration. */
export const getOrCreateCloudSyncDpopKeyPairFromSecretStore = Effect.fn(
  "getOrCreateCloudSyncDpopKeyPairFromSecretStore",
)(function* (secrets: ServerSecretStore.ServerSecretStore["Service"]) {
  const existing = yield* readCloudSyncDpopKeyPair(secrets);
  if (Option.isSome(existing)) return existing.value;

  const { privateKey, publicKey } = NodeCrypto.generateKeyPairSync("ec", {
    namedCurve: "P-256",
  });
  const exported = publicKey.export({ format: "jwk" });
  const publicJwk = {
    kty: "EC" as const,
    crv: "P-256" as const,
    x: String(exported.x),
    y: String(exported.y),
  };
  return yield* persistCloudSyncDpopKeyPair(secrets, {
    privateKey,
    publicJwk,
    thumbprint: computeDpopJwkThumbprint(publicJwk),
  });
});
