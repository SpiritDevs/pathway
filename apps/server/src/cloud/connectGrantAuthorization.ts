/**
 * Target-side authorization for relay-validated connect grants.
 *
 * The relay proves that Convex issued and consumed a grant. It does not authorize the connection:
 * this environment independently resolves the membership and permission from its own completed
 * cloud-sync replica. A server with cloud sync disabled never opens the replica for this path and
 * refuses every connect grant because it has no local authorization state to consult.
 *
 * @module cloud/connectGrantAuthorization
 */
import type { EnvironmentId } from "@spiritdevs/contracts";
import {
  hasCompanyPermission,
  resolveEffectivePermissions,
  type CompanyRoleAssignmentGrant,
  type CompanyRoleGrant,
} from "@spiritdevs/contracts/company";
import {
  grantedCompanyPermissions,
  SyncCompanyPayload,
  SyncMembershipPayload,
  SyncRoleAssignmentPayload,
  SyncRolePayload,
} from "@spiritdevs/contracts/cloudSync";
import type { RelayValidatedConnectGrantIdentity } from "@spiritdevs/contracts/relay";
import {
  makeSqliteSyncStore,
  SYNC_BOOTSTRAP_GENERATION,
  type StoredSyncState,
} from "@spiritdevs/client-runtime/sync";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { resolveCloudSyncConfig } from "./syncDaemon.ts";
import { makeSyncSqliteExecutor } from "./syncSqliteExecutor.ts";

const decodeCompany = Schema.decodeUnknownOption(SyncCompanyPayload);
const decodeMembership = Schema.decodeUnknownOption(SyncMembershipPayload);
const decodeRole = Schema.decodeUnknownOption(SyncRolePayload);
const decodeRoleAssignment = Schema.decodeUnknownOption(SyncRoleAssignmentPayload);

function decodeRows<A extends { readonly id: string }>(
  replica: StoredSyncState,
  entityKind: "company" | "membership" | "role" | "roleAssignment",
  decode: (value: unknown) => Option.Option<A>,
): ReadonlyArray<A> | null {
  const decoded: A[] = [];
  for (const row of replica.entities) {
    if (row.entityKind !== entityKind) continue;
    const value = decode(row.payload);
    if (Option.isNone(value)) return null;
    if (value.value.id !== row.entityId) return null;
    decoded.push(value.value);
  }
  return decoded;
}

/** Pure target-side verdict over one durable replica snapshot. */
export function isConnectGrantAuthorizedByReplica(input: {
  readonly environmentId: EnvironmentId;
  readonly connectGrant: RelayValidatedConnectGrantIdentity;
  readonly replica: StoredSyncState;
}): boolean {
  if (input.connectGrant.environmentId !== input.environmentId) return false;

  const checkpoint = input.replica.checkpoint;
  if (
    checkpoint === null ||
    !checkpoint.bootstrapped ||
    checkpoint.bootstrapGeneration !== SYNC_BOOTSTRAP_GENERATION
  ) {
    return false;
  }

  const companies = decodeRows(input.replica, "company", decodeCompany);
  const memberships = decodeRows(input.replica, "membership", decodeMembership);
  const roles = decodeRows(input.replica, "role", decodeRole);
  const roleAssignments = decodeRows(input.replica, "roleAssignment", decodeRoleAssignment);
  if (companies === null || memberships === null || roles === null || roleAssignments === null) {
    return false;
  }

  const membership = memberships.find(
    (candidate) => candidate.id === input.connectGrant.membershipId,
  );
  if (membership?.state !== "active") return false;

  const company = companies.find((candidate) => candidate.id === checkpoint.companyId);
  if (company === undefined || company.lifecycleState !== "active") return false;

  const assigned = roleAssignments.filter(
    (assignment) => assignment.membershipId === membership.id,
  );
  const assignedRoleIds = new Set(assigned.map((assignment) => assignment.roleId));
  const permissionRoles: CompanyRoleGrant[] = roles
    .filter((role) => assignedRoleIds.has(role.id))
    .map((role) => ({
      id: role.id,
      permissions: grantedCompanyPermissions(role.permissions),
    }));
  const permissionAssignments: CompanyRoleAssignmentGrant[] = assigned.map((assignment) => ({
    roleId: assignment.roleId,
    scope: assignment.scope,
  }));
  const effective = resolveEffectivePermissions({
    isOwner: company.owners.some((owner) => owner.membershipId === membership.id),
    roles: permissionRoles,
    assignments: permissionAssignments,
  });

  return hasCompanyPermission(effective, input.connectGrant.permission);
}

/**
 * Reads the configured company's replica. Configuration, storage, and decoding failures all
 * collapse to the same refusal so the mint endpoint cannot disclose target authorization state.
 */
export const authorizeConnectGrantFromLocalReplica = Effect.fn(
  "environment.cloud.authorizeConnectGrant",
)(
  function* (input: {
    readonly environmentId: EnvironmentId;
    readonly connectGrant: RelayValidatedConnectGrantIdentity;
  }) {
    const configured = yield* resolveCloudSyncConfig;
    if (configured._tag !== "Configured") return false;

    const store = yield* makeSqliteSyncStore(yield* makeSyncSqliteExecutor);
    const replica = yield* store.service.read(configured.settings.companyId);
    return isConnectGrantAuthorizedByReplica({ ...input, replica });
  },
  Effect.catchCause(() => Effect.succeed(false)),
);
