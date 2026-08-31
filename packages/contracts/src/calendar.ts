/**
 * Calendar entities replicated by the Convex company change feed.
 *
 * Calendar ids are client-generated domain ids. Google identifiers deliberately remain plain,
 * opaque strings: they come from Google and the stable event id, rather than a mirrored row id,
 * is what keeps an issue link alive across disconnect and reconnect.
 *
 * @module calendar
 */
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { CloudTimestamp, CompanyId, MembershipId, TeamId } from "./company.ts";
import { IssueId } from "./issues.ts";

const calendarEntityId = <Brand extends string>(brand: Brand) =>
  TrimmedNonEmptyString.pipe(Schema.brand(brand));

export const CalendarId = calendarEntityId("CalendarId");
export type CalendarId = typeof CalendarId.Type;
export const CalendarEventId = calendarEntityId("CalendarEventId");
export type CalendarEventId = typeof CalendarEventId.Type;
export const CalendarGrantId = calendarEntityId("CalendarGrantId");
export type CalendarGrantId = typeof CalendarGrantId.Type;
export const CalendarAccountId = calendarEntityId("CalendarAccountId");
export type CalendarAccountId = typeof CalendarAccountId.Type;
export const CalendarEventLinkId = calendarEntityId("CalendarEventLinkId");
export type CalendarEventLinkId = typeof CalendarEventLinkId.Type;

export const CalendarSharing = Schema.Literals(["private", "team", "company"]);
export type CalendarSharing = typeof CalendarSharing.Type;
export const CalendarKind = Schema.Literals(["pathway", "google"]);
export type CalendarKind = typeof CalendarKind.Type;
export const CalendarEventVisibility = Schema.Literals(["default", "private"]);
export type CalendarEventVisibility = typeof CalendarEventVisibility.Type;

export const Calendar = Schema.Struct({
  id: CalendarId,
  companyId: CompanyId,
  ownerMembershipId: MembershipId,
  name: TrimmedNonEmptyString,
  sharing: CalendarSharing,
  /** Required exactly when sharing is `team`; null for private/company calendars. */
  teamId: Schema.NullOr(TeamId),
  kind: CalendarKind,
  accountId: Schema.NullOr(CalendarAccountId),
  /** Google's stable calendar id for a mirror; null for Pathway-owned calendars. */
  googleCalendarId: Schema.NullOr(TrimmedNonEmptyString),
  createdAt: CloudTimestamp,
  updatedAt: CloudTimestamp,
});
export type Calendar = typeof Calendar.Type;

export const CalendarEvent = Schema.Struct({
  id: CalendarEventId,
  companyId: CompanyId,
  calendarId: CalendarId,
  ownerMembershipId: MembershipId,
  title: TrimmedNonEmptyString,
  startAt: CloudTimestamp,
  endAt: CloudTimestamp,
  /** IANA time-zone name used to interpret and display this event. */
  timeZone: TrimmedNonEmptyString,
  allDay: Schema.Boolean,
  visibility: CalendarEventVisibility,
  /** Google's stable event id for a mirrored occurrence; null for Pathway-owned events. */
  googleEventId: Schema.NullOr(TrimmedNonEmptyString),
  createdAt: CloudTimestamp,
  updatedAt: CloudTimestamp,
});
export type CalendarEvent = typeof CalendarEvent.Type;

export const CalendarGrant = Schema.Struct({
  id: CalendarGrantId,
  companyId: CompanyId,
  calendarId: CalendarId,
  granteeMembershipId: MembershipId,
  grantedByMembershipId: MembershipId,
  createdAt: CloudTimestamp,
});
export type CalendarGrant = typeof CalendarGrant.Type;

export const CalendarAccount = Schema.Struct({
  id: CalendarAccountId,
  companyId: CompanyId,
  ownerMembershipId: MembershipId,
  provider: Schema.Literal("google"),
  providerAccountId: TrimmedNonEmptyString,
  email: TrimmedNonEmptyString,
  createdAt: CloudTimestamp,
  updatedAt: CloudTimestamp,
});
export type CalendarAccount = typeof CalendarAccount.Type;

export const CalendarEventLink = Schema.Struct({
  id: CalendarEventLinkId,
  companyId: CompanyId,
  issueId: IssueId,
  /** Stable Google event id, intentionally not a `calendarEvent` row id. */
  googleEventId: TrimmedNonEmptyString,
  createdByMembershipId: MembershipId,
  createdAt: CloudTimestamp,
});
export type CalendarEventLink = typeof CalendarEventLink.Type;

export const CalendarOwnerGroup = Schema.Struct({
  ownerMembershipId: MembershipId,
  ownerName: Schema.String,
  calendars: Schema.Array(Calendar),
});
export type CalendarOwnerGroup = typeof CalendarOwnerGroup.Type;
