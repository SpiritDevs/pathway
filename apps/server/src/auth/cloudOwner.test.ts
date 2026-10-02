// @effect-diagnostics nodeBuiltinImport:off -- the fixture signs tokens with a node:crypto RSA key
import * as NodeCrypto from "node:crypto";

import { describe, expect, it } from "vite-plus/test";

import { verifyClerkSessionToken } from "./cloudOwner.ts";

const ISSUER = "https://clerk.example.test";
const NOW = 1_800_000_000;

const keyPair = NodeCrypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const otherKeyPair = NodeCrypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwks = { keys: [{ ...keyPair.publicKey.export({ format: "jwk" }), kid: "key-1" }] };

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

function signToken(
  claims: Record<string, unknown>,
  options: { readonly kid?: string; readonly key?: NodeCrypto.KeyObject } = {},
) {
  const signingInput = `${encode({ alg: "RS256", kid: options.kid ?? "key-1" })}.${encode(claims)}`;
  const signature = NodeCrypto.sign(
    "RSA-SHA256",
    Buffer.from(signingInput),
    options.key ?? keyPair.privateKey,
  ).toString("base64url");
  return `${signingInput}.${signature}`;
}

const validClaims = { iss: ISSUER, sub: "user_owner", exp: NOW + 60, nbf: NOW - 10 };
const verify = (token: string) =>
  verifyClerkSessionToken({ token, issuer: ISSUER, jwks, nowEpochSeconds: NOW });

describe("verifyClerkSessionToken", () => {
  it("returns the user a valid session token names", () => {
    expect(verify(signToken(validClaims))).toBe("user_owner");
  });

  it("rejects tokens from another Clerk instance", () => {
    expect(verify(signToken({ ...validClaims, iss: "https://other.example.test" }))).toBeNull();
  });

  it("rejects expired and not-yet-valid tokens", () => {
    expect(verify(signToken({ ...validClaims, exp: NOW - 60 }))).toBeNull();
    expect(verify(signToken({ ...validClaims, nbf: NOW + 60 }))).toBeNull();
  });

  it("rejects tokens signed by a key the JWKS does not hold", () => {
    expect(verify(signToken(validClaims, { key: otherKeyPair.privateKey }))).toBeNull();
    expect(verify(signToken(validClaims, { kid: "key-2" }))).toBeNull();
  });

  it("rejects malformed and tampered tokens", () => {
    expect(verify("not-a-token")).toBeNull();
    const [header, , signature] = signToken(validClaims).split(".");
    const forgedClaims = encode({ ...validClaims, sub: "user_intruder" });
    expect(verify(`${header}.${forgedClaims}.${signature}`)).toBeNull();
  });
});
