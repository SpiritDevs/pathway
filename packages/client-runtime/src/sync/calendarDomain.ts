/**
 * The calendar domain on the sync engine: a read cache, plus the one cascade rule ADR 0013 puts on
 * the client.
 *
 * Calendars and events are **online-only** the way company administration is. Nothing here has an
 * operation kind, nothing enters the outbox, and there is no optimistic overlay: a member who
 * creates an event calls `calendars.createEvent` and waits for the feed to echo it back. So, like
 * {@link module:sync/companyDomain}, this module declares entity shapes and codecs and stops —
 * except for {@link calendarSyncTombstoneCascade}, which exists because the protocol deliberately
 * leaves work here.
 *
 * **The cascade.** Revoking a grant tombstones the `calendar` row for that grantee alone, and the
 * grantee's client is what drops the events under it. That is the whole reason events are keyed by
 * `calendarId`: one feed row un-shares a calendar however many events it holds, where tombstoning
 * each event would emit thousands of rows and, under the narrowing-tombstone rule, broadcast them
 * to a wider audience than the one being narrowed. Disconnecting a `calendarAccount` cascades the
 * same way, one level further — account to its calendars, then those calendars to their events.
 *
 * `calendarEventLink` rows are deliberately *not* cascaded. They name Google's stable event id
 * rather than a mirrored row, so an issue says "event unavailable" while a calendar is away and
 * gets its link back on reconnect instead of losing it silently.
 *
 * The cascade relies on the client honouring it, which is acceptable for the reason the ADR gives:
 * no option can un-send bytes already replicated to disk, and a per-member authorization epoch is
 * the upgrade path if hard revocation is ever required.
 *
 * @module sync/calendarDomain
 */
import {
  SyncCalendarAccountPayload,
  SyncCalendarEventLinkPayload,
  SyncCalendarEventPayload,
  SyncCalendarPayload,
  type SyncEntityKind,
} from "@spiritdevs/contracts/cloudSync";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { SyncCodec } from "./codec.ts";
import type { SyncEntityKey } from "./model.ts";

// ---------------------------------------------------------------------------
// Entity kinds
// ---------------------------------------------------------------------------

/**
 * The four tables this domain replicates. Grants are absent on purpose: a grant is authorization
 * input, and what a client is told is the outcome — the `calendar` row arrives, or it does not.
 */
export const CALENDAR_SYNC_ENTITY_KINDS = [
  "calendarAccount",
  "calendar",
  "calendarEvent",
  "calendarEventLink",
] as const satisfies ReadonlyArray<SyncEntityKind>;
export type CalendarSyncEntityKind = (typeof CALENDAR_SYNC_ENTITY_KINDS)[number];

const CALENDAR_SYNC_ENTITY_KIND_SET: ReadonlySet<string> = new Set<string>(
  CALENDAR_SYNC_ENTITY_KINDS,
);

export function isCalendarSyncEntityKind(value: string): value is CalendarSyncEntityKind {
  return CALENDAR_SYNC_ENTITY_KIND_SET.has(value);
}

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

// The contract's wire payload plus the local `entityKind` tag, exactly as the company and issue
// domains do it. The tag is not on the wire — the change envelope carries it — so the codecs below
// attach it on decode and strip it on encode.

/** One connected Google account. The encrypted OAuth credential never enters the feed. */
export const CalendarAccountEntity = Schema.Struct({
  entityKind: Schema.Literal("calendarAccount"),
  ...SyncCalendarAccountPayload.fields,
});
export type CalendarAccountEntity = typeof CalendarAccountEntity.Type;

/** The sharing and revocation boundary: a Pathway calendar, or one mirrored Google calendar. */
export const CalendarEntity = Schema.Struct({
  entityKind: Schema.Literal("calendar"),
  ...SyncCalendarPayload.fields,
});
export type CalendarEntity = typeof CalendarEntity.Type;

/** A dated thing with its own IANA zone. `calendarId` is what the cascade above is keyed on. */
export const CalendarEventEntity = Schema.Struct({
  entityKind: Schema.Literal("calendarEvent"),
  ...SyncCalendarEventPayload.fields,
});
export type CalendarEventEntity = typeof CalendarEventEntity.Type;

/** Survives every cascade: it names Google's stable event identity, not a mirrored row. */
export const CalendarEventLinkEntity = Schema.Struct({
  entityKind: Schema.Literal("calendarEventLink"),
  ...SyncCalendarEventLinkPayload.fields,
});
export type CalendarEventLinkEntity = typeof CalendarEventLinkEntity.Type;

/** One replicated calendar-domain row, tagged with the kind that selected its shape. */
export const CalendarSyncEntity = Schema.Union([
  CalendarAccountEntity,
  CalendarEntity,
  CalendarEventEntity,
  CalendarEventLinkEntity,
]);
export type CalendarSyncEntity = typeof CalendarSyncEntity.Type;

/** The member of {@link CalendarSyncEntity} carrying one entity kind. */
export type CalendarSyncEntityOf<K extends CalendarSyncEntityKind> = Extract<
  CalendarSyncEntity,
  { readonly entityKind: K }
>;

// ---------------------------------------------------------------------------
// Codecs
// ---------------------------------------------------------------------------

/** Attaches the local tag on decode and strips it on encode; the company domain's helper, again. */
function taggedEntityCodec<A, I>(
  entityKind: CalendarSyncEntityKind,
  payload: Schema.Codec<A, I>,
): SyncCodec<CalendarSyncEntity> {
  const decode = Schema.decodeUnknownOption(payload);
  const encode = Schema.encodeSync(payload);
  return {
    decode: (input) =>
      Option.map(
        decode(input),
        (value) => ({ entityKind, ...(value as object) }) as CalendarSyncEntity,
      ),
    encode: (value) => {
      const { entityKind: _entityKind, ...rest } = value;
      return encode(rest as unknown as A) as unknown;
    },
  };
}

/**
 * Every calendar codec by kind. Exported as the table rather than only behind
 * {@link calendarEntityCodec} so the widened adapter builds its dispatch from a total map.
 */
export const CALENDAR_ENTITY_CODECS: Record<
  CalendarSyncEntityKind,
  SyncCodec<CalendarSyncEntity>
> = {
  calendarAccount: taggedEntityCodec("calendarAccount", SyncCalendarAccountPayload),
  calendar: taggedEntityCodec("calendar", SyncCalendarPayload),
  calendarEvent: taggedEntityCodec("calendarEvent", SyncCalendarEventPayload),
  calendarEventLink: taggedEntityCodec("calendarEventLink", SyncCalendarEventLinkPayload),
};

/** Codec for one entity kind, or `null` for a kind this domain does not replicate. */
export function calendarEntityCodec(
  entityKind: SyncEntityKind,
): SyncCodec<CalendarSyncEntity> | null {
  return isCalendarSyncEntityKind(entityKind) ? CALENDAR_ENTITY_CODECS[entityKind] : null;
}

// ---------------------------------------------------------------------------
// Cascade
// ---------------------------------------------------------------------------

/**
 * What a cascade predicate reads off a replica row: its kind, and the owning id that decides the
 * match. Structural rather than {@link CalendarSyncEntity} on purpose — the engine holds a union
 * wider than this module's, every member of it satisfies this, and typing the predicate on the
 * narrow union would need a cast at the one call site that matters.
 */
export interface CalendarCascadeRow {
  readonly entityKind: string;
  /** Present on `calendarEvent`. */
  readonly calendarId?: string | undefined;
  /** Present on `calendar`; null for a Pathway-owned one. */
  readonly accountId?: string | null | undefined;
}

/**
 * The rows a calendar-domain tombstone takes with it, as a predicate over what the replica still
 * holds — or `null` when it takes nothing, which is the answer for every kind but two.
 *
 * A `calendar` tombstone drops its events. A `calendarAccount` tombstone drops its calendars, and
 * the engine re-asks for each of those, which is how the account reaches the events two levels
 * down without this function having to hold the replica in its head.
 */
export function calendarSyncTombstoneCascade(
  key: SyncEntityKey,
): ((entity: CalendarCascadeRow) => boolean) | null {
  if (key.entityKind === "calendar") {
    const calendarId: string = key.entityId;
    return (entity) => entity.entityKind === "calendarEvent" && entity.calendarId === calendarId;
  }
  if (key.entityKind === "calendarAccount") {
    const accountId: string = key.entityId;
    return (entity) => entity.entityKind === "calendar" && entity.accountId === accountId;
  }
  return null;
}
