// @effect-diagnostics globalDate:off -- Convex mutations are not Effect programs; the transaction clock is `Date.now()`.
/**
 * Roles and role assignments.
 *
 * Roles are allow-only permission bundles; effective permission is the OR-union of every
 * applicable company- and team-scoped assignment, resolved by `src/permissions.ts`. Ownership is
 * deliberately not a role — it is a relation that passes every check and cannot be edited.
 *
 * Administration is **online-only**, and every write appends to the change feed through
 * `lib/companyApply` so replicas can render the role editor and a member's grants offline.
 *
 * The epoch rule is sharper here than anywhere else in the company domain, because this is the file
 * that decides who may read what. Anything that changes a *resolved* grant bumps
 * `authorizationEpoch` and forces every replica to reseed: editing a role's permission set,
 * deleting a role, assigning, unassigning. Anything that cannot change one bumps nothing: creating
 * a role (nobody holds it yet) and renaming one (the switches are unchanged). The distinction is
 * worth drawing precisely — a bump costs every client its entire replica, issue database included.
 *
 * @module roles
 */
import { v } from "convex/values";

import { isPermissionKey, PERMISSIONS, SEED_ROLES } from "../src/permissions.ts";
import { SYNC_MAX_ID_CHARS } from "../src/sync/operations.ts";
import type { Doc, Id } from "./_generated/dataModel.js";
import { mutation, query, type QueryCtx } from "./_generated/server.js";
import {
  appendCompanyChanges,
  encodeRole,
  encodeRoleAssignment,
  type CompanyChange,
} from "./lib/companyApply.ts";
import { backendError } from "./lib/errors.ts";
import {
  actorRecord,
  requireCompanyActor,
  requireOrganizationWorkspace,
  requirePermission,
} from "./lib/identity.ts";
import { domainIdArg, roleAssignmentArg } from "./lib/validators.ts";

const roleSummary = v.object({
  id: domainIdArg,
  name: v.string(),
  description: v.string(),
  permissions: v.array(v.string()),
  seeded: v.boolean(),
});

/**
 * How many assignments {@link remove} will cascade through in one transaction. A role handed to
 * every member of a large company is past what a Convex mutation may write — two writes per
 * assignment, the delete and its feed row — and a half-applied cascade is a role that is gone with
 * grants still resolving through it. So the bound is checked up front and the caller is told to
 * unassign in batches rather than discovering the ceiling as a failed transaction.
 */
const ROLE_REMOVE_MAX_ASSIGNMENTS = 500;

/** The switch catalog the role editor renders. Static, so it needs no company scope. */
export const availablePermissions = query({
  args: {},
  returns: v.array(v.string()),
  handler: async () => {
    return [...PERMISSIONS];
  },
});

/** The Admin/Manager/Member bundles seeded into every new company. */
export const seedRoleTemplates = query({
  args: {},
  returns: v.array(
    v.object({
      key: v.string(),
      name: v.string(),
      description: v.string(),
      permissions: v.array(v.string()),
    }),
  ),
  handler: async () => {
    return SEED_ROLES.map((role) => ({
      key: role.key,
      name: role.name,
      description: role.description,
      permissions: [...role.permissions],
    }));
  },
});

export const list = query({
  args: { companyId: domainIdArg },
  returns: v.array(roleSummary),
  handler: async (ctx, args) => {
    const actor = await requireCompanyActor(ctx, args.companyId);
    requirePermission(actor, "roles.read");
    const roles = await ctx.db
      .query("roles")
      .withIndex("by_company", (q) => q.eq("companyId", actor.company._id))
      .collect();
    return roles.map((role) => ({
      id: role.id,
      name: role.name,
      description: role.description,
      permissions: role.permissions,
      seeded: role.seeded,
    }));
  },
});

/** Rejects unknown switches outright: a role that silently drops a permission is a support case. */
function assertKnownPermissions(permissions: readonly string[]): void {
  for (const permission of permissions) {
    if (!isPermissionKey(permission)) {
      throw backendError("invalid-arguments", `Unknown permission ${permission}.`);
    }
  }
}

/**
 * Holds a client-minted domain id to the bound `validateOperationBatch` applies to the sync
 * envelope, which `v.string()` cannot express. The empty string is the one that matters: the
 * bootstrap walk pages ascending by domain id from an exclusive `""`, so a row keyed by it would
 * reach connected replicas through the feed and never appear in a fresh device's seed.
 */
function assertDomainId(value: string, what: string): void {
  if (value.length === 0 || value.length > SYNC_MAX_ID_CHARS || value.trim() !== value) {
    throw backendError(
      "invalid-arguments",
      `${what} must be a trimmed, non-empty id of at most ${SYNC_MAX_ID_CHARS} characters.`,
    );
  }
}

/** Order-insensitive and duplicate-insensitive: the union is what resolution actually reads. */
function samePermissionSet(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  if (left.size !== right.size) return false;
  for (const permission of left) if (!right.has(permission)) return false;
  return true;
}

/** Stored de-duplicated, in the order given: a repeated switch grants nothing twice. */
function normalizePermissions(permissions: readonly string[]): string[] {
  return [...new Set(permissions)];
}

function roleByDomainId(
  ctx: QueryCtx,
  companyId: Id<"companies">,
  roleId: string,
): Promise<Doc<"roles"> | null> {
  return ctx.db
    .query("roles")
    .withIndex("by_company_and_domain_id", (q) => q.eq("companyId", companyId).eq("id", roleId))
    .unique();
}

async function requireRole(
  ctx: QueryCtx,
  companyId: Id<"companies">,
  roleId: string,
): Promise<Doc<"roles">> {
  const role = await roleByDomainId(ctx, companyId, roleId);
  if (role === null) throw backendError("entity-not-found", `No role ${roleId} in this company.`);
  return role;
}

function assignmentByDomainId(
  ctx: QueryCtx,
  companyId: Id<"companies">,
  assignmentId: string,
): Promise<Doc<"roleAssignments"> | null> {
  return ctx.db
    .query("roleAssignments")
    .withIndex("by_company_and_domain_id", (q) =>
      q.eq("companyId", companyId).eq("id", assignmentId),
    )
    .unique();
}

export const create = mutation({
  args: {
    companyId: domainIdArg,
    id: domainIdArg,
    name: v.string(),
    description: v.optional(v.string()),
    permissions: v.array(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const actor = await requireCompanyActor(ctx, args.companyId);
    requireOrganizationWorkspace(actor);
    requirePermission(actor, "roles.manage");
    assertKnownPermissions(args.permissions);
    if (args.name.trim().length === 0) {
      throw backendError("invalid-arguments", "A role needs a name.");
    }
    assertDomainId(args.id, "A role id");
    if ((await roleByDomainId(ctx, actor.company._id, args.id)) !== null) {
      throw backendError("invalid-arguments", `A role ${args.id} already exists.`);
    }

    const now = Date.now();
    const roleDocId = await ctx.db.insert("roles", {
      id: args.id,
      companyId: actor.company._id,
      name: args.name.trim(),
      description: args.description ?? "",
      permissions: normalizePermissions(args.permissions),
      // `seeded` is provenance: it marks the Admin/Manager/Member bundles a company is created
      // with. A role authored here is not one of those however identical its switches.
      seeded: false,
      createdAt: now,
      updatedAt: now,
    });
    const role = await ctx.db.get(roleDocId);
    if (role === null) throw backendError("entity-not-found", "The new role vanished.");

    // No epoch bump: an unassigned role is a definition nobody resolves through, so no replica's
    // authorization has moved and none of them needs to throw its data away.
    await appendCompanyChanges(ctx, {
      companyId: actor.company._id,
      actor: actorRecord(actor),
      changes: [
        {
          entityKind: "role",
          entityId: role.id,
          changeKind: "upsert",
          versionDocId: roleDocId,
          payload: encodeRole(role),
        },
      ],
    });
    return null;
  },
});

export const update = mutation({
  args: {
    companyId: domainIdArg,
    roleId: domainIdArg,
    name: v.optional(v.string()),
    description: v.optional(v.string()),
    permissions: v.optional(v.array(v.string())),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const actor = await requireCompanyActor(ctx, args.companyId);
    requireOrganizationWorkspace(actor);
    requirePermission(actor, "roles.manage");
    if (args.permissions !== undefined) assertKnownPermissions(args.permissions);
    if (
      args.name === undefined &&
      args.description === undefined &&
      args.permissions === undefined
    ) {
      throw backendError(
        "invalid-arguments",
        "An update needs a name, description, or permissions.",
      );
    }
    if (args.name !== undefined && args.name.trim().length === 0) {
      throw backendError("invalid-arguments", "A role needs a name.");
    }
    const role = await requireRole(ctx, actor.company._id, args.roleId);

    const now = Date.now();
    const patch: {
      name?: string;
      description?: string;
      permissions?: string[];
      updatedAt: number;
    } = { updatedAt: now };
    if (args.name !== undefined) patch.name = args.name.trim();
    if (args.description !== undefined) patch.description = args.description;
    if (args.permissions !== undefined) patch.permissions = normalizePermissions(args.permissions);
    await ctx.db.patch(role._id, patch);

    // An edited role changes who can read what — but only when the *switches* changed. A rename
    // resolves to exactly the permissions it did a moment ago, and charging every client a full
    // reseed for a typo fix is a real cost paid for nothing.
    const permissionsChanged =
      patch.permissions !== undefined && !samePermissionSet(role.permissions, patch.permissions);

    await appendCompanyChanges(ctx, {
      companyId: actor.company._id,
      actor: actorRecord(actor),
      changes: [
        {
          entityKind: "role",
          entityId: role.id,
          changeKind: "upsert",
          versionDocId: role._id,
          payload: encodeRole({ ...role, ...patch }),
        },
      ],
      bumpEpoch: permissionsChanged,
    });
    return null;
  },
});

/**
 * Deletes a role and every assignment of it, in one transaction.
 *
 * Cascading rather than refusing while assignments exist: the two states a caller could be left in
 * by a guard — a role they cannot delete, or a list of assignments they must hunt down first — are
 * both worse than the atomic answer, and an orphaned assignment is unresolvable anyway
 * (`resolveEffectivePermissions` skips an assignment whose role it cannot find, so the grant is
 * already gone the moment the role is). Doing it here means every replica learns through a
 * tombstone per assignment instead of quietly holding rows that name nothing.
 *
 * Seeded roles are deletable. The `seeded` flag is provenance, not protection, and ownership — not
 * a role — is what guarantees a company always has somebody who can administer it.
 */
export const remove = mutation({
  args: { companyId: domainIdArg, roleId: domainIdArg },
  returns: v.null(),
  handler: async (ctx, args) => {
    const actor = await requireCompanyActor(ctx, args.companyId);
    requireOrganizationWorkspace(actor);
    requirePermission(actor, "roles.manage");
    const role = await requireRole(ctx, actor.company._id, args.roleId);

    // One over the ceiling is enough to know the cascade is too large to be atomic.
    const assignments = await ctx.db
      .query("roleAssignments")
      .withIndex("by_role", (q) => q.eq("roleId", role._id))
      .take(ROLE_REMOVE_MAX_ASSIGNMENTS + 1);
    if (assignments.length > ROLE_REMOVE_MAX_ASSIGNMENTS) {
      throw backendError(
        "invalid-arguments",
        `This role has more than ${ROLE_REMOVE_MAX_ASSIGNMENTS} assignments; unassign it before deleting it.`,
      );
    }

    const changes: CompanyChange[] = [];
    for (const assignment of assignments) {
      await ctx.db.delete(assignment._id);
      changes.push({
        entityKind: "roleAssignment",
        entityId: assignment.id,
        changeKind: "tombstone",
        versionDocId: null,
        payload: null,
      });
    }
    await ctx.db.delete(role._id);
    // The role's tombstone comes last, after the assignments that named it: a replica folding the
    // page in order never holds an assignment pointing at a role it has already dropped.
    changes.push({
      entityKind: "role",
      entityId: role.id,
      changeKind: "tombstone",
      versionDocId: null,
      payload: null,
    });

    await appendCompanyChanges(ctx, {
      companyId: actor.company._id,
      actor: actorRecord(actor),
      changes,
      // Unconditional, even with no assignments: a role can be re-created under the same domain id,
      // and a replica that kept resolving the old switch set would outlive the deletion.
      bumpEpoch: true,
    });
    return null;
  },
});

/**
 * Assigns a role to a membership, company-wide or within one team.
 *
 * A team-scoped assignment never grants company administration, no matter what the role contains;
 * that carve-out lives in `resolveEffectivePermissions` so every read path shares it.
 */
export const assign = mutation({
  args: {
    companyId: domainIdArg,
    /**
     * The assignment's own domain id, minted by the caller like every other `create` here. Server
     * minting was the alternative and is worse: the id is a change-feed entity id, so it has to be
     * the same on a retry, and only the caller knows whether this is a retry.
     */
    id: domainIdArg,
    membershipId: domainIdArg,
    assignment: roleAssignmentArg,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const actor = await requireCompanyActor(ctx, args.companyId);
    requireOrganizationWorkspace(actor);
    requirePermission(actor, "roles.manage");
    assertDomainId(args.id, "A role assignment id");

    const membership = await ctx.db
      .query("memberships")
      .withIndex("by_company_and_domain_id", (q) =>
        q.eq("companyId", actor.company._id).eq("id", args.membershipId),
      )
      .unique();
    if (membership === null) {
      throw backendError("entity-not-found", `No membership ${args.membershipId} in this company.`);
    }
    if (membership.state !== "active") {
      throw backendError("invalid-arguments", "That membership is not active.");
    }
    const role = await requireRole(ctx, actor.company._id, args.assignment.roleId);

    // A team-scoped assignment cannot arrive without its team: the scope is tagged on the wire,
    // matching `RoleAssignmentScope` in the contracts, so the validator has already refused that.
    // What the validator cannot check is that the team is this company's and still live.
    const teamId = args.assignment.scope.kind === "team" ? args.assignment.scope.teamId : null;
    if (teamId !== null) {
      const team = await ctx.db
        .query("teams")
        .withIndex("by_company_and_domain_id", (q) =>
          q.eq("companyId", actor.company._id).eq("id", teamId),
        )
        .unique();
      if (team === null) {
        throw backendError("entity-not-found", `No team ${teamId} in this company.`);
      }
      if (team.archivedAt !== null) {
        throw backendError("invalid-arguments", "An archived team does not take new grants.");
      }
    }

    // The same grant twice is one grant. Refusing a second id for a triple that already resolves
    // keeps `unassign` meaningful: one id to revoke, not an unknown number of duplicates that each
    // keep the permission alive.
    const existing = await ctx.db
      .query("roleAssignments")
      .withIndex("by_membership", (q) => q.eq("membershipId", membership._id))
      .collect();
    for (const candidate of existing) {
      if (candidate.roleId !== role._id) continue;
      if (candidate.scope !== args.assignment.scope.kind) continue;
      if (candidate.teamId !== teamId) continue;
      // A retry under the same id is the caller's own write arriving twice: nothing to do, and no
      // epoch bump for it.
      if (candidate.id === args.id) return null;
      throw backendError("invalid-arguments", "That role is already assigned at this scope.");
    }
    if ((await assignmentByDomainId(ctx, actor.company._id, args.id)) !== null) {
      throw backendError("invalid-arguments", `A role assignment ${args.id} already exists.`);
    }

    const now = Date.now();
    const assignmentDocId = await ctx.db.insert("roleAssignments", {
      id: args.id,
      companyId: actor.company._id,
      membershipId: membership._id,
      roleId: role._id,
      // Storage splits the tagged scope into a discriminator plus a nullable team so both
      // "everything for this membership" and "everything through this team" are index reads; the
      // encoder re-joins them for the wire.
      scope: args.assignment.scope.kind,
      teamId,
      createdAt: now,
    });
    const assignment = await ctx.db.get(assignmentDocId);
    if (assignment === null) {
      throw backendError("entity-not-found", "The new role assignment vanished.");
    }

    await appendCompanyChanges(ctx, {
      companyId: actor.company._id,
      actor: actorRecord(actor),
      changes: [
        {
          entityKind: "roleAssignment",
          entityId: assignment.id,
          changeKind: "upsert",
          versionDocId: assignmentDocId,
          payload: await encodeRoleAssignment(ctx, assignment),
        },
      ],
      bumpEpoch: true,
    });
    return null;
  },
});

export const unassign = mutation({
  args: { companyId: domainIdArg, assignmentId: domainIdArg },
  returns: v.null(),
  handler: async (ctx, args) => {
    const actor = await requireCompanyActor(ctx, args.companyId);
    requireOrganizationWorkspace(actor);
    requirePermission(actor, "roles.manage");

    const assignment = await assignmentByDomainId(ctx, actor.company._id, args.assignmentId);
    // Already revoked: replicas learn assignments from this same feed, so a row that is gone here
    // is a row no replica holds. Announcing it again would cost a company-wide reseed for nothing.
    if (assignment === null) return null;

    await ctx.db.delete(assignment._id);
    await appendCompanyChanges(ctx, {
      companyId: actor.company._id,
      actor: actorRecord(actor),
      changes: [
        {
          entityKind: "roleAssignment",
          entityId: assignment.id,
          changeKind: "tombstone",
          versionDocId: null,
          payload: null,
        },
      ],
      // The revocation itself. Without the bump a client keeps serving records offline that it may
      // no longer read, because nothing else tells it to purge them.
      bumpEpoch: true,
    });
    return null;
  },
});
