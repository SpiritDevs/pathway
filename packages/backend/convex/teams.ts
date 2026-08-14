/**
 * Team administration.
 *
 * A team is a visibility scope as much as a group: removing one from a record has to atomically
 * clear the team-scoped labels, cycles, workflow ownership, and project references that record
 * would otherwise keep pointing at.
 *
 * @module teams
 */
import { v } from "convex/values";

import { mutation, query } from "./_generated/server.js";
import { requireCloudSyncEnabled } from "./lib/capability.ts";
import { backendError, notImplemented } from "./lib/errors.ts";
import { requireCompanyActor, requirePermission } from "./lib/identity.ts";
import { domainIdArg } from "./lib/validators.ts";

const teamSummary = v.object({
  id: domainIdArg,
  name: v.string(),
  description: v.string(),
  memberCount: v.number(),
  archivedAt: v.union(v.number(), v.null()),
});

export const list = query({
  args: { companyId: domainIdArg },
  returns: v.array(teamSummary),
  handler: async (ctx, args) => {
    requireCloudSyncEnabled();
    const actor = await requireCompanyActor(ctx, args.companyId);
    requirePermission(actor, "teams.read");
    // TODO(phase 2): list teams with their member counts under a bounded read.
    return notImplemented("teams.list");
  },
});

export const create = mutation({
  args: {
    companyId: domainIdArg,
    id: domainIdArg,
    name: v.string(),
    description: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    requireCloudSyncEnabled();
    const actor = await requireCompanyActor(ctx, args.companyId);
    requirePermission(actor, "teams.manage");
    if (args.name.trim().length === 0) {
      throw backendError("invalid-arguments", "A team needs a name.");
    }
    // TODO(phase 2): insert the team, bump the epoch, append the `team` change.
    return notImplemented("teams.create");
  },
});

export const update = mutation({
  args: {
    companyId: domainIdArg,
    teamId: domainIdArg,
    name: v.optional(v.string()),
    description: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    requireCloudSyncEnabled();
    const actor = await requireCompanyActor(ctx, args.companyId);
    requirePermission(actor, "teams.manage");
    void args;
    return notImplemented("teams.update");
  },
});

/**
 * Archives a team.
 *
 * TODO(phase 2): in the same transaction, detach the team from issues, projects, and views, and
 * clear or reassign the team-scoped labels, cycles, and workflow ownership that become invalid.
 */
export const archive = mutation({
  args: { companyId: domainIdArg, teamId: domainIdArg },
  returns: v.null(),
  handler: async (ctx, args) => {
    requireCloudSyncEnabled();
    const actor = await requireCompanyActor(ctx, args.companyId);
    requirePermission(actor, "teams.manage");
    void args;
    return notImplemented("teams.archive");
  },
});

export const addMember = mutation({
  args: { companyId: domainIdArg, teamId: domainIdArg, membershipId: domainIdArg },
  returns: v.null(),
  handler: async (ctx, args) => {
    requireCloudSyncEnabled();
    const actor = await requireCompanyActor(ctx, args.companyId);
    requirePermission(actor, "teams.manage");
    void args;
    // TODO(phase 2): insert the team membership and bump the epoch — team membership is what a
    // team-scoped role grant resolves through, so replicas must reseed.
    return notImplemented("teams.addMember");
  },
});

export const removeMember = mutation({
  args: { companyId: domainIdArg, teamId: domainIdArg, membershipId: domainIdArg },
  returns: v.null(),
  handler: async (ctx, args) => {
    requireCloudSyncEnabled();
    const actor = await requireCompanyActor(ctx, args.companyId);
    requirePermission(actor, "teams.manage");
    void args;
    return notImplemented("teams.removeMember");
  },
});
