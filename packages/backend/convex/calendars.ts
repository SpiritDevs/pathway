// @effect-diagnostics globalDate:off -- Convex mutations use the transaction clock.
/** Online CRUD and sharing for Pathway-owned calendars and events. */
import { v } from "convex/values";

import {
  hasAnyScopePermission,
  hasCompanyPermission,
  hasRecordPermission,
} from "../src/permissions.ts";
import { internal } from "./_generated/api.js";
import { internalMutation, mutation, query } from "./_generated/server.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import type { QueryCtx } from "./_generated/server.js";
import {
  appendCompanyChanges,
  encodeCalendar,
  encodeCalendarEvent,
  encodeCalendarEventLink,
  type CompanyChange,
} from "./lib/companyApply.ts";
import { backendError } from "./lib/errors.ts";
import {
  actorRecord,
  requireCompanyActor,
  requireRecordPermission,
  type CompanyActor,
} from "./lib/identity.ts";
import { domainIdArg } from "./lib/validators.ts";

const MAX_NAME_LENGTH = 200;
const MAX_TITLE_LENGTH = 500;
const MAX_NOTES_LENGTH = 20_000;
const MAX_LOCATION_LENGTH = 500;
const MAX_URLS = 10;
const MAX_INVITEES = 100;
const MAX_REMINDERS = 10;
const MAX_ATTACHMENTS = 8;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const CALENDAR_REMOVE_MAX_DEPENDENT_ROWS = 500;
const CALENDAR_EVENT_RESEED_PAGE_SIZE = 50;
const sharingArg = v.union(v.literal("private"), v.literal("team"), v.literal("company"));
const visibilityArg = v.union(v.literal("default"), v.literal("private"));
const inviteeArg = v.object({
  email: v.string(),
  name: v.union(v.string(), v.null()),
  response: v.union(
    v.literal("needs-action"),
    v.literal("accepted"),
    v.literal("declined"),
    v.literal("tentative"),
  ),
});

function trimmed(value: string, label: string, max: number): string {
  const result = value.trim();
  if (result.length === 0 || result.length > max) {
    throw backendError("invalid-arguments", `${label} must be 1–${max} characters.`);
  }
  return result;
}

function timeZoneOf(value: string): string {
  const timeZone = value.trim();
  try {
    new Intl.DateTimeFormat("en", { timeZone }).format(0);
  } catch {
    throw backendError("invalid-arguments", "Event timeZone must be an IANA time-zone name.");
  }
  return timeZone;
}

function timeRange(startAt: number, endAt: number): void {
  if (
    !Number.isSafeInteger(startAt) ||
    !Number.isSafeInteger(endAt) ||
    startAt < 0 ||
    endAt <= startAt
  ) {
    throw backendError("invalid-arguments", "Event endAt must be after startAt.");
  }
}

function notesOf(value: string): string {
  if (value.length > MAX_NOTES_LENGTH) {
    throw backendError(
      "invalid-arguments",
      `Event notes cannot exceed ${MAX_NOTES_LENGTH} characters.`,
    );
  }
  return value;
}

function remindersOf(values: readonly number[]): number[] {
  if (values.length > MAX_REMINDERS) {
    throw backendError("invalid-arguments", `Choose at most ${MAX_REMINDERS} reminders.`);
  }
  const unique = [...new Set(values)];
  if (unique.some((value) => !Number.isSafeInteger(value) || value <= 0 || value > 40_320)) {
    throw backendError(
      "invalid-arguments",
      "Reminder lead times must be whole minutes within four weeks.",
    );
  }
  return unique.sort((left, right) => left - right);
}

function urlsOf(values: readonly string[]): string[] {
  if (values.length > MAX_URLS) {
    throw backendError("invalid-arguments", `Attach at most ${MAX_URLS} web links.`);
  }
  const result: string[] = [];
  for (const raw of values) {
    let url: URL;
    try {
      url = new URL(raw.trim());
    } catch {
      throw backendError("invalid-arguments", `Invalid event URL: ${raw}`);
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw backendError("invalid-arguments", "Event URLs must use http or https.");
    }
    const normalized = url.toString();
    if (!result.includes(normalized)) result.push(normalized);
  }
  return result;
}

function locationOf(value: string | null): string | null {
  if (value === null) return null;
  const location = value.trim();
  if (location.length === 0) return null;
  if (location.length > MAX_LOCATION_LENGTH) {
    throw backendError(
      "invalid-arguments",
      `Event location cannot exceed ${MAX_LOCATION_LENGTH} characters.`,
    );
  }
  return location;
}

function inviteesOf(
  values: ReadonlyArray<{
    readonly email: string;
    readonly name: string | null;
    readonly response: "needs-action" | "accepted" | "declined" | "tentative";
  }>,
) {
  if (values.length > MAX_INVITEES) {
    throw backendError("invalid-arguments", `An event can have at most ${MAX_INVITEES} invitees.`);
  }
  const result: Array<(typeof values)[number]> = [];
  const seen = new Set<string>();
  for (const invitee of values) {
    const email = invitee.email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw backendError("invalid-arguments", `Invalid invitee email: ${invitee.email}`);
    }
    if (seen.has(email)) continue;
    seen.add(email);
    result.push({
      email,
      name: invitee.name === null ? null : trimmed(invitee.name, "Invitee name", 200),
      response: invitee.response,
    });
  }
  return result;
}

async function byCalendarId(
  ctx: QueryCtx,
  companyId: Id<"companies">,
  calendarId: string,
): Promise<Doc<"calendar"> | null> {
  return await ctx.db
    .query("calendar")
    .withIndex("by_company_and_domain_id", (q) => q.eq("companyId", companyId).eq("id", calendarId))
    .unique();
}

async function byEventId(
  ctx: QueryCtx,
  companyId: Id<"companies">,
  eventId: string,
): Promise<Doc<"calendarEvent"> | null> {
  return await ctx.db
    .query("calendarEvent")
    .withIndex("by_company_and_domain_id", (q) => q.eq("companyId", companyId).eq("id", eventId))
    .unique();
}

function requireMember(
  actor: CompanyActor,
): asserts actor is Extract<CompanyActor, { kind: "member" }> {
  if (actor.kind !== "member") {
    throw backendError("permission-denied", "Calendar changes require a member identity.");
  }
}

function canManageCalendar(actor: CompanyActor, calendar: Doc<"calendar">): boolean {
  return (
    actor.kind === "member" &&
    (actor.membership._id === calendar.ownerMembershipId ||
      hasCompanyPermission(actor.permissions, "company.manage"))
  );
}

function requireOwnedPathwayCalendar(
  actor: CompanyActor,
  calendar: Doc<"calendar">,
): asserts actor is Extract<CompanyActor, { kind: "member" }> {
  requireMember(actor);
  if (!hasAnyScopePermission(actor.permissions, "calendar.read")) {
    throw backendError("permission-denied", "Missing permission calendar.read.");
  }
  if (calendar.deletedAt !== null) throw backendError("entity-not-found", "Calendar not found.");
  if (calendar.kind !== "pathway") {
    throw backendError("permission-denied", "Mirrored calendars are read-only.");
  }
  if (calendar.ownerMembershipId !== actor.membership._id) {
    throw backendError("permission-denied", "Only the calendar owner may edit it.");
  }
}

async function validatedTeamId(
  ctx: QueryCtx,
  actor: CompanyActor,
  sharing: "private" | "team" | "company",
  teamId: string | null,
): Promise<string | null> {
  if (sharing !== "team") {
    if (teamId !== null) {
      throw backendError("invalid-arguments", "teamId is only valid for team sharing.");
    }
    return null;
  }
  if (teamId === null) throw backendError("invalid-arguments", "Team sharing requires teamId.");
  const team = await ctx.db
    .query("teams")
    .withIndex("by_company_and_domain_id", (q) =>
      q.eq("companyId", actor.company._id).eq("id", teamId),
    )
    .unique();
  if (team === null || team.archivedAt !== null) {
    throw backendError("invalid-arguments", "Shared team not found.");
  }
  return team.id;
}

function calendarMetadata(
  calendar: Doc<"calendar">,
  extra: Pick<CompanyChange, "calendarDepartureMembershipIds" | "calendarDeleted"> = {},
): Pick<
  CompanyChange,
  | "calendarId"
  | "calendarOwnerMembershipId"
  | "calendarSharing"
  | "calendarTeamId"
  | "calendarDepartureMembershipIds"
  | "calendarDeleted"
> {
  return {
    calendarId: calendar.id,
    calendarOwnerMembershipId: calendar.ownerMembershipId,
    calendarSharing: calendar.sharing,
    calendarTeamId: calendar.teamId,
    ...extra,
  };
}

function calendarUpsert(calendar: Doc<"calendar">, payload: unknown): CompanyChange {
  return {
    entityKind: "calendar",
    entityId: calendar.id,
    changeKind: "upsert",
    versionDocId: calendar._id,
    payload,
    ...calendarMetadata(calendar),
  };
}

function eventChange(
  calendar: Doc<"calendar">,
  event: Doc<"calendarEvent">,
  changeKind: "upsert" | "tombstone",
  payload: unknown,
): CompanyChange {
  return {
    entityKind: "calendarEvent",
    entityId: event.id,
    changeKind,
    versionDocId: changeKind === "upsert" ? event._id : null,
    payload,
    ...calendarMetadata(calendar),
    calendarEventOwnerMembershipId: event.visibility === "private" ? event.ownerMembershipId : null,
  };
}

async function grantsForCalendar(ctx: QueryCtx, calendar: Doc<"calendar">) {
  return await ctx.db
    .query("calendarGrant")
    .withIndex("by_company_and_calendar", (q) =>
      q.eq("companyId", calendar.companyId).eq("calendarId", calendar.id),
    )
    .collect();
}

function canReadCalendar(
  actor: CompanyActor,
  calendar: Doc<"calendar">,
  grantedCalendarIds: ReadonlySet<string>,
): boolean {
  if (!hasAnyScopePermission(actor.permissions, "calendar.read")) return false;
  if (actor.kind === "member" && actor.membership._id === calendar.ownerMembershipId) return true;
  if (grantedCalendarIds.has(calendar.id)) return true;
  if (calendar.sharing === "company") {
    return hasCompanyPermission(actor.permissions, "calendar.readAll");
  }
  return (
    calendar.sharing === "team" &&
    calendar.teamId !== null &&
    hasRecordPermission(actor.permissions, "calendar.readAll", [calendar.teamId])
  );
}

export const listGroupedByOwner = query({
  args: { companyId: domainIdArg },
  returns: v.array(
    v.object({
      ownerMembershipId: domainIdArg,
      ownerName: v.string(),
      calendars: v.array(v.any()),
    }),
  ),
  handler: async (ctx, args) => {
    const actor = await requireCompanyActor(ctx, args.companyId);
    const grants =
      actor.kind === "member"
        ? await ctx.db
            .query("calendarGrant")
            .withIndex("by_company_and_grantee", (q) =>
              q.eq("companyId", actor.company._id).eq("granteeMembershipId", actor.membership._id),
            )
            .collect()
        : [];
    const grantedCalendarIds = new Set(grants.map((grant) => grant.calendarId));
    const calendars = await ctx.db
      .query("calendar")
      .withIndex("by_company_and_domain_id", (q) => q.eq("companyId", actor.company._id))
      .collect();
    const groups = new Map<
      Id<"memberships">,
      { ownerMembershipId: string; ownerName: string; calendars: unknown[] }
    >();
    for (const calendar of calendars) {
      if (
        calendar.deletedAt !== null ||
        (!canManageCalendar(actor, calendar) &&
          !canReadCalendar(actor, calendar, grantedCalendarIds))
      ) {
        continue;
      }
      const owner = await ctx.db.get(calendar.ownerMembershipId);
      if (owner === null) continue;
      let group = groups.get(owner._id);
      if (group === undefined) {
        group = {
          ownerMembershipId: owner.id,
          ownerName: owner.displayNameSnapshot,
          calendars: [],
        };
        groups.set(owner._id, group);
      }
      group.calendars.push({
        ...(await encodeCalendar(ctx, calendar)),
        companyId: actor.company.id,
      });
    }
    return [...groups.values()].sort((a, b) => a.ownerName.localeCompare(b.ownerName));
  },
});

export const listGrants = query({
  args: { companyId: domainIdArg, calendarId: domainIdArg },
  returns: v.array(
    v.object({
      id: domainIdArg,
      granteeMembershipId: domainIdArg,
      granteeName: v.string(),
      createdAt: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const actor = await requireCompanyActor(ctx, args.companyId);
    const calendar = await byCalendarId(ctx, actor.company._id, args.calendarId);
    if (calendar === null || calendar.deletedAt !== null || !canManageCalendar(actor, calendar)) {
      throw backendError("permission-denied", "Calendar grants are not available.");
    }
    const grants = await grantsForCalendar(ctx, calendar);
    const result = [];
    for (const grant of grants) {
      const grantee = await ctx.db.get(grant.granteeMembershipId);
      if (grantee === null) continue;
      result.push({
        id: grant.id,
        granteeMembershipId: grantee.id,
        granteeName: grantee.displayNameSnapshot,
        createdAt: grant.createdAt,
      });
    }
    return result.sort((a, b) => a.granteeName.localeCompare(b.granteeName));
  },
});

export const create = mutation({
  args: {
    companyId: domainIdArg,
    id: domainIdArg,
    name: v.string(),
    sharing: v.optional(sharingArg),
    teamId: v.optional(v.union(domainIdArg, v.null())),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const actor = await requireCompanyActor(ctx, args.companyId);
    requireMember(actor);
    if (!hasAnyScopePermission(actor.permissions, "calendar.read")) {
      throw backendError("permission-denied", "Missing permission calendar.read.");
    }
    if ((await byCalendarId(ctx, actor.company._id, args.id)) !== null) {
      throw backendError("foreign-id-conflict", "That calendar id exists.");
    }
    const sharing = args.sharing ?? "private";
    const teamId = await validatedTeamId(ctx, actor, sharing, args.teamId ?? null);
    const now = Date.now();
    const rowId = await ctx.db.insert("calendar", {
      id: args.id,
      companyId: actor.company._id,
      ownerMembershipId: actor.membership._id,
      name: trimmed(args.name, "Calendar name", MAX_NAME_LENGTH),
      sharing,
      teamId,
      kind: "pathway",
      accountId: null,
      googleCalendarId: null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    });
    const calendar = await ctx.db.get(rowId);
    if (calendar === null) throw backendError("entity-not-found", "Calendar vanished.");
    await appendCompanyChanges(ctx, {
      companyId: actor.company._id,
      actor: actorRecord(actor),
      changes: [calendarUpsert(calendar, await encodeCalendar(ctx, calendar))],
    });
    return null;
  },
});

export const update = mutation({
  args: {
    companyId: domainIdArg,
    calendarId: domainIdArg,
    name: v.optional(v.string()),
    sharing: v.optional(sharingArg),
    teamId: v.optional(v.union(domainIdArg, v.null())),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const actor = await requireCompanyActor(ctx, args.companyId);
    const calendar = await byCalendarId(ctx, actor.company._id, args.calendarId);
    if (calendar === null) throw backendError("entity-not-found", "Calendar not found.");
    requireOwnedPathwayCalendar(actor, calendar);
    const sharing = args.sharing ?? calendar.sharing;
    const suppliedTeamId = args.teamId === undefined ? calendar.teamId : args.teamId;
    const teamId = await validatedTeamId(ctx, actor, sharing, suppliedTeamId);
    const name =
      args.name === undefined
        ? calendar.name
        : trimmed(args.name, "Calendar name", MAX_NAME_LENGTH);
    if (name === calendar.name && sharing === calendar.sharing && teamId === calendar.teamId)
      return null;
    await ctx.db.patch(calendar._id, { name, sharing, teamId, updatedAt: Date.now() });
    const updated = await ctx.db.get(calendar._id);
    if (updated === null) throw backendError("entity-not-found", "Calendar vanished.");
    const scopeChanged = sharing !== calendar.sharing || teamId !== calendar.teamId;
    const changes: CompanyChange[] = [];
    if (scopeChanged) {
      changes.push({
        entityKind: "calendar",
        entityId: calendar.id,
        changeKind: "tombstone",
        versionDocId: null,
        payload: null,
        ...calendarMetadata(calendar),
        calendarDeleted: true,
      });
    }
    changes.push(calendarUpsert(updated, await encodeCalendar(ctx, updated)));
    await appendCompanyChanges(ctx, {
      companyId: actor.company._id,
      actor: actorRecord(actor),
      changes,
    });
    if (scopeChanged) {
      await ctx.scheduler.runAfter(0, internal.calendars.republishSharedEvents, {
        calendarDocId: updated._id,
        cursor: null,
      });
    }
    return null;
  },
});

export const remove = mutation({
  args: { companyId: domainIdArg, calendarId: domainIdArg },
  returns: v.null(),
  handler: async (ctx, args) => {
    const actor = await requireCompanyActor(ctx, args.companyId);
    const calendar = await byCalendarId(ctx, actor.company._id, args.calendarId);
    if (calendar === null || calendar.deletedAt !== null) return null;
    requireOwnedPathwayCalendar(actor, calendar);
    const grants = await ctx.db
      .query("calendarGrant")
      .withIndex("by_company_and_calendar", (q) =>
        q.eq("companyId", calendar.companyId).eq("calendarId", calendar.id),
      )
      .take(CALENDAR_REMOVE_MAX_DEPENDENT_ROWS + 1);
    const attachmentRoom = CALENDAR_REMOVE_MAX_DEPENDENT_ROWS - grants.length;
    if (attachmentRoom < 0) {
      throw backendError(
        "invalid-arguments",
        `This calendar has more than ${CALENDAR_REMOVE_MAX_DEPENDENT_ROWS} dependent records; revoke grants or delete events before deleting it.`,
      );
    }
    const attachments = await ctx.db
      .query("calendarEventAttachments")
      .withIndex("by_company_and_calendar", (q) =>
        q.eq("companyId", actor.company._id).eq("calendarId", calendar.id),
      )
      .take(attachmentRoom + 1);
    const eventRoom = attachmentRoom - attachments.length;
    if (eventRoom < 0) {
      throw backendError(
        "invalid-arguments",
        `This calendar has more than ${CALENDAR_REMOVE_MAX_DEPENDENT_ROWS} dependent records; remove attachments before deleting it.`,
      );
    }
    const now = Date.now();
    const events = await ctx.db
      .query("calendarEvent")
      .withIndex("by_company_calendar_and_deleted", (q) =>
        q.eq("companyId", actor.company._id).eq("calendarId", calendar.id).eq("deletedAt", null),
      )
      .take(eventRoom + 1);
    if (events.length > eventRoom) {
      throw backendError(
        "invalid-arguments",
        `This calendar has more than ${CALENDAR_REMOVE_MAX_DEPENDENT_ROWS} dependent records; revoke grants or delete events before deleting it.`,
      );
    }
    for (const attachment of attachments) {
      await ctx.storage.delete(attachment.storageId);
      await ctx.db.delete(attachment._id);
    }
    for (const event of events) await ctx.db.patch(event._id, { deletedAt: now, updatedAt: now });
    for (const grant of grants) await ctx.db.delete(grant._id);
    await ctx.db.patch(calendar._id, { deletedAt: now, updatedAt: now });
    await appendCompanyChanges(ctx, {
      companyId: actor.company._id,
      actor: actorRecord(actor),
      changes: [
        {
          entityKind: "calendar",
          entityId: calendar.id,
          changeKind: "tombstone",
          versionDocId: calendar._id,
          payload: null,
          ...calendarMetadata(calendar, {
            calendarDepartureMembershipIds: grants.map((grant) => grant.granteeMembershipId),
            calendarDeleted: true,
          }),
        },
      ],
    });
    return null;
  },
});

export const share = mutation({
  args: {
    companyId: domainIdArg,
    id: domainIdArg,
    calendarId: domainIdArg,
    granteeMembershipId: domainIdArg,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const actor = await requireCompanyActor(ctx, args.companyId);
    requireMember(actor);
    const calendar = await byCalendarId(ctx, actor.company._id, args.calendarId);
    if (calendar === null || calendar.deletedAt !== null || !canManageCalendar(actor, calendar)) {
      throw backendError("permission-denied", "Calendar cannot be shared.");
    }
    const grantee = await ctx.db
      .query("memberships")
      .withIndex("by_company_and_domain_id", (q) =>
        q.eq("companyId", actor.company._id).eq("id", args.granteeMembershipId),
      )
      .unique();
    if (grantee === null || grantee.state !== "active") {
      throw backendError("invalid-arguments", "Grantee must be an active company member.");
    }
    const existing = await ctx.db
      .query("calendarGrant")
      .withIndex("by_company_calendar_and_grantee", (q) =>
        q
          .eq("companyId", actor.company._id)
          .eq("calendarId", calendar.id)
          .eq("granteeMembershipId", grantee._id),
      )
      .unique();
    if (existing !== null) return null;
    const idConflict = await ctx.db
      .query("calendarGrant")
      .withIndex("by_company_and_domain_id", (q) =>
        q.eq("companyId", actor.company._id).eq("id", args.id),
      )
      .unique();
    if (idConflict !== null) throw backendError("foreign-id-conflict", "That grant id exists.");
    await ctx.db.insert("calendarGrant", {
      id: args.id,
      companyId: actor.company._id,
      calendarId: calendar.id,
      granteeMembershipId: grantee._id,
      grantedByMembershipId: actor.membership._id,
      createdAt: Date.now(),
    });
    await appendCompanyChanges(ctx, {
      companyId: actor.company._id,
      actor: actorRecord(actor),
      changes: [calendarUpsert(calendar, await encodeCalendar(ctx, calendar))],
    });
    await ctx.scheduler.runAfter(0, internal.calendars.republishSharedEvents, {
      calendarDocId: calendar._id,
      cursor: null,
    });
    return null;
  },
});

/** Republishes non-private events after a grant or scope change, one bounded feed page at a time. */
export const republishSharedEvents = internalMutation({
  args: {
    calendarDocId: v.id("calendar"),
    cursor: v.union(v.string(), v.null()),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const calendar = await ctx.db.get(args.calendarDocId);
    if (calendar === null || calendar.deletedAt !== null) return null;
    const page = await ctx.db
      .query("calendarEvent")
      .withIndex("by_company_calendar_deleted_and_visibility", (q) =>
        q
          .eq("companyId", calendar.companyId)
          .eq("calendarId", calendar.id)
          .eq("deletedAt", null)
          .eq("visibility", "default"),
      )
      .paginate({ cursor: args.cursor, numItems: CALENDAR_EVENT_RESEED_PAGE_SIZE });
    if (page.page.length > 0) {
      const changes = await Promise.all(
        page.page.map(async (event) =>
          eventChange(calendar, event, "upsert", await encodeCalendarEvent(ctx, event)),
        ),
      );
      await appendCompanyChanges(ctx, {
        companyId: calendar.companyId,
        actor: { kind: "system", source: "automation" },
        changes,
      });
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.calendars.republishSharedEvents, {
        ...args,
        cursor: page.continueCursor,
      });
    }
    return null;
  },
});

export const revoke = mutation({
  args: {
    companyId: domainIdArg,
    calendarId: domainIdArg,
    granteeMembershipId: domainIdArg,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const actor = await requireCompanyActor(ctx, args.companyId);
    requireMember(actor);
    const calendar = await byCalendarId(ctx, actor.company._id, args.calendarId);
    if (calendar === null || calendar.deletedAt !== null || !canManageCalendar(actor, calendar)) {
      throw backendError("permission-denied", "Calendar grant cannot be revoked.");
    }
    const grantee = await ctx.db
      .query("memberships")
      .withIndex("by_company_and_domain_id", (q) =>
        q.eq("companyId", actor.company._id).eq("id", args.granteeMembershipId),
      )
      .unique();
    if (grantee === null) return null;
    const grant = await ctx.db
      .query("calendarGrant")
      .withIndex("by_company_calendar_and_grantee", (q) =>
        q
          .eq("companyId", actor.company._id)
          .eq("calendarId", calendar.id)
          .eq("granteeMembershipId", grantee._id),
      )
      .unique();
    if (grant === null) return null;
    await ctx.db.delete(grant._id);
    await appendCompanyChanges(ctx, {
      companyId: actor.company._id,
      actor: actorRecord(actor),
      changes: [
        {
          entityKind: "calendar",
          entityId: calendar.id,
          changeKind: "tombstone",
          versionDocId: null,
          payload: null,
          ...calendarMetadata(calendar, {
            calendarDepartureMembershipIds: [grantee._id],
            calendarDeleted: false,
          }),
        },
      ],
    });
    return null;
  },
});

export const createEvent = mutation({
  args: {
    companyId: domainIdArg,
    id: domainIdArg,
    calendarId: domainIdArg,
    title: v.string(),
    startAt: v.number(),
    endAt: v.number(),
    timeZone: v.string(),
    allDay: v.boolean(),
    notes: v.optional(v.string()),
    reminderMinutes: v.optional(v.array(v.number())),
    urls: v.optional(v.array(v.string())),
    location: v.optional(v.union(v.string(), v.null())),
    invitees: v.optional(v.array(inviteeArg)),
    visibility: v.optional(visibilityArg),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const actor = await requireCompanyActor(ctx, args.companyId);
    const calendar = await byCalendarId(ctx, actor.company._id, args.calendarId);
    if (calendar === null) throw backendError("entity-not-found", "Calendar not found.");
    requireOwnedPathwayCalendar(actor, calendar);
    if ((await byEventId(ctx, actor.company._id, args.id)) !== null) {
      throw backendError("foreign-id-conflict", "That calendar event id exists.");
    }
    timeRange(args.startAt, args.endAt);
    const now = Date.now();
    const rowId = await ctx.db.insert("calendarEvent", {
      id: args.id,
      companyId: actor.company._id,
      calendarId: calendar.id,
      ownerMembershipId: calendar.ownerMembershipId,
      title: trimmed(args.title, "Event title", MAX_TITLE_LENGTH),
      startAt: args.startAt,
      endAt: args.endAt,
      timeZone: timeZoneOf(args.timeZone),
      allDay: args.allDay,
      notes: notesOf(args.notes ?? ""),
      reminderMinutes: remindersOf(args.reminderMinutes ?? []),
      urls: urlsOf(args.urls ?? []),
      location: locationOf(args.location ?? null),
      invitees: inviteesOf(args.invitees ?? []),
      attachments: [],
      visibility: args.visibility ?? "default",
      googleEventId: null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    });
    const event = await ctx.db.get(rowId);
    if (event === null) throw backendError("entity-not-found", "Calendar event vanished.");
    await appendCompanyChanges(ctx, {
      companyId: actor.company._id,
      actor: actorRecord(actor),
      changes: [eventChange(calendar, event, "upsert", await encodeCalendarEvent(ctx, event))],
    });
    return null;
  },
});

export const updateEvent = mutation({
  args: {
    companyId: domainIdArg,
    eventId: domainIdArg,
    title: v.optional(v.string()),
    startAt: v.optional(v.number()),
    endAt: v.optional(v.number()),
    timeZone: v.optional(v.string()),
    allDay: v.optional(v.boolean()),
    notes: v.optional(v.string()),
    reminderMinutes: v.optional(v.array(v.number())),
    urls: v.optional(v.array(v.string())),
    location: v.optional(v.union(v.string(), v.null())),
    invitees: v.optional(v.array(inviteeArg)),
    visibility: v.optional(visibilityArg),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const actor = await requireCompanyActor(ctx, args.companyId);
    const event = await byEventId(ctx, actor.company._id, args.eventId);
    if (event === null || event.deletedAt !== null)
      throw backendError("entity-not-found", "Event not found.");
    const calendar = await byCalendarId(ctx, actor.company._id, event.calendarId);
    if (calendar === null) throw backendError("entity-not-found", "Calendar not found.");
    requireOwnedPathwayCalendar(actor, calendar);
    const startAt = args.startAt ?? event.startAt;
    const endAt = args.endAt ?? event.endAt;
    timeRange(startAt, endAt);
    const patch = {
      title:
        args.title === undefined
          ? event.title
          : trimmed(args.title, "Event title", MAX_TITLE_LENGTH),
      startAt,
      endAt,
      timeZone: args.timeZone === undefined ? event.timeZone : timeZoneOf(args.timeZone),
      allDay: args.allDay ?? event.allDay,
      notes: args.notes === undefined ? (event.notes ?? "") : notesOf(args.notes),
      reminderMinutes:
        args.reminderMinutes === undefined
          ? (event.reminderMinutes ?? [])
          : remindersOf(args.reminderMinutes),
      urls: args.urls === undefined ? (event.urls ?? []) : urlsOf(args.urls),
      location: args.location === undefined ? (event.location ?? null) : locationOf(args.location),
      invitees: args.invitees === undefined ? (event.invitees ?? []) : inviteesOf(args.invitees),
      visibility: args.visibility ?? event.visibility,
      updatedAt: Date.now(),
    };
    await ctx.db.patch(event._id, patch);
    const updated = await ctx.db.get(event._id);
    if (updated === null) throw backendError("entity-not-found", "Calendar event vanished.");
    const changes: CompanyChange[] = [];
    if (event.visibility === "default" && updated.visibility === "private") {
      changes.push(eventChange(calendar, event, "tombstone", null));
    }
    changes.push(eventChange(calendar, updated, "upsert", await encodeCalendarEvent(ctx, updated)));
    await appendCompanyChanges(ctx, {
      companyId: actor.company._id,
      actor: actorRecord(actor),
      changes,
    });
    return null;
  },
});

export const deleteEvent = mutation({
  args: { companyId: domainIdArg, eventId: domainIdArg },
  returns: v.null(),
  handler: async (ctx, args) => {
    const actor = await requireCompanyActor(ctx, args.companyId);
    const event = await byEventId(ctx, actor.company._id, args.eventId);
    if (event === null || event.deletedAt !== null) return null;
    const calendar = await byCalendarId(ctx, actor.company._id, event.calendarId);
    if (calendar === null) throw backendError("entity-not-found", "Calendar not found.");
    requireOwnedPathwayCalendar(actor, calendar);
    const now = Date.now();
    const attachments = await ctx.db
      .query("calendarEventAttachments")
      .withIndex("by_company_and_event", (q) =>
        q.eq("companyId", actor.company._id).eq("eventId", event.id),
      )
      .collect();
    for (const attachment of attachments) {
      await ctx.storage.delete(attachment.storageId);
      await ctx.db.delete(attachment._id);
    }
    await ctx.db.patch(event._id, { deletedAt: now, updatedAt: now });
    await appendCompanyChanges(ctx, {
      companyId: actor.company._id,
      actor: actorRecord(actor),
      changes: [eventChange(calendar, event, "tombstone", null)],
    });
    return null;
  },
});

export const prepareEventAttachmentUpload = mutation({
  args: { companyId: domainIdArg, eventId: domainIdArg },
  returns: v.string(),
  handler: async (ctx, args) => {
    const actor = await requireCompanyActor(ctx, args.companyId);
    const event = await byEventId(ctx, actor.company._id, args.eventId);
    if (event === null || event.deletedAt !== null) {
      throw backendError("entity-not-found", "Event not found.");
    }
    const calendar = await byCalendarId(ctx, actor.company._id, event.calendarId);
    if (calendar === null) throw backendError("entity-not-found", "Calendar not found.");
    requireOwnedPathwayCalendar(actor, calendar);
    if ((event.attachments ?? []).length >= MAX_ATTACHMENTS) {
      throw backendError(
        "invalid-arguments",
        `An event can have at most ${MAX_ATTACHMENTS} attachments.`,
      );
    }
    return await ctx.storage.generateUploadUrl();
  },
});

export const attachEventFile = mutation({
  args: {
    companyId: domainIdArg,
    eventId: domainIdArg,
    id: domainIdArg,
    storageId: v.id("_storage"),
    fileName: v.string(),
    mimeType: v.string(),
    byteSize: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const actor = await requireCompanyActor(ctx, args.companyId);
    const event = await byEventId(ctx, actor.company._id, args.eventId);
    if (event === null || event.deletedAt !== null) {
      throw backendError("entity-not-found", "Event not found.");
    }
    const calendar = await byCalendarId(ctx, actor.company._id, event.calendarId);
    if (calendar === null) throw backendError("entity-not-found", "Calendar not found.");
    requireOwnedPathwayCalendar(actor, calendar);
    const current = event.attachments ?? [];
    if (current.length >= MAX_ATTACHMENTS) {
      throw backendError(
        "invalid-arguments",
        `An event can have at most ${MAX_ATTACHMENTS} attachments.`,
      );
    }
    if (current.some((attachment) => attachment.id === args.id)) return null;
    const conflictingAttachment = await ctx.db
      .query("calendarEventAttachments")
      .withIndex("by_company_and_domain_id", (q) =>
        q.eq("companyId", actor.company._id).eq("id", args.id),
      )
      .unique();
    if (conflictingAttachment !== null) {
      throw backendError("foreign-id-conflict", "That event attachment id exists.");
    }
    const stored = await ctx.db.system.get(args.storageId);
    if (
      stored === null ||
      stored.size !== args.byteSize ||
      args.byteSize <= 0 ||
      args.byteSize > MAX_ATTACHMENT_BYTES
    ) {
      throw backendError(
        "invalid-arguments",
        `Attachments must be no larger than ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB.`,
      );
    }
    const fileName = trimmed(args.fileName, "Attachment file name", 255);
    const mimeType = trimmed(args.mimeType, "Attachment MIME type", 100);
    await ctx.db.insert("calendarEventAttachments", {
      id: args.id,
      companyId: actor.company._id,
      calendarId: calendar.id,
      eventId: event.id,
      storageId: args.storageId,
      uploadedByMembershipId: actor.membership._id,
      createdAt: Date.now(),
    });
    await ctx.db.patch(event._id, {
      attachments: [...current, { id: args.id, fileName, mimeType, byteSize: args.byteSize }],
      updatedAt: Date.now(),
    });
    const updated = await ctx.db.get(event._id);
    if (updated === null) throw backendError("entity-not-found", "Calendar event vanished.");
    await appendCompanyChanges(ctx, {
      companyId: actor.company._id,
      actor: actorRecord(actor),
      changes: [eventChange(calendar, updated, "upsert", await encodeCalendarEvent(ctx, updated))],
    });
    return null;
  },
});

export const eventAttachmentUrl = query({
  args: { companyId: domainIdArg, eventId: domainIdArg, attachmentId: domainIdArg },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => {
    const actor = await requireCompanyActor(ctx, args.companyId);
    const event = await byEventId(ctx, actor.company._id, args.eventId);
    if (event === null || event.deletedAt !== null) return null;
    const calendar = await byCalendarId(ctx, actor.company._id, event.calendarId);
    if (calendar === null || calendar.deletedAt !== null) return null;
    const grants = await grantsForCalendar(ctx, calendar);
    const grantedCalendarIds = new Set(
      actor.kind === "member"
        ? grants
            .filter((grant) => grant.granteeMembershipId === actor.membership._id)
            .map((grant) => grant.calendarId)
        : [],
    );
    if (!canReadCalendar(actor, calendar, grantedCalendarIds)) {
      throw backendError("permission-denied", "Event attachment is not available.");
    }
    if (
      event.visibility === "private" &&
      (actor.kind !== "member" || actor.membership._id !== event.ownerMembershipId)
    ) {
      throw backendError("permission-denied", "Event attachment is private.");
    }
    const attachment = await ctx.db
      .query("calendarEventAttachments")
      .withIndex("by_company_and_domain_id", (q) =>
        q.eq("companyId", actor.company._id).eq("id", args.attachmentId),
      )
      .unique();
    if (attachment === null || attachment.eventId !== event.id) return null;
    return await ctx.storage.getUrl(attachment.storageId);
  },
});

export const removeEventAttachment = mutation({
  args: { companyId: domainIdArg, eventId: domainIdArg, attachmentId: domainIdArg },
  returns: v.null(),
  handler: async (ctx, args) => {
    const actor = await requireCompanyActor(ctx, args.companyId);
    const event = await byEventId(ctx, actor.company._id, args.eventId);
    if (event === null || event.deletedAt !== null) return null;
    const calendar = await byCalendarId(ctx, actor.company._id, event.calendarId);
    if (calendar === null) throw backendError("entity-not-found", "Calendar not found.");
    requireOwnedPathwayCalendar(actor, calendar);
    const attachment = await ctx.db
      .query("calendarEventAttachments")
      .withIndex("by_company_and_domain_id", (q) =>
        q.eq("companyId", actor.company._id).eq("id", args.attachmentId),
      )
      .unique();
    if (attachment === null || attachment.eventId !== event.id) return null;
    await ctx.storage.delete(attachment.storageId);
    await ctx.db.delete(attachment._id);
    await ctx.db.patch(event._id, {
      attachments: (event.attachments ?? []).filter((item) => item.id !== args.attachmentId),
      updatedAt: Date.now(),
    });
    const updated = await ctx.db.get(event._id);
    if (updated === null) throw backendError("entity-not-found", "Calendar event vanished.");
    await appendCompanyChanges(ctx, {
      companyId: actor.company._id,
      actor: actorRecord(actor),
      changes: [eventChange(calendar, updated, "upsert", await encodeCalendarEvent(ctx, updated))],
    });
    return null;
  },
});

export const linkIssue = mutation({
  args: {
    companyId: domainIdArg,
    id: domainIdArg,
    issueId: domainIdArg,
    googleEventId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const actor = await requireCompanyActor(ctx, args.companyId);
    requireMember(actor);
    const issue = await ctx.db
      .query("issues")
      .withIndex("by_company_and_domain_id", (q) =>
        q.eq("companyId", actor.company._id).eq("id", args.issueId),
      )
      .unique();
    if (issue === null || issue.deletedAt !== null)
      throw backendError("entity-not-found", "Issue not found.");
    requireRecordPermission(actor, "issues.update", issue.teamIds);
    const googleEventId = trimmed(args.googleEventId, "Google event id", 1024);
    const existing = await ctx.db
      .query("calendarEventLink")
      .withIndex("by_company_and_google_event", (q) =>
        q.eq("companyId", actor.company._id).eq("googleEventId", googleEventId),
      )
      .filter((q) => q.eq(q.field("deletedAt"), null))
      .first();
    if (existing !== null) throw backendError("conflict", "That event is already linked.");
    const idConflict = await ctx.db
      .query("calendarEventLink")
      .withIndex("by_company_and_domain_id", (q) =>
        q.eq("companyId", actor.company._id).eq("id", args.id),
      )
      .unique();
    if (idConflict !== null)
      throw backendError("foreign-id-conflict", "That event link id exists.");
    const rowId = await ctx.db.insert("calendarEventLink", {
      id: args.id,
      companyId: actor.company._id,
      issueId: issue.id,
      googleEventId,
      createdByMembershipId: actor.membership._id,
      createdAt: Date.now(),
      deletedAt: null,
    });
    const link = await ctx.db.get(rowId);
    if (link === null) throw backendError("entity-not-found", "Calendar event link vanished.");
    await appendCompanyChanges(ctx, {
      companyId: actor.company._id,
      actor: actorRecord(actor),
      changes: [
        {
          entityKind: "calendarEventLink",
          entityId: link.id,
          changeKind: "upsert",
          teamIds: issue.teamIds,
          versionDocId: link._id,
          payload: await encodeCalendarEventLink(ctx, link),
        },
      ],
    });
    return null;
  },
});

export const unlinkIssue = mutation({
  args: { companyId: domainIdArg, linkId: domainIdArg },
  returns: v.null(),
  handler: async (ctx, args) => {
    const actor = await requireCompanyActor(ctx, args.companyId);
    const link = await ctx.db
      .query("calendarEventLink")
      .withIndex("by_company_and_domain_id", (q) =>
        q.eq("companyId", actor.company._id).eq("id", args.linkId),
      )
      .unique();
    if (link === null || link.deletedAt !== null) return null;
    const issue = await ctx.db
      .query("issues")
      .withIndex("by_company_and_domain_id", (q) =>
        q.eq("companyId", actor.company._id).eq("id", link.issueId),
      )
      .unique();
    if (issue === null) throw backendError("entity-not-found", "Issue not found.");
    requireRecordPermission(actor, "issues.update", issue.teamIds);
    await ctx.db.patch(link._id, { deletedAt: Date.now() });
    await appendCompanyChanges(ctx, {
      companyId: actor.company._id,
      actor: actorRecord(actor),
      changes: [
        {
          entityKind: "calendarEventLink",
          entityId: link.id,
          changeKind: "tombstone",
          teamIds: issue.teamIds,
          versionDocId: link._id,
          payload: null,
        },
      ],
    });
    return null;
  },
});
