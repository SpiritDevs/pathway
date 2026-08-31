// @effect-diagnostics globalDate:off -- Convex mutations use the transaction clock.
/** Google calendar-account lifecycle. OAuth and mirror synchronization intentionally remain stubbed. */
import { v } from "convex/values";

import { hasCompanyPermission } from "../src/permissions.ts";
import { mutation } from "./_generated/server.js";
import { appendCompanyChanges, type CompanyChange } from "./lib/companyApply.ts";
import { backendError, notImplemented } from "./lib/errors.ts";
import { actorRecord, requireCompanyActor } from "./lib/identity.ts";
import { domainIdArg } from "./lib/validators.ts";

/**
 * Pins the future mirror API boundary without pretending OAuth or polling exists. When implemented,
 * mirrored calendars created here must use `sharing: "private"` by default.
 */
export const mirrorGoogleAccount = mutation({
  args: {
    companyId: domainIdArg,
    id: domainIdArg,
    providerAccountId: v.string(),
    email: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const actor = await requireCompanyActor(ctx, args.companyId);
    if (actor.kind !== "member") {
      throw backendError("permission-denied", "Calendar accounts require a member identity.");
    }
    notImplemented("Google Calendar OAuth and mirror synchronization");
  },
});

export const disconnect = mutation({
  args: { companyId: domainIdArg, accountId: domainIdArg },
  returns: v.null(),
  handler: async (ctx, args) => {
    const actor = await requireCompanyActor(ctx, args.companyId);
    if (actor.kind !== "member") {
      throw backendError("permission-denied", "Calendar accounts require a member identity.");
    }
    const account = await ctx.db
      .query("calendarAccount")
      .withIndex("by_company_and_domain_id", (q) =>
        q.eq("companyId", actor.company._id).eq("id", args.accountId),
      )
      .unique();
    if (account === null || account.disconnectedAt !== null) return null;
    if (
      account.ownerMembershipId !== actor.membership._id &&
      !hasCompanyPermission(actor.permissions, "company.manage")
    ) {
      throw backendError("permission-denied", "Calendar account cannot be disconnected.");
    }

    const calendars = await ctx.db
      .query("calendar")
      .withIndex("by_company_and_account", (q) =>
        q.eq("companyId", actor.company._id).eq("accountId", account._id),
      )
      .collect();
    const now = Date.now();
    const changes: CompanyChange[] = [
      {
        entityKind: "calendarAccount",
        entityId: account.id,
        changeKind: "tombstone",
        versionDocId: account._id,
        payload: null,
        calendarOwnerMembershipId: account.ownerMembershipId,
      },
    ];

    for (const calendar of calendars) {
      if (calendar.deletedAt !== null) continue;
      const grants = await ctx.db
        .query("calendarGrant")
        .withIndex("by_company_and_calendar", (q) =>
          q.eq("companyId", actor.company._id).eq("calendarId", calendar.id),
        )
        .collect();
      const events = await ctx.db
        .query("calendarEvent")
        .withIndex("by_company_and_calendar", (q) =>
          q.eq("companyId", actor.company._id).eq("calendarId", calendar.id),
        )
        .collect();
      for (const event of events) {
        if (event.deletedAt === null)
          await ctx.db.patch(event._id, { deletedAt: now, updatedAt: now });
      }
      for (const grant of grants) await ctx.db.delete(grant._id);
      await ctx.db.patch(calendar._id, { deletedAt: now, updatedAt: now });
      changes.push({
        entityKind: "calendar",
        entityId: calendar.id,
        changeKind: "tombstone",
        versionDocId: calendar._id,
        payload: null,
        calendarId: calendar.id,
        calendarOwnerMembershipId: calendar.ownerMembershipId,
        calendarSharing: calendar.sharing,
        calendarTeamId: calendar.teamId,
        calendarDepartureMembershipIds: grants.map((grant) => grant.granteeMembershipId),
        calendarDeleted: true,
      });
    }

    await ctx.db.patch(account._id, { disconnectedAt: now, updatedAt: now });
    await appendCompanyChanges(ctx, {
      companyId: actor.company._id,
      actor: actorRecord(actor),
      changes,
    });
    // `calendarEventLink` is deliberately untouched: unavailable links revive on reconnect.
    return null;
  },
});
