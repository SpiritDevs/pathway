/**
 * The sidebar's Layers: which row-sources the surface is drawing, and how they are grouped.
 *
 * A Layer is one toggleable source — a Calendar, or a work source such as Issues, Milestones, or
 * Cycles. Visibility is per-machine and per-company and does not sync, the same rule the Active
 * Focus follows, so what is stored is a set of *hidden* keys: a calendar shared with you tomorrow
 * arrives visible rather than arriving hidden because it was not in a list written today.
 *
 * Calendars group by owner rather than by kind, for the reason ADR 0012 gives about grants: sharing
 * a work calendar while withholding a personal one is the case that matters, so the owner is what a
 * reader is scanning for. The viewer's own group sorts first and is named for them.
 *
 * @module components/calendar/calendarLayers.logic
 */
import type { CalendarEntity } from "@spiritdevs/client-runtime/sync";
import type { CalendarId } from "@spiritdevs/contracts";
import type { MembershipId } from "@spiritdevs/contracts/company";

/** Date-only sources from the tracker. They can only ever reach the all-day lane (ADR 0011). */
export const CALENDAR_WORK_LAYERS = ["issues", "milestones", "cycles"] as const;
export type CalendarWorkLayer = (typeof CALENDAR_WORK_LAYERS)[number];

export const CALENDAR_WORK_LAYER_LABELS: Readonly<Record<CalendarWorkLayer, string>> = {
  issues: "Issue due dates",
  milestones: "Milestones",
  cycles: "Cycles",
};

const CALENDAR_LAYER_PREFIX = "calendar:";

/** A layer's stable identity in the hidden set. Prefixed so a calendar id cannot forge a work key. */
export type CalendarLayerKey = string;

export function calendarLayerKey(calendarId: CalendarId): CalendarLayerKey {
  return `${CALENDAR_LAYER_PREFIX}${calendarId}`;
}

export function calendarIdFromLayerKey(key: CalendarLayerKey): CalendarId | null {
  if (!key.startsWith(CALENDAR_LAYER_PREFIX)) return null;
  const id = key.slice(CALENDAR_LAYER_PREFIX.length);
  return id.length === 0 ? null : (id as CalendarId);
}

export interface CalendarLayer {
  readonly key: CalendarLayerKey;
  readonly label: string;
  readonly visible: boolean;
  /** A mirrored Google calendar, or one owned by somebody else: drawn, never edited. */
  readonly readOnly: boolean;
  readonly kind: "pathway" | "google" | "work";
}

export interface CalendarLayerGroup {
  readonly id: string;
  readonly title: string;
  readonly layers: ReadonlyArray<CalendarLayer>;
}

/**
 * The sidebar's groups: the viewer's calendars, then everybody else's by name, then the work
 * sources.
 *
 * A calendar with no owner in the directory still gets a group rather than being dropped — the
 * membership row may simply not have arrived yet, and a calendar you can see but cannot place is
 * still a calendar you can turn off.
 */
export function buildCalendarLayerGroups(input: {
  readonly calendars: ReadonlyArray<CalendarEntity>;
  readonly hidden: ReadonlySet<CalendarLayerKey>;
  readonly membershipId: MembershipId | null;
  readonly memberNames: ReadonlyMap<string, string>;
}): ReadonlyArray<CalendarLayerGroup> {
  const byOwner = new Map<string, Array<CalendarEntity>>();
  for (const calendar of input.calendars) {
    const bucket = byOwner.get(calendar.ownerMembershipId);
    if (bucket === undefined) byOwner.set(calendar.ownerMembershipId, [calendar]);
    else bucket.push(calendar);
  }

  const groups: Array<CalendarLayerGroup> = [];
  const ownerIds = [...byOwner.keys()].sort((left, right) => {
    if (left === input.membershipId) return -1;
    if (right === input.membershipId) return 1;
    const leftName = input.memberNames.get(left) ?? left;
    const rightName = input.memberNames.get(right) ?? right;
    return leftName.localeCompare(rightName);
  });

  for (const ownerId of ownerIds) {
    const mine = ownerId === input.membershipId;
    groups.push({
      id: ownerId,
      title: mine ? "My calendars" : (input.memberNames.get(ownerId) ?? "Shared with me"),
      layers: (byOwner.get(ownerId) ?? []).map((calendar) => ({
        key: calendarLayerKey(calendar.id),
        label: calendar.name,
        visible: !input.hidden.has(calendarLayerKey(calendar.id)),
        // Only the owner may edit a Pathway calendar, and nobody may edit a mirror.
        readOnly: calendar.kind !== "pathway" || !mine,
        kind: calendar.kind,
      })),
    });
  }

  groups.push({
    id: "work",
    title: "Work",
    layers: CALENDAR_WORK_LAYERS.map((layer) => ({
      key: layer,
      label: CALENDAR_WORK_LAYER_LABELS[layer],
      visible: !input.hidden.has(layer),
      readOnly: false,
      kind: "work" as const,
    })),
  });

  return groups;
}

/** Toggling writes the *hidden* set, so a layer nobody has touched stays visible by default. */
export function toggleCalendarLayer(
  hidden: ReadonlySet<CalendarLayerKey>,
  key: CalendarLayerKey,
): ReadonlyArray<CalendarLayerKey> {
  const next = new Set(hidden);
  if (!next.delete(key)) next.add(key);
  return [...next].sort();
}

/** Every layer in a group on or off at once — the "only this one" gesture, spelled as a group. */
export function setCalendarGroupVisible(
  hidden: ReadonlySet<CalendarLayerKey>,
  group: CalendarLayerGroup,
  visible: boolean,
): ReadonlyArray<CalendarLayerKey> {
  const next = new Set(hidden);
  for (const layer of group.layers) {
    if (visible) next.delete(layer.key);
    else next.add(layer.key);
  }
  return [...next].sort();
}

export function isCalendarLayerVisible(
  hidden: ReadonlySet<CalendarLayerKey>,
  key: CalendarLayerKey,
): boolean {
  return !hidden.has(key);
}

/** The calendars whose events are drawn. Hidden ones are filtered here rather than at render. */
export function visibleCalendarIds(
  calendars: ReadonlyArray<CalendarEntity>,
  hidden: ReadonlySet<CalendarLayerKey>,
): ReadonlySet<CalendarId> {
  const visible = new Set<CalendarId>();
  for (const calendar of calendars) {
    if (!hidden.has(calendarLayerKey(calendar.id))) visible.add(calendar.id);
  }
  return visible;
}

/** The per-machine, per-company storage key. Layer visibility never enters the change feed. */
export function calendarLayersStorageKey(companyId: string | null): string {
  return `pathway:calendar-layers:${companyId ?? "none"}`;
}
