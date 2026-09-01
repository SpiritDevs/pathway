import type { CalendarEventInput } from "./calendarGrid.logic";

export type CalendarEventOptimisticPatch = Partial<
  Pick<CalendarEventInput, "title" | "startAt" | "endAt" | "allDay">
>;

export interface OptimisticCalendarEventWrite {
  readonly revision: number;
  readonly patch: CalendarEventOptimisticPatch;
}

export type OptimisticCalendarEventWrites = ReadonlyMap<string, OptimisticCalendarEventWrite>;

/** Keep a local move visible while the replica still contains the event's previous values. */
export function applyOptimisticCalendarEventWrites(
  events: ReadonlyArray<CalendarEventInput>,
  writes: OptimisticCalendarEventWrites,
): ReadonlyArray<CalendarEventInput> {
  if (writes.size === 0) return events;
  return events.map((event) => {
    const write = writes.get(event.id);
    return write === undefined ? event : { ...event, ...write.patch };
  });
}

/** Drop an overlay only after the replica has echoed every field from its latest write. */
export function reconcileOptimisticCalendarEventWrites(
  events: ReadonlyArray<CalendarEventInput>,
  writes: OptimisticCalendarEventWrites,
): OptimisticCalendarEventWrites {
  if (writes.size === 0) return writes;
  const eventsById = new Map(events.map((event) => [event.id, event]));
  let next: Map<string, OptimisticCalendarEventWrite> | null = null;

  for (const [eventId, write] of writes) {
    const event = eventsById.get(eventId);
    if (event !== undefined && !calendarEventMatchesPatch(event, write.patch)) continue;
    next ??= new Map(writes);
    next.delete(eventId);
  }

  return next ?? writes;
}

/** A late failure from an older drag must not roll back a newer move of the same event. */
export function rollbackOptimisticCalendarEventWrite(
  writes: OptimisticCalendarEventWrites,
  eventId: string,
  revision: number,
): OptimisticCalendarEventWrites {
  if (writes.get(eventId)?.revision !== revision) return writes;
  const next = new Map(writes);
  next.delete(eventId);
  return next;
}

function calendarEventMatchesPatch(
  event: CalendarEventInput,
  patch: CalendarEventOptimisticPatch,
): boolean {
  return (
    (patch.title === undefined || event.title === patch.title) &&
    (patch.startAt === undefined || event.startAt === patch.startAt) &&
    (patch.endAt === undefined || event.endAt === patch.endAt) &&
    (patch.allDay === undefined || event.allDay === patch.allDay)
  );
}
