/**
 * Pure decision logic behind `convex/smoke.ts`, the internal-only seed/teardown functions for the
 * relay → Convex trust-chain smoke test.
 *
 * The smoke company lives at one reserved, deterministic domain id so re-runs converge on the same
 * rows and the admin functions can refuse — by construction — to touch anything else. Domain ids
 * are UUIDv7-shaped strings by convention (`contracts/company`), so the reserved ids keep that
 * shape: version nibble `7`, variant nibble `8`, with `736d6f6b65` ("smoke" in hex) marking them as
 * synthetic.
 *
 * Kept free of Convex imports so every rule here is unit testable without a deployment.
 *
 * @module smokeSeed
 */
import type { PermissionKey } from "./permissions.ts";
import { SYNC_ENTITY_KINDS } from "./sync/protocol.ts";
import { readPermissionForEntityKind } from "./sync/visibility.ts";

/** The one company the smoke functions will ever create, read, or delete. */
export const SMOKE_COMPANY_DOMAIN_ID = "00000000-0000-7000-8000-736d6f6b6501";

/** The single service role the smoke registration is granted. */
export const SMOKE_ROLE_DOMAIN_ID = "00000000-0000-7000-8000-736d6f6b6502";

/** Loud on purpose: anyone browsing the dashboard should see this is synthetic. */
export const SMOKE_COMPANY_NAME = "Smoke Test — relay e2e";

export const SMOKE_ISSUE_KEY_PREFIX = "SMK";

export const SMOKE_ROLE_NAME = "Smoke Service";

/**
 * Every environment the smoke harness registers has an id starting with this prefix (the harness
 * mints `env-smoke-<uuid>`; see `apps/server/src/cloud/convexSyncSmoke.ts` and
 * `docs/internals/cloud-sync-smoke.md`). Cleanup relies on it: a registration in the smoke company
 * whose environment id carries the prefix is synthetic by construction, so it can be swept even
 * when the run that seeded it was interrupted before its own teardown — once it has aged out (see
 * {@link isSweepableSmokeOrphan}, since the prefix alone cannot tell an orphan from a live run).
 */
export const SMOKE_ENVIRONMENT_ID_PREFIX = "env-smoke-";

/** True for the synthetic environment ids the harness mints; cleanup sweeps only these. */
export function isSmokeEnvironmentId(environmentId: string): boolean {
  return environmentId.startsWith(SMOKE_ENVIRONMENT_ID_PREFIX);
}

/**
 * How long an `env-smoke-*` registration must have sat untouched before cleanup may treat it as
 * residue from an interrupted run. The prefix alone cannot tell an orphan from the live
 * registration of a smoke still in flight — the runs share one reserved company — and sweeping a
 * live one deletes the company out from under it, failing a healthy run for no reason. A full run
 * takes seconds, so age settles it.
 */
export const SMOKE_ORPHAN_MIN_AGE_MS = 15 * 60 * 1_000;

/**
 * True when cleanup may sweep a registration as orphaned residue: a synthetic id *and* untouched
 * for at least {@link SMOKE_ORPHAN_MIN_AGE_MS}. Failing either test keeps the smoke company open
 * rather than deleting it — the conservative direction, because a genuine orphan is swept by the
 * next run once it ages out, while a wrongly swept one breaks a run in progress.
 */
export function isSweepableSmokeOrphan(input: {
  readonly environmentId: string;
  readonly updatedAt: number;
  readonly now: number;
}): boolean {
  return (
    isSmokeEnvironmentId(input.environmentId) &&
    input.now - input.updatedAt >= SMOKE_ORPHAN_MIN_AGE_MS
  );
}

export const SMOKE_ROLE_DESCRIPTION =
  "Service role for the relay e2e smoke test. Grants exactly what the sync and " +
  "environment-command surfaces require of an environment actor.";

/**
 * The identity half of the guard every smoke function applies before writing or deleting anything.
 * `convex/smoke.ts` pairs it with an exact {@link SMOKE_COMPANY_NAME} check: the id proves which
 * row was found, the marker name proves the smoke seed created it.
 */
export function isSmokeCompanyDomainId(companyDomainId: string): boolean {
  return companyDomainId === SMOKE_COMPANY_DOMAIN_ID;
}

/**
 * Exactly the switches the smoke run itself needs — no wider, because a role nobody audits is the
 * easiest place for an unearned grant to hide.
 *
 * `latestVersion` and `applyOperations` gate on the actor alone, and `listChanges` filters rows
 * through the per-entity-kind read permissions — so the read half is derived from that same map
 * rather than restated, and stays exact when the map changes. `environmentCommands.list` needs
 * `environments.read`, which the map already carries; `claim`/`renewClaim`/`reportStatus` gate on
 * the actor alone.
 *
 * `workflow.manage` is the one write switch: the harness's `issueLabel.create`/`delete` round trip
 * (`convexSyncSmoke.ts`) gates on it in `convex/lib/issueApply.ts`. It is deliberately not in
 * `COMPANY_ADMINISTRATION_PERMISSIONS`, so a plain role grant suffices.
 *
 * `remoteAgents.dispatch`/`remoteAgents.control` are deliberately absent: no step the harness runs
 * gates on either (`environmentCommands.issue` and `cancel` want `remoteAgents.dispatch`, and the
 * former is member-only anyway; nothing in the deployed surface reads `remoteAgents.control`).
 * They belong here only once a smoke step actually exercises them.
 */
export function smokeServiceRolePermissions(): readonly PermissionKey[] {
  const permissions = new Set<PermissionKey>();
  for (const kind of SYNC_ENTITY_KINDS) permissions.add(readPermissionForEntityKind(kind));
  permissions.add("workflow.manage");
  return [...permissions];
}

/** FNV-1a over UTF-16 code units: stable, dependency-free, and plenty for one synthetic id. */
function fnv1a32(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Deterministic UUIDv7-shaped domain id for the smoke registration of `environmentId`, so
 * re-seeding the same environment converges on the same row identity. The hash rides in the first
 * group, which the reserved company/role ids keep zeroed, so the three can never collide.
 */
export function smokeRegistrationDomainId(environmentId: string): string {
  const hash = fnv1a32(environmentId).toString(16).padStart(8, "0");
  return `${hash}-0000-7000-8000-736d6f6b65ee`;
}

/**
 * The storage shape of `ExecutionEnvironmentDescriptor` in `contracts/environment`, at its minimal
 * valid extent. Hand-mirrored because this package deliberately does not depend on the contracts
 * workspace; when the two disagree, this is what changes.
 */
export interface SmokeEnvironmentDescriptor {
  readonly environmentId: string;
  readonly label: string;
  readonly platform: { readonly os: "unknown"; readonly arch: "other" };
  readonly serverVersion: string;
  readonly capabilities: { readonly repositoryIdentity: boolean };
}

export function smokeDescriptor(environmentId: string): SmokeEnvironmentDescriptor {
  return {
    environmentId,
    label: "Smoke Test — relay e2e environment",
    platform: { os: "unknown", arch: "other" },
    serverVersion: "0.0.0-smoke",
    capabilities: { repositoryIdentity: false },
  };
}

/**
 * True when a caller-supplied identifier is usable as an exact-match key. Registrations are looked
 * up by exact `environmentId` and thumbprints compared byte-for-byte, so anything the caller would
 * have meant trimmed is refused rather than silently normalized into a row nobody can match.
 */
export function isUsableSmokeKey(value: string): boolean {
  return value.length > 0 && value === value.trim();
}
