import { describe, expect, it } from "@effect/vitest";

import {
  buildRailPageMenu,
  describePanePosition,
  findPanesShowing,
  findWindowsShowing,
  type RailPageMenuInput,
} from "./railPageMenu";

const base: RailPageMenuInput = {
  canOpenWindows: false,
  split: false,
  panes: [],
  windows: [],
  anyWindows: false,
  move: null,
};

describe("buildRailPageMenu", () => {
  it("offers only the open actions for a page shown nowhere else", () => {
    expect(buildRailPageMenu(base)).toEqual([
      { id: "open-left", label: "Open in left panel" },
      { id: "open-right", label: "Open in right panel" },
    ]);
  });

  it("offers a new window only where windows can open", () => {
    expect(buildRailPageMenu({ ...base, canOpenWindows: true }).map((item) => item.id)).toEqual([
      "open-left",
      "open-right",
      "open-window",
    ]);
  });

  it("closes a single matching pane and window directly, separated from the open actions", () => {
    expect(
      buildRailPageMenu({
        ...base,
        split: true,
        panes: [{ id: "pane-1", label: "Right" }],
        windows: [{ id: "window-1", label: "Email" }],
        anyWindows: true,
      }),
    ).toEqual([
      { id: "open-left", label: "Open in left panel" },
      { id: "open-right", label: "Open in right panel", separatorAfter: true },
      { id: "close-pane:pane-1", label: "Close panel" },
      { id: "close-window:window-1", label: "Close window" },
      { id: "close-all-panes", label: "Close all panels" },
      { id: "close-all-windows", label: "Close all windows" },
    ]);
  });

  it("lists each match in a submenu when several panes or windows show the page", () => {
    const items = buildRailPageMenu({
      ...base,
      split: true,
      panes: [
        { id: "primary", label: "Left" },
        { id: "pane-2", label: "Right" },
      ],
      windows: [
        { id: "w1", label: "Email (1)" },
        { id: "w2", label: "Email (2)" },
      ],
      anyWindows: true,
    });
    expect(items.find((item) => item.id === "close-pane-menu")).toEqual({
      id: "close-pane-menu",
      label: "Close panel",
      children: [
        { id: "close-pane:primary", label: "Left" },
        { id: "close-pane:pane-2", label: "Right" },
      ],
    });
    expect(items.find((item) => item.id === "close-window-menu")?.children).toEqual([
      { id: "close-window:w1", label: "Email (1)" },
      { id: "close-window:w2", label: "Email (2)" },
    ]);
  });

  it("keeps close-all actions even when this page is not among them", () => {
    expect(
      buildRailPageMenu({ ...base, split: true, anyWindows: true }).map((item) => item.id),
    ).toEqual(["open-left", "open-right", "close-all-panes", "close-all-windows"]);
  });

  it("ends with the move actions for reorderable pages", () => {
    const items = buildRailPageMenu({ ...base, move: { canMoveUp: false, canMoveDown: true } });
    expect(items.slice(-3)).toEqual([
      { id: "open-right", label: "Open in right panel", separatorAfter: true },
      { id: "move-up", label: "Move up", disabled: true },
      { id: "move-down", label: "Move down", disabled: false },
    ]);
  });
});

describe("describePanePosition", () => {
  it("names two and three panes by side, and more by number", () => {
    expect([0, 1].map((index) => describePanePosition(index, 2))).toEqual(["Left", "Right"]);
    expect([0, 1, 2].map((index) => describePanePosition(index, 3))).toEqual([
      "Left",
      "Middle",
      "Right",
    ]);
    expect(describePanePosition(3, 4)).toBe("Panel 4");
  });
});

describe("findPanesShowing", () => {
  it("matches panes by the page their location belongs to", () => {
    const panes = [
      { id: "pane-a", href: "/email?inbox=work" },
      { id: "primary", href: "/threads/env/thread" },
      { id: "pane-b", href: "/email/message-1" },
    ];
    expect(findPanesShowing("email", panes)).toEqual([
      { id: "pane-a", label: "Left" },
      { id: "pane-b", label: "Right" },
    ]);
    expect(findPanesShowing("threads", panes)).toEqual([{ id: "primary", label: "Middle" }]);
  });

  it("has nothing to close when the row is not split", () => {
    expect(findPanesShowing("dashboard", [{ id: "primary", href: "/" }])).toEqual([]);
  });

  it("skips panes whose location is not known yet", () => {
    expect(
      findPanesShowing("dashboard", [
        { id: "primary", href: null },
        { id: "pane-a", href: "/" },
      ]),
    ).toEqual([{ id: "pane-a", label: "Right" }]);
  });
});

describe("findWindowsShowing", () => {
  it("numbers windows that share a title", () => {
    expect(
      findWindowsShowing("email", [
        { id: "w1", href: "/email", title: "Email" },
        { id: "w2", href: "/calendar", title: "Calendar" },
        { id: "w3", href: "/email/message-1", title: "Email" },
      ]),
    ).toEqual([
      { id: "w1", label: "Email (1)" },
      { id: "w3", label: "Email (2)" },
    ]);
    expect(
      findWindowsShowing("calendar", [{ id: "w2", href: "/calendar", title: "Calendar" }]),
    ).toEqual([{ id: "w2", label: "Calendar" }]);
  });
});
