import type { CalendarEntity } from "@spiritdevs/client-runtime/sync";
import type { CalendarId } from "@spiritdevs/contracts";
import type { MembershipId } from "@spiritdevs/contracts/company";
import { describe, expect, it } from "vite-plus/test";

import {
  CALENDAR_WORK_LAYERS,
  buildCalendarLayerGroups,
  calendarIdFromLayerKey,
  calendarLayerKey,
  calendarLayersStorageKey,
  isCalendarLayerVisible,
  setCalendarGroupVisible,
  toggleCalendarLayer,
  visibleCalendarIds,
} from "./calendarLayers.logic";

const ME = "membership-me" as MembershipId;
const DARREN = "membership-darren" as MembershipId;

const NAMES = new Map<string, string>([
  [ME, "Corey Baines"],
  [DARREN, "Darren Ford"],
]);

function calendar(overrides: Partial<CalendarEntity> = {}): CalendarEntity {
  return {
    entityKind: "calendar",
    id: "cal-1" as CalendarId,
    ownerMembershipId: ME,
    name: "Work",
    sharing: "private",
    teamId: null,
    kind: "pathway",
    accountId: null,
    googleCalendarId: null,
    createdAt: 1_760_000_000_000,
    updatedAt: 1_760_000_000_000,
    ...overrides,
  } as CalendarEntity;
}

const groups = (calendars: ReadonlyArray<CalendarEntity>, hidden: ReadonlyArray<string> = []) =>
  buildCalendarLayerGroups({
    calendars,
    hidden: new Set(hidden),
    membershipId: ME,
    memberNames: NAMES,
  });

describe("layer keys", () => {
  it("round-trips a calendar id and refuses a work key", () => {
    const key = calendarLayerKey("cal-1" as CalendarId);
    expect(calendarIdFromLayerKey(key)).toBe("cal-1");
    for (const layer of CALENDAR_WORK_LAYERS) {
      expect(calendarIdFromLayerKey(layer)).toBeNull();
    }
  });

  it("scopes storage per company, because visibility is per-machine and per-company", () => {
    expect(calendarLayersStorageKey("company-1")).toBe("pathway:calendar-layers:company-1");
    expect(calendarLayersStorageKey(null)).not.toBe(calendarLayersStorageKey("company-1"));
  });
});

describe("layer groups", () => {
  it("puts the viewer's own calendars first, then owners by name, then Work", () => {
    const built = groups([
      calendar({ id: "b" as CalendarId, ownerMembershipId: DARREN, name: "Darren — Work" }),
      calendar({ id: "a" as CalendarId, name: "Mine" }),
    ]);
    expect(built.map((group) => group.title)).toEqual(["My calendars", "Darren Ford", "Work"]);
    expect(built[2]?.layers.map((layer) => layer.key)).toEqual([...CALENDAR_WORK_LAYERS]);
  });

  it("marks everything but the viewer's own Pathway calendars read-only", () => {
    const built = groups([
      calendar({ id: "mine" as CalendarId }),
      calendar({ id: "mirror" as CalendarId, kind: "google", accountId: "acct" as never }),
      calendar({ id: "theirs" as CalendarId, ownerMembershipId: DARREN }),
    ]);
    const byKey = new Map(
      built.flatMap((group) => group.layers.map((layer) => [layer.key, layer] as const)),
    );
    expect(byKey.get(calendarLayerKey("mine" as CalendarId))?.readOnly).toBe(false);
    // A mirror is read-only even when it is the viewer's own connected account.
    expect(byKey.get(calendarLayerKey("mirror" as CalendarId))?.readOnly).toBe(true);
    expect(byKey.get(calendarLayerKey("theirs" as CalendarId))?.readOnly).toBe(true);
  });

  it("still groups a calendar whose owner has not arrived in the directory yet", () => {
    const built = groups([
      calendar({ id: "orphan" as CalendarId, ownerMembershipId: "who" as MembershipId }),
    ]);
    expect(built.map((group) => group.title)).toEqual(["Shared with me", "Work"]);
    expect(built[0]?.layers).toHaveLength(1);
  });

  it("reads a layer nobody has touched as visible", () => {
    const built = groups([calendar()]);
    expect(built[0]?.layers[0]?.visible).toBe(true);
    expect(built[1]?.layers.every((layer) => layer.visible)).toBe(true);
  });

  it("reads a hidden key as off", () => {
    const built = groups([calendar()], [calendarLayerKey("cal-1" as CalendarId), "cycles"]);
    expect(built[0]?.layers[0]?.visible).toBe(false);
    const work = built[1]?.layers ?? [];
    expect(work.find((layer) => layer.key === "cycles")?.visible).toBe(false);
    expect(work.find((layer) => layer.key === "issues")?.visible).toBe(true);
  });
});

describe("toggling", () => {
  it("adds and removes from the hidden set", () => {
    expect(toggleCalendarLayer(new Set(), "issues")).toEqual(["issues"]);
    expect(toggleCalendarLayer(new Set(["issues"]), "issues")).toEqual([]);
    expect(isCalendarLayerVisible(new Set(["issues"]), "issues")).toBe(false);
    expect(isCalendarLayerVisible(new Set(["issues"]), "cycles")).toBe(true);
  });

  it("turns a whole group off and back on", () => {
    const built = groups([calendar()]);
    const work = built[1];
    if (work === undefined) throw new Error("expected a Work group");
    const off = setCalendarGroupVisible(new Set(), work, false);
    expect(off).toEqual([...CALENDAR_WORK_LAYERS].sort());
    expect(setCalendarGroupVisible(new Set(off), work, true)).toEqual([]);
  });

  it("leaves layers outside the group alone", () => {
    const built = groups([calendar()]);
    const work = built[1];
    if (work === undefined) throw new Error("expected a Work group");
    const hidden = new Set([calendarLayerKey("cal-1" as CalendarId)]);
    expect(setCalendarGroupVisible(hidden, work, true)).toEqual([
      calendarLayerKey("cal-1" as CalendarId),
    ]);
  });
});

describe("visibleCalendarIds", () => {
  it("keeps every calendar not explicitly hidden", () => {
    const calendars = [calendar({ id: "a" as CalendarId }), calendar({ id: "b" as CalendarId })];
    expect([...visibleCalendarIds(calendars, new Set())]).toEqual(["a", "b"]);
    expect([
      ...visibleCalendarIds(calendars, new Set([calendarLayerKey("a" as CalendarId)])),
    ]).toEqual(["b"]);
  });
});
