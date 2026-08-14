// @effect-diagnostics globalDate:off -- Convex mutations are not Effect programs; the transaction clock is `Date.now()`.
/**
 * Company lifecycle: provisioning on first sign-in, renaming, ownership, and the 30-day
 * delete/restore window.
 *
 * Ownership is not a role. Owners pass every authorization check and cannot all be removed, so
 * every path that could strip the last one goes through {@link checkOwnershipChange} inside the
 * same transaction that would have removed it.
 *
 * @module companies
 */
import { v } from "convex/values";

import {
  clampOfflineAccessDays,
  normalizeCompanyName,
  normalizeIssueKeyPrefix,
} from "../src/companies.ts";
import { checkOwnershipChange } from "../src/ownership.ts";
import { mutation, query } from "./_generated/server.js";
import { requireCloudSyncEnabled } from "./lib/capability.ts";
import { backendError, notImplemented } from "./lib/errors.ts";
import {
  currentUser,
  requireCompanyActor,
  requireIdentity,
  requirePermission,
} from "./lib/identity.ts";
import { domainIdArg } from "./lib/validators.ts";

const companySummary = v.object({
  id: domainIdArg,
  /**
   * The caller's own membership in this company. A client cannot derive it — it holds a Clerk
   * identity, not a membership — and it is what a client-authored operation carries as its
   * `actor`, so a summary without it cannot start a sync engine. Attribution only: Convex still
   * re-derives the authoritative actor from the token on every write.
   */
  membershipId: domainIdArg,
  name: v.string(),
  issueKeyPrefix: v.string(),
  lifecycleState: v.union(v.literal("active"), v.literal("deletionScheduled"), v.literal("purged")),
  purgeAfter: v.union(v.number(), v.null()),
  authorizationEpoch: v.number(),
  syncVersion: v.number(),
  isOwner: v.boolean(),
});

/**
 * Every company the signed-in user still has an active membership in.
 *
 * An identity is required rather than assumed: this listing is what a client reconciles its sync
 * engines against, and an empty array is a meaningful answer — "you are a member of nothing, stop
 * everything". Answering it to a caller with no identity at all (a token that never arrived, one
 * Convex refused, a socket that authenticated after the first subscribe) would make an
 * authentication problem indistinguishable from a legitimately empty membership list, and would
 * quietly tear every engine down. A signed-in identity with no `users` row yet is different: that
 * person really has no companies, and gets the empty listing.
 */
export const listMine = query({
  args: {},
  returns: v.array(companySummary),
  handler: async (ctx) => {
    requireCloudSyncEnabled();
    await requireIdentity(ctx);
    const user = await currentUser(ctx);
    if (user === null) return [];

    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .collect();

    const summaries = [];
    for (const membership of memberships) {
      if (membership.state !== "active") continue;
      const company = await ctx.db.get(membership.companyId);
      if (company === null || company.lifecycleState === "purged") continue;
      const owner = await ctx.db
        .query("companyOwners")
        .withIndex("by_company_and_membership", (q) =>
          q.eq("companyId", company._id).eq("membershipId", membership._id),
        )
        .unique();
      summaries.push({
        id: company.id,
        membershipId: membership.id,
        name: company.name,
        issueKeyPrefix: company.issueKeyPrefix,
        lifecycleState: company.lifecycleState,
        purgeAfter: company.purgeAfter,
        authorizationEpoch: company.authorizationEpoch,
        syncVersion: company.syncVersion,
        isOwner: owner !== null,
      });
    }
    return summaries;
  },
});

/**
 * Idempotently provisions the signed-in Clerk identity: the `users` row, and — on a first sign-in
 * — one ordinary single-member company they own. That company is not a personal-data model; it can
 * be renamed, gain teams, and invite others like any other.
 *
 * TODO(phase 2): create the user, company, membership, owner row, `companySettings`, and the
 * seeded Admin/Manager/Member roles from `SEED_ROLES` in one transaction, and return the company.
 */
export const provisionCurrentUser = mutation({
  args: { displayName: v.optional(v.string()) },
  returns: companySummary,
  handler: async (ctx, _args) => {
    requireCloudSyncEnabled();
    const identity = await ctx.auth.getUserIdentity();
    if (identity === null) {
      throw backendError("not-authenticated", "Provisioning requires a signed-in identity.");
    }
    return notImplemented("companies.provisionCurrentUser");
  },
});

/**
 * Creates an additional company owned by the caller.
 *
 * TODO(phase 2): insert the company, its settings, the caller's membership and owner row, and the
 * seeded roles, then append the company change so existing clients pick it up.
 */
export const create = mutation({
  args: {
    id: domainIdArg,
    name: v.string(),
    issueKeyPrefix: v.optional(v.string()),
  },
  returns: companySummary,
  handler: async (ctx, args) => {
    requireCloudSyncEnabled();
    const user = await currentUser(ctx);
    if (user === null) {
      throw backendError("user-not-provisioned", "Provision the user before creating a company.");
    }
    if (normalizeCompanyName(args.name).length === 0) {
      throw backendError("invalid-arguments", "A company needs a name.");
    }
    if (args.issueKeyPrefix !== undefined && normalizeIssueKeyPrefix(args.issueKeyPrefix) === "") {
      throw backendError("invalid-arguments", "An issue key prefix needs at least one character.");
    }
    return notImplemented("companies.create");
  },
});

export const rename = mutation({
  args: { companyId: domainIdArg, name: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    requireCloudSyncEnabled();
    const actor = await requireCompanyActor(ctx, args.companyId);
    requirePermission(actor, "company.manage");
    const name = normalizeCompanyName(args.name);
    if (name.length === 0) throw backendError("invalid-arguments", "A company needs a name.");
    // TODO(phase 2): patch the row and append the `company` change so replicas see the rename.
    return notImplemented("companies.rename");
  },
});

export const setOfflineAccessDays = mutation({
  args: { companyId: domainIdArg, days: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    requireCloudSyncEnabled();
    const actor = await requireCompanyActor(ctx, args.companyId);
    requirePermission(actor, "company.manage");
    // Clamped rather than rejected: zero and ninety are both meaningful ends of the same dial.
    const _days = clampOfflineAccessDays(args.days);
    // TODO(phase 2): patch `companySettings` and append the `companySettings` change.
    return notImplemented("companies.setOfflineAccessDays");
  },
});

/** Any owner may add another. Ownership is symmetric; there is no super-owner. */
export const addOwner = mutation({
  args: { companyId: domainIdArg, membershipId: domainIdArg },
  returns: v.null(),
  handler: async (ctx, args) => {
    requireCloudSyncEnabled();
    const actor = await requireCompanyActor(ctx, args.companyId);
    if (!actor.permissions.isOwner) {
      throw backendError("permission-denied", "Only an owner may grant ownership.");
    }
    // TODO(phase 2): resolve the membership, insert the owner row, bump the authorization epoch.
    return notImplemented("companies.addOwner");
  },
});

/**
 * Removes an owner, refusing when it would leave the company with none. The same check guards
 * locking and leaving, because all three end at an unadministered company.
 */
export const removeOwner = mutation({
  args: { companyId: domainIdArg, membershipId: domainIdArg },
  returns: v.null(),
  handler: async (ctx, args) => {
    requireCloudSyncEnabled();
    const actor = await requireCompanyActor(ctx, args.companyId);
    if (!actor.permissions.isOwner) {
      throw backendError("permission-denied", "Only an owner may revoke ownership.");
    }

    const owners = await ctx.db
      .query("companyOwners")
      .withIndex("by_company", (q) => q.eq("companyId", actor.company._id))
      .collect();

    const activeOwnerMembershipIds: string[] = [];
    let target: (typeof owners)[number] | null = null;
    for (const owner of owners) {
      const membership = await ctx.db.get(owner.membershipId);
      if (membership === null) continue;
      if (membership.id === args.membershipId) target = owner;
      if (membership.state === "active") activeOwnerMembershipIds.push(membership.id);
    }
    if (target === null) {
      throw backendError("entity-not-found", "That membership does not own this company.");
    }

    const rejection = checkOwnershipChange(activeOwnerMembershipIds, [args.membershipId]);
    if (rejection !== null) {
      throw backendError(rejection, "A company must always have at least one active owner.");
    }

    await ctx.db.delete(target._id);
    await ctx.db.patch(actor.company._id, {
      authorizationEpoch: actor.company.authorizationEpoch + 1,
      updatedAt: Date.now(),
    });
    return null;
  },
});

/**
 * Schedules deletion. Access is disabled immediately and the records survive, owner-restorable,
 * for 30 days before a purge run removes them.
 *
 * TODO(phase 2): set the lifecycle state and purge deadline, append the company change, and
 * schedule the purge job.
 */
export const scheduleDeletion = mutation({
  args: { companyId: domainIdArg },
  returns: v.null(),
  handler: async (ctx, args) => {
    requireCloudSyncEnabled();
    const actor = await requireCompanyActor(ctx, args.companyId);
    if (!actor.permissions.isOwner) {
      throw backendError("permission-denied", "Only an owner may delete a company.");
    }
    return notImplemented("companies.scheduleDeletion");
  },
});

/**
 * Restores a company inside its recovery window.
 *
 * Cannot go through {@link requireCompanyActor}, which refuses non-active companies — restoring is
 * the one operation whose whole point is that the company is unavailable.
 *
 * TODO(phase 2): re-check owner membership directly, clear the deletion fields, bump the epoch.
 */
export const restore = mutation({
  args: { companyId: domainIdArg },
  returns: v.null(),
  handler: async (ctx, args) => {
    requireCloudSyncEnabled();
    const user = await currentUser(ctx);
    if (user === null) {
      throw backendError("not-authenticated", "Restoring a company requires a signed-in user.");
    }
    void args;
    return notImplemented("companies.restore");
  },
});
