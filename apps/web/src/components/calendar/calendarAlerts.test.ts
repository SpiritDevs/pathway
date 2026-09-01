import type { CalendarEventEntity } from "@spiritdevs/client-runtime/sync";
import { describe, expect, it } from "vite-plus/test";

import { calendarAlertOccurrences } from "./calendarAlerts";

function event(overrides: Partial<CalendarEventEntity> = {}): CalendarEventEntity {
  return {
    entityKind: "calendarEvent",
    id: "event-alert" as CalendarEventEntity["id"],
    calendarId: "calendar-alert" as CalendarEventEntity["calendarId"],
    ownerMembershipId: "member-alert" as CalendarEventEntity["ownerMembershipId"],
    title: "Design review",
    startAt: 1_800_000_000_000,
    endAt: 1_800_003_600_000,
    timeZone: "Australia/Sydney",
    allDay: false,
    notes: "",
    reminderMinutes: [30, 5, 30],
    urls: [],
    location: null,
    invitees: [],
    attachments: [],
    visibility: "default",
    googleEventId: null,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe("calendar alert occurrences", () => {
  it("adds the implicit start alert and deduplicates selected reminders", () => {
    const occurrences = calendarAlertOccurrences([event()], 1_799_998_000_000);
    expect(occurrences.map((item) => item.minutesBefore)).toEqual([30, 5, 0]);
    expect(occurrences.at(-1)?.dueAt).toBe(1_800_000_000_000);
  });

  it("keeps a one-minute delivery grace after a client wakes", () => {
    const at = 1_800_000_000_000;
    expect(
      calendarAlertOccurrences([event()], at + 59_000).map((item) => item.minutesBefore),
    ).toEqual([0]);
    expect(calendarAlertOccurrences([event()], at + 61_000)).toEqual([]);
  });
});
