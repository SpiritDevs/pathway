/**
 * Everything `/calendar` reads, and — separately — everything it writes.
 *
 * The split matters. {@link useCalendarLayers} is pure reading: the replica, the layer filter, and
 * what the filter leaves. Both the sidebar and the grid call it, because they mount in different
 * trees (the sidebar belongs to `AppSidebarLayout`) and so cannot share one hook instance. They
 * still agree, because everything under it is a shared store — the sync atoms and the one
 * `localStorage` key — so a layer toggled in the sidebar reaches the grid on the same tick.
 *
 * {@link useCalendarWriter} is the other half and is deliberately *not* in that hook: it opens a
 * Convex client, and a sidebar that called it would open a second websocket to do nothing with.
 * Only the page writes.
 *
 * @module components/calendar/useCalendarSurface
 */
import { useAuth } from "@clerk/react";
import type { CalendarEventEntity } from "@spiritdevs/client-runtime/sync";
import type { CalendarEventId, CalendarId, IssueDate } from "@spiritdevs/contracts";
import * as Schema from "effect/Schema";
import { useCallback, useEffect, useMemo, useRef } from "react";

import { newCompanyDomainId } from "~/cloud/companyAdmin";
import { makeCalendarEventsClient, type CalendarEventsClient } from "~/cloud/calendarEvents";
import {
  ownedCalendarIds,
  useCalendarViewer,
  useSyncedCalendarEvents,
  useSyncedCalendars,
  type CalendarEntity,
  type CalendarViewer,
} from "~/cloud/calendarReadModel";
import { resolveCloudSyncConvexUrl } from "~/cloud/publicConfig";
import { makeClerkConvexTokenFetcher } from "~/cloud/syncTransportAuth";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { useIssueMemberDirectory } from "../issues/issueMemberDirectory";
import {
  buildCalendarLayerGroups,
  calendarLayersStorageKey,
  setCalendarGroupVisible,
  toggleCalendarLayer,
  visibleCalendarIds,
  type CalendarLayerGroup,
  type CalendarLayerKey,
} from "./calendarLayers.logic";
import type { CalendarEventInput } from "./calendarGrid.logic";

const HIDDEN_LAYERS_SCHEMA = Schema.Array(Schema.String);
const NO_HIDDEN_LAYERS: ReadonlyArray<string> = [];

/**
 * The viewer's own zone, used for events they create and for the "now" rule.
 *
 * Read from the runtime rather than stored: an event carries the zone it was *created* in, and the
 * one place that has to be decided fresh is the moment of creation.
 */
export function viewerTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export interface CalendarWriter {
  /** Null until there is a signed-in viewer and a company to write into. */
  readonly ready: boolean;
  readonly createEvent: (input: {
    readonly calendarId: CalendarId;
    readonly title: string;
    readonly startAt: number;
    readonly endAt: number;
    readonly timeZone: string;
    readonly allDay: boolean;
  }) => Promise<void>;
  readonly updateEvent: (input: {
    readonly eventId: CalendarEventId;
    readonly title?: string;
    readonly startAt?: number;
    readonly endAt?: number;
    readonly allDay?: boolean;
  }) => Promise<void>;
  readonly deleteEvent: (eventId: CalendarEventId) => Promise<void>;
  /** The first calendar a member gets, made on demand the first time they create an event. */
  readonly createCalendar: (name: string) => Promise<CalendarId>;
}

export interface CalendarLayersView {
  readonly viewer: CalendarViewer;
  readonly calendars: ReadonlyArray<CalendarEntity>;
  /** Events on visible calendars only, already shaped for the geometry. */
  readonly events: ReadonlyArray<CalendarEventInput>;
  readonly layerGroups: ReadonlyArray<CalendarLayerGroup>;
  readonly hiddenLayers: ReadonlySet<CalendarLayerKey>;
  readonly toggleLayer: (key: CalendarLayerKey) => void;
  readonly setGroupVisible: (group: CalendarLayerGroup, visible: boolean) => void;
  /** The calendar a new event lands on: the viewer's first own Pathway calendar, or null. */
  readonly defaultCalendarId: CalendarId | null;
}

function toEventInput(
  event: CalendarEventEntity,
  editableCalendars: ReadonlySet<CalendarId>,
): CalendarEventInput {
  return {
    id: event.id,
    calendarId: event.calendarId,
    title: event.title,
    startAt: event.startAt,
    endAt: event.endAt,
    timeZone: event.timeZone,
    allDay: event.allDay,
    editable: editableCalendars.has(event.calendarId),
  };
}

export function useCalendarLayers(): CalendarLayersView {
  const viewer = useCalendarViewer();
  const calendars = useSyncedCalendars();
  const syncedEvents = useSyncedCalendarEvents();
  const directory = useIssueMemberDirectory();

  const [storedHidden, setStoredHidden] = useLocalStorage(
    calendarLayersStorageKey(viewer.companyId),
    NO_HIDDEN_LAYERS,
    HIDDEN_LAYERS_SCHEMA,
  );
  const hiddenLayers = useMemo(() => new Set(storedHidden), [storedHidden]);

  const editableCalendars = useMemo(
    () => ownedCalendarIds(calendars, viewer.membershipId),
    [calendars, viewer.membershipId],
  );
  const visible = useMemo(
    () => visibleCalendarIds(calendars, hiddenLayers),
    [calendars, hiddenLayers],
  );
  const events = useMemo(
    () =>
      syncedEvents
        .filter((event) => visible.has(event.calendarId))
        .map((event) => toEventInput(event, editableCalendars)),
    [editableCalendars, syncedEvents, visible],
  );
  const layerGroups = useMemo(
    () =>
      buildCalendarLayerGroups({
        calendars,
        hidden: hiddenLayers,
        membershipId: viewer.membershipId,
        memberNames: directory.names,
      }),
    [calendars, directory.names, hiddenLayers, viewer.membershipId],
  );
  const defaultCalendarId = useMemo(() => {
    const own = calendars.find(
      (calendar) =>
        calendar.kind === "pathway" && calendar.ownerMembershipId === viewer.membershipId,
    );
    return own?.id ?? null;
  }, [calendars, viewer.membershipId]);

  const toggleLayer = useCallback(
    (key: CalendarLayerKey) => {
      setStoredHidden((current) => [...toggleCalendarLayer(new Set(current), key)]);
    },
    [setStoredHidden],
  );
  const setGroupVisible = useCallback(
    (group: CalendarLayerGroup, nextVisible: boolean) => {
      setStoredHidden((current) => [
        ...setCalendarGroupVisible(new Set(current), group, nextVisible),
      ]);
    },
    [setStoredHidden],
  );

  return {
    viewer,
    calendars,
    events,
    layerGroups,
    hiddenLayers,
    toggleLayer,
    setGroupVisible,
    defaultCalendarId,
  };
}

/**
 * The Convex client, built once per signed-in session and closed with the surface.
 *
 * Writes are refused rather than queued when there is no company to write into: `All companies` has
 * no single mutation target, which is the same rule every other creation flow in the app follows.
 */
export function useCalendarWriter(viewer: CalendarViewer): CalendarWriter {
  const { getToken, isSignedIn } = useAuth({ treatPendingAsSignedOut: false });
  const convexUrl = resolveCloudSyncConvexUrl();
  const getTokenRef = useRef(getToken);
  getTokenRef.current = getToken;

  const client = useMemo<CalendarEventsClient | null>(() => {
    if (!isSignedIn || convexUrl === null) return null;
    return makeCalendarEventsClient({
      convexUrl,
      fetchToken: (args) => makeClerkConvexTokenFetcher(getTokenRef.current)(args),
    });
  }, [convexUrl, isSignedIn]);

  useEffect(() => () => void client?.close(), [client]);

  const companyId = viewer.companyId;
  const requireTarget = useCallback(() => {
    if (client === null || companyId === null) {
      throw new Error("Pick a single company before changing a calendar.");
    }
    return { client, companyId };
  }, [client, companyId]);

  return useMemo<CalendarWriter>(
    () => ({
      ready: client !== null && companyId !== null,
      createEvent: async (input) => {
        const { client: convex, companyId: company } = requireTarget();
        await convex.createEvent({
          companyId: company,
          id: newCompanyDomainId() as CalendarEventId,
          ...input,
        });
      },
      updateEvent: async (input) => {
        const { client: convex, companyId: company } = requireTarget();
        await convex.updateEvent({ companyId: company, ...input });
      },
      deleteEvent: async (eventId) => {
        const { client: convex, companyId: company } = requireTarget();
        await convex.deleteEvent({ companyId: company, eventId });
      },
      createCalendar: async (name) => {
        const { client: convex, companyId: company } = requireTarget();
        const id = newCompanyDomainId() as CalendarId;
        await convex.createCalendar({ companyId: company, id, name });
        return id;
      },
    }),
    [client, companyId, requireTarget],
  );
}

/** The day the surface calls today, in the viewer's own zone rather than in UTC. */
export function todayCalendarDate(now: Date = new Date()): IssueDate {
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  return parts as IssueDate;
}
