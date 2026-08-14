import * as NodeCrypto from "node:crypto";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { decodeProtectedHeader } from "jose";

import {
  relayEs256PublicJwk,
  RelayJwtError,
  signRelayEs256Jwt,
  signRelayJwt,
  verifyRelayEs256Jwt,
  verifyRelayJwt,
} from "./relayJwt.ts";

describe("relayJwt", () => {
  it.effect("preserves signing context and the JOSE cause", () =>
    Effect.gen(function* () {
      const error = yield* signRelayJwt({
        privateKey: "not-a-private-key",
        typ: "test-sign+jwt",
        payload: { sub: "subject" },
      }).pipe(Effect.flip);

      expect(error.operation).toBe("sign");
      expect(error.typ).toBe("test-sign+jwt");
      expect(error.cause).toBeInstanceOf(Error);
      expect(error.message).toBe('Failed to sign relay JWT of type "test-sign+jwt".');
    }),
  );

  it.effect("preserves verification request context and the JOSE cause", () =>
    Effect.gen(function* () {
      const keyPair = NodeCrypto.generateKeyPairSync("ed25519", {
        publicKeyEncoding: { format: "pem", type: "spki" },
        privateKeyEncoding: { format: "pem", type: "pkcs8" },
      });
      const error = yield* verifyRelayJwt({
        publicKey: keyPair.publicKey,
        token: "not-a-jwt",
        typ: "test-verify+jwt",
        issuer: "https://issuer.example.test",
        audience: "test-audience",
        nowEpochSeconds: 100,
      }).pipe(Effect.flip);

      expect(error.operation).toBe("verify");
      expect(error.typ).toBe("test-verify+jwt");
      expect(error.issuer).toBe("https://issuer.example.test");
      expect(error.audience).toBe("test-audience");
      expect(error.cause).toBeInstanceOf(Error);
      expect(error.message).toBe('Failed to verify relay JWT of type "test-verify+jwt".');
    }),
  );

  it("extracts stable diagnostic codes without copying cause text into the error message", () => {
    const error = new RelayJwtError({
      operation: "verify",
      typ: "test+jwt",
      cause: { code: "ERR_JWT_EXPIRED", message: "sensitive library detail" },
    });

    expect(RelayJwtError.diagnosticCode(error)).toBe("ERR_JWT_EXPIRED");
    expect(error.message).not.toContain("sensitive library detail");
  });

  it.effect("signs ES256 JWTs with a stable kid and exports a public-only JWK", () =>
    Effect.gen(function* () {
      const keyPair = NodeCrypto.generateKeyPairSync("ec", {
        namedCurve: "P-256",
        publicKeyEncoding: { format: "pem", type: "spki" },
        privateKeyEncoding: { format: "pem", type: "pkcs8" },
      });
      const token = yield* signRelayEs256Jwt({
        privateKey: keyPair.privateKey,
        keyId: "pathway-convex-test",
        typ: "test-es256+jwt",
        payload: {
          iss: "https://relay.example.test",
          aud: "pathway-convex",
          sub: "pathway-relay",
          iat: 100,
          exp: 200,
        },
      });
      expect(decodeProtectedHeader(token)).toMatchObject({
        alg: "ES256",
        kid: "pathway-convex-test",
        typ: "test-es256+jwt",
      });
      expect(
        yield* verifyRelayEs256Jwt({
          publicKeys: [{ keyId: "pathway-convex-test", publicKey: keyPair.publicKey }],
          token,
          typ: "test-es256+jwt",
          issuer: "https://relay.example.test",
          audience: "pathway-convex",
          nowEpochSeconds: 150,
        }),
      ).toMatchObject({ sub: "pathway-relay" });

      const jwk = yield* relayEs256PublicJwk({
        keyId: "pathway-convex-test",
        publicKey: keyPair.publicKey,
      });
      expect(jwk).toMatchObject({
        alg: "ES256",
        crv: "P-256",
        kid: "pathway-convex-test",
        kty: "EC",
        use: "sig",
      });
      expect(jwk).not.toHaveProperty("d");
    }),
  );
});
