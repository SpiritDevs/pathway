// @effect-diagnostics nodeBuiltinImport:off -- the crash-recovery state files are tiny local sync reads/writes; plain node:fs/node:path keep those helpers pure functions unit-testable without a FileSystem layer
/**
 * Relay-flow smoke harness for Convex-backed cloud sync (Phase 1).
 *
 * `runConvexSyncSmoke` exercises the full trust chain against a REAL deployed
 * relay and Convex deployment: stored Pathway Connect CLI credential → link
 * challenge → publish-only environment link (fresh throwaway Ed25519 key) →
 * environment credential → DPoP + key-binding token exchange → `pathway-convex`
 * service token → authenticated Convex sync calls (a real `issueLabel`
 * create/tombstone through the domain apply handlers, the change-feed drain,
 * and a forced multi-page `sync.bootstrap` snapshot with a second write
 * interleaved between its pages and a gap-free feed resume) → negative cases →
 * cleanup.
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
  RelayConvexAudience,
  RelayConvexServiceTokenResponse,
  RelayEnvironmentLinkChallengeResponse,
  RelayEnvironmentLinkResponse,
  RelayListEnvironmentsResponse,
  RelayOkResponse,
  type RelayEnvironmentLinkProofPayload,
} from "@spiritdevs/contracts/relay";
import {
  normalizeRelayIssuer,
  RELAY_LINK_PROOF_TYP,
  signRelayJwt,
} from "@spiritdevs/shared/relayJwt";
import { ConvexHttpClient } from "convex/browser";
import { api } from "@spiritdevs/backend/convexApi";
import { SMOKE_ENVIRONMENT_ID_PREFIX } from "@spiritdevs/backend/smokeSeed";
import { SYNC_PROTOCOL_VERSION } from "@spiritdevs/contracts/cloudSync";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import * as CliTokenManager from "./CliTokenManager.ts";
import {
  checkConvexServiceTokenClaims,
  convexErrorCode,
  convexTokenExchangeUrl,
  exchangeConvexServiceToken,
  generateDpopKeyPair,
  nowEpochSeconds,
  relayAuthErrorReason,
  verifyServiceTokenSignature,
  type DpopKeyPair,
} from "./convexServiceToken.ts";

/**
 * The signed-artifact and token-inspection primitives now live in `./convexServiceToken.ts`, which
 * the running server's sync transport shares with this harness so the two cannot drift. They are
 * re-exported here because the harness's documented surface — and the CI tests that check its
 * artifacts against the relay's own verifiers — is this module.
 */
export {
  buildKeyBindingPayload,
  checkConvexServiceTokenClaims,
  convexErrorCode,
  generateDpopKeyPair,
  relayAuthErrorReason,
  serviceTokenExpiryEpochSeconds,
  signDpopProof,
  verifyServiceTokenSignature,
  type DpopKeyPair,
} from "./convexServiceToken.ts";

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

// --------------------------------------------------------------------------
// Domain-write helpers (pure)
// --------------------------------------------------------------------------

/**
 * The one entity kind the smoke run writes through the issue-domain apply
 * handlers. `issueLabel.create` is the smallest accepted operation — a single
 * row, no audit event, exactly one feed change — and `issueLabel.delete` is a
 * tombstone, so the whole round trip (create → feed upsert → bootstrap
 * snapshot → delete → feed tombstone) is observable with two operations. A
 * company-scoped label gates on `workflow.manage`, which the seeded smoke role
 * must therefore carry (see `smokeServiceRolePermissions` in
 * `@spiritdevs/backend/smokeSeed`).
 */
export const SMOKE_LABEL_ENTITY_KIND = "issueLabel";

/**
 * Arguments for the smoke `issueLabel.create`. Hand-held within the backend
 * parser's bounds (`parseIssueLabelCreateArgs` in
 * `packages/backend/src/sync/issueOps.ts`): a trimmed non-empty name of at
 * most 512 chars and a `#rrggbb` color; `teamId` omitted, so the label is
 * company-scoped and rides feed rows with an empty team list.
 */
export const SMOKE_LABEL_CREATE_ARGS = {
  name: "convex-sync-smoke",
  color: "#0ea5e9",
} as const;

/**
 * Args for the second label, created *between* two bootstrap pages (see
 * {@link SMOKE_BOOTSTRAP_PAGE_SIZE}). Same shape and same company scope as
 * {@link SMOKE_LABEL_CREATE_ARGS} — labels carry no uniqueness constraint, so
 * only the name differs, and it says why the row exists to anyone who finds one
 * after a run died mid-flight. Deleted in the flow and swept with the company
 * by `smoke:cleanup` (`issueLabels` is on its sweep list).
 */
export const SMOKE_INTERLEAVED_LABEL_CREATE_ARGS = {
  name: "convex-sync-smoke-interleaved",
  color: "#f97316",
} as const;

/** One client id per throwaway environment, so receipts and feed rows are attributable to the run. */
export function smokeSyncClientId(environmentId: EnvironmentId): string {
  return `convex-sync-smoke-${environmentId}`;
}

export interface SmokeSyncOperationInput {
  readonly operationId: string;
  readonly companyId: string;
  readonly environmentId: EnvironmentId;
  readonly localSequence: number;
  /** Company version the client had confirmed when it authored this. Never a clock reading. */
  readonly baseVersion: number;
  readonly kind: string;
  readonly entityId: string;
  readonly args: unknown;
}

/**
 * A `SyncOperationEnvelope` (as `sync.applyOperations` validates it) authored
 * by the smoke environment actor. The asserted `actor` is attribution only —
 * Convex re-derives the authoritative actor from the service token — but it
 * must still be the truth.
 */
export function buildSmokeSyncOperation(input: SmokeSyncOperationInput): {
  readonly protocolVersion: number;
  readonly operationId: string;
  readonly companyId: string;
  readonly clientId: string;
  readonly environmentId: string;
  readonly actor: { readonly kind: "environment"; readonly environmentId: string };
  readonly localSequence: number;
  readonly baseVersion: number;
  readonly kind: string;
  readonly entityId: string;
  readonly args: unknown;
  /** Mutable array type because the Convex argument validator's inferred type is mutable. */
  readonly dependsOn: string[];
} {
  return {
    protocolVersion: SYNC_PROTOCOL_VERSION,
    operationId: input.operationId,
    companyId: input.companyId,
    clientId: smokeSyncClientId(input.environmentId),
    environmentId: input.environmentId as string,
    actor: { kind: "environment", environmentId: input.environmentId as string },
    localSequence: input.localSequence,
    baseVersion: input.baseVersion,
    kind: input.kind,
    entityId: input.entityId,
    args: input.args,
    dependsOn: [],
  };
}

/** The common shape of a `listChanges` change and a `bootstrap` entity envelope. */
export interface SyncChangeSummary {
  readonly version: number;
  readonly entityKind: string;
  readonly entityId: string;
  readonly changeKind: "upsert" | "tombstone";
}

/**
 * The highest-versioned change for one entity, or `undefined` when none match.
 * Latest wins because a drain that spans both a create and its delete must
 * report the entity as tombstoned, not resurrect it from the earlier upsert.
 */
export function latestSyncChange<C extends SyncChangeSummary>(
  changes: readonly C[],
  entityKind: string,
  entityId: string,
): C | undefined {
  let latest: C | undefined;
  for (const change of changes) {
    if (change.entityKind !== entityKind || change.entityId !== entityId) continue;
    if (latest === undefined || change.version > latest.version) latest = change;
  }
  return latest;
}

/** Every delivery of one entity, in the order the caller collected them. */
export function syncChangesFor<C extends SyncChangeSummary>(
  changes: readonly C[],
  entityKind: string,
  entityId: string,
): readonly C[] {
  return changes.filter(
    (change) => change.entityKind === entityKind && change.entityId === entityId,
  );
}

/**
 * Page size the smoke forces on `sync.bootstrap`: the smallest a
 * `SyncBootstrapRequest` allows (`pageSize` is a positive int), so even the
 * reserved smoke company's handful of rows takes several pages to seed. Without
 * it one page finishes the walk and nothing about a write landing mid-seed —
 * the one hazard the snapshot→feed handoff has — is exercised.
 */
export const SMOKE_BOOTSTRAP_PAGE_SIZE = 1;

/**
 * Page ceiling for the forced one-row-per-page walk. The smoke company only
 * ever holds what the smoke flow wrote (`smoke:cleanup` refuses to delete a
 * company carrying anything else), so a seed needing more pages than this means
 * the walk is not advancing.
 */
export const SMOKE_BOOTSTRAP_MAX_PAGES = 25;

/**
 * A seed's `version` is the company head captured on its FIRST page, and every
 * later page must repeat that same value: it is the resume position the client
 * persists, so a walk that re-captured the head per page would hand back a
 * version *past* the writes that landed mid-seed and the client's first drain
 * would skip them. Returns `null` when every page agrees, otherwise the first
 * page that did not.
 *
 * `laterPageVersions` holds the pages walked after the first, so page numbering
 * starts at two.
 */
export function checkBootstrapSnapshotVersions(input: {
  readonly snapshotVersion: number;
  readonly laterPageVersions: readonly number[];
}): string | null {
  for (const [index, version] of input.laterPageVersions.entries()) {
    if (version !== input.snapshotVersion) {
      return `bootstrap page ${index + 2} reports version ${version}, expected the first page's snapshot version ${input.snapshotVersion} — a seed that re-captures the head per page resumes past the writes that landed mid-seed`;
    }
  }
  return null;
}

export interface InterleavedWriteDeliveryInput {
  readonly entityKind: string;
  readonly entityId: string;
  /** Version the accepted interleaved write reported. */
  readonly writeVersion: number;
  /** The head page one pinned the seed to; the write landed after it. */
  readonly snapshotVersion: number;
  /** Entities from the seed pages walked *after* the write landed. */
  readonly laterSnapshotEntities: readonly SyncChangeSummary[];
  /** Changes drained from `snapshotVersion` once the seed finished. */
  readonly drainedChanges: readonly SyncChangeSummary[];
}

/**
 * Holds a write that landed between two bootstrap pages to the one guarantee
 * the seed→feed handoff makes: a client that finishes the seed and resumes
 * `listChanges` at the seed's version applies that write exactly once.
 *
 * Concretely — returns `null` when all of this holds, otherwise the first thing
 * that did not:
 *
 * - the write is past the snapshot version at all (otherwise it did not land
 *   mid-seed and the rest proves nothing);
 * - it is delivered — by the remaining seed pages, by the drain, or both;
 * - the *drain* carries it, exactly once: its version is past the snapshot
 *   version, so a resume there that misses it is a lost write;
 * - the remaining seed pages carry it at most once;
 * - every delivery is the create's `upsert` stamped with the version the
 *   receipt reported, so the whole set collapses to one `(entityId, version)`.
 *
 * Deliberately NOT an exclusive-or over the two sides. The seed is pinned to
 * page one's head, so a row written mid-walk that the remaining pages happen to
 * still read is *re-delivered* by the drain that resumes at that head — by
 * design (`packages/backend/src/sync/bootstrap.ts`), and harmless because both
 * sides carry the same stamp and the client folds them through one idempotent
 * upsert. Which side delivers it depends on where the walk stood in the table
 * when the write landed: an internal detail of the cursor and the walk order
 * that the contract does not promise and the smoke must not assert on.
 */
export function checkInterleavedWriteDelivery(input: InterleavedWriteDeliveryInput): string | null {
  const { entityId, entityKind, snapshotVersion, writeVersion } = input;
  const subject = `${entityKind} ${entityId}`;
  if (writeVersion <= snapshotVersion) {
    return `the interleaved write for ${subject} reports version ${writeVersion}, not past the seed's snapshot version ${snapshotVersion} — it did not land mid-seed, so the handoff is untested`;
  }
  const fromSeed = syncChangesFor(input.laterSnapshotEntities, entityKind, entityId);
  const fromDrain = syncChangesFor(input.drainedChanges, entityKind, entityId);
  if (fromSeed.length + fromDrain.length === 0) {
    return `the write for ${subject} at version ${writeVersion} landed between seed pages and was then lost: neither the ${input.laterSnapshotEntities.length} remaining seed entity(ies) nor the ${input.drainedChanges.length} change(s) drained from ${snapshotVersion} carry it`;
  }
  if (fromDrain.length === 0) {
    return `the write for ${subject} at version ${writeVersion} is past the seed's snapshot version ${snapshotVersion}, so a drain resuming there must carry it — it did not, over ${input.drainedChanges.length} drained change(s), so a client that seeded and resumed at ${snapshotVersion} would never learn of it`;
  }
  if (fromDrain.length > 1) {
    return `the drain from ${snapshotVersion} carries ${fromDrain.length} changes for ${subject} (versions ${fromDrain.map((change) => change.version).join(", ")}), expected the interleaved write exactly once`;
  }
  if (fromSeed.length > 1) {
    return `the remaining seed pages carry ${subject} ${fromSeed.length} times (versions ${fromSeed.map((entity) => entity.version).join(", ")}), expected at most once`;
  }
  for (const delivery of [...fromSeed, ...fromDrain]) {
    if (delivery.changeKind !== "upsert") {
      return `${subject} arrives as a ${delivery.changeKind} at version ${delivery.version}, expected the interleaved create's upsert`;
    }
    if (delivery.version !== writeVersion) {
      return `${subject} arrives at version ${delivery.version}, expected the ${writeVersion} its receipt reported — seed and feed must stamp one change once, or a client folding both applies two`;
    }
  }
  return null;
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

/** Leftover runs split by whether this run's targets can clean them up. */
export interface SmokeRecoveryTargets {
  /** Recorded against this run's relay and deployment, so recovery reaches them. */
  readonly recoverable: ReadonlyArray<SmokeRunStateFile>;
  /** Recorded against a different relay or deployment; only an operator can clear them. */
  readonly foreign: ReadonlyArray<SmokeRunStateFile>;
}

/**
 * Splits the leftover state files of prior runs into the ones this run may
 * recover and the ones it must not touch.
 *
 * Recovery is pinned to the *current* config — the unlink goes to
 * `config.relayBaseUrl` and the cleanup hook to `config.deployment` — while a
 * state file names the relay and deployment its run actually mutated. When the
 * two disagree (the same machine smoke-tests two deployments, sharing the
 * default state dir) recovering from here would sweep the wrong deployment,
 * ask the wrong relay — which answers "already gone" for an id it never linked
 * — and then delete the only record of the real leftovers. Those runs are
 * reported instead, with their marker files kept.
 *
 * The run's own environment is never a recovery target: its state file belongs
 * to the cleanup that is still to come.
 */
export function partitionSmokeRecoveryTargets(input: {
  readonly states: ReadonlyArray<SmokeRunStateFile>;
  readonly environmentId: string;
  readonly relayBaseUrl: string;
  readonly deployment: string;
}): SmokeRecoveryTargets {
  const relayBaseUrl = normalizeRelayIssuer(input.relayBaseUrl);
  const recoverable: Array<SmokeRunStateFile> = [];
  const foreign: Array<SmokeRunStateFile> = [];
  for (const stale of input.states) {
    if (stale.environmentId === input.environmentId) continue;
    const matches =
      stale.deployment === input.deployment &&
      normalizeRelayIssuer(stale.relayBaseUrl) === relayBaseUrl;
    (matches ? recoverable : foreign).push(stale);
  }
  return { recoverable, foreign };
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
  const exchangeUrl = convexTokenExchangeUrl(relayBaseUrl);

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

  /** A verdict the harness reaches without running anything, and still must fail on. */
  const fail = (name: string, detail: string): void => {
    steps.push({ name, ok: false, detail: truncateDetail(detail) });
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
   * assert the exact status code, so this returns status + body text. The
   * request itself is the shared {@link exchangeConvexServiceToken} the running
   * server uses, so a harness pass proves the production path.
   */
  const exchangeConvexTokenRaw = (input: {
    readonly environmentCredential: string;
    readonly bindingPrivateKey: string;
    readonly bindingJkt: string;
    readonly dpopKeys: DpopKeyPair;
  }) =>
    exchangeConvexServiceToken({
      environmentId: config.environmentId,
      relayBaseUrl,
      environmentCredential: input.environmentCredential,
      linkPrivateKey: input.bindingPrivateKey,
      bindingJkt: input.bindingJkt,
      dpopKeys: input.dpopKeys,
    }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient));

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

    yield* step(
      "relay.listEnvironments",
      HttpClientRequest.get(`${relayBaseUrl}/v1/environments`).pipe(
        HttpClientRequest.bearerToken(cliAccessToken),
        httpClient.execute,
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap(HttpClientResponse.schemaBodyJson(RelayListEnvironmentsResponse)),
      ),
      ({ environments }) => `${environments.length} linked environment(s) visible`,
    );

    // (a2) Recover leftovers from prior runs that died before cleanup could
    // run (SIGKILL cannot fire Effect.ensuring). Each state file names an
    // environment whose relay link and Convex registration may still exist;
    // the unlink is the same per-environment route cleanup uses, and one
    // backend cleanup call suffices because `smoke:cleanup` sweeps aged-out
    // `env-smoke-*` registrations. Only runs recorded against this run's relay
    // and deployment are recoverable from here — see
    // {@link partitionSmokeRecoveryTargets}.
    const leftovers = yield* step(
      "recovery.leftoverState",
      Effect.try({
        try: () =>
          partitionSmokeRecoveryTargets({
            states: listSmokeStateFiles(config.stateDir),
            environmentId: config.environmentId,
            relayBaseUrl,
            deployment: config.deployment,
          }),
        catch: (cause) =>
          new ConvexSyncSmokeError({
            reason: `failed to list recovery state files in ${config.stateDir}`,
            cause,
          }),
      }),
      (targets) =>
        targets.recoverable.length + targets.foreign.length === 0
          ? "no leftover state from prior runs"
          : `found ${targets.recoverable.length} recoverable and ${targets.foreign.length} foreign leftover run(s): ` +
            [...targets.recoverable, ...targets.foreign]
              .map((stale) => stale.environmentId)
              .join(", "),
    );
    // A leftover run against another deployment or relay is reported, never
    // cleaned from here: its marker file stays so the run keeps failing until
    // an operator clears it against the target it actually mutated.
    if (Option.isSome(leftovers)) {
      for (const stale of leftovers.value.foreign) {
        const commands = manualCleanupInstructions({ ...stale, stateDir: config.stateDir });
        fail(
          `recovery.foreignRun[${stale.environmentId}]`,
          `state file records deployment ${stale.deployment} at ${stale.relayBaseUrl}, but this ` +
            `run targets ${config.deployment} at ${relayBaseUrl}; recovering from here would ` +
            `sweep the wrong deployment. State file kept at ${commands.stateFile}. Clean it by ` +
            `hand: ${commands.convex} — and: ${commands.relay}`,
        );
      }
    }
    if (Option.isSome(leftovers) && leftovers.value.recoverable.length > 0) {
      const swept = yield* hookStep(
        "recovery.hooks.cleanupRegistration",
        config.hooks.cleanupRegistration(),
      );
      for (const stale of leftovers.value.recoverable) {
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

    /** Submits one domain operation and yields its receipt, matched by operation id. */
    const applyOne = (operation: ReturnType<typeof buildSmokeSyncOperation>) =>
      convexCall(() =>
        convexClient.mutation(api.sync.applyOperations, {
          companyId: config.companyId,
          operations: [operation],
        }),
      ).pipe(
        Effect.flatMap((result) => {
          const receipt = result.receipts.find(
            (entry) => entry.operationId === operation.operationId,
          );
          return receipt === undefined
            ? Effect.fail(
                new ConvexSyncSmokeError({
                  reason: `applyOperations returned ${result.receipts.length} receipt(s), none for operation ${operation.operationId}`,
                }),
              )
            : Effect.succeed(receipt);
        }),
      );

    /** Pages `listChanges` forward from `from` until `hasMore` clears, collecting every change. */
    const drainChanges = (from: number) =>
      Effect.gen(function* () {
        const changes: SyncChangeSummary[] = [];
        let cursor = from;
        for (let page = 1; page <= 10; page += 1) {
          const result = yield* convexCall(() =>
            convexClient.query(api.sync.listChanges, {
              companyId: config.companyId,
              cursor,
            }),
          );
          if (result._tag === "CursorExpired") {
            return yield* new ConvexSyncSmokeError({
              reason: `listChanges reported CursorExpired at head ${result.latestVersion} for cursor ${cursor}, taken from this run's own calls moments ago — retention cannot have pruned it, so the cursor accounting is broken`,
            });
          }
          changes.push(...result.changes);
          cursor = result.cursor;
          if (!result.hasMore) {
            return { pages: page, cursor, changes: changes as readonly SyncChangeSummary[] };
          }
        }
        return yield* new ConvexSyncSmokeError({
          reason:
            "listChanges still reported hasMore after 10 pages — the smoke company's feed should drain in far fewer",
        });
      });

    // (f2) A real write through the issue-domain apply handlers. `issueLabel`
    // is the smallest round-trippable entity (see SMOKE_LABEL_ENTITY_KIND);
    // the accepted receipt proves authorization (the smoke role's
    // `workflow.manage`) and the version stamp anchors the feed and bootstrap
    // assertions below.
    const labelEntityId = NodeCrypto.randomUUID();
    const created = yield* step(
      "convex.sync.applyOperations.createLabel",
      Effect.gen(function* () {
        const receipt = yield* applyOne(
          buildSmokeSyncOperation({
            operationId: NodeCrypto.randomUUID(),
            companyId: config.companyId,
            environmentId: config.environmentId,
            localSequence: 1,
            baseVersion,
            kind: "issueLabel.create",
            entityId: labelEntityId,
            args: SMOKE_LABEL_CREATE_ARGS,
          }),
        );
        if (receipt.status !== "accepted") {
          return yield* new ConvexSyncSmokeError({
            reason: `expected issueLabel.create to be accepted (the domain handlers are registered and the smoke role must grant workflow.manage), got rejected '${receipt.code}': ${receipt.message}`,
          });
        }
        if (receipt.lastVersion <= baseVersion) {
          return yield* new ConvexSyncSmokeError({
            reason: `the accepted create reports lastVersion ${receipt.lastVersion}, not past the base ${baseVersion} — no feed change can carry it`,
          });
        }
        return { headAfterCreate: receipt.lastVersion };
      }),
      (value) => `issueLabel ${labelEntityId} accepted, head at ${value.headAfterCreate}`,
    );

    yield* step(
      "convex.sync.listChanges",
      Effect.gen(function* () {
        const drained = yield* drainChanges(baseVersion);
        if (Option.isNone(created)) {
          return `drained ${drained.pages} page(s) to cursor ${drained.cursor} (no accepted create to look for)`;
        }
        const change = latestSyncChange(drained.changes, SMOKE_LABEL_ENTITY_KIND, labelEntityId);
        if (change === undefined) {
          return yield* new ConvexSyncSmokeError({
            reason: `the accepted issueLabel.create never surfaced in the feed: no ${SMOKE_LABEL_ENTITY_KIND} change for ${labelEntityId} among ${drained.changes.length} drained change(s)`,
          });
        }
        if (change.changeKind !== "upsert") {
          return yield* new ConvexSyncSmokeError({
            reason: `the label's feed change at version ${change.version} is a ${change.changeKind}, expected the create's upsert`,
          });
        }
        return `drained ${drained.pages} page(s) to cursor ${drained.cursor}; issueLabel upsert visible at version ${change.version}`;
      }),
      (detail) => detail,
    );

    // (f3) Snapshot seed, forced multi-page, with a write interleaved between
    // its pages. A seed that completes before anything else happens says
    // nothing about the one hazard the snapshot→feed handoff has, so:
    // page one is taken alone, a second label is created while the walk is
    // suspended, the walk then finishes from page one's ORIGINAL (opaque)
    // cursor, and the drain that resumes at page one's version must carry the
    // interleaved write exactly once. The seed's `version` is the resume
    // position a fresh client persists, so it also anchors the gap-free check
    // after the delete below.
    const interleavedLabelEntityId = NodeCrypto.randomUUID();
    const bootstrapped = yield* Effect.gen(function* () {
      const firstPage = yield* step(
        "convex.sync.bootstrap.firstPage",
        Effect.gen(function* () {
          const result = yield* convexCall(() =>
            convexClient.query(api.sync.bootstrap, {
              companyId: config.companyId,
              cursor: null,
              pageSize: SMOKE_BOOTSTRAP_PAGE_SIZE,
            }),
          );
          if (result.isDone || result.cursor === null) {
            return yield* new ConvexSyncSmokeError({
              reason: `bootstrap finished the seed in one ${SMOKE_BOOTSTRAP_PAGE_SIZE}-row page (isDone ${result.isDone}, ${result.cursor === null ? "null" : "non-null"} cursor, ${result.entities.length} entity(ies)) — with the label above in the company the walk must have more to deliver, and a single-page seed cannot exercise a mid-seed write`,
            });
          }
          return {
            snapshotVersion: result.version,
            cursor: result.cursor,
            entities: result.entities as readonly SyncChangeSummary[],
          };
        }),
        (value) =>
          `page 1 delivered ${value.entities.length} entity(ies) at snapshot version ${value.snapshotVersion}; the walk resumes from its cursor`,
      );
      if (Option.isNone(firstPage)) {
        for (const name of [
          "convex.sync.applyOperations.interleavedLabel",
          "convex.sync.bootstrap.finishAfterWrite",
          "convex.sync.bootstrap.interleavedWrite",
          "convex.sync.applyOperations.deleteInterleavedLabel",
        ]) {
          skip(name, "bootstrap page one did not complete");
        }
        return Option.none<{
          readonly version: number;
          readonly interleavedTombstoneVersion: Option.Option<number>;
        }>();
      }
      const snapshotVersion = firstPage.value.snapshotVersion;

      // The interleaved write itself: a second company-scoped label, created
      // while the seed sits between pages. It is deleted below, and its rows
      // are on `smoke:cleanup`'s `issueLabels` sweep either way.
      const interleaved = yield* step(
        "convex.sync.applyOperations.interleavedLabel",
        Effect.gen(function* () {
          const receipt = yield* applyOne(
            buildSmokeSyncOperation({
              operationId: NodeCrypto.randomUUID(),
              companyId: config.companyId,
              environmentId: config.environmentId,
              localSequence: 2,
              baseVersion: snapshotVersion,
              kind: "issueLabel.create",
              entityId: interleavedLabelEntityId,
              args: SMOKE_INTERLEAVED_LABEL_CREATE_ARGS,
            }),
          );
          if (receipt.status !== "accepted") {
            return yield* new ConvexSyncSmokeError({
              reason: `expected the interleaved issueLabel.create to be accepted, got rejected '${receipt.code}': ${receipt.message}`,
            });
          }
          if (receipt.lastVersion <= snapshotVersion) {
            return yield* new ConvexSyncSmokeError({
              reason: `the interleaved create reports lastVersion ${receipt.lastVersion}, not past the seed's snapshot version ${snapshotVersion} — it did not land mid-seed`,
            });
          }
          return { version: receipt.lastVersion };
        }),
        (value) =>
          `issueLabel ${interleavedLabelEntityId} created at version ${value.version}, between seed pages`,
      );

      // Finish the walk with page one's own cursor — treated as opaque, exactly
      // as a client must — and hold every page to page one's snapshot version.
      const finished = yield* step(
        "convex.sync.bootstrap.finishAfterWrite",
        Effect.gen(function* () {
          const laterEntities: SyncChangeSummary[] = [];
          const laterPageVersions: number[] = [];
          let cursor: string = firstPage.value.cursor;
          for (let page = 2; page <= SMOKE_BOOTSTRAP_MAX_PAGES; page += 1) {
            const result = yield* convexCall(() =>
              convexClient.query(api.sync.bootstrap, {
                companyId: config.companyId,
                cursor,
                pageSize: SMOKE_BOOTSTRAP_PAGE_SIZE,
              }),
            );
            laterPageVersions.push(result.version);
            laterEntities.push(...result.entities);
            // Checked per page rather than at the end, so a walk that drifts and
            // then fails to finish still reports the drift.
            const drift = checkBootstrapSnapshotVersions({ snapshotVersion, laterPageVersions });
            if (drift !== null) {
              return yield* new ConvexSyncSmokeError({ reason: drift });
            }
            if (result.isDone) {
              const seeded = latestSyncChange(
                [...firstPage.value.entities, ...laterEntities],
                SMOKE_LABEL_ENTITY_KIND,
                labelEntityId,
              );
              if (Option.isSome(created) && seeded === undefined) {
                return yield* new ConvexSyncSmokeError({
                  reason: `the issueLabel accepted before the seed is missing from the snapshot (${firstPage.value.entities.length + laterEntities.length} entities over ${page} page(s))`,
                });
              }
              return { pages: page, laterEntities: laterEntities as readonly SyncChangeSummary[] };
            }
            if (result.cursor === null) {
              return yield* new ConvexSyncSmokeError({
                reason:
                  "bootstrap reported isDone false with a null cursor — the walk cannot resume",
              });
            }
            cursor = result.cursor;
          }
          return yield* new ConvexSyncSmokeError({
            reason: `bootstrap still not done after ${SMOKE_BOOTSTRAP_MAX_PAGES} pages of ${SMOKE_BOOTSTRAP_PAGE_SIZE} row(s) — the smoke company holds a handful of rows, so the walk is not advancing`,
          });
        }),
        (value) =>
          `seed finished from page one's cursor over ${value.pages} page(s), every page pinned to snapshot version ${snapshotVersion}`,
      );

      if (Option.isSome(interleaved) && Option.isSome(finished)) {
        yield* step(
          "convex.sync.bootstrap.interleavedWrite",
          Effect.gen(function* () {
            const drained = yield* drainChanges(snapshotVersion);
            const mismatch = checkInterleavedWriteDelivery({
              entityKind: SMOKE_LABEL_ENTITY_KIND,
              entityId: interleavedLabelEntityId,
              writeVersion: interleaved.value.version,
              snapshotVersion,
              laterSnapshotEntities: finished.value.laterEntities,
              drainedChanges: drained.changes,
            });
            if (mismatch !== null) {
              return yield* new ConvexSyncSmokeError({ reason: mismatch });
            }
            const inSeed = syncChangesFor(
              finished.value.laterEntities,
              SMOKE_LABEL_ENTITY_KIND,
              interleavedLabelEntityId,
            ).length;
            const inDrain = syncChangesFor(
              drained.changes,
              SMOKE_LABEL_ENTITY_KIND,
              interleavedLabelEntityId,
            ).length;
            return `the write at version ${interleaved.value.version} landed between seed pages and arrives exactly once: ${inSeed} later seed page delivery(ies) + ${inDrain} drain delivery(ies), all stamped with that one version`;
          }),
          (detail) => detail,
        );
      } else {
        skip(
          "convex.sync.bootstrap.interleavedWrite",
          "no accepted interleaved write and finished seed to check",
        );
      }

      // The extra entity leaves through the same surface it arrived by, in the
      // flow, so a successful run adds no live row.
      let interleavedTombstoneVersion = Option.none<number>();
      if (Option.isSome(interleaved)) {
        const interleavedDeleted = yield* step(
          "convex.sync.applyOperations.deleteInterleavedLabel",
          Effect.gen(function* () {
            const receipt = yield* applyOne(
              buildSmokeSyncOperation({
                operationId: NodeCrypto.randomUUID(),
                companyId: config.companyId,
                environmentId: config.environmentId,
                localSequence: 3,
                baseVersion: interleaved.value.version,
                kind: "issueLabel.delete",
                entityId: interleavedLabelEntityId,
                args: {},
              }),
            );
            if (receipt.status !== "accepted") {
              return yield* new ConvexSyncSmokeError({
                reason: `expected the interleaved issueLabel.delete to be accepted, got rejected '${receipt.code}': ${receipt.message}`,
              });
            }
            return { tombstoneVersion: receipt.lastVersion };
          }),
          (value) =>
            `issueLabel ${interleavedLabelEntityId} tombstoned at version ${value.tombstoneVersion}`,
        );
        interleavedTombstoneVersion = Option.map(
          interleavedDeleted,
          (value) => value.tombstoneVersion,
        );
      } else {
        skip(
          "convex.sync.applyOperations.deleteInterleavedLabel",
          "the interleaved issueLabel.create was not accepted, so there is nothing to delete",
        );
      }

      return Option.some({ version: snapshotVersion, interleavedTombstoneVersion });
    });

    // (f4) Tombstone the label and prove the bootstrap resume position is
    // gap-free: a change written after the snapshot must surface when
    // listChanges resumes from the snapshot's version. This is also as much
    // cleanup as the sync surface offers — the authoritative row stays behind
    // as a tombstone until `smoke:cleanup` deletes the company.
    if (Option.isSome(created) && Option.isSome(bootstrapped)) {
      const snapshotVersion = bootstrapped.value.version;
      const deleted = yield* step(
        "convex.sync.applyOperations.deleteLabel",
        Effect.gen(function* () {
          const receipt = yield* applyOne(
            buildSmokeSyncOperation({
              operationId: NodeCrypto.randomUUID(),
              companyId: config.companyId,
              environmentId: config.environmentId,
              localSequence: 4,
              baseVersion: created.value.headAfterCreate,
              kind: "issueLabel.delete",
              entityId: labelEntityId,
              args: {},
            }),
          );
          if (receipt.status !== "accepted") {
            return yield* new ConvexSyncSmokeError({
              reason: `expected issueLabel.delete to be accepted, got rejected '${receipt.code}': ${receipt.message}`,
            });
          }
          if (receipt.lastVersion <= snapshotVersion) {
            return yield* new ConvexSyncSmokeError({
              reason: `the delete's version ${receipt.lastVersion} is not past the bootstrap snapshot ${snapshotVersion} — the resume check below would prove nothing`,
            });
          }
          return { tombstoneVersion: receipt.lastVersion };
        }),
        (value) => `issueLabel ${labelEntityId} tombstoned at version ${value.tombstoneVersion}`,
      );
      if (Option.isSome(deleted)) {
        yield* step(
          "convex.sync.resumeAfterBootstrap",
          Effect.gen(function* () {
            const drained = yield* drainChanges(snapshotVersion);
            const change = latestSyncChange(
              drained.changes,
              SMOKE_LABEL_ENTITY_KIND,
              labelEntityId,
            );
            if (change === undefined) {
              return yield* new ConvexSyncSmokeError({
                reason: `resuming listChanges from the bootstrap version ${snapshotVersion} never surfaced the tombstone written at ${deleted.value.tombstoneVersion} — the snapshot→feed handoff has a gap`,
              });
            }
            if (
              change.changeKind !== "tombstone" ||
              change.version !== deleted.value.tombstoneVersion
            ) {
              return yield* new ConvexSyncSmokeError({
                reason: `expected the ${SMOKE_LABEL_ENTITY_KIND} tombstone at version ${deleted.value.tombstoneVersion}, got a ${change.changeKind} at ${change.version}`,
              });
            }
            // The interleaved label leaves the same way; the run must end with
            // no live row it created.
            if (Option.isSome(bootstrapped.value.interleavedTombstoneVersion)) {
              const interleavedVersion = bootstrapped.value.interleavedTombstoneVersion.value;
              const interleavedChange = latestSyncChange(
                drained.changes,
                SMOKE_LABEL_ENTITY_KIND,
                interleavedLabelEntityId,
              );
              if (
                interleavedChange === undefined ||
                interleavedChange.changeKind !== "tombstone" ||
                interleavedChange.version !== interleavedVersion
              ) {
                return yield* new ConvexSyncSmokeError({
                  reason: `expected the interleaved ${SMOKE_LABEL_ENTITY_KIND} ${interleavedLabelEntityId} to end tombstoned at version ${interleavedVersion}, got ${
                    interleavedChange === undefined
                      ? "no change at all"
                      : `a ${interleavedChange.changeKind} at ${interleavedChange.version}`
                  }`,
                });
              }
            }
            return `listChanges from snapshot version ${snapshotVersion} yields the tombstone at ${change.version} — handoff is gap-free`;
          }),
          (detail) => detail,
        );
      } else {
        skip("convex.sync.resumeAfterBootstrap", "issueLabel.delete was not accepted");
      }
    } else {
      skip(
        "convex.sync.applyOperations.deleteLabel",
        "no accepted create and bootstrap to build on",
      );
      skip("convex.sync.resumeAfterBootstrap", "no accepted create and bootstrap to build on");
    }

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
