/**
 * Membership administration. Online-only by design: a client may read its cached member list
 * offline, but locking, removing, and leaving all need an authorization check that only the
 * backend can make.
 *
 * @module memberships
 */
import { v } from "convex/values";

import { checkOwnershipChange } from "../src/ownership.ts";
import { mutation, query } from "./_generated/server.js";
import type { MutationCtx } from "./_generated/server.js";
import { requireCloudSyncEnabled } from "./lib/capability.ts";
import { backendError, notImplemented } from "./lib/errors.ts";
import { requireCompanyActor, requirePermission, type CompanyActor } from "./lib/identity.ts";
import { domainIdArg } from "./lib/validators.ts";

const membershipSummary = v.object({
  id: domainIdArg,
  displayName: v.string(),
  email: v.string(),
  state: v.union(v.literal("active"), v.literal("locked"), v.literal("left")),
  isOwner: v.boolean(),
  teamIds: v.array(domainIdArg),
  joinedAt: v.number(),
});

export const list = query({
  args: { companyId: domainIdArg },
  returns: v.array(membershipSummary),
  handler: async (ctx, args) => {
    requireCloudSyncEnabled();
    const actor = await requireCompanyActor(ctx, args.companyId);
    requirePermission(actor, "members.read");
    // TODO(phase 2): join memberships with owner rows and team memberships under a bounded read.
    return notImplemented("memberships.list");
  },
});

/**
 * Locks a membership without destroying its attribution. A locked member keeps their audit
 * history and assignments; they simply stop authorizing.
 */
export const setState = mutation({
  args: {
    companyId: domainIdArg,
    membershipId: domainIdArg,
    state: v.union(v.literal("active"), v.literal("locked")),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    requireCloudSyncEnabled();
    const actor = await requireCompanyActor(ctx, args.companyId);
    requirePermission(actor, "members.manage");
    await assertNotLastActiveOwner(ctx, actor, args.membershipId, args.state === "locked");
    // TODO(phase 2): patch the membership, bump the epoch, append the `membership` change.
    return notImplemented("memberships.setState");
  },
});

/**
 * Removes a membership. The row is kept as a tombstone in `left` state rather than deleted, so
 * "assigned to" and "commented by" keep meaning something after somebody leaves.
 */
export const remove = mutation({
  args: { companyId: domainIdArg, membershipId: domainIdArg },
  returns: v.null(),
  handler: async (ctx, args) => {
    requireCloudSyncEnabled();
    const actor = await requireCompanyActor(ctx, args.companyId);
    requirePermission(actor, "members.manage");
    await assertNotLastActiveOwner(ctx, actor, args.membershipId, true);
    return notImplemented("memberships.remove");
  },
});

/** Leaving is the self-service form of removal and hits the same last-owner protection. */
export const leave = mutation({
  args: { companyId: domainIdArg },
  returns: v.null(),
  handler: async (ctx, args) => {
    requireCloudSyncEnabled();
    const actor = await requireCompanyActor(ctx, args.companyId);
    if (actor.kind !== "member") {
      throw backendError("invalid-arguments", "An environment cannot leave a company.");
    }
    await assertNotLastActiveOwner(ctx, actor, actor.membership.id, true);
    return notImplemented("memberships.leave");
  },
});

/**
 * Shared guard for the three ways a membership stops authorizing. Reads the owner set inside the
 * caller's transaction so a concurrent removal cannot slip past it.
 */
async function assertNotLastActiveOwner(
  ctx: MutationCtx,
  actor: CompanyActor,
  membershipDomainId: string,
  isLosingAuthorization: boolean,
): Promise<void> {
  if (!isLosingAuthorization) return;

  const owners = await ctx.db
    .query("companyOwners")
    .withIndex("by_company", (q) => q.eq("companyId", actor.company._id))
    .collect();

  const activeOwnerMembershipIds: string[] = [];
  for (const owner of owners) {
    const membership = await ctx.db.get(owner.membershipId);
    if (membership !== null && membership.state === "active") {
      activeOwnerMembershipIds.push(membership.id);
    }
  }
  if (!activeOwnerMembershipIds.includes(membershipDomainId)) return;

  const rejection = checkOwnershipChange(activeOwnerMembershipIds, [membershipDomainId]);
  if (rejection !== null) {
    throw backendError(rejection, "A company must always have at least one active owner.");
  }
}
