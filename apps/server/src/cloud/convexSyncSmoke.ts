// @effect-diagnostics nodeBuiltinImport:off -- the crash-recovery state files are tiny local sync reads/writes; plain node:fs/node:path keep those helpers pure functions unit-testable without a FileSystem layer
/**
 * Relay-flow smoke harness for Convex-backed cloud sync (Phase 1).
 *
 * `runConvexSyncSmoke` exercises the full trust chain against a REAL deployed
 * relay and Convex deployment: stored Pathway Connect CLI credential → link
 * challenge → publish-only environment link (fresh throwaway Ed25519 key) →
 * environment credential → DPoP + key-binding token exchange → `pathway-convex`
 * service token → authenticated Convex sync calls → negative cases → cleanup.
 *
 * Nothing here talks to the network at import time or in the pure helpers; the
 * pure pieces (payload construction, DPoP proof signing, claim checks, report
 * aggregation) are exported for CI unit tests that verify the signed artifacts
 * against the same verifiers the relay runs (`verifyRelayJwt`,
 * `verifyDpopProof`).
 *
 * Registration state inside Convex (`environmentRegistrations` rows) cannot be
 * managed through any public API, so the harness takes injected hooks; the
 * integrator wires them to `npx convex run` against the target deployment.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import { EnvironmentId, type ExecutionEnvironmentDescriptor } from "@spiritdevs/contracts";
import {
  RELAY_CONVEX_KEY_BINDING_TYP,
  RelayAccessTokenType,
  RelayConvexAudience,
  RelayConvexServiceTokenResponse,
  RelayDpopTokenExchangeGrantType,
  RelayEnvironmentCredentialTokenType,
  RelayEnvironmentLinkChallengeResponse,
  RelayEnvironmentLinkResponse,
  RelayOkResponse,
  type RelayConvexKeyBindingPayload,
  type RelayEnvironmentLinkProofPayload,
} from "@spiritdevs/contracts/relay";
import { computeDpopJwkThumbprint, type DpopPublicJwk } from "@spiritdevs/shared/dpop";
import { normalizeDpopHtu } from "@spiritdevs/shared/dpopCommon";
import {
  decodeRelayJwt,
  normalizeRelayIssuer,
  RELAY_LINK_PROOF_TYP,
  signRelayJwt,
} from "@spiritdevs/shared/relayJwt";
import { ConvexHttpClient } from "convex/browser";
import { ConvexError } from "convex/values";
import { api } from "@spiritdevs/backend/convexApi";
import { SMOKE_ENVIRONMENT_ID_PREFIX } from "@spiritdevs/backend/smokeSeed";
import { SYNC_PROTOCOL_VERSION } from "@spiritdevs/contracts/cloudSync";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import * as CliTokenManager from "./CliTokenManager.ts";

// --------------------------------------------------------------------------
// Errors
// --------------------------------------------------------------------------

/** A smoke step observed something other than what the trust chain promises. */
export class ConvexSyncSmokeError extends Schema.TaggedErrorClass<ConvexSyncSmokeError>()(
  "ConvexSyncSmokeError",
  {
    reason: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.reason;
  }
}

/** Failure raised by an integrator-provided registration hook. */
export class ConvexSyncSmokeHookError extends Schema.TaggedErrorClass<ConvexSyncSmokeHookError>()(
  "ConvexSyncSmokeHookError",
  {
    hook: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Convex sync smoke hook '${this.hook}' failed`;
  }
}

/** A Convex client call rejected; `cause` is whatever the client threw (usually a `ConvexError`). */
export class ConvexSyncSmokeConvexCallError extends Schema.TaggedErrorClass<ConvexSyncSmokeConvexCallError>()(
  "ConvexSyncSmokeConvexCallError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Convex call failed: ${String(this.cause)}`;
  }
}

// --------------------------------------------------------------------------
// Config and hooks
// --------------------------------------------------------------------------

/**
 * Registration state lives in Convex's `environmentRegistrations` table and has
 * no public management API, so the harness delegates to the integrator, who
 * wires these to `npx convex run` (or an admin client) against the target
 * deployment. The harness only decides *when* each transition happens.
 */
export interface ConvexSyncSmokeHooks {
  /** Create an active registration for the smoke environment bound to `thumbprint`. */
  readonly seedRegistration: (thumbprint: string) => Effect.Effect<void, ConvexSyncSmokeHookError>;
  /** Point the existing registration at a different proof-key thumbprint. */
  readonly setRegistrationThumbprint: (
    thumbprint: string,
  ) => Effect.Effect<void, ConvexSyncSmokeHookError>;
  /** Revoke (or delete) the registration so the environment is no longer registered. */
  readonly revokeRegistration: () => Effect.Effect<void, ConvexSyncSmokeHookError>;
  /** Remove any state `seedRegistration` created. Runs even when earlier steps fail. */
  readonly cleanupRegistration: () => Effect.Effect<void, ConvexSyncSmokeHookError>;
}

export interface ConvexSyncSmokeConfig {
  /** Base URL of the deployed relay, e.g. `https://relay.spiritdevs.com`. */
  readonly relayBaseUrl: string;
  /** Convex deployment URL the relay mints `pathway-convex` tokens for. */
  readonly convexUrl: string;
  /**
   * Convex deployment identifier the admin hooks are pinned to, e.g.
   * `dev:chatty-ermine-52`. Recorded in the recovery state file and in the
   * manual-cleanup instructions logged before the first mutation.
   */
  readonly deployment: string;
  /**
   * Directory recovery state files live in (see {@link defaultSmokeStateDir}).
   * A file is written before the first mutating request and removed only after
   * cleanup fully succeeds, so a SIGKILLed run leaves a marker the next run
   * (or an operator) recovers from.
   */
  readonly stateDir: string;
  /** Seeded company domain id the smoke registration belongs to. */
  readonly companyId: string;
  /** Throwaway environment id, e.g. from {@link makeSmokeEnvironmentId}. */
  readonly environmentId: EnvironmentId;
  readonly hooks: ConvexSyncSmokeHooks;
}

// --------------------------------------------------------------------------
// Step results and reporting (pure)
// --------------------------------------------------------------------------

export interface ConvexSyncSmokeStepResult {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface ConvexSyncSmokeReport {
  readonly ok: boolean;
  readonly steps: ReadonlyArray<ConvexSyncSmokeStepResult>;
}

export function overallOk(steps: ReadonlyArray<ConvexSyncSmokeStepResult>): boolean {
  return steps.length > 0 && steps.every((step) => step.ok);
}

export function renderConvexSyncSmokeReport(report: ConvexSyncSmokeReport): string {
  const lines = report.steps.map(
    (step) => `${step.ok ? "PASS" : "FAIL"}  ${step.name}${step.detail ? ` — ${step.detail}` : ""}`,
  );
  const passed = report.steps.filter((step) => step.ok).length;
  lines.push(
    `${report.ok ? "PASS" : "FAIL"}  convex sync smoke (${passed}/${report.steps.length} steps ok)`,
  );
  return lines.join("\n");
}

function truncateDetail(value: string, maxLength = 600): string {
  const collapsed = value.replaceAll(/\s+/gu, " ").trim();
  return collapsed.length <= maxLength ? collapsed : `${collapsed.slice(0, maxLength)}…`;
}

// --------------------------------------------------------------------------
// Pure construction helpers
// --------------------------------------------------------------------------

/**
 * Mints the throwaway environment id for a run. The prefix is the backend's
 * {@link SMOKE_ENVIRONMENT_ID_PREFIX} — `smoke:cleanup`'s orphan sweep keys on
 * it, so the two sides must always agree.
 */
export function makeSmokeEnvironmentId(): EnvironmentId {
  return EnvironmentId.make(`${SMOKE_ENVIRONMENT_ID_PREFIX}${NodeCrypto.randomUUID()}`);
}

/**
 * Publish-only links never route through their stored endpoint, so a nominal
 * unreachable endpoint is acceptable (and the relay only enforces
 * https/wss + loopback origin for managed tunnels).
 */
export const SMOKE_LINK_ENDPOINT = {
  httpBaseUrl: "https://convex-sync-smoke.invalid",
  wsBaseUrl: "wss://convex-sync-smoke.invalid",
  providerKind: "manual",
} as const;

export const SMOKE_LINK_ORIGIN = {
  localHttpHost: "127.0.0.1",
  localHttpPort: 8787,
} as const;

export function smokeDescriptor(environmentId: EnvironmentId): ExecutionEnvironmentDescriptor {
  return {
    environmentId,
    label: "convex-sync-smoke",
    platform: { os: "unknown", arch: "other" },
    serverVersion: "0.0.0-smoke",
    capabilities: { repositoryIdentity: false },
  };
}

export interface EnvironmentLinkKeyPair {
  /** PEM (pkcs8) Ed25519 private key. */
  readonly privateKey: string;
  /** PEM (spki) Ed25519 public key. */
  readonly publicKey: string;
}

export function generateEnvironmentLinkKeyPair(): EnvironmentLinkKeyPair {
  const keyPair = NodeCrypto.generateKeyPairSync("ed25519", {
    privateKeyEncoding: { format: "pem", type: "pkcs8" },
    publicKeyEncoding: { format: "pem", type: "spki" },
  });
  return { privateKey: keyPair.privateKey, publicKey: keyPair.publicKey };
}

export interface DpopKeyPair {
  readonly privateKey: NodeCrypto.KeyObject;
  readonly publicJwk: DpopPublicJwk;
  /** RFC 7638 thumbprint of the public JWK. */
  readonly thumbprint: string;
}

export function generateDpopKeyPair(): DpopKeyPair {
  const { privateKey, publicKey } = NodeCrypto.generateKeyPairSync("ec", {
    namedCurve: "P-256",
  });
  const exported = publicKey.export({ format: "jwk" });
  const publicJwk: DpopPublicJwk = {
    kty: "EC",
    crv: "P-256",
    x: String(exported.x),
    y: String(exported.y),
  };
  return { privateKey, publicJwk, thumbprint: computeDpopJwkThumbprint(publicJwk) };
}

/**
 * The exact payload `EnvironmentLinker.link` verifies: `iss`/`sub`/`environmentId`
 * agree, `descriptor.environmentId` matches, `aud` is the normalized relay
 * issuer, the challenge is echoed, and the (empty) scope list authorizes a
 * publish-only link with every capability flag false.
 */
export function buildLinkProofPayload(input: {
  readonly environmentId: EnvironmentId;
  readonly relayIssuer: string;
  readonly challenge: string;
  readonly environmentPublicKey: string;
  readonly jti: string;
  readonly nowEpochSeconds: number;
}): RelayEnvironmentLinkProofPayload {
  return {
    iss: `t3-env:${input.environmentId}`,
    aud: normalizeRelayIssuer(input.relayIssuer),
    sub: input.environmentId,
    jti: input.jti,
    iat: input.nowEpochSeconds,
    exp: input.nowEpochSeconds + 300,
    challenge: input.challenge,
    descriptor: smokeDescriptor(input.environmentId),
    environmentId: input.environmentId,
    environmentPublicKey: input.environmentPublicKey.trim(),
    endpoint: SMOKE_LINK_ENDPOINT,
    origin: SMOKE_LINK_ORIGIN,
    scopes: [],
  } satisfies RelayEnvironmentLinkProofPayload;
}

/**
 * The environment-signed assertion that ties a DPoP proof key to the linked
 * environment. The relay verifies it with the stored link public key and
 * requires `sub === environmentId`.
 */
export function buildKeyBindingPayload(input: {
  readonly environmentId: EnvironmentId;
  readonly relayIssuer: string;
  readonly jkt: string;
  readonly jti: string;
  readonly nowEpochSeconds: number;
}): RelayConvexKeyBindingPayload {
  return {
    iss: `t3-env:${input.environmentId}`,
    aud: normalizeRelayIssuer(input.relayIssuer),
    sub: input.environmentId,
    jti: input.jti,
    iat: input.nowEpochSeconds,
    exp: input.nowEpochSeconds + 300,
    environmentId: input.environmentId,
    jkt: input.jkt,
  } satisfies RelayConvexKeyBindingPayload;
}

/**
 * Compact ES256 DPoP proof in the exact shape `verifyDpopProof` accepts:
 * `typ: dpop+jwt` header carrying the public JWK, `htm`/`htu`/`jti`/`iat`
 * payload, ieee-p1363 signature over `header.payload`.
 */
export function signDpopProof(input: {
  readonly privateKey: NodeCrypto.KeyObject;
  readonly publicJwk: DpopPublicJwk;
  readonly method: string;
  readonly url: string;
  readonly jti: string;
  readonly iatEpochSeconds: number;
}): string {
  const header = Buffer.from(
    JSON.stringify({ typ: "dpop+jwt", alg: "ES256", jwk: input.publicJwk }),
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      htm: input.method,
      htu: input.url,
      jti: input.jti,
      iat: input.iatEpochSeconds,
    }),
  ).toString("base64url");
  const signature = NodeCrypto.sign("sha256", Buffer.from(`${header}.${payload}`), {
    key: input.privateKey,
    dsaEncoding: "ieee-p1363",
  }).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

/** Decodes the JOSE header of a compact JWT, or `null` when it is not one. */
function decodeJwtHeaderSegment(token: string): Record<string, unknown> | null {
  const segment = token.split(".")[0] ?? "";
  try {
    const parsed: unknown = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Tolerance for clock disagreement between this machine and the relay. */
const TOKEN_CLOCK_SKEW_SECONDS = 60;

/**
 * Checks the header and claims of a minted service token: the shape Convex
 * authorizes on (`aud`/`sub`/`environmentId`/`cnf.jkt`), the issuer, and that
 * the header/lifetime are what the relay's ES256 signing path produces. Returns
 * `null` when everything holds, otherwise a description of the first mismatch.
 *
 * Purely structural — signature verification against the relay's live JWKS is
 * {@link verifyServiceTokenSignature}, kept separate so this stays unit
 * testable without a network.
 */
export function checkConvexServiceTokenClaims(input: {
  readonly token: string;
  readonly environmentId: EnvironmentId;
  readonly expectedJkt: string;
  /** The relay base URL the token was requested from. */
  readonly expectedIssuer: string;
  /** `expires_in` from the exchange response; bounds the token's lifetime. */
  readonly expiresInSeconds: number;
  readonly nowEpochSeconds: number;
}): string | null {
  const header = decodeJwtHeaderSegment(input.token);
  if (header === null) {
    return "service token header is not decodable JOSE JSON";
  }
  if (header["alg"] !== "ES256") {
    return `header alg is ${JSON.stringify(header["alg"])}, expected "ES256"`;
  }
  if (typeof header["kid"] !== "string" || header["kid"].length === 0) {
    return "header has no kid — Convex cannot select the relay's JWKS key without one";
  }
  let claims: Record<string, unknown>;
  try {
    claims = decodeRelayJwt(input.token) as Record<string, unknown>;
  } catch (error) {
    return `service token is not a decodable JWT: ${String(error)}`;
  }
  const expectedIssuer = normalizeRelayIssuer(input.expectedIssuer);
  if (claims["iss"] !== expectedIssuer) {
    return `iss is ${JSON.stringify(claims["iss"])}, expected "${expectedIssuer}"`;
  }
  if (claims["aud"] !== RelayConvexAudience) {
    return `aud is ${JSON.stringify(claims["aud"])}, expected "${RelayConvexAudience}"`;
  }
  if (claims["sub"] !== input.environmentId) {
    return `sub is ${JSON.stringify(claims["sub"])}, expected "${input.environmentId}"`;
  }
  if (claims["environmentId"] !== input.environmentId) {
    return `environmentId is ${JSON.stringify(claims["environmentId"])}, expected "${input.environmentId}"`;
  }
  if (typeof claims["jti"] !== "string" || claims["jti"].length === 0) {
    return `jti is ${JSON.stringify(claims["jti"])}, expected a non-empty string`;
  }
  const iat = claims["iat"];
  const exp = claims["exp"];
  if (typeof iat !== "number" || typeof exp !== "number") {
    return `iat/exp are ${JSON.stringify(iat)}/${JSON.stringify(exp)}, expected numbers`;
  }
  if (exp <= iat) {
    return `exp ${exp} is not after iat ${iat}`;
  }
  if (exp - iat > input.expiresInSeconds + TOKEN_CLOCK_SKEW_SECONDS) {
    return `token lifetime is ${exp - iat}s, expected at most expires_in ${input.expiresInSeconds}s (+${TOKEN_CLOCK_SKEW_SECONDS}s skew)`;
  }
  if (iat > input.nowEpochSeconds + TOKEN_CLOCK_SKEW_SECONDS) {
    return `iat ${iat} is in the future (now ${input.nowEpochSeconds})`;
  }
  if (exp < input.nowEpochSeconds - TOKEN_CLOCK_SKEW_SECONDS) {
    return `token already expired at ${exp} (now ${input.nowEpochSeconds})`;
  }
  const cnf = claims["cnf"];
  const jkt =
    typeof cnf === "object" && cnf !== null ? (cnf as Record<string, unknown>)["jkt"] : undefined;
  if (jkt !== input.expectedJkt) {
    return `cnf.jkt is ${JSON.stringify(jkt)}, expected the DPoP key thumbprint "${input.expectedJkt}"`;
  }
  return null;
}

/**
 * Verifies the token's ES256 signature against a JWKS document (as served at
 * the relay's `/.well-known/jwks.json`). Returns `null` when the signature
 * verifies with the key the header's `kid` names, otherwise a description of
 * what failed. Pure given the JWKS — the live run fetches the document over
 * the injected HttpClient and hands it in.
 */
export function verifyServiceTokenSignature(input: {
  readonly token: string;
  readonly jwks: unknown;
}): string | null {
  const segments = input.token.split(".");
  if (segments.length !== 3) {
    return "service token is not a three-segment compact JWT";
  }
  const header = decodeJwtHeaderSegment(input.token);
  if (header === null) {
    return "service token header is not decodable JOSE JSON";
  }
  const kid = header["kid"];
  if (typeof kid !== "string" || kid.length === 0) {
    return "service token header has no kid to select a JWKS key with";
  }
  const keys =
    typeof input.jwks === "object" && input.jwks !== null
      ? (input.jwks as Record<string, unknown>)["keys"]
      : undefined;
  if (!Array.isArray(keys)) {
    return "relay JWKS document has no keys array";
  }
  const jwk = keys.find(
    (key: unknown) =>
      typeof key === "object" && key !== null && (key as Record<string, unknown>)["kid"] === kid,
  );
  if (jwk === undefined) {
    return `relay JWKS serves no key with kid "${kid}" (${keys.length} key(s) present)`;
  }
  let publicKey: NodeCrypto.KeyObject;
  try {
    publicKey = NodeCrypto.createPublicKey({ key: jwk as NodeCrypto.JsonWebKey, format: "jwk" });
  } catch (error) {
    return `relay JWKS key "${kid}" is not importable: ${String(error)}`;
  }
  const valid = NodeCrypto.verify(
    "sha256",
    Buffer.from(`${segments[0]}.${segments[1]}`),
    { key: publicKey, dsaEncoding: "ieee-p1363" },
    Buffer.from(segments[2] ?? "", "base64url"),
  );
  return valid ? null : `service token signature does not verify against JWKS key "${kid}"`;
}

/**
 * The `reason` of a relay `auth_invalid` error body, or `null` when the body is
 * not one. The negative cases assert the exact reason so a refusal for the
 * wrong cause (say, a concurrently invalidated credential) cannot pass as the
 * refusal under test.
 */
export function relayAuthErrorReason(body: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  if (record["code"] !== "auth_invalid") {
    return null;
  }
  return typeof record["reason"] === "string" ? record["reason"] : null;
}

/** Extracts the backend error `code` from a thrown Convex `ConvexError`, if that is what `error` is. */
export function convexErrorCode(error: unknown): string | null {
  if (!(error instanceof ConvexError)) {
    return null;
  }
  const data: unknown = error.data;
  if (typeof data !== "object" || data === null) {
    return null;
  }
  const code = (data as Record<string, unknown>)["code"];
  return typeof code === "string" ? code : null;
}

// --------------------------------------------------------------------------
// Recovery state files
// --------------------------------------------------------------------------

/**
 * What a rerun (or an operator) needs to clean up after a run that died before
 * `Effect.ensuring` could fire (SIGKILL, power loss): the relay link is keyed
 * by `environmentId` under the operator's account, and the Convex registration
 * by `environmentId` on `deployment`.
 */
export interface SmokeRunStateFile {
  readonly environmentId: string;
  readonly relayBaseUrl: string;
  readonly deployment: string;
  readonly companyId: string;
}

export function defaultSmokeStateDir(): string {
  return NodePath.join(NodeOs.tmpdir(), "pathway-convex-smoke");
}

export function smokeStateFilePath(stateDir: string, environmentId: string): string {
  return NodePath.join(stateDir, `${environmentId}.json`);
}

/** Parses one state file's content; `null` for anything that is not one. */
export function parseSmokeRunStateFile(content: string): SmokeRunStateFile | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const environmentId = record["environmentId"];
  const relayBaseUrl = record["relayBaseUrl"];
  const deployment = record["deployment"];
  const companyId = record["companyId"];
  if (
    typeof environmentId !== "string" ||
    !environmentId.startsWith(SMOKE_ENVIRONMENT_ID_PREFIX) ||
    typeof relayBaseUrl !== "string" ||
    relayBaseUrl.length === 0 ||
    typeof deployment !== "string" ||
    deployment.length === 0 ||
    typeof companyId !== "string" ||
    companyId.length === 0
  ) {
    return null;
  }
  return { environmentId, relayBaseUrl, deployment, companyId };
}

export function writeSmokeRunStateFile(stateDir: string, state: SmokeRunStateFile): void {
  NodeFs.mkdirSync(stateDir, { recursive: true });
  NodeFs.writeFileSync(
    smokeStateFilePath(stateDir, state.environmentId),
    JSON.stringify(state, null, 2),
    "utf8",
  );
}

export function removeSmokeRunStateFile(stateDir: string, environmentId: string): void {
  NodeFs.rmSync(smokeStateFilePath(stateDir, environmentId), { force: true });
}

/**
 * State files left behind by prior runs. Unreadable or foreign files are
 * skipped — only `env-smoke-*.json` files that parse count, so a stray file in
 * the directory cannot wedge recovery.
 */
export function listSmokeStateFiles(stateDir: string): ReadonlyArray<SmokeRunStateFile> {
  let entries: ReadonlyArray<string>;
  try {
    entries = NodeFs.readdirSync(stateDir);
  } catch {
    return [];
  }
  const states: Array<SmokeRunStateFile> = [];
  for (const entry of entries) {
    if (!entry.startsWith(SMOKE_ENVIRONMENT_ID_PREFIX) || !entry.endsWith(".json")) {
      continue;
    }
    try {
      const parsed = parseSmokeRunStateFile(
        NodeFs.readFileSync(NodePath.join(stateDir, entry), "utf8"),
      );
      if (parsed !== null) {
        states.push(parsed);
      }
    } catch {
      // Unreadable file — skip; the backend cleanup sweep covers registrations.
    }
  }
  return states;
}

/**
 * The commands an operator runs by hand to clean up after a run that died
 * before its own cleanup (SIGKILL, power loss). Logged at intent time, right
 * before the first mutating request leaves the machine.
 */
export function manualCleanupInstructions(
  input: SmokeRunStateFile & { readonly stateDir: string },
): {
  readonly convex: string;
  readonly relay: string;
  readonly stateFile: string;
} {
  const args = JSON.stringify({ environmentId: input.environmentId });
  return {
    convex: `cd packages/backend && CONVEX_DEPLOYMENT=${input.deployment} npx convex run smoke:cleanup '${args}'`,
    relay: `curl -X DELETE ${input.relayBaseUrl}/v1/client/environment-links/${input.environmentId} -H 'Authorization: Bearer <pathway connect CLI access token>'`,
    stateFile: smokeStateFilePath(input.stateDir, input.environmentId),
  };
}

// --------------------------------------------------------------------------
// The smoke program
// --------------------------------------------------------------------------

const nowEpochSeconds = Clock.currentTimeMillis.pipe(
  Effect.map((millis) => Math.floor(millis / 1_000)),
);

const convexCall = <A>(run: () => Promise<A>): Effect.Effect<A, ConvexSyncSmokeConvexCallError> =>
  Effect.tryPromise({ try: run, catch: (cause) => new ConvexSyncSmokeConvexCallError({ cause }) });

const isConvexCallError = Schema.is(ConvexSyncSmokeConvexCallError);

/** The value a Convex call rejected with, unwrapped from the smoke's typed wrapper. */
function thrownConvexValue(error: unknown): unknown {
  return isConvexCallError(error) ? error.cause : error;
}

export const runConvexSyncSmoke = Effect.fn("cloud.convex_sync_smoke.run")(function* (
  config: ConvexSyncSmokeConfig,
) {
  const httpClient = yield* HttpClient.HttpClient;
  const tokens = yield* CliTokenManager.CloudCliTokenManager;
  const relayBaseUrl = normalizeRelayIssuer(config.relayBaseUrl);
  const exchangeUrl = `${relayBaseUrl}/v1/environment/convex-token`;
  const exchangeHtu = normalizeDpopHtu(exchangeUrl) ?? exchangeUrl;

  const steps: Array<ConvexSyncSmokeStepResult> = [];
  // Attempt flags flip BEFORE the corresponding mutating request goes out: a
  // committed-but-lost response must still be cleaned up, so intent — not a
  // validated response — is what obligates cleanup.
  const state = {
    linkAttempted: false,
    seedAttempted: false,
    stateFileWritten: false,
    cliAccessToken: null as string | null,
  };

  /**
   * Runs one step, recording success or failure without failing the harness:
   * a failed step yields `Option.none` so dependent steps can be skipped while
   * independent ones still run and the report stays complete.
   */
  const step = <A, E>(
    name: string,
    effect: Effect.Effect<A, E>,
    describe?: (value: A) => string,
  ): Effect.Effect<Option.Option<A>> =>
    Effect.matchCause(effect, {
      onSuccess: (value) => {
        steps.push({ name, ok: true, detail: describe ? describe(value) : "" });
        return Option.some(value);
      },
      onFailure: (cause) => {
        steps.push({ name, ok: false, detail: truncateDetail(Cause.pretty(cause)) });
        return Option.none<A>();
      },
    });

  const skip = (name: string, reason: string): void => {
    steps.push({ name, ok: false, detail: `skipped: ${reason}` });
  };

  const relayPost = <A>(input: {
    readonly url: string;
    readonly token: string;
    readonly payload: unknown;
    readonly schema: Schema.Decoder<A>;
  }) =>
    HttpClientRequest.post(input.url).pipe(
      HttpClientRequest.bearerToken(input.token),
      HttpClientRequest.bodyJson(input.payload),
      Effect.flatMap(httpClient.execute),
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(input.schema)),
    );

  /**
   * Raw token exchange: the negative cases need the un-filtered response to
   * assert the exact status code, so this returns status + body text.
   */
  const exchangeConvexTokenRaw = (input: {
    readonly environmentCredential: string;
    readonly bindingPrivateKey: string;
    readonly bindingJkt: string;
    readonly dpopKeys: DpopKeyPair;
  }) =>
    Effect.gen(function* () {
      const now = yield* nowEpochSeconds;
      const keyBinding = yield* signRelayJwt({
        privateKey: input.bindingPrivateKey,
        typ: RELAY_CONVEX_KEY_BINDING_TYP,
        payload: buildKeyBindingPayload({
          environmentId: config.environmentId,
          relayIssuer: relayBaseUrl,
          jkt: input.bindingJkt,
          jti: NodeCrypto.randomUUID(),
          nowEpochSeconds: now,
        }),
      });
      const dpopProof = signDpopProof({
        privateKey: input.dpopKeys.privateKey,
        publicJwk: input.dpopKeys.publicJwk,
        method: "POST",
        url: exchangeHtu,
        jti: NodeCrypto.randomUUID(),
        iatEpochSeconds: now,
      });
      const response = yield* HttpClientRequest.post(exchangeUrl).pipe(
        HttpClientRequest.setHeader("dpop", dpopProof),
        HttpClientRequest.bodyUrlParams({
          grant_type: RelayDpopTokenExchangeGrantType,
          subject_token: input.environmentCredential,
          subject_token_type: RelayEnvironmentCredentialTokenType,
          requested_token_type: RelayAccessTokenType,
          audience: RelayConvexAudience,
          key_binding: keyBinding,
        }),
        httpClient.execute,
      );
      const body = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
      return { status: response.status, body };
    });

  /**
   * A negative case must be refused for its OWN reason: the relay maps a bad
   * key binding to `auth_invalid/invalid_bearer` and a DPoP proof from the
   * wrong key to `auth_invalid/invalid_dpop` (see `mapRelayCommonApiErrors` in
   * `infra/relay/src/http/Api.ts`), so a 401 with any other reason — say, a
   * concurrently invalidated credential — fails the step.
   */
  const expectAuthInvalid = <E>(
    exchange: Effect.Effect<{ readonly status: number; readonly body: string }, E>,
    expectedReason: "invalid_bearer" | "invalid_dpop",
  ) =>
    exchange.pipe(
      Effect.flatMap(({ status, body }) => {
        if (status !== 401) {
          return Effect.fail(
            new ConvexSyncSmokeError({
              reason: `expected HTTP 401 from the relay, got ${status}: ${truncateDetail(body)}`,
            }),
          );
        }
        const reason = relayAuthErrorReason(body);
        return reason === expectedReason
          ? Effect.succeed(`relay refused with HTTP 401 auth_invalid/${expectedReason}`)
          : Effect.fail(
              new ConvexSyncSmokeError({
                reason: `expected 401 auth_invalid reason '${expectedReason}', got ${
                  reason === null ? "an unrecognized 401 body" : `'${reason}'`
                }: ${truncateDetail(body)}`,
              }),
            );
      }),
    );

  const expectConvexRefusal = <A, E>(effect: Effect.Effect<A, E>, expectedCode: string) =>
    Effect.exit(effect).pipe(
      Effect.flatMap((exit) => {
        if (Exit.isSuccess(exit)) {
          return Effect.fail(
            new ConvexSyncSmokeError({
              reason: `expected Convex to refuse with '${expectedCode}', but the call succeeded`,
            }),
          );
        }
        const error = Cause.findErrorOption(exit.cause);
        const code = Option.isSome(error) ? convexErrorCode(thrownConvexValue(error.value)) : null;
        return code === expectedCode
          ? Effect.succeed(`Convex refused with '${expectedCode}'`)
          : Effect.fail(
              new ConvexSyncSmokeError({
                reason: `expected Convex error '${expectedCode}', got ${
                  code === null ? "a non-Convex failure" : `'${code}'`
                }: ${truncateDetail(Cause.pretty(exit.cause))}`,
              }),
            );
      }),
    );

  const hookStep = (name: string, effect: Effect.Effect<void, ConvexSyncSmokeHookError>) =>
    step(name, effect, () => "done");

  /**
   * Unlinks `environmentId` under the operator's account. The relay answers
   * 200 `{ ok: false }` when no link exists, so unlinking something already
   * gone (a lost link response, a prior partial cleanup) reads as success.
   */
  const unlinkEnvironment = (token: string, environmentId: string) =>
    HttpClientRequest.delete(
      `${relayBaseUrl}/v1/client/environment-links/${encodeURIComponent(environmentId)}`,
    ).pipe(
      HttpClientRequest.bearerToken(token),
      httpClient.execute,
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(RelayOkResponse)),
    );

  const describeUnlink = (value: RelayOkResponse): string =>
    value.ok ? "environment link removed" : "no environment link to remove (already gone)";

  const cleanup = Effect.gen(function* () {
    let cleanupComplete = true;
    if (state.linkAttempted && state.cliAccessToken !== null) {
      const unlinked = yield* step(
        "cleanup.relay.unlinkEnvironment",
        unlinkEnvironment(state.cliAccessToken, config.environmentId),
        describeUnlink,
      );
      cleanupComplete = cleanupComplete && Option.isSome(unlinked);
    }
    if (state.seedAttempted) {
      const cleaned = yield* hookStep(
        "cleanup.hooks.cleanupRegistration",
        config.hooks.cleanupRegistration(),
      );
      cleanupComplete = cleanupComplete && Option.isSome(cleaned);
    }
    // The state file only leaves once cleanup fully converged; anything less
    // keeps the marker so the next run's recovery pass retries.
    if (state.stateFileWritten && cleanupComplete) {
      yield* step(
        "cleanup.stateFile",
        Effect.try({
          try: () => removeSmokeRunStateFile(config.stateDir, config.environmentId),
          catch: (cause) =>
            new ConvexSyncSmokeError({
              reason: `failed to remove the recovery state file ${smokeStateFilePath(config.stateDir, config.environmentId)}`,
              cause,
            }),
        }),
        () => "recovery state file removed",
      );
    }
  });

  const main = Effect.gen(function* () {
    // (a) Stored CLI credential — same source connect.ts uses for relay client calls.
    const credential = yield* step(
      "cli.credential",
      tokens.getExisting.pipe(
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new ConvexSyncSmokeError({
                  reason:
                    "No stored Pathway Connect CLI credential. Run `pathway connect login` on this machine first, then re-run the smoke.",
                }),
              ),
            onSome: Effect.succeed,
          }),
        ),
      ),
      (token) => `credential present${token.identity ? ` for ${token.identity}` : ""}`,
    );
    if (Option.isNone(credential)) {
      return;
    }
    const cliAccessToken = credential.value.accessToken;
    state.cliAccessToken = cliAccessToken;

    // (a2) Recover leftovers from prior runs that died before cleanup could
    // run (SIGKILL cannot fire Effect.ensuring). Each state file names an
    // environment whose relay link and Convex registration may still exist;
    // the unlink is the same per-environment route cleanup uses, and one
    // backend cleanup call suffices because `smoke:cleanup` sweeps every
    // `env-smoke-*` registration.
    const leftovers = yield* step(
      "recovery.leftoverState",
      Effect.try({
        try: () =>
          listSmokeStateFiles(config.stateDir).filter(
            (stale) => stale.environmentId !== config.environmentId,
          ),
        catch: (cause) =>
          new ConvexSyncSmokeError({
            reason: `failed to list recovery state files in ${config.stateDir}`,
            cause,
          }),
      }),
      (files) =>
        files.length === 0
          ? "no leftover state from prior runs"
          : `found ${files.length} leftover run(s): ${files.map((stale) => stale.environmentId).join(", ")}`,
    );
    if (Option.isSome(leftovers) && leftovers.value.length > 0) {
      const swept = yield* hookStep(
        "recovery.hooks.cleanupRegistration",
        config.hooks.cleanupRegistration(),
      );
      for (const stale of leftovers.value) {
        const unlinked = yield* step(
          `recovery.relay.unlinkEnvironment[${stale.environmentId}]`,
          unlinkEnvironment(cliAccessToken, stale.environmentId),
          describeUnlink,
        );
        if (Option.isSome(unlinked) && Option.isSome(swept)) {
          yield* step(
            `recovery.stateFile[${stale.environmentId}]`,
            Effect.try({
              try: () => removeSmokeRunStateFile(config.stateDir, stale.environmentId),
              catch: (cause) =>
                new ConvexSyncSmokeError({
                  reason: `failed to remove the recovered state file ${smokeStateFilePath(config.stateDir, stale.environmentId)}`,
                  cause,
                }),
            }),
            () => "recovered; state file removed",
          );
        }
      }
    }

    // (b) Link challenge with every capability flag false (publish-only).
    const challenge = yield* step(
      "relay.createLinkChallenge",
      relayPost({
        url: `${relayBaseUrl}/v1/client/environment-link-challenges`,
        token: cliAccessToken,
        payload: {
          notificationsEnabled: false,
          liveActivitiesEnabled: false,
          managedTunnelsEnabled: false,
        },
        schema: RelayEnvironmentLinkChallengeResponse,
      }),
      (value) => `challenge issued, expires ${value.expiresAt}`,
    );
    if (Option.isNone(challenge)) {
      return;
    }

    // (c) Fresh environment link key, signed proof, publish-only link.
    const linkKeys = generateEnvironmentLinkKeyPair();
    const link = yield* step(
      "relay.linkEnvironment",
      Effect.gen(function* () {
        const now = yield* nowEpochSeconds;
        const proof = yield* signRelayJwt({
          privateKey: linkKeys.privateKey,
          typ: RELAY_LINK_PROOF_TYP,
          payload: buildLinkProofPayload({
            environmentId: config.environmentId,
            relayIssuer: relayBaseUrl,
            challenge: challenge.value.challenge,
            environmentPublicKey: linkKeys.publicKey,
            jti: NodeCrypto.randomUUID(),
            nowEpochSeconds: now,
          }),
        });
        // Intent precedes the request: once this POST leaves the machine the
        // link may exist even if the response is lost, so cleanup must run and
        // an operator must be able to recover a SIGKILLed run by hand.
        yield* Effect.try({
          try: () =>
            writeSmokeRunStateFile(config.stateDir, {
              environmentId: config.environmentId,
              relayBaseUrl,
              deployment: config.deployment,
              companyId: config.companyId,
            }),
          catch: (cause) =>
            new ConvexSyncSmokeError({
              reason: `failed to write the recovery state file in ${config.stateDir} — refusing to mutate without one`,
              cause,
            }),
        });
        state.stateFileWritten = true;
        state.linkAttempted = true;
        yield* Effect.logInfo(
          "convex sync smoke: manual cleanup, should this run die before its own cleanup",
          manualCleanupInstructions({
            environmentId: config.environmentId,
            relayBaseUrl,
            deployment: config.deployment,
            companyId: config.companyId,
            stateDir: config.stateDir,
          }),
        );
        return yield* relayPost({
          url: `${relayBaseUrl}/v1/client/environment-links`,
          token: cliAccessToken,
          payload: {
            proof,
            notificationsEnabled: false,
            liveActivitiesEnabled: false,
            managedTunnelsEnabled: false,
          },
          schema: RelayEnvironmentLinkResponse,
        });
      }),
      (value) => `linked ${value.environmentId} for cloud user ${value.cloudUserId}`,
    );
    if (Option.isNone(link)) {
      return;
    }
    const environmentCredential = link.value.environmentCredential;

    // (d) DPoP proof key + registration seeded with its RFC 7638 thumbprint.
    // Seed intent flips first for the same reason link intent does: a seed
    // whose response is lost still wrote rows that cleanup must sweep.
    const dpopKeys = generateDpopKeyPair();
    state.seedAttempted = true;
    const seeded = yield* hookStep(
      "hooks.seedRegistration",
      config.hooks.seedRegistration(dpopKeys.thumbprint),
    );
    if (Option.isNone(seeded)) {
      return;
    }

    // (e) Key-binding + DPoP token exchange → pathway-convex service token.
    const exchanged = yield* step(
      "relay.exchangeConvexServiceToken",
      Effect.gen(function* () {
        const { status, body } = yield* exchangeConvexTokenRaw({
          environmentCredential,
          bindingPrivateKey: linkKeys.privateKey,
          bindingJkt: dpopKeys.thumbprint,
          dpopKeys,
        });
        if (status !== 200) {
          return yield* new ConvexSyncSmokeError({
            reason: `token exchange returned HTTP ${status}: ${truncateDetail(body)}`,
          });
        }
        return yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(RelayConvexServiceTokenResponse),
        )(body);
      }),
      (value) => `Bearer ${value.audience} token, expires_in ${value.expires_in}s`,
    );
    if (Option.isNone(exchanged)) {
      return;
    }
    const serviceToken = exchanged.value.access_token;

    yield* step(
      "relay.serviceTokenClaims",
      Effect.gen(function* () {
        const now = yield* nowEpochSeconds;
        const mismatch = checkConvexServiceTokenClaims({
          token: serviceToken,
          environmentId: config.environmentId,
          expectedJkt: dpopKeys.thumbprint,
          expectedIssuer: relayBaseUrl,
          expiresInSeconds: exchanged.value.expires_in,
          nowEpochSeconds: now,
        });
        if (mismatch !== null) {
          return yield* new ConvexSyncSmokeError({ reason: mismatch });
        }
        return `ES256 header with kid, iss=${relayBaseUrl}, aud=${RelayConvexAudience}, sub=${config.environmentId}, jti/iat/exp sane, cnf.jkt matches DPoP key`;
      }),
      (detail) => detail,
    );

    yield* step(
      "relay.serviceTokenSignature",
      HttpClientRequest.get(`${relayBaseUrl}/.well-known/jwks.json`).pipe(
        httpClient.execute,
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap((response) => response.json),
        Effect.flatMap((jwks) => {
          const mismatch = verifyServiceTokenSignature({ token: serviceToken, jwks });
          return mismatch === null
            ? Effect.succeed("signature verifies against the relay's live JWKS")
            : Effect.fail(new ConvexSyncSmokeError({ reason: mismatch }));
        }),
      ),
      (detail) => detail,
    );

    // (f) Authenticated Convex calls.
    const convexClient = new ConvexHttpClient(config.convexUrl);
    convexClient.setAuth(serviceToken);
    const latestVersionCall = convexCall(() =>
      convexClient.query(api.sync.latestVersion, { companyId: config.companyId }),
    );

    const latest = yield* step(
      "convex.sync.latestVersion",
      latestVersionCall,
      (value) => `version ${value.version}, authorizationEpoch ${value.authorizationEpoch}`,
    );
    const baseVersion = Option.isSome(latest) ? latest.value.version : 0;

    yield* step(
      "convex.sync.applyOperations",
      Effect.gen(function* () {
        const operationId = NodeCrypto.randomUUID();
        const result = yield* convexCall(() =>
          convexClient.mutation(api.sync.applyOperations, {
            companyId: config.companyId,
            operations: [
              {
                protocolVersion: SYNC_PROTOCOL_VERSION,
                operationId,
                companyId: config.companyId,
                clientId: `convex-sync-smoke-${config.environmentId}`,
                environmentId: config.environmentId as string,
                actor: {
                  kind: "environment" as const,
                  environmentId: config.environmentId as string,
                },
                localSequence: 1,
                baseVersion,
                kind: "issue.update",
                entityId: `smoke-${NodeCrypto.randomUUID()}`,
                args: {},
                dependsOn: [],
              },
            ],
          }),
        );
        const receipt = result.receipts.find((entry) => entry.operationId === operationId);
        if (receipt === undefined) {
          return yield* new ConvexSyncSmokeError({
            reason: `applyOperations returned ${result.receipts.length} receipt(s), none for operation ${operationId}`,
          });
        }
        // `sync.ts` registers no DOMAIN_APPLY handlers yet (phase 4), so the
        // one honest outcome today is this exact receipt. When domain handlers
        // land, this assertion must flip: expect an accepted receipt AND the
        // resulting change to be visible in the listChanges drain below.
        const code = "code" in receipt && typeof receipt.code === "string" ? receipt.code : null;
        if (receipt.status !== "rejected" || code !== "unknown-operation") {
          return yield* new ConvexSyncSmokeError({
            reason: `expected the exact receipt rejected/unknown-operation (no domain handlers are registered yet — if they landed, update this assertion), got status '${receipt.status}'${
              code === null ? "" : ` (${code})`
            }`,
          });
        }
        return "receipted rejected/unknown-operation — the operation authenticated and was receipted, but no domain handler exists yet to apply it";
      }),
      (detail) => detail,
    );

    yield* step(
      "convex.sync.listChanges",
      Effect.gen(function* () {
        let cursor = baseVersion;
        for (let page = 1; page <= 10; page += 1) {
          const result = yield* convexCall(() =>
            convexClient.query(api.sync.listChanges, {
              companyId: config.companyId,
              cursor,
            }),
          );
          if (result._tag === "CursorExpired") {
            return yield* new ConvexSyncSmokeError({
              reason: `listChanges reported CursorExpired at head ${result.latestVersion} for a cursor taken from latestVersion moments ago — retention cannot have pruned it, so the cursor accounting is broken`,
            });
          }
          if (!result.hasMore) {
            return `drained ${page} page(s) to cursor ${result.cursor}`;
          }
          cursor = result.cursor;
        }
        return yield* new ConvexSyncSmokeError({
          reason:
            "listChanges still reported hasMore after 10 pages — the smoke company's feed should drain in far fewer",
        });
      }),
      (detail) => detail,
    );

    // Commands surface is authorization-complete but not implemented yet, so a
    // typed refusal after auth also proves the token works.
    const commandProbe = <A, E>(
      effect: Effect.Effect<A, E>,
      acceptableCodes: ReadonlyArray<string>,
    ) =>
      Effect.exit(effect).pipe(
        Effect.flatMap((exit) => {
          if (Exit.isSuccess(exit)) {
            return Effect.succeed("call succeeded");
          }
          const error = Cause.findErrorOption(exit.cause);
          const code = Option.isSome(error)
            ? convexErrorCode(thrownConvexValue(error.value))
            : null;
          return code !== null && acceptableCodes.includes(code)
            ? Effect.succeed(`refused after auth with acceptable code '${code}'`)
            : Effect.fail(
                new ConvexSyncSmokeError({
                  reason: `expected success or one of [${acceptableCodes.join(", ")}], got ${
                    code === null ? "a non-Convex failure" : `'${code}'`
                  }: ${truncateDetail(Cause.pretty(exit.cause))}`,
                }),
              );
        }),
      );

    // `environmentCommands.list` requires `environments.read`, which the
    // seeded role grants (see `smokeServiceRolePermissions`), so authorization
    // must pass: the only acceptable refusal is the backend's typed
    // `not-implemented` thrown after the permission check. A permission-denied
    // here would mean service-role authorization is broken and must FAIL.
    yield* step(
      "convex.environmentCommands.list",
      commandProbe(
        convexCall(() =>
          convexClient.query(api.environmentCommands.list, { companyId: config.companyId }),
        ),
        ["not-implemented"],
      ),
      (detail) => detail,
    );

    yield* step(
      "convex.environmentCommands.claim",
      commandProbe(
        convexCall(() =>
          convexClient.mutation(api.environmentCommands.claim, { companyId: config.companyId }),
        ),
        ["not-implemented"],
      ),
      (detail) => detail,
    );

    // (g) Negative cases.
    const rogueLinkKeys = generateEnvironmentLinkKeyPair();
    yield* step(
      "negative.relay.rogueKeyBinding",
      expectAuthInvalid(
        exchangeConvexTokenRaw({
          environmentCredential,
          bindingPrivateKey: rogueLinkKeys.privateKey,
          bindingJkt: dpopKeys.thumbprint,
          dpopKeys,
        }),
        // The relay rejects the key binding before touching the DPoP proof.
        "invalid_bearer",
      ),
      (detail) => detail,
    );

    const otherDpopKeys = generateDpopKeyPair();
    yield* step(
      "negative.relay.dpopKeyMismatch",
      expectAuthInvalid(
        exchangeConvexTokenRaw({
          environmentCredential,
          bindingPrivateKey: linkKeys.privateKey,
          bindingJkt: dpopKeys.thumbprint,
          dpopKeys: otherDpopKeys,
        }),
        // Binding is valid; the proof from the wrong key dies at DPoP checks.
        "invalid_dpop",
      ),
      (detail) => detail,
    );

    const retargeted = yield* hookStep(
      "hooks.setRegistrationThumbprint",
      config.hooks.setRegistrationThumbprint(otherDpopKeys.thumbprint),
    );
    if (Option.isSome(retargeted)) {
      yield* step(
        "negative.convex.environmentKeyMismatch",
        expectConvexRefusal(latestVersionCall, "environment-key-mismatch"),
        (detail) => detail,
      );
    } else {
      skip("negative.convex.environmentKeyMismatch", "setRegistrationThumbprint hook failed");
    }

    const revoked = yield* hookStep("hooks.revokeRegistration", config.hooks.revokeRegistration());
    if (Option.isSome(revoked)) {
      yield* step(
        "negative.convex.environmentNotRegistered",
        expectConvexRefusal(latestVersionCall, "environment-not-registered"),
        (detail) => detail,
      );
    } else {
      skip("negative.convex.environmentNotRegistered", "revokeRegistration hook failed");
    }

    // (h) Re-validation: one more happy-path exchange with the ORIGINAL link
    // and DPoP keys, proving the credential and environment link were still
    // valid while the negatives ran — so their 401s refused the bad artifacts,
    // not a concurrently invalidated credential. The relay does not consult
    // the Convex registration, so the revocation above does not interfere.
    yield* step(
      "relay.reexchangeAfterNegatives",
      Effect.gen(function* () {
        const { status, body } = yield* exchangeConvexTokenRaw({
          environmentCredential,
          bindingPrivateKey: linkKeys.privateKey,
          bindingJkt: dpopKeys.thumbprint,
          dpopKeys,
        });
        if (status !== 200) {
          return yield* new ConvexSyncSmokeError({
            reason: `re-exchange after the negative cases returned HTTP ${status} — the credential or link went bad during the run, so the negatives may have refused for the wrong reason: ${truncateDetail(body)}`,
          });
        }
        yield* Schema.decodeUnknownEffect(Schema.fromJsonString(RelayConvexServiceTokenResponse))(
          body,
        );
        return "credential and link still exchange successfully — the negatives refused for their own reasons";
      }),
      (detail) => detail,
    );
  });

  // (h) Cleanup always runs, even when the main flow failed or died.
  yield* Effect.ensuring(main, cleanup);

  const report: ConvexSyncSmokeReport = { ok: overallOk(steps), steps };
  return report;
});
