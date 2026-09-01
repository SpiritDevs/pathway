import type { CalendarEventAttachmentId, CalendarEventId } from "@spiritdevs/contracts";
import type { CompanyId } from "@spiritdevs/contracts/company";
import { getFunctionName } from "convex/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { makeCalendarEventsClient, type CalendarEventsConvexClient } from "./calendarEvents";

const COMPANY_ID = "company-calendar" as CompanyId;
const EVENT_ID = "event-calendar" as CalendarEventId;
const ATTACHMENT_ID = "attachment-calendar" as CalendarEventAttachmentId;

describe("calendar event attachment client", () => {
  it("uploads bytes before binding their metadata to an event", async () => {
    const calls: Array<{ readonly name: string; readonly args: Record<string, unknown> }> = [];
    const convex: CalendarEventsConvexClient = {
      mutation: async (reference, args) => {
        const name = getFunctionName(reference);
        calls.push({ name, args });
        return name === "calendars:prepareEventAttachmentUpload"
          ? "https://upload.example.test"
          : null;
      },
      query: vi.fn(async () => "https://files.example.test/agenda.pdf"),
      setAuth: vi.fn(),
      close: vi.fn(async () => undefined),
    };
    const fetcher = vi.fn(
      async () =>
        new Response(JSON.stringify({ storageId: "storage-1" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const client = makeCalendarEventsClient({
      convexUrl: "https://example.convex.cloud",
      fetchToken: async () => "token",
      client: convex,
      fetcher,
    });
    const file = new File(["agenda"], "agenda.pdf", { type: "application/pdf" });

    await client.uploadAttachment({
      companyId: COMPANY_ID,
      eventId: EVENT_ID,
      id: ATTACHMENT_ID,
      file,
    });

    expect(calls.map((call) => call.name)).toEqual([
      "calendars:prepareEventAttachmentUpload",
      "calendars:attachEventFile",
    ]);
    expect(fetcher).toHaveBeenCalledWith(
      "https://upload.example.test",
      expect.objectContaining({ method: "POST", body: file }),
    );
    expect(calls[1]?.args).toMatchObject({
      companyId: COMPANY_ID,
      eventId: EVENT_ID,
      id: ATTACHMENT_ID,
      storageId: "storage-1",
      fileName: "agenda.pdf",
      mimeType: "application/pdf",
      byteSize: 6,
    });
  });
});
