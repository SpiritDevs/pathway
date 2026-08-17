// @effect-diagnostics globalDate:off -- Convex mutations are not Effect programs; the transaction clock is `Date.now()`.
/**
 * Internal-only seed and teardown for the relay → Convex trust-chain smoke test.
 *
 * Every function here is an `internalMutation`/`internalQuery`, so nothing in this module is
 * reachable from a client bundle — the only way in is `npx convex run smoke:<fn>` with admin
 * credentials. They also deliberately skip the `PATHWAY_CLOUD_SYNC` capability gate: seeding and
 * cleanup must work on a deployment where the public surface is still switched off.
 *
 * All of them operate exclusively on the reserved smoke company
 * ({@link SMOKE_COMPANY_DOMAIN_ID}) and refuse anything else, so re-runs converge and real company
 * data is unreachable by construction. The reserved id alone proves identity, not provenance — a
 * manually imported company could carry it — so every function additionally requires the exact
 * {@link SMOKE_COMPANY_NAME} marker before touching the row, and `cleanup` refuses company
 * deletion outright when any table the smoke flow cannot write holds a row for it. The idempotency
 * key is that reserved id: `seed` upserts, `revokeRegistration`/`setThumbprint` patch in place,
 * and `cleanup` deletes only rows keyed to the smoke company.
 *
 * @module smoke
 */
import { v } from "convex/values";

import {
  isSmokeCompanyDomainId,
  isSweepableSmokeOrphan,
  isUsableSmokeKey,
  SMOKE_COMPANY_DOMAIN_ID,
  SMOKE_COMPANY_NAME,
  SMOKE_ISSUE_KEY_PREFIX,
  SMOKE_ROLE_DESCRIPTION,
  SMOKE_ROLE_DOMAIN_ID,
  SMOKE_ROLE_NAME,
  smokeDescriptor,
  smokeRegistrationDomainId,
  smokeServiceRolePermissions,
} from "../src/smokeSeed.ts";
import type { Doc } from "./_generated/dataModel.js";
import { internalMutation, internalQuery } from "./_generated/server.js";
import type { MutationCtx, QueryCtx } from "./_generated/server.js";
import { backendError } from "./lib/errors.ts";

/**
 * The last line of defense: no smoke function may proceed against any other company. Identity and
 * provenance are both required — the reserved id says which row was found, and the exact marker
 * name says the smoke seed created it. A company that carries the reserved id under any other name
 * was put there by something else (a manual import, say) and is refused rather than renamed,
 * reactivated, or deleted as disposable.
 */
function assertSmokeCompany(company: Doc<"companies">): void {
  if (!isSmokeCompanyDomainId(company.id)) {
    throw backendError(
      "smoke-guard-violation",
      `Refusing to touch company ${company.id}: smoke functions only operate on ${SMOKE_COMPANY_DOMAIN_ID}.`,
    );
  }
  if (company.name !== SMOKE_COMPANY_NAME) {
    throw backendError(
      "smoke-guard-violation",
      `Refusing to touch company ${company.id}: its name ${JSON.stringify(company.name)} is not ` +
        `the smoke marker ${JSON.stringify(SMOKE_COMPANY_NAME)}, so the smoke seed did not create it.`,
    );
  }
}

function requireUsableKey(name: string, value: string): string {
  if (!isUsableSmokeKey(value)) {
    throw backendError("invalid-arguments", `${name} must be a non-empty, trimmed string.`);
  }
  return value;
}

async function findSmokeCompany(ctx: QueryCtx): Promise<Doc<"companies"> | null> {
  const company = await ctx.db
    .query("companies")
    .withIndex("by_domain_id", (q) => q.eq("id", SMOKE_COMPANY_DOMAIN_ID))
    .unique();
  if (company !== null) assertSmokeCompany(company);
  return company;
}

async function findSmokeRegistration(
  ctx: QueryCtx,
  company: Doc<"companies">,
  environmentId: string,
): Promise<Doc<"environmentRegistrations"> | null> {
  assertSmokeCompany(company);
  return await ctx.db
    .query("environmentRegistrations")
    .withIndex("by_company_and_environment", (q) =>
      q.eq("companyId", company._id).eq("environmentId", environmentId),
    )
    .unique();
}

/** Any authorization-relevant change bumps the epoch, exactly as the real admin surface would. */
async function bumpAuthorizationEpoch(ctx: MutationCtx, company: Doc<"companies">): Promise<void> {
  assertSmokeCompany(company);
  await ctx.db.patch(company._id, {
    authorizationEpoch: company.authorizationEpoch + 1,
  });
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * Creates — or converges onto — the smoke company, its service role, and an active registration
 * for `environmentId` bound to `publicKeyThumbprint`. Re-seeding with a new thumbprint updates the
 * existing registration in place and restores it to `active`.
 */
export const seed = internalMutation({
  args: {
    environmentId: v.string(),
    publicKeyThumbprint: v.string(),
  },
  returns: v.object({
    companyId: v.string(),
    registrationId: v.string(),
    roleId: v.string(),
  }),
  handler: async (ctx, args) => {
    const environmentId = requireUsableKey("environmentId", args.environmentId);
    const publicKeyThumbprint = requireUsableKey("publicKeyThumbprint", args.publicKeyThumbprint);
    const now = Date.now();
    let authorizationChanged = false;

    let company = await findSmokeCompany(ctx);
    if (company === null) {
      const companyDocId = await ctx.db.insert("companies", {
        id: SMOKE_COMPANY_DOMAIN_ID,
        name: SMOKE_COMPANY_NAME,
        issueKeyPrefix: SMOKE_ISSUE_KEY_PREFIX,
        nextIssueNumber: 1,
        lifecycleState: "active",
        deletionScheduledAt: null,
        purgeAfter: null,
        authorizationEpoch: 1,
        syncVersion: 0,
        createdAt: now,
        updatedAt: now,
      });
      company = await ctx.db.get(companyDocId);
      if (company === null) {
        throw backendError("smoke-seed-failed", "The smoke company insert did not persist.");
      }
    } else if (company.lifecycleState !== "active") {
      // The marker name is already proven by `findSmokeCompany`; only the lifecycle can drift.
      // Renaming or reactivating a company that lacks the marker never happens — the guard threw.
      await ctx.db.patch(company._id, {
        lifecycleState: "active",
        deletionScheduledAt: null,
        purgeAfter: null,
        updatedAt: now,
      });
    }

    const permissions = [...smokeServiceRolePermissions()];
    const existingRole = await ctx.db
      .query("roles")
      .withIndex("by_company_and_domain_id", (q) =>
        q.eq("companyId", company._id).eq("id", SMOKE_ROLE_DOMAIN_ID),
      )
      .unique();
    if (existingRole === null) {
      await ctx.db.insert("roles", {
        id: SMOKE_ROLE_DOMAIN_ID,
        companyId: company._id,
        name: SMOKE_ROLE_NAME,
        description: SMOKE_ROLE_DESCRIPTION,
        permissions,
        seeded: false,
        createdAt: now,
        updatedAt: now,
      });
      authorizationChanged = true;
    } else if (!sameStringArray(existingRole.permissions, permissions)) {
      await ctx.db.patch(existingRole._id, { permissions, updatedAt: now });
      authorizationChanged = true;
    }

    const existingRegistration = await findSmokeRegistration(ctx, company, environmentId);
    let registrationId: string;
    if (existingRegistration === null) {
      registrationId = smokeRegistrationDomainId(environmentId);
      await ctx.db.insert("environmentRegistrations", {
        id: registrationId,
        companyId: company._id,
        environmentId,
        publicKeyThumbprint,
        descriptor: smokeDescriptor(environmentId),
        relayLinkState: "linked",
        managedEndpointAvailable: false,
        lastSeenAt: null,
        serviceRoleIds: [SMOKE_ROLE_DOMAIN_ID],
        teamIds: [],
        state: "active",
        registeredByMembershipId: null,
        createdAt: now,
        updatedAt: now,
      });
      authorizationChanged = true;
    } else {
      registrationId = existingRegistration.id;
      const converged =
        existingRegistration.publicKeyThumbprint === publicKeyThumbprint &&
        existingRegistration.state === "active" &&
        existingRegistration.relayLinkState === "linked" &&
        sameStringArray(existingRegistration.serviceRoleIds, [SMOKE_ROLE_DOMAIN_ID]) &&
        existingRegistration.teamIds.length === 0;
      if (!converged) {
        await ctx.db.patch(existingRegistration._id, {
          publicKeyThumbprint,
          state: "active",
          relayLinkState: "linked",
          serviceRoleIds: [SMOKE_ROLE_DOMAIN_ID],
          teamIds: [],
          updatedAt: now,
        });
        authorizationChanged = true;
      }
    }

    if (authorizationChanged) await bumpAuthorizationEpoch(ctx, company);

    return {
      companyId: SMOKE_COMPANY_DOMAIN_ID,
      registrationId,
      roleId: SMOKE_ROLE_DOMAIN_ID,
    };
  },
});

/** Revokes the smoke registration, which `requireCompanyActor` must then refuse. */
export const revokeRegistration = internalMutation({
  args: { environmentId: v.string() },
  returns: v.object({ revoked: v.boolean() }),
  handler: async (ctx, args) => {
    const environmentId = requireUsableKey("environmentId", args.environmentId);
    const company = await findSmokeCompany(ctx);
    if (company === null) return { revoked: false };
    const registration = await findSmokeRegistration(ctx, company, environmentId);
    if (registration === null) return { revoked: false };

    if (registration.state !== "revoked" || registration.relayLinkState !== "revoked") {
      const now = Date.now();
      await ctx.db.patch(registration._id, {
        state: "revoked",
        relayLinkState: "revoked",
        updatedAt: now,
      });
      await bumpAuthorizationEpoch(ctx, company);
    }
    return { revoked: true };
  },
});

/**
 * Overwrites the registered thumbprint without touching `state`, which is what makes the
 * key-mismatch rejection testable: a valid relay token bound to the old key must be refused.
 */
export const setThumbprint = internalMutation({
  args: {
    environmentId: v.string(),
    publicKeyThumbprint: v.string(),
  },
  returns: v.object({ updated: v.boolean() }),
  handler: async (ctx, args) => {
    const environmentId = requireUsableKey("environmentId", args.environmentId);
    const publicKeyThumbprint = requireUsableKey("publicKeyThumbprint", args.publicKeyThumbprint);
    const company = await findSmokeCompany(ctx);
    if (company === null) return { updated: false };
    const registration = await findSmokeRegistration(ctx, company, environmentId);
    if (registration === null) return { updated: false };

    if (registration.publicKeyThumbprint !== publicKeyThumbprint) {
      const now = Date.now();
      await ctx.db.patch(registration._id, { publicKeyThumbprint, updatedAt: now });
      await bumpAuthorizationEpoch(ctx, company);
    }
    return { updated: true };
  },
});

/**
 * Tables the smoke flow cannot write, each carrying a `companyId`-prefixed index. `seed` only ever
 * inserts the company, one role, and registrations; the environment actor's sync surface can add
 * change-feed rows, receipts, key leases, and issue-domain rows (see
 * {@link SYNC_WRITTEN_TABLES_BY_COMPANY_AND_DOMAIN_ID}) — all of which `cleanup` sweeps — but
 * nothing here. A row in any of these means the reserved company has been mixed with data of
 * unknown provenance, and `cleanup` must refuse to delete the company rather than delete blind.
 *
 * `environmentCommands` and `companySettings` stay on this list rather than swept because the
 * smoke identity cannot create either. Command issuance is member-only; claim and status reporting
 * can only transition a row somebody else already created, which is foreign provenance under this
 * reserved company and must keep cleanup fail-closed.
 *
 * Enumerated from `schema.ts`, split by which company-scoped index each table carries.
 */
const FOREIGN_TABLES_BY_COMPANY = [
  "memberships",
  "companyOwners",
  "teams",
  "teamMemberships",
  "roleAssignments",
  "companyInvitations",
  "cloudProjects",
  "environmentBindings",
  "environmentCommands",
  "agentThreads",
  "capturedEmails",
  "capturedEmailDeletions",
  "emailTags",
  "trustedEmailSenders",
  "companySettings",
] as const;

/**
 * `issueAttachments` is the one issue-domain table with no sync operation kind (attachments stay
 * server-authored), so the environment actor cannot have written it and a row still means foreign
 * data.
 */
const FOREIGN_TABLES_BY_COMPANY_AND_DOMAIN_ID = ["issueAttachments"] as const;

/**
 * Every issue-domain table `sync.applyOperations` can write for an environment actor — the
 * insert targets of `convex/lib/issueApply.ts`, including the server-authored `issueAuditEvents`
 * rows its handlers emit as side effects. The smoke harness's `issueLabel.create`/`delete` round
 * trip leaves a tombstoned `issueLabels` row behind, so `cleanup` sweeps these with the company
 * instead of refusing over the smoke run's own writes.
 */
const SYNC_WRITTEN_TABLES_BY_COMPANY_AND_DOMAIN_ID = [
  "issues",
  "issueStatuses",
  "issueLabels",
  "issueMilestones",
  "issueCycles",
  "issueTodos",
  "issueRelations",
  "issueComments",
  "issueViews",
  "issueAuditEvents",
  "issueThreadLinks",
] as const;

/** Names of the {@link FOREIGN_TABLES_BY_COMPANY}-style tables holding rows for `company`. */
async function foreignTablesWithRows(
  ctx: QueryCtx,
  company: Doc<"companies">,
): Promise<readonly string[]> {
  assertSmokeCompany(company);
  const offending: string[] = [];
  for (const table of FOREIGN_TABLES_BY_COMPANY) {
    const row = await ctx.db
      .query(table)
      .withIndex("by_company", (q) => q.eq("companyId", company._id))
      .first();
    if (row !== null) offending.push(table);
  }
  for (const table of FOREIGN_TABLES_BY_COMPANY_AND_DOMAIN_ID) {
    const row = await ctx.db
      .query(table)
      .withIndex("by_company_and_domain_id", (q) => q.eq("companyId", company._id))
      .first();
    if (row !== null) offending.push(table);
  }
  // `roles` is half foreign: `seed` writes exactly one, at the reserved id. Any other role under
  // the smoke company came from somewhere else, so the sweep must not delete it blind either.
  const roles = await ctx.db
    .query("roles")
    .withIndex("by_company", (q) => q.eq("companyId", company._id))
    .collect();
  if (roles.some((role) => role.id !== SMOKE_ROLE_DOMAIN_ID)) offending.push("roles");
  return offending;
}

const cleanupCounts = v.object({
  registrations: v.number(),
  sweptRegistrations: v.number(),
  /** Registrations left in place, each of which keeps the company alive. */
  retainedRegistrations: v.number(),
  companies: v.number(),
  roles: v.number(),
  syncChanges: v.number(),
  syncOperationReceipts: v.number(),
  issueKeyReservations: v.number(),
  /** Rows deleted across {@link SYNC_WRITTEN_TABLES_BY_COMPANY_AND_DOMAIN_ID}, summed. */
  issueDomainRows: v.number(),
});

/**
 * Deletes the smoke registration for `environmentId`, sweeps the orphaned registrations an
 * interrupted earlier run left behind ({@link isSweepableSmokeOrphan}: the synthetic
 * {@link SMOKE_ENVIRONMENT_ID_PREFIX} *and* untouched long enough that no run could still be using
 * it), and then — once no registrations remain at all — deletes the company itself plus everything
 * the smoke flow can have written under it: its service role, change-feed rows, operation
 * receipts, issue-key leases, and the issue-domain rows the sync surface wrote on the environment
 * actor's behalf (the harness's tombstoned `issueLabels` row and the audit events issue operations
 * emit).
 *
 * The age gate is what keeps two smoke runs from destroying each other: they share one reserved
 * company, so a prefix-only sweep would delete a concurrent run's live registration — and its
 * company — mid-flight. A young registration is retained instead, which merely postpones the
 * company delete to the next run.
 *
 * Every delete is scoped to the smoke company's `_id`, so nothing else is reachable. And before
 * the company goes, every table the smoke flow cannot write is checked: if any holds a row for
 * this company, the whole mutation throws (Convex rolls the transaction back, registrations
 * included), leaving the company intact for a human to inspect instead of deleting blind.
 */
export const cleanup = internalMutation({
  args: { environmentId: v.string() },
  returns: cleanupCounts,
  handler: async (ctx, args) => {
    const environmentId = requireUsableKey("environmentId", args.environmentId);
    const now = Date.now();
    const counts = {
      registrations: 0,
      sweptRegistrations: 0,
      retainedRegistrations: 0,
      companies: 0,
      roles: 0,
      syncChanges: 0,
      syncOperationReceipts: 0,
      issueKeyReservations: 0,
      issueDomainRows: 0,
    };

    const company = await findSmokeCompany(ctx);
    if (company === null) return counts;

    const registration = await findSmokeRegistration(ctx, company, environmentId);
    if (registration !== null) {
      await ctx.db.delete(registration._id);
      counts.registrations += 1;
    }

    // Sweep the orphans an interrupted run left behind. Only aged-out ids carrying the synthetic
    // prefix qualify; anything else registered against the smoke company — a real registration, or
    // a concurrent run's live one — keeps holding it open.
    const others = await ctx.db
      .query("environmentRegistrations")
      .withIndex("by_company", (q) => q.eq("companyId", company._id))
      .collect();
    for (const other of others) {
      if (
        isSweepableSmokeOrphan({
          environmentId: other.environmentId,
          updatedAt: other.updatedAt,
          now,
        })
      ) {
        await ctx.db.delete(other._id);
        counts.sweptRegistrations += 1;
      } else {
        counts.retainedRegistrations += 1;
      }
    }
    if (counts.retainedRegistrations > 0) return counts;

    const offendingTables = await foreignTablesWithRows(ctx, company);
    if (offendingTables.length > 0) {
      throw backendError(
        "smoke-cleanup-refused",
        `Refusing to delete company ${company.id}: rows exist in tables the smoke flow never ` +
          `writes (${offendingTables.join(", ")}). Nothing was deleted; inspect and clean the ` +
          `company by hand.`,
      );
    }

    // The foreign check above proved the reserved role is the only one here, and deleting by its
    // exact id keeps that true even if the check ever loosens.
    const role = await ctx.db
      .query("roles")
      .withIndex("by_company_and_domain_id", (q) =>
        q.eq("companyId", company._id).eq("id", SMOKE_ROLE_DOMAIN_ID),
      )
      .unique();
    if (role !== null) {
      await ctx.db.delete(role._id);
      counts.roles += 1;
    }

    const syncChanges = await ctx.db
      .query("syncChanges")
      .withIndex("by_company_and_version", (q) => q.eq("companyId", company._id))
      .collect();
    for (const change of syncChanges) {
      await ctx.db.delete(change._id);
      counts.syncChanges += 1;
    }

    const receipts = await ctx.db
      .query("syncOperationReceipts")
      .withIndex("by_company_and_operation", (q) => q.eq("companyId", company._id))
      .collect();
    for (const receipt of receipts) {
      await ctx.db.delete(receipt._id);
      counts.syncOperationReceipts += 1;
    }

    const reservations = await ctx.db
      .query("issueKeyReservations")
      .withIndex("by_company", (q) => q.eq("companyId", company._id))
      .collect();
    for (const reservation of reservations) {
      await ctx.db.delete(reservation._id);
      counts.issueKeyReservations += 1;
    }

    for (const table of SYNC_WRITTEN_TABLES_BY_COMPANY_AND_DOMAIN_ID) {
      const rows = await ctx.db
        .query(table)
        .withIndex("by_company_and_domain_id", (q) => q.eq("companyId", company._id))
        .collect();
      for (const row of rows) {
        await ctx.db.delete(row._id);
        counts.issueDomainRows += 1;
      }
    }

    await ctx.db.delete(company._id);
    counts.companies += 1;
    return counts;
  },
});

/** Read-only view of the seeded state, for eyeballing a smoke run without touching anything. */
export const inspect = internalQuery({
  args: { environmentId: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      companyId: v.string(),
      authorizationEpoch: v.number(),
      syncVersion: v.number(),
      registration: v.union(
        v.null(),
        v.object({
          id: v.string(),
          publicKeyThumbprint: v.string(),
          state: v.union(v.literal("active"), v.literal("revoked")),
          relayLinkState: v.string(),
          serviceRoleIds: v.array(v.string()),
          teamIds: v.array(v.string()),
        }),
      ),
    }),
  ),
  handler: async (ctx, args) => {
    const environmentId = requireUsableKey("environmentId", args.environmentId);
    const company = await findSmokeCompany(ctx);
    if (company === null) return null;
    const registration = await findSmokeRegistration(ctx, company, environmentId);
    return {
      companyId: company.id,
      authorizationEpoch: company.authorizationEpoch,
      syncVersion: company.syncVersion,
      registration:
        registration === null
          ? null
          : {
              id: registration.id,
              publicKeyThumbprint: registration.publicKeyThumbprint,
              state: registration.state,
              relayLinkState: registration.relayLinkState,
              serviceRoleIds: registration.serviceRoleIds,
              teamIds: registration.teamIds,
            },
    };
  },
});
