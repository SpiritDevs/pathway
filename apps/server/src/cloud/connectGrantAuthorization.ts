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
  type CloudUserId,
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
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { getOrCreateCloudSyncDpopKeyPairFromSecretStore } from "./environmentKeys.ts";
import {
  discoverCloudSyncCompanyIds,
  makeCloudSyncTokenProvider,
  resolveCloudSyncConfig,
} from "./syncDaemon.ts";
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
  return resolveConnectGrantActorFromReplica(input) !== null;
}

/**
 * Resolves a grant against the environment's currently registered company replicas.
 *
 * Membership ids are globally unique, but duplicate authorization is still treated as ambiguous
 * so corrupted or crossed replicas cannot silently choose an authority boundary.
 */
export function resolveConnectGrantActorFromReplicas(input: {
  readonly environmentId: EnvironmentId;
  readonly connectGrant: RelayValidatedConnectGrantIdentity;
  readonly replicas: ReadonlyArray<StoredSyncState>;
}): CloudUserId | null {
  let resolved: CloudUserId | null = null;
  for (const replica of input.replicas) {
    const actor = resolveConnectGrantActorFromReplica({ ...input, replica });
    if (actor === null) continue;
    if (resolved !== null) return null;
    resolved = actor;
  }
  return resolved;
}

/**
 * Resolves the user whose authority a validated grant represents only after applying every
 * target-side replica check. Returning the user from the membership row keeps the relay's service
 * subject out of user-shaped authorization paths.
 */
export function resolveConnectGrantActorFromReplica(input: {
  readonly environmentId: EnvironmentId;
  readonly connectGrant: RelayValidatedConnectGrantIdentity;
  readonly replica: StoredSyncState;
}): CloudUserId | null {
  if (input.connectGrant.environmentId !== input.environmentId) return null;

  const checkpoint = input.replica.checkpoint;
  if (
    checkpoint === null ||
    !checkpoint.bootstrapped ||
    checkpoint.bootstrapGeneration !== SYNC_BOOTSTRAP_GENERATION
  ) {
    return null;
  }

  const companies = decodeRows(input.replica, "company", decodeCompany);
  const memberships = decodeRows(input.replica, "membership", decodeMembership);
  const roles = decodeRows(input.replica, "role", decodeRole);
  const roleAssignments = decodeRows(input.replica, "roleAssignment", decodeRoleAssignment);
  if (companies === null || memberships === null || roles === null || roleAssignments === null) {
    return null;
  }

  const membership = memberships.find(
    (candidate) => candidate.id === input.connectGrant.membershipId,
  );
  if (membership?.state !== "active") return null;

  const company = companies.find((candidate) => candidate.id === checkpoint.companyId);
  if (company === undefined || company.lifecycleState !== "active") return null;

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

  return hasCompanyPermission(effective, input.connectGrant.permission) ? membership.userId : null;
}

/**
 * Resolves the grant's acting user by scanning only companies Convex currently registers for this
 * environment. Configuration, discovery, storage, and decoding failures all collapse to the same
 * refusal so the mint endpoint cannot disclose target authorization state.
 */
export const resolveConnectGrantActorFromLocalReplica = Effect.fn(
  "environment.cloud.resolveConnectGrantActor",
)(
  function* (input: {
    readonly environmentId: EnvironmentId;
    readonly connectGrant: RelayValidatedConnectGrantIdentity;
  }) {
    const configured = yield* resolveCloudSyncConfig;
    if (configured._tag !== "Configured") return null;

    const secrets = yield* ServerSecretStore.ServerSecretStore;
    const dpopKeys = yield* getOrCreateCloudSyncDpopKeyPairFromSecretStore(secrets);
    const tokens = yield* makeCloudSyncTokenProvider({
      environmentId: input.environmentId,
      secrets,
      dpopKeys,
    });
    const companyIds = yield* discoverCloudSyncCompanyIds({
      convexUrl: configured.settings.convexUrl,
      tokens,
    });
    const store = yield* makeSqliteSyncStore(yield* makeSyncSqliteExecutor);
    const replicas = yield* Effect.forEach(companyIds, store.service.read, { concurrency: 4 });
    return resolveConnectGrantActorFromReplicas({ ...input, replicas });
  },
  Effect.catchCause((cause) =>
    Cause.hasInterrupts(cause)
      ? Effect.failCause(cause as Cause.Cause<never>)
      : Effect.succeed(null),
  ),
);

/** Boolean authorization verdict over the same fail-closed multi-company replica scan. */
export const authorizeConnectGrantFromLocalReplica = Effect.fn(
  "environment.cloud.authorizeConnectGrant",
)(
  (input: {
    readonly environmentId: EnvironmentId;
    readonly connectGrant: RelayValidatedConnectGrantIdentity;
  }) => resolveConnectGrantActorFromLocalReplica(input).pipe(Effect.map((actor) => actor !== null)),
);
