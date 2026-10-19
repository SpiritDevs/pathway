/**
 * Argument validators shared by the public functions. Convex validates before the handler runs, so
 * these are the deployment's outermost contract.
 *
 * Every shape here mirrors `packages/contracts` — `cloudSync.ts` for the sync protocol,
 * `company.ts` for authorization — which is the source of truth. Convex validators are `v.*` values
 * and cannot import Effect Schema, so the mirror is hand-written; when the two disagree, this file
 * is what changes.
 *
 * Closed literal sets are deliberately *not* mirrored for `kind` and `code`. A batch carrying one
 * operation of an unknown kind must come back as a per-operation `unknown-operation` receipt, which
 * is what the contract's rejection codes describe; a literal union here would fail Convex's
 * argument validation and refuse the whole batch instead, taking the caller's other writes with it.
 * The closed sets are enforced in `src/sync/protocol.ts`, inside the handler.
 *
 * @module lib/validators
 */
import { v } from "convex/values";

/**
 * Client-generated UUIDv7 domain id. The contract brands these as trimmed non-empty strings, which
 * a Convex validator cannot express: `validateOperationBatch` in `src/sync/operations` holds the
 * envelope's `operationId` and `entityId` to that bound and refuses the batch as
 * `invalid-arguments` otherwise.
 */
export const domainIdArg = v.string();

/** `RepositoryIdentity` from `contracts/environment`. */
export const repositoryIdentityArg = v.object({
  canonicalKey: v.string(),
  locator: v.object({
    source: v.literal("git-remote"),
    remoteName: v.string(),
    remoteUrl: v.string(),
  }),
  rootPath: v.optional(v.string()),
  displayName: v.optional(v.string()),
  provider: v.optional(v.string()),
  owner: v.optional(v.string()),
  name: v.optional(v.string()),
});

/** `SyncActor` from `contracts/cloudSync`. */
export const syncActorArg = v.union(
  v.object({ kind: v.literal("member"), membershipId: domainIdArg }),
  v.object({
    kind: v.literal("agent"),
    provider: v.string(),
    onBehalfOfMembershipId: v.union(domainIdArg, v.null()),
  }),
  v.object({
    kind: v.literal("system"),
    source: v.union(
      v.literal("import"),
      v.literal("cycles"),
      v.literal("slack"),
      v.literal("automation"),
    ),
  }),
  v.object({ kind: v.literal("environment"), environmentId: v.string() }),
);

/** `SyncOperationEnvelope` from `contracts/cloudSync`. */
export const syncOperationArg = v.object({
  protocolVersion: v.number(),
  operationId: v.string(),
  companyId: domainIdArg,
  clientId: v.string(),
  environmentId: v.union(v.string(), v.null()),
  /**
   * Requested attribution. Convex maps ordinary claims back to the authenticated identity; only
   * an environment-bound operation may deliberately name a system source.
   */
  actor: syncActorArg,
  localSequence: v.number(),
  baseVersion: v.number(),
  kind: v.string(),
  entityId: domainIdArg,
  args: v.any(),
  dependsOn: v.array(v.string()),
});

/** `SyncChangeEnvelope` from `contracts/cloudSync`. */
export const syncChangeResult = v.object({
  version: v.number(),
  entityKind: v.string(),
  entityId: domainIdArg,
  changeKind: v.union(v.literal("upsert"), v.literal("tombstone")),
  payload: v.any(),
});

/**
 * `SyncOperationReceipt` from `contracts/cloudSync`. `status` is the operation's real outcome and
 * `duplicate` says only whether the answer replayed a stored receipt, so a resend of a rejected
 * operation still comes back rejected.
 */
export const operationReceiptResult = v.union(
  v.object({
    operationId: v.string(),
    status: v.literal("accepted"),
    duplicate: v.boolean(),
    firstVersion: v.number(),
    lastVersion: v.number(),
  }),
  v.object({
    operationId: v.string(),
    status: v.literal("rejected"),
    duplicate: v.boolean(),
    code: v.string(),
    message: v.string(),
  }),
);

/**
 * `RoleAssignmentScope` from `contracts/company`. Tagged on the wire so a team-scoped assignment
 * cannot arrive without its team; the `roleAssignments` table splits it into a literal plus a
 * nullable column for indexing, and that split is storage-only.
 */
export const roleAssignmentScopeArg = v.union(
  v.object({ kind: v.literal("company") }),
  v.object({ kind: v.literal("team"), teamId: domainIdArg }),
);

/** `CompanyRoleAssignmentGrant` from `contracts/company`. */
export const roleAssignmentArg = v.object({
  roleId: domainIdArg,
  scope: roleAssignmentScopeArg,
});
