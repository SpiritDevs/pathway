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
 * whose environment id carries the prefix is synthetic by construction and safe to sweep even when
 * the run that seeded it was interrupted before its own teardown.
 */
export const SMOKE_ENVIRONMENT_ID_PREFIX = "env-smoke-";

/** True for the synthetic environment ids the harness mints; cleanup sweeps exactly these. */
export function isSmokeEnvironmentId(environmentId: string): boolean {
  return environmentId.startsWith(SMOKE_ENVIRONMENT_ID_PREFIX);
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
 * Exactly the switches the sync surface and `environmentCommands` require of an environment actor,
 * plus the two remote-agent switches the smoke test exercises.
 *
 * `latestVersion` and `applyOperations` gate on the actor alone, and `listChanges` filters rows
 * through the per-entity-kind read permissions — so the read half is derived from that same map
 * rather than restated, and stays exact when the map changes. `environmentCommands.list` needs
 * `environments.read`, which the map already carries; `claim`/`renewClaim`/`reportStatus` gate on
 * the actor alone.
 */
export function smokeServiceRolePermissions(): readonly PermissionKey[] {
  const permissions = new Set<PermissionKey>();
  for (const kind of SYNC_ENTITY_KINDS) permissions.add(readPermissionForEntityKind(kind));
  permissions.add("remoteAgents.dispatch");
  permissions.add("remoteAgents.control");
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
