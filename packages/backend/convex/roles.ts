/**
 * Roles and role assignments.
 *
 * Roles are allow-only permission bundles; effective permission is the OR-union of every
 * applicable company- and team-scoped assignment, resolved by `src/permissions.ts`. Ownership is
 * deliberately not a role — it is a relation that passes every check and cannot be edited.
 *
 * @module roles
 */
import { v } from "convex/values";

import { isPermissionKey, PERMISSIONS, SEED_ROLES } from "../src/permissions.ts";
import { mutation, query } from "./_generated/server.js";
import { requireCloudSyncEnabled } from "./lib/capability.ts";
import { backendError, notImplemented } from "./lib/errors.ts";
import { requireCompanyActor, requirePermission } from "./lib/identity.ts";
import { domainIdArg, roleAssignmentArg } from "./lib/validators.ts";

const roleSummary = v.object({
  id: domainIdArg,
  name: v.string(),
  description: v.string(),
  permissions: v.array(v.string()),
  seeded: v.boolean(),
});

/** The switch catalog the role editor renders. Static, so it needs no company scope. */
export const availablePermissions = query({
  args: {},
  returns: v.array(v.string()),
  handler: async () => {
    requireCloudSyncEnabled();
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
    requireCloudSyncEnabled();
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
    requireCloudSyncEnabled();
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
    requireCloudSyncEnabled();
    const actor = await requireCompanyActor(ctx, args.companyId);
    requirePermission(actor, "roles.manage");
    assertKnownPermissions(args.permissions);
    // TODO(phase 2): insert the role and append the `role` change.
    return notImplemented("roles.create");
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
    requireCloudSyncEnabled();
    const actor = await requireCompanyActor(ctx, args.companyId);
    requirePermission(actor, "roles.manage");
    if (args.permissions !== undefined) assertKnownPermissions(args.permissions);
    // TODO(phase 2): patch the role, bump the epoch — an edited role changes who can read what.
    return notImplemented("roles.update");
  },
});

export const remove = mutation({
  args: { companyId: domainIdArg, roleId: domainIdArg },
  returns: v.null(),
  handler: async (ctx, args) => {
    requireCloudSyncEnabled();
    const actor = await requireCompanyActor(ctx, args.companyId);
    requirePermission(actor, "roles.manage");
    void args;
    // TODO(phase 2): delete the role and its assignments together, then bump the epoch.
    return notImplemented("roles.remove");
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
    membershipId: domainIdArg,
    assignment: roleAssignmentArg,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    requireCloudSyncEnabled();
    const actor = await requireCompanyActor(ctx, args.companyId);
    requirePermission(actor, "roles.manage");
    // A team-scoped assignment cannot arrive without its team: the scope is tagged on the wire,
    // matching `RoleAssignmentScope` in the contracts, so the validator has already refused that.
    // TODO(phase 2): insert the assignment, bump the epoch, append the change.
    return notImplemented("roles.assign");
  },
});

export const unassign = mutation({
  args: { companyId: domainIdArg, assignmentId: domainIdArg },
  returns: v.null(),
  handler: async (ctx, args) => {
    requireCloudSyncEnabled();
    const actor = await requireCompanyActor(ctx, args.companyId);
    requirePermission(actor, "roles.manage");
    void args;
    return notImplemented("roles.unassign");
  },
});
