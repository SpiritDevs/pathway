import { CALENDAR_KEYBINDING_COMMANDS } from "@spiritdevs/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@spiritdevs/shared/keybindings";
import { describe, expect, it } from "vite-plus/test";

import { resolveShortcutCommand } from "../../keybindings";
import {
  calendarKeyAction,
  calendarKeyIsAllowed,
  isCalendarTextEntryTarget,
} from "./calendarKeybindings.logic";

const press = (key: string, overrides: Record<string, unknown> = {}) => ({
  key,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...overrides,
});

const resolve = (key: string, calendarView: boolean) =>
  resolveShortcutCommand(press(key), DEFAULT_RESOLVED_KEYBINDINGS, {
    platform: "MacIntel",
    context: { calendarView },
  });

describe("calendar key defaults", () => {
  it.each([
    ["d", "calendar.day"],
    ["w", "calendar.week"],
    ["m", "calendar.month"],
    ["x", "calendar.timeline"],
    ["t", "calendar.today"],
    ["[", "calendar.previous"],
    ["]", "calendar.next"],
    ["c", "calendar.newEvent"],
  ])("binds %s on the calendar", (key, command) => {
    expect(resolve(key, true)).toBe(command);
  });

  it("resolves to nothing off the calendar, which is what `calendarView` is for", () => {
    for (const key of ["d", "w", "m", "x", "t", "[", "]", "c"]) {
      expect(resolve(key, false)).toBeNull();
    }
  });

  it("collides with no existing default, because every other one carries a modifier", () => {
    const bare = DEFAULT_RESOLVED_KEYBINDINGS.filter(
      (binding) =>
        !binding.shortcut.modKey &&
        !binding.shortcut.metaKey &&
        !binding.shortcut.ctrlKey &&
        !binding.shortcut.altKey,
    );
    expect(bare.every((binding) => String(binding.command).startsWith("calendar."))).toBe(true);
  });

  it("is rebindable, which means every command is a real built-in", () => {
    for (const command of CALENDAR_KEYBINDING_COMMANDS) {
      expect(DEFAULT_RESOLVED_KEYBINDINGS.some((binding) => binding.command === command)).toBe(
        true,
      );
    }
  });
});

describe("calendarKeyAction", () => {
  it("maps every calendar command to an action, and nothing else to one", () => {
    for (const command of CALENDAR_KEYBINDING_COMMANDS) {
      expect(calendarKeyAction(command)).not.toBeNull();
    }
    expect(calendarKeyAction("sidebar.toggle")).toBeNull();
    expect(calendarKeyAction(null)).toBeNull();
  });

  it("reads the four modes, today, both steps, and create", () => {
    expect(calendarKeyAction("calendar.day")).toEqual({ kind: "mode", mode: "day" });
    expect(calendarKeyAction("calendar.timeline")).toEqual({ kind: "mode", mode: "timeline" });
    expect(calendarKeyAction("calendar.today")).toEqual({ kind: "today" });
    expect(calendarKeyAction("calendar.previous")).toEqual({ kind: "step", direction: -1 });
    expect(calendarKeyAction("calendar.next")).toEqual({ kind: "step", direction: 1 });
    expect(calendarKeyAction("calendar.newEvent")).toEqual({ kind: "newEvent" });
  });
});

describe("the text-entry guard", () => {
  it("recognises the three places a character gets typed", () => {
    expect(isCalendarTextEntryTarget({ tagName: "INPUT" })).toBe(true);
    expect(isCalendarTextEntryTarget({ tagName: "TEXTAREA" })).toBe(true);
    expect(isCalendarTextEntryTarget({ isContentEditable: true, tagName: "DIV" })).toBe(true);
    expect(isCalendarTextEntryTarget({ tagName: "DIV" })).toBe(false);
    expect(isCalendarTextEntryTarget(null)).toBe(false);
    expect(isCalendarTextEntryTarget(undefined)).toBe(false);
  });

  it("refuses a bare key inside a field and allows it everywhere else", () => {
    expect(
      calendarKeyIsAllowed({
        metaKey: false,
        ctrlKey: false,
        altKey: false,
        target: { tagName: "INPUT" },
      }),
    ).toBe(false);
    expect(
      calendarKeyIsAllowed({
        metaKey: false,
        ctrlKey: false,
        altKey: false,
        target: { tagName: "DIV" },
      }),
    ).toBe(true);
  });

  it("still fires a rebound modifier shortcut inside a field, because that was asked for", () => {
    expect(
      calendarKeyIsAllowed({
        metaKey: true,
        ctrlKey: false,
        altKey: false,
        target: { tagName: "INPUT" },
      }),
    ).toBe(true);
  });

  it("does not count Shift as a modifier: Shift+D still types a letter", () => {
    expect(
      calendarKeyIsAllowed({
        metaKey: false,
        ctrlKey: false,
        altKey: false,
        target: { isContentEditable: true },
      }),
    ).toBe(false);
  });
});
