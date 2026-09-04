// @effect-diagnostics nodeBuiltinImport:off -- the state-file round-trip tests exercise the harness's plain sync node:fs helpers against a real tmpdir
/**
 * CI unit tests for the pure pieces of the Convex sync smoke harness. The
 * signed artifacts are checked against the same verifiers the relay runs
 * (`verifyRelayJwt`, `verifyDpopProof`), so a proof that passes here is one the
 * deployed relay would accept modulo nonces and clocks.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { parseIssueLabelCreateArgs } from "@spiritdevs/backend/sync/issueOps";
import { SYNC_PROTOCOL_VERSION, SyncBootstrapRequest } from "@spiritdevs/contracts/cloudSync";
import {
  RELAY_CONVEX_KEY_BINDING_TYP,
  RelayConvexKeyBindingPayload,
  RelayEnvironmentLinkProofPayload,
} from "@spiritdevs/contracts/relay";
import { verifyDpopProof } from "@spiritdevs/shared/dpop";
import { normalizeDpopHtu } from "@spiritdevs/shared/dpopCommon";
import { RELAY_LINK_PROOF_TYP, signRelayJwt, verifyRelayJwt } from "@spiritdevs/shared/relayJwt";
import { ConvexError } from "convex/values";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  buildKeyBindingPayload,
  buildLinkProofPayload,
  buildSmokeSyncOperation,
  checkBootstrapSnapshotVersions,
  checkConvexServiceTokenClaims,
  checkInterleavedWriteDelivery,
  convexErrorCode,
  generateDpopKeyPair,
  generateEnvironmentLinkKeyPair,
  latestSyncChange,
  listSmokeStateFiles,
  makeSmokeEnvironmentId,
  manualCleanupInstructions,
  overallOk,
  parseSmokeRunStateFile,
  partitionSmokeRecoveryTargets,
  relayAuthErrorReason,
  removeSmokeRunStateFile,
  renderConvexSyncSmokeReport,
  signDpopProof,
  SMOKE_BOOTSTRAP_MAX_PAGES,
  SMOKE_BOOTSTRAP_PAGE_SIZE,
  SMOKE_INTERLEAVED_LABEL_CREATE_ARGS,
  SMOKE_LABEL_CREATE_ARGS,
  SMOKE_LABEL_ENTITY_KIND,
  smokeDescriptor,
  smokeStateFilePath,
  smokeSyncClientId,
  syncChangesFor,
  verifyServiceTokenSignature,
  writeSmokeRunStateFile,
  type SmokeRunStateFile,
  type SyncChangeSummary,
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
        issuer: `pathway-env:${environmentId}`,
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
          issuer: `pathway-env:${environmentId}`,
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
        issuer: `pathway-env:${environmentId}`,
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
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pathway-smoke-state-"));
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
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates the directory on write and lists a missing one as empty", () => {
    const parent = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pathway-smoke-state-"));
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
      NodeFS.rmSync(parent, { recursive: true, force: true });
    }
  });

  it("skips foreign and unparseable files instead of failing the listing", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pathway-smoke-state-"));
    try {
      writeSmokeRunStateFile(dir, state("env-smoke-ddd"));
      NodeFS.writeFileSync(NodePath.join(dir, "notes.txt"), "not a state file", "utf8");
      NodeFS.writeFileSync(NodePath.join(dir, "env-smoke-broken.json"), "{nope", "utf8");
      NodeFS.writeFileSync(
        NodePath.join(dir, "env-smoke-partial.json"),
        JSON.stringify({ environmentId: "env-smoke-partial" }),
        "utf8",
      );
      assert.deepEqual([...listSmokeStateFiles(dir)], [state("env-smoke-ddd")]);
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
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

  it("recovers only the leftovers recorded against this run's relay and deployment", () => {
    const mine = state("env-smoke-mine");
    const otherDeployment = { ...state("env-smoke-other-deployment"), deployment: "dev:other" };
    const otherRelay = {
      ...state("env-smoke-other-relay"),
      relayBaseUrl: "https://relay.other.example",
    };
    const sameRun = state("env-smoke-current");

    const targets = partitionSmokeRecoveryTargets({
      states: [sameRun, mine, otherDeployment, otherRelay],
      environmentId: "env-smoke-current",
      // A trailing slash is the same relay: recovery must not be refused over spelling.
      relayBaseUrl: "https://relay.example/",
      deployment: "dev:chatty-ermine-52",
    });

    // The run's own marker belongs to the cleanup still to come, and the two runs recorded
    // against another target must not be swept from here: the unlink would go to this run's
    // relay (which reports the unknown id as "already gone") and the cleanup hook to this run's
    // deployment, after which the only record of the real leftovers would be deleted.
    assert.deepEqual([...targets.recoverable], [mine]);
    assert.deepEqual([...targets.foreign], [otherDeployment, otherRelay]);
  });

  it("renders manual cleanup commands pinned to the run's deployment and relay", () => {
    const commands = manualCleanupInstructions({ ...state("env-smoke-fff"), stateDir: "/tmp/x" });
    assert.equal(
      commands.convex,
      `cd packages/backend && CONVEX_DEPLOYMENT=dev:chatty-ermine-52 npx convex run smoke:cleanup '{"environmentId":"env-smoke-fff"}'`,
    );
    assert.equal(
      commands.relay,
      "curl -X DELETE https://relay.example/v1/client/environment-links/env-smoke-fff -H 'Authorization: Bearer <pathway connect CLI access token>'",
    );
    assert.equal(commands.stateFile, smokeStateFilePath("/tmp/x", "env-smoke-fff"));
  });
});

describe("smoke domain operations", () => {
  it("builds an envelope whose attribution matches the smoke environment actor", () => {
    const environmentId = makeSmokeEnvironmentId();
    const operation = buildSmokeSyncOperation({
      operationId: "op-1",
      companyId: "00000000-0000-7000-8000-736d6f6b6501",
      environmentId,
      localSequence: 1,
      baseVersion: 7,
      kind: "issueLabel.create",
      entityId: "label-1",
      args: SMOKE_LABEL_CREATE_ARGS,
    });
    assert.equal(operation.protocolVersion, SYNC_PROTOCOL_VERSION);
    assert.equal(operation.operationId, "op-1");
    assert.equal(operation.companyId, "00000000-0000-7000-8000-736d6f6b6501");
    assert.equal(operation.clientId, smokeSyncClientId(environmentId));
    // The envelope's environmentId, actor, and clientId must all name the same
    // environment: Convex re-derives the actor from the token and refuses a
    // batch whose asserted attribution disagrees with it.
    assert.equal(operation.environmentId, environmentId);
    assert.deepEqual(operation.actor, { kind: "environment", environmentId });
    assert.equal(operation.localSequence, 1);
    assert.equal(operation.baseVersion, 7);
    assert.equal(operation.kind, "issueLabel.create");
    assert.equal(operation.entityId, "label-1");
    assert.strictEqual(operation.args, SMOKE_LABEL_CREATE_ARGS);
    assert.deepEqual([...operation.dependsOn], []);
  });

  it("uses label args the backend parser accepts as a company-scoped label", () => {
    // The exact decoder Convex runs before applying `issueLabel.create`.
    const parsed = parseIssueLabelCreateArgs(SMOKE_LABEL_CREATE_ARGS);
    assert.isTrue(parsed.ok);
    // No teamId: the label is company-scoped, so its feed rows carry an empty
    // team list and the write gates on company-scope `workflow.manage`.
    assert.notProperty(SMOKE_LABEL_CREATE_ARGS, "teamId");
    assert.equal(SMOKE_LABEL_ENTITY_KIND, "issueLabel");
  });

  it("uses the same accepted, company-scoped shape for the interleaved label", () => {
    // The mid-seed write goes through the same handler and the same permission
    // (`workflow.manage` at company scope) the seeded smoke role already grants,
    // so forcing the interleave needs no new role permission.
    const parsed = parseIssueLabelCreateArgs(SMOKE_INTERLEAVED_LABEL_CREATE_ARGS);
    assert.isTrue(parsed.ok);
    assert.notProperty(SMOKE_INTERLEAVED_LABEL_CREATE_ARGS, "teamId");
    // A distinct name so a row surviving a killed run says which write left it.
    assert.notEqual(SMOKE_INTERLEAVED_LABEL_CREATE_ARGS.name, SMOKE_LABEL_CREATE_ARGS.name);
  });
});

describe("smoke bootstrap paging", () => {
  const decodeBootstrapRequest = Schema.decodeUnknownSync(SyncBootstrapRequest);
  const request = (pageSize: unknown): unknown => ({
    companyId: "00000000-0000-7000-8000-736d6f6b6501",
    cursor: null,
    pageSize,
  });

  it("forces the smallest page size the contract allows, so one seed spans pages", () => {
    // `pageSize` is a positive int, so 1 is the floor: anything larger risks
    // finishing the smoke company's seed in a single page, which exercises
    // nothing about a write landing mid-seed.
    assert.equal(SMOKE_BOOTSTRAP_PAGE_SIZE, 1);
    const decoded = decodeBootstrapRequest(request(SMOKE_BOOTSTRAP_PAGE_SIZE));
    assert.equal(decoded.pageSize, SMOKE_BOOTSTRAP_PAGE_SIZE);
    assert.throws(() => decodeBootstrapRequest(request(SMOKE_BOOTSTRAP_PAGE_SIZE - 1)));
    assert.isAbove(SMOKE_BOOTSTRAP_MAX_PAGES, 1);
  });

  it("holds every page of a seed to the version its first page captured", () => {
    assert.isNull(
      checkBootstrapSnapshotVersions({ snapshotVersion: 41, laterPageVersions: [41, 41, 41] }),
    );
    assert.isNull(checkBootstrapSnapshotVersions({ snapshotVersion: 41, laterPageVersions: [] }));
    // A walk that re-captured the head per page resumes past the mid-seed
    // writes, so the drift must be named with the page it appeared on.
    const drift = checkBootstrapSnapshotVersions({
      snapshotVersion: 41,
      laterPageVersions: [41, 44],
    });
    assert.include(drift ?? "", "page 3");
    assert.include(drift ?? "", "44");
    assert.include(drift ?? "", "41");
  });
});

describe("checkInterleavedWriteDelivery", () => {
  const KIND = "issueLabel";
  const ID = "label-interleaved";
  const upsert = (version: number, entityId = ID): SyncChangeSummary => ({
    version,
    entityKind: KIND,
    entityId,
    changeKind: "upsert",
  });

  const check = (input: {
    readonly laterSnapshotEntities: readonly SyncChangeSummary[];
    readonly drainedChanges: readonly SyncChangeSummary[];
    readonly writeVersion?: number;
  }) =>
    checkInterleavedWriteDelivery({
      entityKind: KIND,
      entityId: ID,
      writeVersion: input.writeVersion ?? 12,
      snapshotVersion: 10,
      laterSnapshotEntities: input.laterSnapshotEntities,
      drainedChanges: input.drainedChanges,
    });

  it("accepts the drain-only delivery and the both-sides delivery alike", () => {
    // The walk had already passed the row's position when the write landed, so
    // only the drain from the snapshot version carries it.
    assert.isNull(check({ laterSnapshotEntities: [], drainedChanges: [upsert(12)] }));
    // The remaining pages still read the new row. Not a duplicate: the seed is
    // pinned to page one's head, so the drain re-delivers it with the same
    // stamp and the client folds both through one idempotent upsert.
    assert.isNull(check({ laterSnapshotEntities: [upsert(12)], drainedChanges: [upsert(12)] }));
    // Other entities on either side are none of this check's business.
    assert.isNull(
      check({
        laterSnapshotEntities: [upsert(4, "label-seeded")],
        drainedChanges: [upsert(12), upsert(13, "label-other")],
      }),
    );
  });

  it("fails when the write is lost between the seed pages and the drain", () => {
    const lost = check({ laterSnapshotEntities: [], drainedChanges: [] });
    assert.include(lost ?? "", "lost");
    assert.include(lost ?? "", ID);
  });

  it("fails when the drain resuming at the snapshot version misses the write", () => {
    // The one case a client cannot recover from: it finished the seed, resumed
    // at the seed's version, and the change past that version never arrived.
    const missed = check({ laterSnapshotEntities: [upsert(12)], drainedChanges: [] });
    assert.include(missed ?? "", "drain");
    assert.include(missed ?? "", "never learn of it");
  });

  it("fails on repeated deliveries within one side", () => {
    assert.include(
      check({ laterSnapshotEntities: [], drainedChanges: [upsert(12), upsert(12)] }) ?? "",
      "exactly once",
    );
    assert.include(
      check({ laterSnapshotEntities: [upsert(12), upsert(12)], drainedChanges: [upsert(12)] }) ??
        "",
      "at most once",
    );
  });

  it("fails when seed and feed disagree about the change's version or kind", () => {
    // Two different stamps for one change is a double-apply: the client folds
    // the seed page and the drain page as two separate changes.
    assert.include(
      check({ laterSnapshotEntities: [upsert(11)], drainedChanges: [upsert(12)] }) ?? "",
      "stamp one change once",
    );
    assert.include(
      check({
        laterSnapshotEntities: [],
        drainedChanges: [{ ...upsert(12), changeKind: "tombstone" }],
      }) ?? "",
      "expected the interleaved create's upsert",
    );
  });

  it("refuses to certify a write that did not land after the snapshot version", () => {
    const early = check({
      writeVersion: 10,
      laterSnapshotEntities: [],
      drainedChanges: [upsert(10)],
    });
    assert.include(early ?? "", "not past the seed's snapshot version");
  });
});

describe("syncChangesFor", () => {
  const changes: readonly SyncChangeSummary[] = [
    { version: 3, entityKind: "issueLabel", entityId: "a", changeKind: "upsert" },
    { version: 5, entityKind: "issueLabel", entityId: "a", changeKind: "tombstone" },
    { version: 4, entityKind: "issue", entityId: "a", changeKind: "upsert" },
  ];

  it("returns every delivery of one entity, in order", () => {
    assert.deepEqual(
      [...syncChangesFor(changes, "issueLabel", "a")].map((change) => change.version),
      [3, 5],
    );
    assert.deepEqual(
      [...syncChangesFor(changes, "issue", "a")].map((c) => c.version),
      [4],
    );
    assert.deepEqual([...syncChangesFor(changes, "issueLabel", "b")], []);
    assert.deepEqual([...syncChangesFor([], "issueLabel", "a")], []);
  });
});

describe("latestSyncChange", () => {
  const changes: readonly SyncChangeSummary[] = [
    { version: 3, entityKind: "issueLabel", entityId: "a", changeKind: "upsert" },
    { version: 5, entityKind: "issueLabel", entityId: "a", changeKind: "tombstone" },
    { version: 4, entityKind: "issue", entityId: "a", changeKind: "upsert" },
    { version: 6, entityKind: "issueLabel", entityId: "b", changeKind: "upsert" },
  ];

  it("returns the highest-versioned change for the entity, not the first", () => {
    // A drain spanning create and delete must report the tombstone.
    assert.deepEqual(latestSyncChange(changes, "issueLabel", "a"), {
      version: 5,
      entityKind: "issueLabel",
      entityId: "a",
      changeKind: "tombstone",
    });
    assert.equal(latestSyncChange(changes, "issueLabel", "b")?.version, 6);
  });

  it("matches on both entity kind and id", () => {
    assert.equal(latestSyncChange(changes, "issue", "a")?.version, 4);
    assert.isUndefined(latestSyncChange(changes, "issueStatus", "a"));
    assert.isUndefined(latestSyncChange(changes, "issueLabel", "missing"));
    assert.isUndefined(latestSyncChange([], "issueLabel", "a"));
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
