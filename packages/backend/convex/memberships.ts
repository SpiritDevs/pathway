// @effect-diagnostics globalDate:off -- Convex mutations are not Effect programs; the transaction clock is `Date.now()`.
/**
 * Membership administration. Online-only by design: a client may read its cached member list
 * offline, but locking, removing, and leaving all need an authorization check that only the
 * backend can make.
 *
 * Every mutation here bumps the authorization epoch, because every one of them changes who
 * authorizes. A client that sees a new epoch discards its replica and reseeds, which is the only
 * thing that purges rows it should no longer hold — and for a departure, the only thing that stops
 * the departed client from serving the company out of cache for the rest of its offline grant.
 *
 * @module memberships
 */
import { v } from "convex/values";

import { checkOwnershipChange } from "../src/ownership.ts";
import type { Doc, Id } from "./_generated/dataModel.js";
import { mutation, query } from "./_generated/server.js";
import type { MutationCtx, QueryCtx } from "./_generated/server.js";
import { requireCloudSyncEnabled } from "./lib/capability.ts";
import {
  appendCompanyChanges,
  encodeMembership,
  teamMembershipDomainId,
  type CompanyChange,
} from "./lib/companyApply.ts";
import { backendError } from "./lib/errors.ts";
import {
  actorRecord,
  requireCompanyActor,
  requirePermission,
  type CompanyActor,
} from "./lib/identity.ts";
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

/**
 * Ceiling on every table this module's directory read walks. A company large enough to exceed it
 * needs a paginated admin screen rather than a bigger number here; taking a bounded slice is what
 * keeps one oversized company from blowing the transaction's read limit and failing the query for
 * everyone in it.
 */
const DIRECTORY_MAX_ROWS = 2_000;

export const list = query({
  args: { companyId: domainIdArg },
  returns: v.array(membershipSummary),
  handler: async (ctx, args) => {
    requireCloudSyncEnabled();
    const actor = await requireCompanyActor(ctx, args.companyId);
    requirePermission(actor, "members.read");

    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_company", (q) => q.eq("companyId", actor.company._id))
      .take(DIRECTORY_MAX_ROWS);
    const owners = await ctx.db
      .query("companyOwners")
      .withIndex("by_company", (q) => q.eq("companyId", actor.company._id))
      .take(DIRECTORY_MAX_ROWS);
    const teams = await ctx.db
      .query("teams")
      .withIndex("by_company", (q) => q.eq("companyId", actor.company._id))
      .take(DIRECTORY_MAX_ROWS);
    const teamMemberships = await ctx.db
      .query("teamMemberships")
      .withIndex("by_company", (q) => q.eq("companyId", actor.company._id))
      .take(DIRECTORY_MAX_ROWS);

    // Three whole-table reads joined in memory rather than a per-member index read each: the join
    // is over the same company either way, and this way the cost does not multiply by member count.
    const ownerDocIds = new Set<string>(owners.map((owner) => owner.membershipId));
    const teamDomainIds = new Map<string, string>(teams.map((team) => [team._id, team.id]));
    const teamIdsByMembership = new Map<string, string[]>();
    for (const row of teamMemberships) {
      const teamDomainId = teamDomainIds.get(row.teamId);
      if (teamDomainId === undefined) continue;
      const bucket = teamIdsByMembership.get(row.membershipId);
      if (bucket === undefined) teamIdsByMembership.set(row.membershipId, [teamDomainId]);
      else bucket.push(teamDomainId);
    }

    // Departed members stay in the listing: their snapshots are what makes "assigned to" and
    // "commented by" keep naming a person, and an admin screen needs to show who has left.
    return memberships.map((membership) => ({
      id: membership.id,
      displayName: membership.displayNameSnapshot,
      email: membership.emailSnapshot,
      state: membership.state,
      isOwner: ownerDocIds.has(membership._id),
      teamIds: teamIdsByMembership.get(membership._id) ?? [],
      joinedAt: membership.joinedAt,
    }));
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

    const membership = await membershipInCompany(ctx, actor.company._id, args.membershipId);
    if (membership.state === args.state) return null;
    // Departure is not a state this dial can undo. The row is kept for attribution, not held open
    // as a seat, and re-admission goes back through an invitation so the email binding is rechecked.
    if (membership.state === "left") {
      throw backendError(
        "invalid-arguments",
        "A membership that has left is restored by invitation, not by setting its state.",
      );
    }

    const patch = { state: args.state, updatedAt: Date.now() };
    await ctx.db.patch(membership._id, patch);
    await appendCompanyChanges(ctx, {
      companyId: actor.company._id,
      actor: actorRecord(actor),
      changes: [
        {
          entityKind: "membership",
          entityId: membership.id,
          changeKind: "upsert",
          versionDocId: membership._id,
          payload: encodeMembership({ ...membership, ...patch }),
        },
      ],
      // Both directions: locking takes authorization away, unlocking gives it back, and only a
      // reseed makes either one true on a replica that is already holding the company.
      bumpEpoch: true,
    });
    return null;
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
    const membership = await membershipInCompany(ctx, actor.company._id, args.membershipId);
    await departMembership(ctx, actor, membership);
    return null;
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
    await departMembership(ctx, actor, actor.membership);
    return null;
  },
});

async function membershipInCompany(
  ctx: QueryCtx,
  companyDocId: Id<"companies">,
  membershipDomainId: string,
): Promise<Doc<"memberships">> {
  const membership = await ctx.db
    .query("memberships")
    .withIndex("by_company_and_domain_id", (q) =>
      q.eq("companyId", companyDocId).eq("id", membershipDomainId),
    )
    .unique();
  if (membership === null) {
    throw backendError("entity-not-found", "No such membership in this company.");
  }
  return membership;
}

/**
 * The one departure path, shared by removal and leaving, because they differ only in who asked.
 *
 * The membership itself is a `left` **upsert**, not a feed tombstone. That is the whole reason the
 * row keeps `displayNameSnapshot` and `emailSnapshot`: a replica that dropped it would render every
 * issue the departed member was assigned, and every comment they wrote, against an unresolvable id.
 * A departure is a person changing state, not a record ceasing to exist.
 *
 * What *is* tombstoned is everything that only existed to grant them something — their team
 * memberships and role assignments. Those are deleted rather than left inert: a `left` membership
 * authorizes nothing today (`requireCompanyActor` refuses it outright), but leaving the grants
 * behind would show a departed person in every team roster, and would silently restore their old
 * access if a future invitation reactivates this row instead of minting a new one. The owner grant
 * goes the same way, guarded upstream by {@link assertNotLastActiveOwner}; it has no wire kind, so
 * it is delivered by re-emitting the company.
 */
async function departMembership(
  ctx: MutationCtx,
  actor: CompanyActor,
  membership: Doc<"memberships">,
): Promise<void> {
  // Idempotent: a retried removal must not append a second run of tombstones for rows that are
  // already gone, nor bump the epoch again and force a pointless reseed of the whole company.
  if (membership.state === "left") return;

  const companyDocId = actor.company._id;
  const changes: CompanyChange[] = [];

  const teamRows = await ctx.db
    .query("teamMemberships")
    .withIndex("by_membership", (q) => q.eq("membershipId", membership._id))
    .collect();
  for (const row of teamRows) {
    const team = await ctx.db.get(row.teamId);
    // A row written before the id column existed derives the composite its upsert would have used,
    // which is the id a replica folded it under.
    const entityId =
      row.id ?? (team === null ? null : teamMembershipDomainId(team.id, membership.id));
    await ctx.db.delete(row._id);
    // A join row whose team has vanished was never deliverable, so no replica holds it to drop.
    if (entityId === null) continue;
    changes.push({
      entityKind: "teamMembership",
      entityId,
      changeKind: "tombstone",
      versionDocId: null,
      payload: null,
    });
  }

  const assignments = await ctx.db
    .query("roleAssignments")
    .withIndex("by_membership", (q) => q.eq("membershipId", membership._id))
    .collect();
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

  const owner = await ctx.db
    .query("companyOwners")
    .withIndex("by_company_and_membership", (q) =>
      q.eq("companyId", companyDocId).eq("membershipId", membership._id),
    )
    .unique();
  if (owner !== null) await ctx.db.delete(owner._id);

  const patch = { state: "left" as const, updatedAt: Date.now() };
  await ctx.db.patch(membership._id, patch);
  changes.push({
    entityKind: "membership",
    entityId: membership.id,
    changeKind: "upsert",
    versionDocId: membership._id,
    payload: encodeMembership({ ...membership, ...patch }),
  });

  await appendCompanyChanges(ctx, {
    companyId: companyDocId,
    actor: actorRecord(actor),
    changes,
    // Only when ownership actually moved: the company payload is large and re-emitting it on every
    // ordinary departure would be a page of noise for a row that did not change.
    companyUpsert: owner !== null,
    bumpEpoch: true,
  });
}

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
