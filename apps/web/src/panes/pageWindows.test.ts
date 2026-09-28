import { describe, expect, it } from "@effect/vitest";

import {
  applyPageWindowMessage,
  reconcilePageWindows,
  toPageWindow,
  type PageWindow,
} from "./pageWindows";
import { isOutsideViewport } from "./paneTearOut";

const email: PageWindow = { id: "a", href: "/email", title: "Email - Pathway" };
const calendar: PageWindow = { id: "b", href: "/calendar", title: "Calendar - Pathway" };

describe("toPageWindow", () => {
  it("uses the desktop window's hash route as the href", () => {
    expect(
      toPageWindow({ id: "a", path: "/email?folder=inbox", title: "Email - Pathway" }),
    ).toEqual({ id: "a", href: "/email?folder=inbox", title: "Email - Pathway" });
    expect(toPageWindow({ id: "a", path: "calendar", title: "Calendar" }).href).toBe("/calendar");
  });

  it("names an untitled window after its page", () => {
    expect(toPageWindow({ id: "a", path: "/email", title: "" }).title).toBe("Email");
  });
});

describe("reconcilePageWindows", () => {
  it("keeps the current array when nothing changed", () => {
    const current = [email, calendar];
    expect(reconcilePageWindows(current, [{ ...email }, { ...calendar }])).toBe(current);
  });

  it("takes the next array when anything changed", () => {
    const current = [email, calendar];
    const retitled = [email, { ...calendar, title: "Calendar (2)" }];
    expect(reconcilePageWindows(current, retitled)).toBe(retitled);
    expect(reconcilePageWindows(current, [calendar, email])).not.toBe(current);
    expect(reconcilePageWindows(current, [email])).not.toBe(current);
  });
});

describe("applyPageWindowMessage", () => {
  const own = (id: string) => id !== "stranger";

  it("adds and updates a popup's page", () => {
    const added = applyPageWindowMessage([email], { type: "state", ...calendar }, own);
    expect(added).toEqual([email, calendar]);
    const moved = applyPageWindowMessage(
      added,
      { type: "state", id: "a", href: "/contacts", title: "Contacts - Pathway" },
      own,
    );
    expect(moved).toEqual([{ id: "a", href: "/contacts", title: "Contacts - Pathway" }, calendar]);
  });

  it("drops a popup that closed", () => {
    expect(applyPageWindowMessage([email, calendar], { type: "closed", id: "a" }, own)).toEqual([
      calendar,
    ]);
  });

  it("ignores popups another tab opened", () => {
    const current = [email];
    expect(
      applyPageWindowMessage(
        current,
        { type: "state", id: "stranger", href: "/", title: "Dashboard" },
        own,
      ),
    ).toBe(current);
  });
});

describe("isOutsideViewport", () => {
  const viewport = { width: 1000, height: 700 };

  it("is false anywhere inside, edges included", () => {
    expect(isOutsideViewport({ x: 0, y: 0 }, viewport)).toBe(false);
    expect(isOutsideViewport({ x: 1000, y: 700 }, viewport)).toBe(false);
    expect(isOutsideViewport({ x: 500, y: 350 }, viewport)).toBe(false);
  });

  it("is true past any edge", () => {
    expect(isOutsideViewport({ x: -1, y: 350 }, viewport)).toBe(true);
    expect(isOutsideViewport({ x: 1001, y: 350 }, viewport)).toBe(true);
    expect(isOutsideViewport({ x: 500, y: -4 }, viewport)).toBe(true);
    expect(isOutsideViewport({ x: 500, y: 701 }, viewport)).toBe(true);
  });
});
