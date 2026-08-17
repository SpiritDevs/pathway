// @effect-diagnostics globalDate:off -- Convex mutations are not Effect programs; the transaction clock is `Date.now()`.
/**
 * Team administration.
 *
 * A team is a visibility scope as much as a group: removing one from a record has to atomically
 * clear the team-scoped labels, cycles, workflow ownership, and project references that record
 * would otherwise keep pointing at.
 *
 * Administration here is **online-only** (there is no `team` operation kind and no offline write
 * path), but every write appends to the change feed through `lib/companyApply`, because replicas
 * carry teams as a permission-filtered read cache and have to render a team list offline.
 *
 * Two rules run through the file.
 *
 * - *Authorization changes bump the epoch; content changes do not.* Adding or removing a team
 *   member changes what that person resolves through, so those two bump `authorizationEpoch` and
 *   every client reseeds. Creating, renaming, and archiving do not change any grant — a brand new
 *   team is a scope nobody has an assignment to yet, and an archived one keeps the assignments it
 *   had — so they ride the feed as ordinary rows. A gratuitous bump is not free: it discards every
 *   client's whole replica, issue database included, and re-seeds it.
 * - *Idempotent writes emit nothing.* Adding a member who is already on the team, or removing one
 *   who is not, is a no-op with no feed row and no bump, so a retried click cannot cost every
 *   client a reseed.
 *
 * @module teams
 */
import { v } from "convex/values";

import { SYNC_MAX_ID_CHARS } from "../src/sync/operations.ts";
import type { Doc, Id } from "./_generated/dataModel.js";
import { mutation, query, type QueryCtx } from "./_generated/server.js";
import {
  appendCompanyChanges,
  encodeTeam,
  encodeTeamMembership,
  teamMembershipDomainId,
} from "./lib/companyApply.ts";
import { backendError } from "./lib/errors.ts";
import {
  actorRecord,
  requireCompanyActor,
  requireOrganizationWorkspace,
  requirePermission,
} from "./lib/identity.ts";
import { domainIdArg } from "./lib/validators.ts";

const teamSummary = v.object({
  id: domainIdArg,
  name: v.string(),
  description: v.string(),
  memberCount: v.number(),
  archivedAt: v.union(v.number(), v.null()),
});

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

function teamByDomainId(
  ctx: QueryCtx,
  companyId: Id<"companies">,
  teamId: string,
): Promise<Doc<"teams"> | null> {
  return ctx.db
    .query("teams")
    .withIndex("by_company_and_domain_id", (q) => q.eq("companyId", companyId).eq("id", teamId))
    .unique();
}

async function requireTeam(
  ctx: QueryCtx,
  companyId: Id<"companies">,
  teamId: string,
): Promise<Doc<"teams">> {
  const team = await teamByDomainId(ctx, companyId, teamId);
  if (team === null) throw backendError("entity-not-found", `No team ${teamId} in this company.`);
  return team;
}

/**
 * The membership a team write names. Only an `active` one may be placed on a team: a `locked` or
 * `left` membership resolves to no actor at all, so a team seat for one would be a grant nobody
 * can ever exercise and a name on the roster of a person who is gone.
 */
async function requireActiveMembership(
  ctx: QueryCtx,
  companyId: Id<"companies">,
  membershipId: string,
): Promise<Doc<"memberships">> {
  const membership = await ctx.db
    .query("memberships")
    .withIndex("by_company_and_domain_id", (q) =>
      q.eq("companyId", companyId).eq("id", membershipId),
    )
    .unique();
  if (membership === null) {
    throw backendError("entity-not-found", `No membership ${membershipId} in this company.`);
  }
  if (membership.state !== "active") {
    throw backendError("invalid-arguments", "That membership is not active.");
  }
  return membership;
}

export const list = query({
  args: { companyId: domainIdArg },
  returns: v.array(teamSummary),
  handler: async (ctx, args) => {
    const actor = await requireCompanyActor(ctx, args.companyId);
    requirePermission(actor, "teams.read");
    // Archived teams are included, flagged rather than hidden: their issues are still live and
    // still name the team, so a picker that omits them cannot render what it already holds.
    const teams = await ctx.db
      .query("teams")
      .withIndex("by_company", (q) => q.eq("companyId", actor.company._id))
      .collect();

    const summaries = [];
    for (const team of teams) {
      // One index read per team, over a company's teams rather than its people — the roster of a
      // single team is the only unbounded axis, and it is the count being asked for.
      const members = await ctx.db
        .query("teamMemberships")
        .withIndex("by_team", (q) => q.eq("teamId", team._id))
        .collect();
      summaries.push({
        id: team.id,
        name: team.name,
        description: team.description,
        memberCount: members.length,
        archivedAt: team.archivedAt,
      });
    }
    return summaries;
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
    const actor = await requireCompanyActor(ctx, args.companyId);
    requireOrganizationWorkspace(actor);
    requirePermission(actor, "teams.manage");
    if (args.name.trim().length === 0) {
      throw backendError("invalid-arguments", "A team needs a name.");
    }
    assertDomainId(args.id, "A team id");
    // Refused rather than folded into an update: the id is the client's, and a second create under
    // one that already exists is a bug in the caller, not a rename.
    if ((await teamByDomainId(ctx, actor.company._id, args.id)) !== null) {
      throw backendError("invalid-arguments", `A team ${args.id} already exists.`);
    }

    const now = Date.now();
    const teamDocId = await ctx.db.insert("teams", {
      id: args.id,
      companyId: actor.company._id,
      name: args.name.trim(),
      description: args.description ?? "",
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    const team = await ctx.db.get(teamDocId);
    if (team === null) throw backendError("entity-not-found", "The new team vanished.");

    // No epoch bump: a team nobody is assigned to and nobody is a member of grants nothing, so no
    // replica's authorization has changed and none of them needs to throw its data away.
    await appendCompanyChanges(ctx, {
      companyId: actor.company._id,
      actor: actorRecord(actor),
      changes: [
        {
          entityKind: "team",
          entityId: team.id,
          changeKind: "upsert",
          versionDocId: teamDocId,
          payload: encodeTeam(team),
        },
      ],
    });
    return null;
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
    const actor = await requireCompanyActor(ctx, args.companyId);
    requireOrganizationWorkspace(actor);
    requirePermission(actor, "teams.manage");
    if (args.name === undefined && args.description === undefined) {
      throw backendError("invalid-arguments", "An update needs a name or a description.");
    }
    if (args.name !== undefined && args.name.trim().length === 0) {
      throw backendError("invalid-arguments", "A team needs a name.");
    }
    const team = await requireTeam(ctx, actor.company._id, args.teamId);

    const now = Date.now();
    const patch: { name?: string; description?: string; updatedAt: number } = { updatedAt: now };
    if (args.name !== undefined) patch.name = args.name.trim();
    if (args.description !== undefined) patch.description = args.description;
    await ctx.db.patch(team._id, patch);

    // No epoch bump: a name is content. Every grant that resolved through this team before still
    // does, and the row itself reaches replicas as the ordinary feed change below.
    await appendCompanyChanges(ctx, {
      companyId: actor.company._id,
      actor: actorRecord(actor),
      changes: [
        {
          entityKind: "team",
          entityId: team.id,
          changeKind: "upsert",
          versionDocId: team._id,
          payload: encodeTeam({ ...team, ...patch }),
        },
      ],
    });
    return null;
  },
});

/**
 * Archives a team: an `archivedAt` stamp and an ordinary `upsert`, never a tombstone.
 *
 * The distinction is load-bearing. Issues, projects, and views keep naming their teams after an
 * archive — that is what makes archiving reversible and different from deleting — so a replica that
 * dropped the row would hold work attached to a team it can no longer name, and a board it cannot
 * draw. `SyncTeamPayload` carries `archivedAt` for exactly this: the row stays, flagged, and
 * clients decide whether to offer it in a picker.
 *
 * Archiving changes no authorization either. A team-scoped assignment still resolves through an
 * archived team, so there is no epoch bump; revoking access is `roles.unassign`, which is a
 * different decision than retiring a team and is spelled separately.
 *
 * TODO(phase 2): in the same transaction, detach the team from issues, projects, and views, and
 * clear or reassign the team-scoped labels, cycles, and workflow ownership that become invalid.
 * That work belongs to team *deletion*, which does not exist yet; archiving deliberately leaves
 * every reference intact.
 */
export const archive = mutation({
  args: { companyId: domainIdArg, teamId: domainIdArg },
  returns: v.null(),
  handler: async (ctx, args) => {
    const actor = await requireCompanyActor(ctx, args.companyId);
    requireOrganizationWorkspace(actor);
    requirePermission(actor, "teams.manage");
    const team = await requireTeam(ctx, actor.company._id, args.teamId);
    // Idempotent, and it keeps the original stamp: "archived on the 3rd" is a fact about the team,
    // not about the last person to press the button.
    if (team.archivedAt !== null) return null;

    const now = Date.now();
    const patch = { archivedAt: now, updatedAt: now };
    await ctx.db.patch(team._id, patch);

    await appendCompanyChanges(ctx, {
      companyId: actor.company._id,
      actor: actorRecord(actor),
      changes: [
        {
          entityKind: "team",
          entityId: team.id,
          changeKind: "upsert",
          versionDocId: team._id,
          payload: encodeTeam({ ...team, ...patch }),
        },
      ],
    });
    return null;
  },
});

export const addMember = mutation({
  args: { companyId: domainIdArg, teamId: domainIdArg, membershipId: domainIdArg },
  returns: v.null(),
  handler: async (ctx, args) => {
    const actor = await requireCompanyActor(ctx, args.companyId);
    requireOrganizationWorkspace(actor);
    requirePermission(actor, "teams.manage");
    const team = await requireTeam(ctx, actor.company._id, args.teamId);
    if (team.archivedAt !== null) {
      throw backendError("invalid-arguments", "An archived team does not take new members.");
    }
    const membership = await requireActiveMembership(ctx, actor.company._id, args.membershipId);

    const existing = await ctx.db
      .query("teamMemberships")
      .withIndex("by_team_and_membership", (q) =>
        q.eq("teamId", team._id).eq("membershipId", membership._id),
      )
      .unique();
    // Already on the team: no row, no change, and — the point of checking — no epoch bump, so a
    // double-click cannot make every client discard its replica twice.
    if (existing !== null) return null;

    const now = Date.now();
    const joinDocId = await ctx.db.insert("teamMemberships", {
      companyId: actor.company._id,
      // Derived, never minted: the tombstone `removeMember` writes has to name the same entity, and
      // re-adding someone has to converge on the row they had rather than accumulate a second one.
      id: teamMembershipDomainId(team.id, membership.id),
      teamId: team._id,
      membershipId: membership._id,
      createdAt: now,
    });
    const join = await ctx.db.get(joinDocId);
    if (join === null) throw backendError("entity-not-found", "The new team membership vanished.");

    // Team membership is what a team-scoped role grant resolves through, so replicas must reseed:
    // this is the write that can hand somebody a whole team's issues.
    await appendCompanyChanges(ctx, {
      companyId: actor.company._id,
      actor: actorRecord(actor),
      changes: [
        {
          entityKind: "teamMembership",
          entityId: teamMembershipDomainId(team.id, membership.id),
          changeKind: "upsert",
          versionDocId: joinDocId,
          payload: await encodeTeamMembership(ctx, join),
        },
      ],
      bumpEpoch: true,
    });
    return null;
  },
});

export const removeMember = mutation({
  args: { companyId: domainIdArg, teamId: domainIdArg, membershipId: domainIdArg },
  returns: v.null(),
  handler: async (ctx, args) => {
    const actor = await requireCompanyActor(ctx, args.companyId);
    requireOrganizationWorkspace(actor);
    requirePermission(actor, "teams.manage");
    const team = await requireTeam(ctx, actor.company._id, args.teamId);
    // Not `requireActiveMembership`: a locked or departed member still has to be removable from the
    // teams they were on, and that is precisely when someone reaches for this.
    const membership = await ctx.db
      .query("memberships")
      .withIndex("by_company_and_domain_id", (q) =>
        q.eq("companyId", actor.company._id).eq("id", args.membershipId),
      )
      .unique();
    if (membership === null) {
      throw backendError("entity-not-found", `No membership ${args.membershipId} in this company.`);
    }

    const existing = await ctx.db
      .query("teamMemberships")
      .withIndex("by_team_and_membership", (q) =>
        q.eq("teamId", team._id).eq("membershipId", membership._id),
      )
      .unique();
    // Not on the team: nothing to announce. Replicas learn team membership from this same feed, so
    // a row that was never written is a row no replica holds, and a tombstone for it would buy
    // nothing but an epoch bump and a company-wide reseed.
    if (existing === null) return null;

    // Team-scoped role assignments are deliberately left alone. Losing a seat is not losing a role,
    // the assignment is an administered record of its own with its own mutation, and cascading here
    // would silently discard a grant that `teams.addMember` cannot put back.
    await ctx.db.delete(existing._id);

    await appendCompanyChanges(ctx, {
      companyId: actor.company._id,
      actor: actorRecord(actor),
      changes: [
        {
          entityKind: "teamMembership",
          entityId: teamMembershipDomainId(team.id, membership.id),
          changeKind: "tombstone",
          // The row is gone, so there is nothing left to stamp with the version.
          versionDocId: null,
          payload: null,
        },
      ],
      // Removing someone's last team changes what they may see; the epoch is what makes their
      // replica throw the now-unreadable records away rather than keep serving them offline.
      bumpEpoch: true,
    });
    return null;
  },
});
