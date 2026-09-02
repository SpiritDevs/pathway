import type { CalendarEventId } from "@spiritdevs/contracts";
import type { CompanyId } from "@spiritdevs/contracts/company";
import { describe, expect, it } from "vite-plus/test";

import { calendarAlertOccurrences, type CalendarAlertEvent } from "./calendarAlerts";

function event(overrides: Partial<CalendarAlertEvent> = {}): CalendarAlertEvent {
  return {
    companyId: "company-alert" as CompanyId,
    id: "event-alert" as CalendarEventId,
    title: "Design review",
    startAt: 1_800_000_000_000,
    reminderMinutes: [30, 5, 30],
    location: null,
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

  it("keeps alert identity stable across unrelated event edits", () => {
    const now = 1_799_998_000_000;
    const before = calendarAlertOccurrences([event()], now).map((item) => item.id);
    const after = calendarAlertOccurrences(
      [event({ title: "Design review with prototype" })],
      now,
    ).map((item) => item.id);

    expect(after).toEqual(before);
  });
});
