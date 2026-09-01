import { describe, expect, it } from "vite-plus/test";

import type { CalendarEventInput } from "./calendarGrid.logic";
import {
  applyOptimisticCalendarEventWrites,
  reconcileOptimisticCalendarEventWrites,
  rollbackOptimisticCalendarEventWrite,
  type OptimisticCalendarEventWrites,
} from "./calendarOptimistic.logic";

const event = (overrides: Partial<CalendarEventInput> = {}): CalendarEventInput => ({
  id: "event-1",
  calendarId: "calendar-1",
  title: "Design review",
  startAt: 100,
  endAt: 200,
  timeZone: "UTC",
  allDay: false,
  editable: true,
  ...overrides,
});

const writes = (
  patch: OptimisticCalendarEventWrites extends ReadonlyMap<string, infer W> ? W : never,
) => new Map([["event-1", patch]]);

describe("optimistic calendar event writes", () => {
  it("keeps the moved event at its new times while the replica is stale", () => {
    const source = [event()];
    const pending = writes({ revision: 1, patch: { startAt: 300, endAt: 400 } });

    expect(applyOptimisticCalendarEventWrites(source, pending)).toEqual([
      event({ startAt: 300, endAt: 400 }),
    ]);
    expect(reconcileOptimisticCalendarEventWrites(source, pending)).toBe(pending);
  });

  it("removes the overlay only after every written field reaches the replica", () => {
    const pending = writes({
      revision: 1,
      patch: { startAt: 300, endAt: 400, allDay: true },
    });

    expect(
      reconcileOptimisticCalendarEventWrites(
        [event({ startAt: 300, endAt: 400, allDay: false })],
        pending,
      ),
    ).toBe(pending);
    expect(
      reconcileOptimisticCalendarEventWrites(
        [event({ startAt: 300, endAt: 400, allDay: true })],
        pending,
      ).size,
    ).toBe(0);
  });

  it("drops an orphaned overlay when the event disappears", () => {
    const pending = writes({ revision: 1, patch: { startAt: 300 } });
    expect(reconcileOptimisticCalendarEventWrites([], pending).size).toBe(0);
  });

  it("does not let an older failed drag roll back a newer one", () => {
    const pending = writes({ revision: 2, patch: { startAt: 500, endAt: 600 } });
    expect(rollbackOptimisticCalendarEventWrite(pending, "event-1", 1)).toBe(pending);
    expect(rollbackOptimisticCalendarEventWrite(pending, "event-1", 2).size).toBe(0);
  });
});
