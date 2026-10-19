// @effect-diagnostics globalDate:off -- Convex mutations use the transaction clock.
/** Google calendar-account lifecycle. OAuth and mirror synchronization intentionally remain stubbed. */
import { v } from "convex/values";

import { hasCompanyPermission } from "../src/permissions.ts";
import { mutation } from "./_generated/server.js";
import { appendCompanyChanges, type CompanyChange } from "./lib/companyApply.ts";
import { backendError, notImplemented } from "./lib/errors.ts";
import { actorRecord, requireCompanyActor } from "./lib/identity.ts";
import { domainIdArg } from "./lib/validators.ts";

/** Keeps account disconnect atomic and below Convex's single-transaction read/write limits. */
const ACCOUNT_DISCONNECT_MAX_CALENDARS = 50;
const ACCOUNT_DISCONNECT_MAX_DEPENDENT_ROWS = 500;

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
      .withIndex("by_company_account_and_deleted", (q) =>
        q.eq("companyId", actor.company._id).eq("accountId", account._id).eq("deletedAt", null),
      )
      .take(ACCOUNT_DISCONNECT_MAX_CALENDARS + 1);
    if (calendars.length > ACCOUNT_DISCONNECT_MAX_CALENDARS) {
      throw backendError(
        "invalid-arguments",
        `This account has more than ${ACCOUNT_DISCONNECT_MAX_CALENDARS} live calendars and cannot be disconnected in one transaction.`,
      );
    }
    let dependentRoom = ACCOUNT_DISCONNECT_MAX_DEPENDENT_ROWS - calendars.length;
    const cascades = [];
    for (const calendar of calendars) {
      const grants = await ctx.db
        .query("calendarGrant")
        .withIndex("by_company_and_calendar", (q) =>
          q.eq("companyId", actor.company._id).eq("calendarId", calendar.id),
        )
        .take(dependentRoom + 1);
      if (grants.length > dependentRoom) {
        throw backendError(
          "invalid-arguments",
          `This account has more than ${ACCOUNT_DISCONNECT_MAX_DEPENDENT_ROWS} dependent records and cannot be disconnected in one transaction.`,
        );
      }
      dependentRoom -= grants.length;
      const events = await ctx.db
        .query("calendarEvent")
        .withIndex("by_company_calendar_and_deleted", (q) =>
          q.eq("companyId", actor.company._id).eq("calendarId", calendar.id).eq("deletedAt", null),
        )
        .take(dependentRoom + 1);
      if (events.length > dependentRoom) {
        throw backendError(
          "invalid-arguments",
          `This account has more than ${ACCOUNT_DISCONNECT_MAX_DEPENDENT_ROWS} dependent records and cannot be disconnected in one transaction.`,
        );
      }
      dependentRoom -= events.length;
      cascades.push({ calendar, grants, events });
    }
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

    for (const { calendar, grants, events } of cascades) {
      for (const event of events) {
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
