import * as NodeCrypto from "node:crypto";

import { describe, expect, it } from "@effect/vitest";
import {
  computeDpopAccessTokenHash,
  computeDpopJwkThumbprint,
  type DpopPublicJwk,
} from "@spiritdevs/shared/dpop";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { RelayConvexClient, RelayConvexClientError } from "../db.ts";
import * as DpopProofs from "./DpopProofs.ts";

interface ConsumedProof {
  readonly thumbprint: string;
  readonly jti: string;
  readonly iat: number;
  readonly expiresAt: string;
  readonly createdAt: string;
}

function makeDpopProof(input: {
  readonly method: string;
  readonly url: string;
  readonly iat: number;
  readonly jti: string;
  readonly accessToken?: string;
}) {
  const { privateKey, publicKey } = NodeCrypto.generateKeyPairSync("ec", {
    namedCurve: "P-256",
  });
  const publicJwk = publicKey.export({ format: "jwk" }) as DpopPublicJwk;
  const header = Buffer.from(
    JSON.stringify({ typ: "dpop+jwt", alg: "ES256", jwk: publicJwk }),
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      htm: input.method,
      htu: input.url,
      jti: input.jti,
      iat: input.iat,
      ...(input.accessToken ? { ath: computeDpopAccessTokenHash(input.accessToken) } : {}),
    }),
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

function layer(consume: (values: ConsumedProof) => Effect.Effect<boolean, RelayConvexClientError>) {
  const client = RelayConvexClient.of({
    query: () => Effect.die("unexpected query"),
    mutation: (_reference: unknown, args: unknown) => consume(args as ConsumedProof),
  } as unknown as RelayConvexClient["Service"]);
  return DpopProofs.layer.pipe(Layer.provide(Layer.succeed(RelayConvexClient, client)));
}

function consumeEachProofOnce() {
  const consumed = new Set<string>();
  return (values: ConsumedProof) =>
    Effect.sync(() => {
      const key = `${values.thumbprint}:${values.jti}`;
      if (consumed.has(key)) return false;
      consumed.add(key);
      return true;
    });
}

describe("DpopProofReplay.verifyAndConsume", () => {
  it.effect("rejects replayed proofs after Convex consumes the jti once", () => {
    const now = DateTime.makeUnsafe("2026-05-25T12:00:00.000Z");
    const url = "https://relay.example.com/v1/environments/env/connect";
    const proof = makeDpopProof({
      method: "POST",
      url,
      iat: Math.floor(now.epochMilliseconds / 1_000),
      jti: "proof-1",
    });
    return Effect.gen(function* () {
      const replay = yield* DpopProofs.DpopProofReplay;
      expect(
        yield* replay.verifyAndConsume({
          proof: proof.proof,
          method: "POST",
          url,
          expectedThumbprint: proof.thumbprint,
          now,
        }),
      ).toBe(proof.thumbprint);
      expect(
        (yield* Effect.exit(
          replay.verifyAndConsume({
            proof: proof.proof,
            method: "POST",
            url,
            expectedThumbprint: proof.thumbprint,
            now,
          }),
        ))._tag,
      ).toBe("Failure");
    }).pipe(Effect.provide(layer(consumeEachProofOnce())));
  });

  it.effect("rejects proofs missing the expected access-token hash before persistence", () => {
    const now = DateTime.makeUnsafe("2026-05-25T12:00:00.000Z");
    const url = "https://relay.example.com/v1/environments/env/connect";
    const proof = makeDpopProof({
      method: "POST",
      url,
      iat: Math.floor(now.epochMilliseconds / 1_000),
      jti: "proof-2",
    });
    return Effect.gen(function* () {
      const replay = yield* DpopProofs.DpopProofReplay;
      expect(
        (yield* Effect.exit(
          replay.verifyAndConsume({
            proof: proof.proof,
            method: "POST",
            url,
            expectedThumbprint: proof.thumbprint,
            expectedAccessToken: "clerk-access-token",
            now,
          }),
        ))._tag,
      ).toBe("Failure");
    }).pipe(Effect.provide(layer(() => Effect.die("unexpected DPoP replay persistence"))));
  });

  it.effect("preserves Convex replay persistence failures without exposing the proof", () => {
    const now = DateTime.makeUnsafe("2026-05-25T12:00:00.000Z");
    const url = "https://relay.example.com/v1/environments/env/connect";
    const proof = makeDpopProof({
      method: "POST",
      url,
      iat: Math.floor(now.epochMilliseconds / 1_000),
      jti: "proof-persistence-failure",
    });
    const cause = new RelayConvexClientError({
      operation: "mutation",
      cause: new Error("offline"),
    });
    return Effect.gen(function* () {
      const replay = yield* DpopProofs.DpopProofReplay;
      const error = yield* Effect.flip(
        replay.verifyAndConsume({
          proof: proof.proof,
          method: "POST",
          url,
          expectedThumbprint: proof.thumbprint,
          now,
        }),
      );
      expect(error).toMatchObject({
        _tag: "DpopProofReplayPersistenceError",
        operation: "consume",
        thumbprint: proof.thumbprint,
        jti: "proof-persistence-failure",
        cause,
      });
      expect(error).not.toHaveProperty("proof");
    }).pipe(Effect.provide(layer(() => Effect.fail(cause))));
  });

  it.effect("accepts proofs bound to the access-token hash", () => {
    const now = DateTime.makeUnsafe("2026-05-25T12:00:00.000Z");
    const url = "https://relay.example.com/v1/environments/env/status";
    const proof = makeDpopProof({
      method: "POST",
      url,
      iat: Math.floor(now.epochMilliseconds / 1_000),
      jti: "proof-status-1",
      accessToken: "clerk-access-token",
    });
    return Effect.gen(function* () {
      const replay = yield* DpopProofs.DpopProofReplay;
      expect(
        yield* replay.verifyAndConsume({
          proof: proof.proof,
          method: "POST",
          url,
          expectedAccessToken: "clerk-access-token",
          now,
        }),
      ).toBe(proof.thumbprint);
    }).pipe(Effect.provide(layer(consumeEachProofOnce())));
  });
});
