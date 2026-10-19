/**
 * Framework-neutral read model over the calendar entities in one company replica.
 *
 * The counterpart of {@link module:sync/issueReadModel}: the engine publishes a heterogeneous
 * entity map, and the narrowing plus a stable order live here so the browser's live view and the
 * server's durable SQLite replica cannot disagree about what the calendar domain is.
 *
 * Ordering is by start instant for events and by name for calendars, because both are what the
 * surface reads them in — a grid packs a day's events in start order, and the layer list is
 * alphabetical within its owner group.
 *
 * @module sync/calendarReadModel
 */
import type { CalendarId } from "@spiritdevs/contracts";
import * as Schema from "effect/Schema";

import {
  CalendarAccountEntity,
  CalendarEntity,
  CalendarEventEntity,
  CalendarEventLinkEntity,
} from "./calendarDomain.ts";

const isCalendarAccount = Schema.is(CalendarAccountEntity);
const isCalendar = Schema.is(CalendarEntity);
const isCalendarEvent = Schema.is(CalendarEventEntity);
const isCalendarEventLink = Schema.is(CalendarEventLinkEntity);

/** Every synced calendar row the `/calendar` surface and the issue link chip read. */
export interface SyncedCalendarReadModel {
  readonly calendarAccounts: ReadonlyArray<CalendarAccountEntity>;
  readonly calendars: ReadonlyArray<CalendarEntity>;
  readonly calendarEvents: ReadonlyArray<CalendarEventEntity>;
  readonly calendarEventLinks: ReadonlyArray<CalendarEventLinkEntity>;
}

export const EMPTY_SYNCED_CALENDAR: SyncedCalendarReadModel = Object.freeze({
  calendarAccounts: Object.freeze([]),
  calendars: Object.freeze([]),
  calendarEvents: Object.freeze([]),
  calendarEventLinks: Object.freeze([]),
});

const byId = <T extends { readonly id: string }>(left: T, right: T) =>
  left.id.localeCompare(right.id);

/** Narrows and deterministically orders the heterogeneous values from one company replica. */
export function syncedCalendarFromEntities(values: Iterable<unknown>): SyncedCalendarReadModel {
  const calendarAccounts: CalendarAccountEntity[] = [];
  const calendars: CalendarEntity[] = [];
  const calendarEvents: CalendarEventEntity[] = [];
  const calendarEventLinks: CalendarEventLinkEntity[] = [];

  for (const value of values) {
    if (isCalendarEvent(value)) calendarEvents.push(value);
    else if (isCalendar(value)) calendars.push(value);
    else if (isCalendarAccount(value)) calendarAccounts.push(value);
    else if (isCalendarEventLink(value)) calendarEventLinks.push(value);
  }

  calendarAccounts.sort(
    (left, right) => left.email.localeCompare(right.email) || byId(left, right),
  );
  calendars.sort((left, right) => left.name.localeCompare(right.name) || byId(left, right));
  calendarEvents.sort((left, right) => left.startAt - right.startAt || byId(left, right));
  calendarEventLinks.sort((left, right) => left.createdAt - right.createdAt || byId(left, right));

  return { calendarAccounts, calendars, calendarEvents, calendarEventLinks };
}

/** Compatibility wrapper for callers whose absence signal is a nullable replica object. */
export function syncedCalendarFromReplica(
  replica: { readonly view: ReadonlyMap<string, unknown> } | null,
): SyncedCalendarReadModel {
  return replica === null
    ? EMPTY_SYNCED_CALENDAR
    : syncedCalendarFromEntities(replica.view.values());
}

/**
 * Events grouped by the calendar they belong to.
 *
 * The grid asks "what is on this layer" far more often than "where does this event live", and the
 * cascade means a calendar's absence already implies its events are gone — so a bucket per calendar
 * is both the access pattern and the invariant.
 */
export function calendarEventsByCalendar(
  events: ReadonlyArray<CalendarEventEntity>,
): ReadonlyMap<CalendarId, ReadonlyArray<CalendarEventEntity>> {
  const byCalendar = new Map<CalendarId, Array<CalendarEventEntity>>();
  for (const event of events) {
    const bucket = byCalendar.get(event.calendarId);
    if (bucket === undefined) byCalendar.set(event.calendarId, [event]);
    else bucket.push(event);
  }
  return byCalendar;
}
