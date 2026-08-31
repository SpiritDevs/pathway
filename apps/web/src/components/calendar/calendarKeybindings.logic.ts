/**
 * What `/calendar`'s keys mean, and the one guard that makes bare keys safe.
 *
 * The bindings themselves are ordinary {@link BUILT_IN_KEYBINDING_COMMANDS} with a `calendarView`
 * `when` clause, so they are rebindable from the keybindings settings page like everything else and
 * this module never reads a key. What it does is translate a resolved command into an action the
 * surface applies, and answer whether the keystroke should have been allowed to reach it at all.
 *
 * **The guard.** Every other default binding in the app carries a modifier, so `d` and `c` collide
 * with nothing — but there is no `textInputFocus` context identifier, and a bare letter that fires
 * while somebody is naming an event would be a keystroke eaten mid-word. So the surface refuses a
 * modifier-free keystroke whose target is a text entry. Refusing only the modifier-free case is
 * deliberate: a user who rebinds these to `mod+d` has asked for a shortcut that works everywhere,
 * and taking it away inside a field would be answering a question they did not ask.
 *
 * @module components/calendar/calendarKeybindings.logic
 */
import type { KeybindingCommand } from "@spiritdevs/contracts";

import type { CalendarMode } from "./calendarGrid.logic";

/** What a calendar key does, once the command has been resolved through the user's bindings. */
export type CalendarKeyAction =
  | { readonly kind: "mode"; readonly mode: CalendarMode }
  | { readonly kind: "today" }
  | { readonly kind: "step"; readonly direction: -1 | 1 }
  | { readonly kind: "newEvent" };

const ACTIONS: Readonly<Record<string, CalendarKeyAction>> = {
  "calendar.day": { kind: "mode", mode: "day" },
  "calendar.week": { kind: "mode", mode: "week" },
  "calendar.month": { kind: "mode", mode: "month" },
  "calendar.timeline": { kind: "mode", mode: "timeline" },
  "calendar.today": { kind: "today" },
  "calendar.previous": { kind: "step", direction: -1 },
  "calendar.next": { kind: "step", direction: 1 },
  "calendar.newEvent": { kind: "newEvent" },
};

/** The action a resolved command names, or null for every command that is not the calendar's. */
export function calendarKeyAction(command: KeybindingCommand | null): CalendarKeyAction | null {
  return command === null ? null : (ACTIONS[command] ?? null);
}

/** The shape of an event target this module needs; a DOM node satisfies it. */
export interface CalendarKeyTarget {
  readonly tagName?: string | undefined;
  readonly isContentEditable?: boolean | undefined;
}

const TEXT_ENTRY_TAGS: ReadonlySet<string> = new Set(["INPUT", "TEXTAREA", "SELECT"]);

/** Whether the keystroke landed somewhere a character was going to be typed. */
export function isCalendarTextEntryTarget(target: unknown): boolean {
  if (typeof target !== "object" || target === null) return false;
  const node = target as CalendarKeyTarget;
  if (node.isContentEditable === true) return true;
  return typeof node.tagName === "string" && TEXT_ENTRY_TAGS.has(node.tagName);
}

export interface CalendarKeyEventLike {
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly target?: unknown;
}

/**
 * Whether a keystroke may reach the calendar at all.
 *
 * Shift is deliberately not a modifier here: `Shift+d` still types a letter, so it is exactly as
 * unsafe inside a field as `d` is.
 */
export function calendarKeyIsAllowed(event: CalendarKeyEventLike): boolean {
  const modified = event.metaKey || event.ctrlKey || event.altKey;
  return modified || !isCalendarTextEntryTarget(event.target);
}
