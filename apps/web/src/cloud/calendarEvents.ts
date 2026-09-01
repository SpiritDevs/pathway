/**
 * The write half of `/calendar`: creating a Pathway calendar, and creating, moving, and deleting
 * events on one.
 *
 * These are online-only Convex mutations rather than sync operations, and that is the whole reason
 * this file exists next to a read model instead of inside one. The change feed brings calendars and
 * events *in*; nothing carries them back out, because `SYNC_OPERATION_KINDS` has no calendar verb
 * and an outbox that could not ship one would only be a queue of writes that never leave. So a
 * drag calls the mutation while the calendar surface holds an optimistic overlay until the change
 * feed echoes it. A refused mutation drops that overlay.
 *
 * Sharing is deliberately absent: grants belong to the calendar settings surface, which owns
 * `calendars.share` and `calendars.revoke`.
 *
 * @module cloud/calendarEvents
 */
import type {
  CalendarEventAttachmentId,
  CalendarEventId,
  CalendarEventInvitee,
  CalendarId,
} from "@spiritdevs/contracts";
import type { CompanyId } from "@spiritdevs/contracts/company";
import { ConvexClient } from "convex/browser";
import { makeFunctionReference, type FunctionReference } from "convex/server";
import { ConvexError } from "convex/values";

import type { ConvexAuthTokenFetcher } from "./syncTransport";

type ConvexArgs = Record<string, unknown>;

const mutationReference = <Request extends ConvexArgs, Response = null>(name: string) =>
  makeFunctionReference<"mutation", Request, Response>(name);

export interface CalendarEventsConvexClient {
  readonly mutation: (
    reference: FunctionReference<"mutation">,
    args: ConvexArgs,
  ) => Promise<unknown>;
  readonly query: (reference: FunctionReference<"query">, args: ConvexArgs) => Promise<unknown>;
  readonly setAuth: (fetchToken: ConvexAuthTokenFetcher) => void;
  readonly close: () => Promise<void>;
}

export interface CalendarCreateArgs extends ConvexArgs {
  readonly companyId: CompanyId;
  /** Client-generated, so the row has an identity before Convex sees it. */
  readonly id: CalendarId;
  readonly name: string;
}

export interface CalendarEventCreateArgs extends ConvexArgs {
  readonly companyId: CompanyId;
  readonly id: CalendarEventId;
  readonly calendarId: CalendarId;
  readonly title: string;
  readonly startAt: number;
  readonly endAt: number;
  /** IANA name. The zone the event is both interpreted and drawn in. */
  readonly timeZone: string;
  readonly allDay: boolean;
  readonly notes: string;
  readonly reminderMinutes: ReadonlyArray<number>;
  readonly urls: ReadonlyArray<string>;
  readonly location: string | null;
  readonly invitees: ReadonlyArray<CalendarEventInvitee>;
}

export interface CalendarEventUpdateArgs extends ConvexArgs {
  readonly companyId: CompanyId;
  readonly eventId: CalendarEventId;
  readonly title?: string;
  readonly startAt?: number;
  readonly endAt?: number;
  readonly timeZone?: string;
  readonly allDay?: boolean;
  readonly notes?: string;
  readonly reminderMinutes?: ReadonlyArray<number>;
  readonly urls?: ReadonlyArray<string>;
  readonly location?: string | null;
  readonly invitees?: ReadonlyArray<CalendarEventInvitee>;
}

export const CALENDAR_EVENT_FUNCTION_REFERENCES = {
  createCalendar: mutationReference<CalendarCreateArgs>("calendars:create"),
  createEvent: mutationReference<CalendarEventCreateArgs>("calendars:createEvent"),
  updateEvent: mutationReference<CalendarEventUpdateArgs>("calendars:updateEvent"),
  deleteEvent: mutationReference<{
    readonly companyId: CompanyId;
    readonly eventId: CalendarEventId;
  }>("calendars:deleteEvent"),
  prepareEventAttachmentUpload: mutationReference<
    {
      readonly companyId: CompanyId;
      readonly eventId: CalendarEventId;
      readonly id: CalendarEventAttachmentId;
    },
    string
  >("calendars:prepareEventAttachmentUpload"),
  discardEventAttachmentUpload: mutationReference<{
    readonly companyId: CompanyId;
    readonly eventId: CalendarEventId;
    readonly attachmentId: CalendarEventAttachmentId;
    readonly storageId?: string;
  }>("calendars:discardEventAttachmentUpload"),
  attachEventFile: mutationReference<{
    readonly companyId: CompanyId;
    readonly eventId: CalendarEventId;
    readonly id: CalendarEventAttachmentId;
    readonly storageId: string;
    readonly fileName: string;
    readonly mimeType: string;
    readonly byteSize: number;
  }>("calendars:attachEventFile"),
  removeEventAttachment: mutationReference<{
    readonly companyId: CompanyId;
    readonly eventId: CalendarEventId;
    readonly attachmentId: CalendarEventAttachmentId;
  }>("calendars:removeEventAttachment"),
} as const;

const eventAttachmentUrlReference = makeFunctionReference<
  "query",
  {
    readonly companyId: CompanyId;
    readonly eventId: CalendarEventId;
    readonly attachmentId: CalendarEventAttachmentId;
  },
  string | null
>("calendars:eventAttachmentUrl");

const FRIENDLY_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  "permission-denied": "You do not have permission to change this calendar.",
  "entity-not-found": "That calendar or event no longer exists.",
  "invalid-arguments": "That event's details are not valid.",
  "foreign-id-conflict": "That event already exists.",
};

export class CalendarWriteError extends Error {
  readonly code: string | null;
  constructor(options: { readonly code: string | null; readonly message: string }) {
    super(options.message);
    this.name = "CalendarWriteError";
    this.code = options.code;
  }
}

/** The same mapping `companyAdmin` does, so a refusal reads the same wherever it surfaced. */
export function mapCalendarWriteError(error: unknown): CalendarWriteError {
  if (error instanceof CalendarWriteError) return error;
  if (error instanceof ConvexError && typeof error.data === "object" && error.data !== null) {
    const data = error.data as Record<string, unknown>;
    const code = typeof data["code"] === "string" ? data["code"] : null;
    const backendMessage = typeof data["message"] === "string" ? data["message"] : null;
    return new CalendarWriteError({
      code,
      message:
        (code === null ? undefined : FRIENDLY_ERROR_MESSAGES[code]) ??
        backendMessage ??
        "The calendar change failed.",
    });
  }
  const message = error instanceof Error ? error.message : String(error);
  const offline =
    typeof navigator !== "undefined" && navigator.onLine === false
      ? "You appear to be offline. Calendar changes require a connection."
      : null;
  return new CalendarWriteError({
    code: null,
    message: offline ?? (message || "The calendar change failed."),
  });
}

export interface CalendarEventsClient {
  readonly createCalendar: (args: CalendarCreateArgs) => Promise<void>;
  readonly createEvent: (args: CalendarEventCreateArgs) => Promise<void>;
  readonly updateEvent: (args: CalendarEventUpdateArgs) => Promise<void>;
  readonly deleteEvent: (args: {
    readonly companyId: CompanyId;
    readonly eventId: CalendarEventId;
  }) => Promise<void>;
  readonly uploadAttachment: (args: {
    readonly companyId: CompanyId;
    readonly eventId: CalendarEventId;
    readonly id: CalendarEventAttachmentId;
    readonly file: File;
  }) => Promise<void>;
  readonly removeAttachment: (args: {
    readonly companyId: CompanyId;
    readonly eventId: CalendarEventId;
    readonly attachmentId: CalendarEventAttachmentId;
  }) => Promise<void>;
  readonly attachmentUrl: (args: {
    readonly companyId: CompanyId;
    readonly eventId: CalendarEventId;
    readonly attachmentId: CalendarEventAttachmentId;
  }) => Promise<string | null>;
  readonly close: () => Promise<void>;
}

export function makeCalendarEventsClient(options: {
  readonly convexUrl: string;
  readonly fetchToken: ConvexAuthTokenFetcher;
  readonly client?: CalendarEventsConvexClient;
  readonly fetcher?: typeof fetch;
}): CalendarEventsClient {
  const ownsClient = options.client === undefined;
  const client: CalendarEventsConvexClient = options.client ?? new ConvexClient(options.convexUrl);
  const fetcher = options.fetcher ?? fetch;
  client.setAuth(options.fetchToken);

  const mutation = async (reference: FunctionReference<"mutation">, args: ConvexArgs) => {
    try {
      await client.mutation(reference, args);
    } catch (error) {
      throw mapCalendarWriteError(error);
    }
  };

  return {
    createCalendar: (args) => mutation(CALENDAR_EVENT_FUNCTION_REFERENCES.createCalendar, args),
    createEvent: (args) => mutation(CALENDAR_EVENT_FUNCTION_REFERENCES.createEvent, args),
    updateEvent: (args) => mutation(CALENDAR_EVENT_FUNCTION_REFERENCES.updateEvent, args),
    deleteEvent: (args) => mutation(CALENDAR_EVENT_FUNCTION_REFERENCES.deleteEvent, args),
    uploadAttachment: async (args) => {
      if (args.file.size > 25 * 1024 * 1024) {
        throw new CalendarWriteError({
          code: "invalid-arguments",
          message: "Attachments must be no larger than 25 MB.",
        });
      }
      let uploadUrl: string;
      const discardUpload = async (storageId?: string) => {
        await client
          .mutation(CALENDAR_EVENT_FUNCTION_REFERENCES.discardEventAttachmentUpload, {
            companyId: args.companyId,
            eventId: args.eventId,
            attachmentId: args.id,
            ...(storageId === undefined ? {} : { storageId }),
          })
          .catch(() => undefined);
      };
      try {
        uploadUrl = (await client.mutation(
          CALENDAR_EVENT_FUNCTION_REFERENCES.prepareEventAttachmentUpload,
          { companyId: args.companyId, eventId: args.eventId, id: args.id },
        )) as string;
      } catch (error) {
        throw mapCalendarWriteError(error);
      }
      let response: Response;
      try {
        response = await fetcher(uploadUrl, {
          method: "POST",
          headers: { "Content-Type": args.file.type || "application/octet-stream" },
          body: args.file,
        });
      } catch (error) {
        await discardUpload();
        throw error;
      }
      if (!response.ok) {
        await discardUpload();
        throw new CalendarWriteError({
          code: "upload-failed",
          message: `The attachment upload failed with HTTP ${response.status}.`,
        });
      }
      let uploaded: { storageId?: unknown };
      try {
        uploaded = (await response.json()) as { storageId?: unknown };
      } catch {
        await discardUpload();
        throw new CalendarWriteError({
          code: "upload-failed",
          message: "The attachment upload returned an invalid response.",
        });
      }
      if (typeof uploaded.storageId !== "string") {
        await discardUpload();
        throw new CalendarWriteError({
          code: "upload-failed",
          message: "The attachment upload returned no file id.",
        });
      }
      try {
        await mutation(CALENDAR_EVENT_FUNCTION_REFERENCES.attachEventFile, {
          companyId: args.companyId,
          eventId: args.eventId,
          id: args.id,
          storageId: uploaded.storageId,
          fileName: args.file.name || "Attachment",
          mimeType: args.file.type || "application/octet-stream",
          byteSize: args.file.size,
        });
      } catch (error) {
        await discardUpload(uploaded.storageId);
        throw error;
      }
    },
    removeAttachment: (args) =>
      mutation(CALENDAR_EVENT_FUNCTION_REFERENCES.removeEventAttachment, args),
    attachmentUrl: async (args) => {
      try {
        return (await client.query(eventAttachmentUrlReference, args)) as string | null;
      } catch (error) {
        throw mapCalendarWriteError(error);
      }
    },
    close: () => (ownsClient ? client.close() : Promise.resolve()),
  };
}
