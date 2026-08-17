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
  companyPurgeAfter,
  DEFAULT_ISSUE_STATUSES,
  defaultIssueKeyPrefix,
  isCompanyPurgeDue,
  normalizeCompanyName,
  normalizeIssueKeyPrefix,
  OFFLINE_ACCESS_DEFAULT_DAYS,
  type WorkspaceKind,
} from "../src/companies.ts";
import { normalizeEmail } from "../src/invitations.ts";
import { checkOwnershipChange } from "../src/ownership.ts";
import { SEED_ROLES } from "../src/permissions.ts";
import type { Doc, Id } from "./_generated/dataModel.js";
import { mutation, query } from "./_generated/server.js";
import type { MutationCtx, QueryCtx } from "./_generated/server.js";
import {
  appendCompanyChanges,
  encodeCompanySettings,
  encodeMembership,
  encodeRole,
  type CompanyChange,
} from "./lib/companyApply.ts";
import { mintDomainId } from "./lib/domainIds.ts";
import { backendError } from "./lib/errors.ts";
import { encodeIssueStatus } from "./lib/issueApply.ts";
import {
  actorRecord,
  currentUser,
  isEnvironmentIdentity,
  requireCompanyActor,
  requireIdentity,
  requireOrganizationWorkspace,
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
  workspaceKind: v.union(v.literal("personal"), v.literal("organization")),
  issueKeyPrefix: v.string(),
  lifecycleState: v.union(v.literal("active"), v.literal("deletionScheduled"), v.literal("purged")),
  purgeAfter: v.union(v.number(), v.null()),
  authorizationEpoch: v.number(),
  syncVersion: v.number(),
  isOwner: v.boolean(),
});

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

async function companyByDomainId(
  ctx: QueryCtx,
  companyDomainId: string,
): Promise<Doc<"companies"> | null> {
  return await ctx.db
    .query("companies")
    .withIndex("by_domain_id", (q) => q.eq("id", companyDomainId))
    .unique();
}

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

async function isOwnerMembership(
  ctx: QueryCtx,
  companyDocId: Id<"companies">,
  membershipDocId: Id<"memberships">,
): Promise<boolean> {
  const owner = await ctx.db
    .query("companyOwners")
    .withIndex("by_company_and_membership", (q) =>
      q.eq("companyId", companyDocId).eq("membershipId", membershipDocId),
    )
    .unique();
  return owner !== null;
}

async function insertDefaultIssueStatusChanges(
  ctx: MutationCtx,
  company: Doc<"companies">,
  now: number,
): Promise<CompanyChange[]> {
  const changes: CompanyChange[] = [];
  for (const status of DEFAULT_ISSUE_STATUSES) {
    const statusDocId = await ctx.db.insert("issueStatuses", {
      ...status,
      companyId: company._id,
      scope: "company",
      teamId: null,
      baseStatusId: null,
      hidden: false,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      version: 0,
    });
    const row = await ctx.db.get(statusDocId);
    if (row === null)
      throw backendError("entity-not-found", "The issue status insert did not persist.");
    changes.push({
      entityKind: "issueStatus",
      entityId: row.id,
      changeKind: "upsert",
      versionDocId: statusDocId,
      payload: encodeIssueStatus(company, row),
    });
  }
  return changes;
}

/** Repairs companies created before default workflow seeding shipped, without undoing user edits. */
async function ensureDefaultIssueStatuses(
  ctx: MutationCtx,
  company: Doc<"companies">,
  membership: Doc<"memberships">,
): Promise<Doc<"companies">> {
  const existing = await ctx.db
    .query("issueStatuses")
    .withIndex("by_company_and_version", (q) => q.eq("companyId", company._id))
    .first();
  if (existing !== null) return company;

  const changes = await insertDefaultIssueStatusChanges(ctx, company, Date.now());
  await appendCompanyChanges(ctx, {
    companyId: company._id,
    actor: { kind: "member", membershipId: membership.id },
    changes,
  });
  const repaired = await ctx.db.get(company._id);
  if (repaired === null) throw backendError("entity-not-found", "Company is missing.");
  return repaired;
}

/**
 * Persists a legacy workspace kind or performs the only supported transition. Callers select an
 * organization for a missing legacy kind because those rows predate personal workspaces and were
 * already fully collaboration-capable.
 */
async function ensureWorkspaceKindTransition(
  ctx: MutationCtx,
  company: Doc<"companies">,
  membership: Doc<"memberships">,
  workspaceKind: WorkspaceKind,
  workspaceName?: string,
): Promise<Doc<"companies">> {
  const currentKind = company.workspaceKind ?? "organization";
  if (currentKind === "organization" && workspaceKind === "personal") {
    return company;
  }

  const isLegacyRepair = company.workspaceKind === undefined;
  const isUpgrade = currentKind === "personal" && workspaceKind === "organization";
  if (!isLegacyRepair && !isUpgrade) return company;

  const name = workspaceName ?? company.name;
  await ctx.db.patch(company._id, {
    workspaceKind,
    name,
    updatedAt: Date.now(),
  });
  await appendCompanyChanges(ctx, {
    companyId: company._id,
    actor: { kind: "member", membershipId: membership.id },
    changes: [],
    companyUpsert: true,
  });
  const repaired = await ctx.db.get(company._id);
  if (repaired === null) throw backendError("entity-not-found", "Workspace is missing.");
  return repaired;
}

function optionalWorkspaceName(name: string | undefined): string | undefined {
  if (name === undefined) return undefined;
  const normalized = normalizeCompanyName(name);
  if (normalized.length === 0) {
    throw backendError("invalid-arguments", "A workspace needs a name.");
  }
  return normalized;
}

/** The `companySummary` view of a company as seen through one of its memberships. */
async function summarize(
  ctx: QueryCtx,
  company: Doc<"companies">,
  membership: Doc<"memberships">,
): Promise<{
  id: string;
  membershipId: string;
  name: string;
  workspaceKind: WorkspaceKind;
  issueKeyPrefix: string;
  lifecycleState: "active" | "deletionScheduled" | "purged";
  purgeAfter: number | null;
  authorizationEpoch: number;
  syncVersion: number;
  isOwner: boolean;
}> {
  return {
    id: company.id,
    membershipId: membership.id,
    name: company.name,
    workspaceKind: company.workspaceKind ?? "organization",
    issueKeyPrefix: company.issueKeyPrefix,
    lifecycleState: company.lifecycleState,
    purgeAfter: company.purgeAfter,
    authorizationEpoch: company.authorizationEpoch,
    syncVersion: company.syncVersion,
    isOwner: await isOwnerMembership(ctx, company._id, membership._id),
  };
}

/**
 * The canonical bootstrap of a company: the company row, its settings, the creator's membership and
 * owner grant, and the three seeded roles — in one transaction, because a company that exists
 * without an owner cannot be administered by anybody, and one without settings has no offline
 * policy to enforce.
 *
 * Everything but the company row is then appended to the company's own feed, with the `company`
 * upsert last. Nothing has bootstrapped this company yet, so the run exists for the creator's first
 * drain rather than for an existing replica; it also means the feed and the tables agree from
 * version one instead of from whenever the first edit happens to land.
 *
 * The epoch is *not* bumped. A bump means "every replica of this company must reseed", and a
 * company one transaction old has no replicas to reseed — it starts at epoch one, which is the
 * value every client that ever sees it will start from.
 */
async function createCompanyOwnedBy(
  ctx: MutationCtx,
  input: {
    readonly user: Doc<"users">;
    readonly companyDomainId: string;
    readonly name: string;
    readonly workspaceKind: WorkspaceKind;
    readonly issueKeyPrefix: string;
  },
): Promise<{ company: Doc<"companies">; membership: Doc<"memberships"> }> {
  if ((await companyByDomainId(ctx, input.companyDomainId)) !== null) {
    throw backendError("company-exists", `Company ${input.companyDomainId} already exists.`);
  }

  const now = Date.now();
  const companyDocId = await ctx.db.insert("companies", {
    id: input.companyDomainId,
    name: input.name,
    workspaceKind: input.workspaceKind,
    issueKeyPrefix: input.issueKeyPrefix,
    nextIssueNumber: 1,
    lifecycleState: "active",
    deletionScheduledAt: null,
    purgeAfter: null,
    authorizationEpoch: 1,
    syncVersion: 0,
    createdAt: now,
    updatedAt: now,
  });

  const membershipDomainId = mintDomainId(now);
  const membershipDocId = await ctx.db.insert("memberships", {
    id: membershipDomainId,
    companyId: companyDocId,
    userId: input.user._id,
    state: "active",
    displayNameSnapshot: input.user.displayName,
    emailSnapshot: input.user.email,
    invitedByMembershipId: null,
    joinedAt: now,
    createdAt: now,
    updatedAt: now,
  });
  await ctx.db.insert("companyOwners", {
    companyId: companyDocId,
    membershipId: membershipDocId,
    // Nobody granted the founding ownership; it came with the company.
    grantedByMembershipId: null,
    createdAt: now,
  });

  const settingsDocId = await ctx.db.insert("companySettings", {
    companyId: companyDocId,
    id: input.companyDomainId,
    offlineAccessDays: OFFLINE_ACCESS_DEFAULT_DAYS,
    updatedByMembershipId: null,
    createdAt: now,
    updatedAt: now,
  });

  const roleDocIds: Id<"roles">[] = [];
  for (const seed of SEED_ROLES) {
    roleDocIds.push(
      await ctx.db.insert("roles", {
        id: mintDomainId(now),
        companyId: companyDocId,
        name: seed.name,
        description: seed.description,
        permissions: [...seed.permissions],
        // Provenance only: the seeded three are ordinary, editable roles from here on.
        seeded: true,
        createdAt: now,
        updatedAt: now,
      }),
    );
  }

  // Re-read rather than reconstruct: the encoders are the wire contract and they take documents.
  const company = await ctx.db.get(companyDocId);
  const membership = await ctx.db.get(membershipDocId);
  const settings = await ctx.db.get(settingsDocId);
  if (company === null || membership === null || settings === null) {
    throw backendError("entity-not-found", "The company insert did not persist.");
  }

  const changes: CompanyChange[] = [
    {
      entityKind: "companySettings",
      entityId: input.companyDomainId,
      changeKind: "upsert",
      versionDocId: settingsDocId,
      payload: encodeCompanySettings(company, settings),
    },
    {
      entityKind: "membership",
      entityId: membershipDomainId,
      changeKind: "upsert",
      versionDocId: membershipDocId,
      payload: encodeMembership(membership),
    },
  ];
  for (const roleDocId of roleDocIds) {
    const role = await ctx.db.get(roleDocId);
    if (role === null) continue;
    changes.push({
      entityKind: "role",
      entityId: role.id,
      changeKind: "upsert",
      versionDocId: roleDocId,
      payload: encodeRole(role),
    });
  }
  changes.push(...(await insertDefaultIssueStatusChanges(ctx, company, now)));

  await appendCompanyChanges(ctx, {
    companyId: companyDocId,
    actor: { kind: "member", membershipId: membershipDomainId },
    changes,
    companyUpsert: true,
  });

  const appended = await ctx.db.get(companyDocId);
  if (appended === null)
    throw backendError("entity-not-found", "The company insert did not persist.");
  return { company: appended, membership };
}

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
        workspaceKind: company.workspaceKind ?? "organization",
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
 * — one ordinary single-member personal workspace they own. Organization onboarding upgrades that
 * same workspace in place; a caller may also request an organization on its first call.
 *
 * Idempotence is what makes this safe to call on every sign-in: the `users` row is upserted (the
 * display name and email are re-snapshotted from the identity, because Clerk is authoritative for
 * both), and a caller who already has a usable membership gets that company back rather than
 * accumulating one company per sign-in. "Usable" is an active membership in a company that is not
 * scheduled for deletion — someone whose only company is in its recovery window is provisioned a
 * fresh one, because {@link restore} is a deliberate act and they need somewhere to work meanwhile.
 */
export const provisionCurrentUser = mutation({
  args: {
    displayName: v.optional(v.string()),
    workspaceKind: v.optional(v.union(v.literal("personal"), v.literal("organization"))),
    workspaceName: v.optional(v.string()),
  },
  returns: companySummary,
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (identity === null) {
      throw backendError("not-authenticated", "Provisioning requires a signed-in identity.");
    }
    // An environment presents a relay-minted token for a company that already exists; it is not a
    // person and must never mint one, least of all a company it would then own.
    if (isEnvironmentIdentity(identity)) {
      throw backendError("invalid-arguments", "An environment identity cannot be provisioned.");
    }

    const email = normalizeEmail(identity.email ?? "");
    const displayName =
      (args.displayName ?? identity.name ?? "").trim() ||
      (email.split("@")[0] ?? "").trim() ||
      "Member";
    const workspaceName = optionalWorkspaceName(args.workspaceName);

    const now = Date.now();
    const existingUser = await ctx.db
      .query("users")
      .withIndex("by_clerk_subject", (q) => q.eq("clerkSubject", identity.subject))
      .unique();
    let userDocId: Id<"users">;
    if (existingUser === null) {
      userDocId = await ctx.db.insert("users", {
        clerkSubject: identity.subject,
        email,
        displayName,
        imageUrl: identity.pictureUrl ?? null,
        createdAt: now,
        updatedAt: now,
      });
    } else {
      userDocId = existingUser._id;
      if (existingUser.email !== email || existingUser.displayName !== displayName) {
        await ctx.db.patch(userDocId, { email, displayName, updatedAt: now });
      }
    }
    const user = await ctx.db.get(userDocId);
    if (user === null) throw backendError("entity-not-found", "The user insert did not persist.");

    // Prefer a workspace the caller owns: that is the one this function would have created. An
    // explicit onboarding choice must match the workspace kind; otherwise choosing Personal after
    // joining an organization would incorrectly adopt somebody else's organization as home.
    const owned: Array<{ company: Doc<"companies">; membership: Doc<"memberships"> }> = [];
    let fallback: { company: Doc<"companies">; membership: Doc<"memberships"> } | null = null;
    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_user", (q) => q.eq("userId", userDocId))
      .collect();
    for (const membership of memberships) {
      if (membership.state !== "active") continue;
      const company = await ctx.db.get(membership.companyId);
      if (company === null || company.lifecycleState !== "active") continue;
      if (await isOwnerMembership(ctx, company._id, membership._id)) {
        owned.push({ company, membership });
        continue;
      }
      fallback ??= { company, membership };
    }

    if (args.workspaceKind === undefined && owned[0] !== undefined) {
      const selected = owned[0];
      const repaired = await ensureWorkspaceKindTransition(
        ctx,
        selected.company,
        selected.membership,
        selected.company.workspaceKind ?? "organization",
      );
      return await summarize(
        ctx,
        await ensureDefaultIssueStatuses(ctx, repaired, selected.membership),
        selected.membership,
      );
    }

    if (args.workspaceKind !== undefined) {
      const exact = owned.find(
        ({ company }) => (company.workspaceKind ?? "organization") === args.workspaceKind,
      );
      if (exact !== undefined) {
        const repaired = await ensureWorkspaceKindTransition(
          ctx,
          exact.company,
          exact.membership,
          args.workspaceKind,
          exact.company.workspaceKind === undefined ? workspaceName : undefined,
        );
        return await summarize(
          ctx,
          await ensureDefaultIssueStatuses(ctx, repaired, exact.membership),
          exact.membership,
        );
      }

      if (args.workspaceKind === "organization") {
        const personal = owned.find(({ company }) => company.workspaceKind === "personal");
        if (personal !== undefined) {
          const upgraded = await ensureWorkspaceKindTransition(
            ctx,
            personal.company,
            personal.membership,
            "organization",
            workspaceName,
          );
          return await summarize(
            ctx,
            await ensureDefaultIssueStatuses(ctx, upgraded, personal.membership),
            personal.membership,
          );
        }
      }
    }

    // Preserve the pre-workspace behavior for older callers. New onboarding callers always send a
    // kind, and therefore create an owned workspace rather than silently adopting a joined one.
    if (args.workspaceKind === undefined && fallback !== null) {
      return await summarize(
        ctx,
        await ensureDefaultIssueStatuses(ctx, fallback.company, fallback.membership),
        fallback.membership,
      );
    }

    const workspaceKind = args.workspaceKind ?? "personal";
    const name =
      workspaceName ??
      normalizeCompanyName(
        workspaceKind === "personal" ? `${displayName}'s Workspace` : `${displayName}'s Company`,
      );
    const created = await createCompanyOwnedBy(ctx, {
      user,
      companyDomainId: mintDomainId(now),
      name,
      workspaceKind,
      issueKeyPrefix: defaultIssueKeyPrefix(name),
    });
    return await summarize(ctx, created.company, created.membership);
  },
});

/**
 * Repairs bootstrap rows for an existing workspace without ever creating one. The background sync
 * runtime may call this alongside the onboarding gate's catalog validation; keeping creation out
 * of this path makes that concurrency harmless and ensures a legacy account with no workspace
 * returns to the user's personal/company choice instead of silently receiving a default.
 */
export const repairCurrentUserWorkspace = mutation({
  args: {},
  returns: v.union(companySummary, v.null()),
  handler: async (ctx) => {
    const user = await currentUser(ctx);
    if (user === null) return null;

    let owned: { company: Doc<"companies">; membership: Doc<"memberships"> } | null = null;
    let fallback: { company: Doc<"companies">; membership: Doc<"memberships"> } | null = null;
    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .collect();
    for (const membership of memberships) {
      if (membership.state !== "active") continue;
      const company = await ctx.db.get(membership.companyId);
      if (company === null || company.lifecycleState !== "active") continue;
      if (await isOwnerMembership(ctx, company._id, membership._id)) {
        owned ??= { company, membership };
        continue;
      }
      fallback ??= { company, membership };
    }

    const selected = owned ?? fallback;
    if (selected === null) return null;
    const repaired = await ensureWorkspaceKindTransition(
      ctx,
      selected.company,
      selected.membership,
      selected.company.workspaceKind ?? "organization",
    );
    return await summarize(
      ctx,
      await ensureDefaultIssueStatuses(ctx, repaired, selected.membership),
      selected.membership,
    );
  },
});

/**
 * Converts a personal workspace into an organization without replacing its identity or moving any
 * data. The transition is deliberately one-way; retrying after a successful response was lost is
 * harmless and returns the already-upgraded workspace.
 */
export const upgradeToOrganization = mutation({
  args: { companyId: domainIdArg, name: v.string() },
  returns: companySummary,
  handler: async (ctx, args) => {
    const actor = await requireCompanyActor(ctx, args.companyId);
    if (actor.kind !== "member") {
      throw backendError("invalid-arguments", "An environment cannot upgrade a workspace.");
    }
    requirePermission(actor, "company.manage");
    const name = optionalWorkspaceName(args.name);
    if (name === undefined) {
      throw backendError("invalid-arguments", "An organization needs a name.");
    }

    const upgraded = await ensureWorkspaceKindTransition(
      ctx,
      actor.company,
      actor.membership,
      "organization",
      name,
    );
    return await summarize(ctx, upgraded, actor.membership);
  },
});

/**
 * Creates an additional company owned by the caller.
 *
 * The domain id is the caller's, not this deployment's, so a client that retries a create it never
 * saw the answer to retries with the same id — and gets `company-exists` rather than a second
 * company. Adoption of an id somebody else already used is refused for the same reason: an id
 * collision is a bug on the client, and silently handing back a company the caller does not own
 * would be the worst possible resolution of it.
 */
export const create = mutation({
  args: {
    id: domainIdArg,
    name: v.string(),
    issueKeyPrefix: v.optional(v.string()),
  },
  returns: companySummary,
  handler: async (ctx, args) => {
    const user = await currentUser(ctx);
    if (user === null) {
      throw backendError("user-not-provisioned", "Provision the user before creating a company.");
    }
    const name = normalizeCompanyName(args.name);
    if (name.length === 0) {
      throw backendError("invalid-arguments", "A company needs a name.");
    }
    if (args.issueKeyPrefix !== undefined && normalizeIssueKeyPrefix(args.issueKeyPrefix) === "") {
      throw backendError("invalid-arguments", "An issue key prefix needs at least one character.");
    }
    const issueKeyPrefix =
      args.issueKeyPrefix === undefined
        ? defaultIssueKeyPrefix(name)
        : normalizeIssueKeyPrefix(args.issueKeyPrefix);

    const created = await createCompanyOwnedBy(ctx, {
      user,
      companyDomainId: args.id,
      name,
      workspaceKind: "organization",
      issueKeyPrefix,
    });
    return await summarize(ctx, created.company, created.membership);
  },
});

/**
 * A rename is the one company change that is not authorization-relevant, so it appends a `company`
 * upsert without bumping the epoch: replicas fold the new name in place instead of throwing away a
 * whole cache because somebody fixed a typo.
 */
export const rename = mutation({
  args: { companyId: domainIdArg, name: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const actor = await requireCompanyActor(ctx, args.companyId);
    requirePermission(actor, "company.manage");
    const name = normalizeCompanyName(args.name);
    if (name.length === 0) throw backendError("invalid-arguments", "A company needs a name.");
    if (name === actor.company.name) return null;

    // Patched before the append, which re-reads the row: that is what makes the emitted payload the
    // company as it now is rather than as it was when this handler started.
    await ctx.db.patch(actor.company._id, { name });
    await appendCompanyChanges(ctx, {
      companyId: actor.company._id,
      actor: actorRecord(actor),
      changes: [],
      companyUpsert: true,
    });
    return null;
  },
});

/**
 * Sets how long a client may open this company's data without an online authorization check.
 *
 * No epoch bump: the dial changes how long a *future* grant lives, not who may see what, and every
 * client refreshes its grant on its next successful authorization anyway. Forcing every replica in
 * the company to reseed over it would be a large, pointless cost.
 */
export const setOfflineAccessDays = mutation({
  args: { companyId: domainIdArg, days: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const actor = await requireCompanyActor(ctx, args.companyId);
    requirePermission(actor, "company.manage");
    // Clamped rather than rejected: zero and ninety are both meaningful ends of the same dial.
    const days = clampOfflineAccessDays(args.days);
    const updatedByMembershipId = actor.kind === "member" ? actor.membership.id : null;

    const now = Date.now();
    const existing = await ctx.db
      .query("companySettings")
      .withIndex("by_company", (q) => q.eq("companyId", actor.company._id))
      .unique();
    let settingsDocId: Id<"companySettings">;
    if (existing === null) {
      // A company provisioned before settings existed has none; the first write creates it rather
      // than failing, which is the same coalescing rule the encoders follow.
      settingsDocId = await ctx.db.insert("companySettings", {
        companyId: actor.company._id,
        id: actor.company.id,
        offlineAccessDays: days,
        updatedByMembershipId,
        createdAt: now,
        updatedAt: now,
      });
    } else {
      if (existing.offlineAccessDays === days) return null;
      settingsDocId = existing._id;
      await ctx.db.patch(settingsDocId, {
        // Stamps the singleton id onto a row written before the column existed.
        id: existing.id ?? actor.company.id,
        offlineAccessDays: days,
        updatedByMembershipId,
        updatedAt: now,
      });
    }

    const settings = await ctx.db.get(settingsDocId);
    if (settings === null) {
      throw backendError("entity-not-found", "The settings write did not persist.");
    }
    await appendCompanyChanges(ctx, {
      companyId: actor.company._id,
      actor: actorRecord(actor),
      changes: [
        {
          entityKind: "companySettings",
          entityId: settings.id ?? actor.company.id,
          changeKind: "upsert",
          versionDocId: settingsDocId,
          payload: encodeCompanySettings(actor.company, settings),
        },
      ],
    });
    return null;
  },
});

/**
 * Any owner may add another. Ownership is symmetric; there is no super-owner.
 *
 * Ownership has no wire kind of its own — it is embedded in the `company` payload's `owners` — so
 * the grant is delivered by re-emitting the whole company row. The epoch bumps because an owner
 * passes every authorization check, which is the largest permission change the model has.
 */
export const addOwner = mutation({
  args: { companyId: domainIdArg, membershipId: domainIdArg },
  returns: v.null(),
  handler: async (ctx, args) => {
    const actor = await requireCompanyActor(ctx, args.companyId);
    requireOrganizationWorkspace(actor);
    if (!actor.permissions.isOwner) {
      throw backendError("permission-denied", "Only an owner may grant ownership.");
    }

    const membership = await membershipInCompany(ctx, actor.company._id, args.membershipId);
    if (membership.state !== "active") {
      throw backendError(
        "invalid-arguments",
        "Only an active member may be made an owner; a locked or departed one authorizes nothing.",
      );
    }
    // Idempotent: a retried grant converges on one owner row instead of a duplicate that would then
    // count twice against the last-owner guard.
    if (await isOwnerMembership(ctx, actor.company._id, membership._id)) return null;

    await ctx.db.insert("companyOwners", {
      companyId: actor.company._id,
      membershipId: membership._id,
      grantedByMembershipId: actor.kind === "member" ? actor.membership.id : null,
      createdAt: Date.now(),
    });
    await appendCompanyChanges(ctx, {
      companyId: actor.company._id,
      actor: actorRecord(actor),
      changes: [],
      companyUpsert: true,
      bumpEpoch: true,
    });
    return null;
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
    const actor = await requireCompanyActor(ctx, args.companyId);
    requireOrganizationWorkspace(actor);
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
    // Deleted before the append, which re-reads `companyOwners` while encoding: the emitted payload
    // is the owner set as it now stands, so a replica cannot be left holding the revoked grant.
    await appendCompanyChanges(ctx, {
      companyId: actor.company._id,
      actor: actorRecord(actor),
      changes: [],
      companyUpsert: true,
      bumpEpoch: true,
    });
    return null;
  },
});

/**
 * Schedules deletion. Access is disabled immediately and the records survive, owner-restorable,
 * for 30 days before a purge run removes them.
 *
 * Disabling access needs no extra machinery: `requireCompanyActor` refuses any company whose
 * lifecycle is not `active`, so the state patch itself closes every company-scoped function —
 * including this one, which is what makes a second schedule impossible rather than merely
 * idempotent, and {@link restore} the only way back in.
 *
 * The epoch bumps so a client already holding a replica learns on its next poll that its
 * authorization has changed rather than continuing to serve the company from cache for the length
 * of its offline grant.
 *
 * TODO(phase 8): schedule the purge job that removes records, files, invitations, credentials, and
 * change-feed data once `purgeAfter` passes. Until then the window simply never closes on its own.
 */
export const scheduleDeletion = mutation({
  args: { companyId: domainIdArg },
  returns: v.null(),
  handler: async (ctx, args) => {
    const actor = await requireCompanyActor(ctx, args.companyId);
    if (!actor.permissions.isOwner) {
      throw backendError("permission-denied", "Only an owner may delete a company.");
    }

    const now = Date.now();
    await ctx.db.patch(actor.company._id, {
      lifecycleState: "deletionScheduled",
      deletionScheduledAt: now,
      purgeAfter: companyPurgeAfter(now),
    });
    await appendCompanyChanges(ctx, {
      companyId: actor.company._id,
      actor: actorRecord(actor),
      changes: [],
      companyUpsert: true,
      bumpEpoch: true,
    });
    return null;
  },
});

/**
 * Restores a company inside its recovery window.
 *
 * Cannot go through {@link requireCompanyActor}, which refuses non-active companies — restoring is
 * the one operation whose whole point is that the company is unavailable. So the checks that call
 * makes are re-made here by hand, and only those: an active membership belonging to the signed-in
 * user, and an owner grant on it. Ownership is deliberately not substitutable by `company.manage`;
 * scheduling the deletion was owner-only, so undoing it is too.
 */
export const restore = mutation({
  args: { companyId: domainIdArg },
  returns: v.null(),
  handler: async (ctx, args) => {
    const user = await currentUser(ctx);
    if (user === null) {
      throw backendError("not-authenticated", "Restoring a company requires a signed-in user.");
    }

    const company = await companyByDomainId(ctx, args.companyId);
    if (company === null) throw backendError("company-not-found", `No company ${args.companyId}.`);
    if (company.lifecycleState === "purged") {
      throw backendError("company-unavailable", "This company has been purged and cannot return.");
    }
    // The window has closed even if the purge job has not run yet. Restoring here would resurrect a
    // company the owners have already been told is gone.
    if (company.purgeAfter !== null && isCompanyPurgeDue(company.purgeAfter, Date.now())) {
      throw backendError("company-unavailable", "The recovery window for this company has closed.");
    }

    const membership = await ctx.db
      .query("memberships")
      .withIndex("by_company_and_user", (q) =>
        q.eq("companyId", company._id).eq("userId", user._id),
      )
      .unique();
    if (membership === null || membership.state !== "active") {
      throw backendError("not-a-member", "You are not an active member of this company.");
    }
    if (!(await isOwnerMembership(ctx, company._id, membership._id))) {
      throw backendError("permission-denied", "Only an owner may restore a company.");
    }
    // Checked after authorization so a non-owner learns nothing about the company's lifecycle.
    if (company.lifecycleState === "active") return null;

    await ctx.db.patch(company._id, {
      lifecycleState: "active",
      deletionScheduledAt: null,
      purgeAfter: null,
    });
    await appendCompanyChanges(ctx, {
      companyId: company._id,
      actor: { kind: "member", membershipId: membership.id },
      changes: [],
      companyUpsert: true,
      bumpEpoch: true,
    });
    return null;
  },
});
