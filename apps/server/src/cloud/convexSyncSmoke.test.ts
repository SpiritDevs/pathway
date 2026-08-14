// @effect-diagnostics nodeBuiltinImport:off -- the state-file round-trip tests exercise the harness's plain sync node:fs helpers against a real tmpdir
/**
 * CI unit tests for the pure pieces of the Convex sync smoke harness. The
 * signed artifacts are checked against the same verifiers the relay runs
 * (`verifyRelayJwt`, `verifyDpopProof`), so a proof that passes here is one the
 * deployed relay would accept modulo nonces and clocks.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import {
  RELAY_CONVEX_KEY_BINDING_TYP,
  RelayConvexKeyBindingPayload,
  RelayEnvironmentLinkProofPayload,
} from "@t3tools/contracts/relay";
import { verifyDpopProof } from "@t3tools/shared/dpop";
import { normalizeDpopHtu } from "@t3tools/shared/dpopCommon";
import { RELAY_LINK_PROOF_TYP, signRelayJwt, verifyRelayJwt } from "@t3tools/shared/relayJwt";
import { ConvexError } from "convex/values";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  buildKeyBindingPayload,
  buildLinkProofPayload,
  checkConvexServiceTokenClaims,
  convexErrorCode,
  generateDpopKeyPair,
  generateEnvironmentLinkKeyPair,
  listSmokeStateFiles,
  makeSmokeEnvironmentId,
  manualCleanupInstructions,
  overallOk,
  parseSmokeRunStateFile,
  relayAuthErrorReason,
  removeSmokeRunStateFile,
  renderConvexSyncSmokeReport,
  signDpopProof,
  smokeDescriptor,
  smokeStateFilePath,
  verifyServiceTokenSignature,
  writeSmokeRunStateFile,
  type SmokeRunStateFile,
} from "./convexSyncSmoke.ts";

const NOW = 1_700_000_000;
const RELAY_ISSUER = "https://relay.example";

function encodeSegment(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

const ES256_HEADER = { alg: "ES256", kid: "relay-convex-1", typ: "JWT" } as const;

function unsignedJwt(
  payload: Record<string, unknown>,
  header: Record<string, unknown> = ES256_HEADER,
): string {
  return `${encodeSegment(header)}.${encodeSegment(payload)}.${Buffer.from("sig").toString(
    "base64url",
  )}`;
}

describe("convexSyncSmoke link proof", () => {
  it.effect("signs a payload the relay's link verification accepts", () =>
    Effect.gen(function* () {
      const environmentId = makeSmokeEnvironmentId();
      const keys = generateEnvironmentLinkKeyPair();
      // Trailing slash on the issuer must be normalized away in `aud`.
      const payload = buildLinkProofPayload({
        environmentId,
        relayIssuer: `${RELAY_ISSUER}/`,
        challenge: "challenge-token",
        environmentPublicKey: keys.publicKey,
        jti: "link-jti-1",
        nowEpochSeconds: NOW,
      });
      const proof = yield* signRelayJwt({
        privateKey: keys.privateKey,
        typ: RELAY_LINK_PROOF_TYP,
        payload,
      });
      // The relay verifies with the public key embedded in the proof itself.
      const verified = yield* verifyRelayJwt({
        publicKey: payload.environmentPublicKey,
        token: proof,
        typ: RELAY_LINK_PROOF_TYP,
        issuer: `t3-env:${environmentId}`,
        audience: RELAY_ISSUER,
        nowEpochSeconds: NOW + 5,
      });
      const decoded = yield* Schema.decodeUnknownEffect(RelayEnvironmentLinkProofPayload)(verified);
      assert.equal(decoded.sub, decoded.environmentId);
      assert.equal(decoded.environmentId, environmentId);
      assert.equal(decoded.descriptor.environmentId, environmentId);
      assert.equal(decoded.challenge, "challenge-token");
      assert.deepEqual([...decoded.scopes], []);
      assert.equal(decoded.endpoint.providerKind, "manual");
      assert.isAbove(decoded.exp, NOW);
    }),
  );

  it.effect("is rejected when verified against a different key", () =>
    Effect.gen(function* () {
      const environmentId = makeSmokeEnvironmentId();
      const keys = generateEnvironmentLinkKeyPair();
      const otherKeys = generateEnvironmentLinkKeyPair();
      const payload = buildLinkProofPayload({
        environmentId,
        relayIssuer: RELAY_ISSUER,
        challenge: "challenge-token",
        environmentPublicKey: keys.publicKey,
        jti: "link-jti-2",
        nowEpochSeconds: NOW,
      });
      const proof = yield* signRelayJwt({
        privateKey: keys.privateKey,
        typ: RELAY_LINK_PROOF_TYP,
        payload,
      });
      const result = yield* Effect.exit(
        verifyRelayJwt({
          publicKey: otherKeys.publicKey,
          token: proof,
          typ: RELAY_LINK_PROOF_TYP,
          issuer: `t3-env:${environmentId}`,
          audience: RELAY_ISSUER,
          nowEpochSeconds: NOW + 5,
        }),
      );
      assert.isTrue(result._tag === "Failure");
    }),
  );

  it("builds a minimal publish-only descriptor", () => {
    const environmentId = makeSmokeEnvironmentId();
    const descriptor = smokeDescriptor(environmentId);
    assert.equal(descriptor.environmentId, environmentId);
    assert.deepEqual(descriptor.platform, { os: "unknown", arch: "other" });
    assert.deepEqual(descriptor.capabilities, { repositoryIdentity: false });
  });
});

describe("convexSyncSmoke key binding", () => {
  it.effect("signs a binding the relay verifies with the link public key", () =>
    Effect.gen(function* () {
      const environmentId = makeSmokeEnvironmentId();
      const linkKeys = generateEnvironmentLinkKeyPair();
      const dpopKeys = generateDpopKeyPair();
      const payload = buildKeyBindingPayload({
        environmentId,
        relayIssuer: RELAY_ISSUER,
        jkt: dpopKeys.thumbprint,
        jti: "binding-jti-1",
        nowEpochSeconds: NOW,
      });
      const binding = yield* signRelayJwt({
        privateKey: linkKeys.privateKey,
        typ: RELAY_CONVEX_KEY_BINDING_TYP,
        payload,
      });
      const verified = yield* verifyRelayJwt({
        publicKey: linkKeys.publicKey,
        token: binding,
        typ: RELAY_CONVEX_KEY_BINDING_TYP,
        issuer: `t3-env:${environmentId}`,
        audience: RELAY_ISSUER,
        nowEpochSeconds: NOW + 5,
      });
      const decoded = yield* Schema.decodeUnknownEffect(RelayConvexKeyBindingPayload)(verified);
      assert.equal(decoded.sub, decoded.environmentId);
      assert.equal(decoded.environmentId, environmentId);
      assert.equal(decoded.jkt, dpopKeys.thumbprint);
    }),
  );
});

describe("convexSyncSmoke dpop proof", () => {
  const url = normalizeDpopHtu("https://relay.example/v1/environment/convex-token?ignored=1");
  assert.isNotNull(url);

  it("produces a proof verifyDpopProof accepts for the bound thumbprint", () => {
    const keys = generateDpopKeyPair();
    const proof = signDpopProof({
      privateKey: keys.privateKey,
      publicJwk: keys.publicJwk,
      method: "POST",
      url: url ?? "",
      jti: "dpop-jti-1",
      iatEpochSeconds: NOW,
    });
    const result = verifyDpopProof({
      proof,
      method: "POST",
      url: "https://relay.example/v1/environment/convex-token",
      nowEpochSeconds: NOW + 1,
      expectedThumbprint: keys.thumbprint,
    });
    assert.isTrue(result.ok);
    if (result.ok) {
      assert.equal(result.thumbprint, keys.thumbprint);
      assert.equal(result.jti, "dpop-jti-1");
    }
  });

  it("is rejected when the expected thumbprint belongs to a different key", () => {
    const keys = generateDpopKeyPair();
    const otherKeys = generateDpopKeyPair();
    const proof = signDpopProof({
      privateKey: keys.privateKey,
      publicJwk: keys.publicJwk,
      method: "POST",
      url: url ?? "",
      jti: "dpop-jti-2",
      iatEpochSeconds: NOW,
    });
    const result = verifyDpopProof({
      proof,
      method: "POST",
      url: "https://relay.example/v1/environment/convex-token",
      nowEpochSeconds: NOW + 1,
      expectedThumbprint: otherKeys.thumbprint,
    });
    assert.isFalse(result.ok);
  });
});

describe("checkConvexServiceTokenClaims", () => {
  const environmentId = makeSmokeEnvironmentId();

  const validClaims = (): Record<string, unknown> => ({
    iss: RELAY_ISSUER,
    aud: "pathway-convex",
    sub: environmentId,
    environmentId,
    jti: "service-jti-1",
    iat: NOW - 5,
    exp: NOW + 595,
    cnf: { jkt: "expected-thumbprint" },
  });

  const check = (token: string) =>
    checkConvexServiceTokenClaims({
      token,
      environmentId,
      expectedJkt: "expected-thumbprint",
      expectedIssuer: `${RELAY_ISSUER}/`, // trailing slash must normalize away
      expiresInSeconds: 600,
      nowEpochSeconds: NOW,
    });

  it("accepts a well-formed ES256 token whose header and claims all hold", () => {
    assert.isNull(check(unsignedJwt(validClaims())));
  });

  it("rejects a header that is not ES256-with-kid", () => {
    assert.include(check(unsignedJwt(validClaims(), { alg: "EdDSA", typ: "JWT" })), "alg");
    assert.include(check(unsignedJwt(validClaims(), { alg: "ES256", typ: "JWT" })), "kid");
    assert.include(check("not-a-jwt"), "header");
  });

  it("names the first mismatching claim", () => {
    assert.include(check(unsignedJwt({ ...validClaims(), iss: "https://evil.example" })), "iss");
    assert.include(check(unsignedJwt({ ...validClaims(), aud: "somewhere-else" })), "aud");
    assert.include(check(unsignedJwt({ ...validClaims(), sub: "someone-else" })), "sub");
    assert.include(check(unsignedJwt({ ...validClaims(), jti: undefined })), "jti");
    assert.include(
      check(unsignedJwt({ ...validClaims(), cnf: { jkt: "other-thumbprint" } })),
      "cnf.jkt",
    );
  });

  it("rejects an insane lifetime", () => {
    assert.include(check(unsignedJwt({ ...validClaims(), iat: "soon", exp: "later" })), "iat/exp");
    assert.include(check(unsignedJwt({ ...validClaims(), exp: NOW - 6 })), "not after iat");
    // Lifetime beyond expires_in (600s) plus the 60s skew allowance.
    assert.include(check(unsignedJwt({ ...validClaims(), exp: NOW - 5 + 661 })), "lifetime");
    assert.include(
      check(unsignedJwt({ ...validClaims(), iat: NOW + 120, exp: NOW + 700 })),
      "future",
    );
    assert.include(
      check(unsignedJwt({ ...validClaims(), iat: NOW - 500, exp: NOW - 100 })),
      "expired",
    );
  });
});

describe("verifyServiceTokenSignature", () => {
  const { privateKey, publicKey } = NodeCrypto.generateKeyPairSync("ec", {
    namedCurve: "P-256",
  });
  const jwk = {
    ...publicKey.export({ format: "jwk" }),
    alg: "ES256",
    kid: "relay-convex-1",
    use: "sig",
  };
  const jwks = { keys: [jwk] };

  function es256Jwt(key: NodeCrypto.KeyObject): string {
    const header = encodeSegment(ES256_HEADER);
    const payload = encodeSegment({ sub: "env-smoke-x" });
    const signature = NodeCrypto.sign("sha256", Buffer.from(`${header}.${payload}`), {
      key,
      dsaEncoding: "ieee-p1363",
    }).toString("base64url");
    return `${header}.${payload}.${signature}`;
  }

  it("accepts a token signed by the JWKS key its kid names", () => {
    assert.isNull(verifyServiceTokenSignature({ token: es256Jwt(privateKey), jwks }));
  });

  it("rejects a token signed by a different key", () => {
    const other = NodeCrypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
    assert.include(
      verifyServiceTokenSignature({ token: es256Jwt(other.privateKey), jwks }),
      "does not verify",
    );
  });

  it("rejects a kid the JWKS does not serve, and a malformed JWKS document", () => {
    assert.include(
      verifyServiceTokenSignature({ token: es256Jwt(privateKey), jwks: { keys: [] } }),
      "no key with kid",
    );
    assert.include(
      verifyServiceTokenSignature({ token: es256Jwt(privateKey), jwks: { nope: true } }),
      "keys",
    );
    assert.include(verifyServiceTokenSignature({ token: "junk", jwks }), "JWT");
  });
});

describe("relayAuthErrorReason", () => {
  it("extracts the reason from an auth_invalid error body", () => {
    const body = JSON.stringify({
      _tag: "RelayAuthInvalidError",
      code: "auth_invalid",
      reason: "invalid_dpop",
      traceId: "trace-1",
    });
    assert.equal(relayAuthErrorReason(body), "invalid_dpop");
  });

  it("returns null for other error bodies and non-JSON", () => {
    assert.isNull(
      relayAuthErrorReason(
        JSON.stringify({ code: "internal_error", reason: "persistence_failed" }),
      ),
    );
    assert.isNull(relayAuthErrorReason(JSON.stringify({ code: "auth_invalid", reason: 7 })));
    assert.isNull(relayAuthErrorReason("<html>gateway timeout</html>"));
    assert.isNull(relayAuthErrorReason(""));
  });
});

describe("smoke run state files", () => {
  const state = (environmentId: string): SmokeRunStateFile => ({
    environmentId,
    relayBaseUrl: "https://relay.example",
    deployment: "dev:chatty-ermine-52",
    companyId: "00000000-0000-7000-8000-736d6f6b6501",
  });

  it("round-trips through write, list, and remove", () => {
    const dir = NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "pathway-smoke-state-"));
    try {
      writeSmokeRunStateFile(dir, state("env-smoke-aaa"));
      writeSmokeRunStateFile(dir, state("env-smoke-bbb"));
      const listed = [...listSmokeStateFiles(dir)].sort((a, b) =>
        a.environmentId.localeCompare(b.environmentId),
      );
      assert.deepEqual(listed, [state("env-smoke-aaa"), state("env-smoke-bbb")]);
      removeSmokeRunStateFile(dir, "env-smoke-aaa");
      assert.deepEqual([...listSmokeStateFiles(dir)], [state("env-smoke-bbb")]);
      // Removing something already gone converges silently.
      removeSmokeRunStateFile(dir, "env-smoke-aaa");
    } finally {
      NodeFs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates the directory on write and lists a missing one as empty", () => {
    const parent = NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "pathway-smoke-state-"));
    const dir = NodePath.join(parent, "nested", "state");
    try {
      assert.deepEqual([...listSmokeStateFiles(dir)], []);
      writeSmokeRunStateFile(dir, state("env-smoke-ccc"));
      assert.deepEqual([...listSmokeStateFiles(dir)], [state("env-smoke-ccc")]);
      assert.equal(
        smokeStateFilePath(dir, "env-smoke-ccc"),
        NodePath.join(dir, "env-smoke-ccc.json"),
      );
    } finally {
      NodeFs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it("skips foreign and unparseable files instead of failing the listing", () => {
    const dir = NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "pathway-smoke-state-"));
    try {
      writeSmokeRunStateFile(dir, state("env-smoke-ddd"));
      NodeFs.writeFileSync(NodePath.join(dir, "notes.txt"), "not a state file", "utf8");
      NodeFs.writeFileSync(NodePath.join(dir, "env-smoke-broken.json"), "{nope", "utf8");
      NodeFs.writeFileSync(
        NodePath.join(dir, "env-smoke-partial.json"),
        JSON.stringify({ environmentId: "env-smoke-partial" }),
        "utf8",
      );
      assert.deepEqual([...listSmokeStateFiles(dir)], [state("env-smoke-ddd")]);
    } finally {
      NodeFs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("parses only complete env-smoke state shapes", () => {
    assert.deepEqual(
      parseSmokeRunStateFile(JSON.stringify(state("env-smoke-eee"))),
      state("env-smoke-eee"),
    );
    assert.isNull(parseSmokeRunStateFile(JSON.stringify(state("env-other"))));
    assert.isNull(parseSmokeRunStateFile(JSON.stringify({ environmentId: "env-smoke-x" })));
    assert.isNull(parseSmokeRunStateFile("[]"));
    assert.isNull(parseSmokeRunStateFile("not json"));
  });

  it("renders manual cleanup commands pinned to the run's deployment and relay", () => {
    const commands = manualCleanupInstructions({ ...state("env-smoke-fff"), stateDir: "/tmp/x" });
    assert.equal(
      commands.convex,
      `cd packages/backend && CONVEX_DEPLOYMENT=dev:chatty-ermine-52 npx convex run smoke:cleanup '{"environmentId":"env-smoke-fff"}'`,
    );
    assert.equal(
      commands.relay,
      "curl -X DELETE https://relay.example/v1/client/environment-links/env-smoke-fff -H 'Authorization: Bearer <t3 connect CLI access token>'",
    );
    assert.equal(commands.stateFile, smokeStateFilePath("/tmp/x", "env-smoke-fff"));
  });
});

describe("convexErrorCode", () => {
  it("extracts the backend error code from a ConvexError", () => {
    const error = new ConvexError({ code: "environment-not-registered", message: "nope" });
    assert.equal(convexErrorCode(error), "environment-not-registered");
  });

  it("returns null for anything else", () => {
    assert.isNull(convexErrorCode(new Error("boom")));
    assert.isNull(convexErrorCode(new ConvexError("plain-string-data")));
    assert.isNull(convexErrorCode(undefined));
  });
});

describe("smoke report aggregation", () => {
  it("requires at least one step and every step green", () => {
    assert.isFalse(overallOk([]));
    assert.isTrue(overallOk([{ name: "a", ok: true, detail: "" }]));
    assert.isFalse(
      overallOk([
        { name: "a", ok: true, detail: "" },
        { name: "b", ok: false, detail: "boom" },
      ]),
    );
  });

  it("renders one line per step plus a summary verdict", () => {
    const rendered = renderConvexSyncSmokeReport({
      ok: false,
      steps: [
        { name: "cli.credential", ok: true, detail: "credential present" },
        { name: "relay.linkEnvironment", ok: false, detail: "boom" },
      ],
    });
    const lines = rendered.split("\n");
    assert.lengthOf(lines, 3);
    assert.include(lines[0], "PASS  cli.credential");
    assert.include(lines[1], "FAIL  relay.linkEnvironment — boom");
    assert.include(lines[2], "FAIL  convex sync smoke (1/2 steps ok)");
  });
});
