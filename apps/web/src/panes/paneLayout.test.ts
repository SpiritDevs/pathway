import { describe, expect, it } from "@effect/vitest";

import {
  closePane,
  closeSidePanes,
  equalizePanes,
  flipPane,
  focusAdjacentPane,
  normalizePaneLayout,
  openPane,
  paneCapacity,
  PRIMARY_PANE_ID,
  resizeAtDivider,
  resolveVisiblePanes,
  setPaneHref,
  SINGLE_PANE_LAYOUT,
  splitEdge,
  type PaneLayout,
} from "./paneLayout";

const ids = (layout: PaneLayout) => layout.panes.map((entry) => entry.id);

describe("openPane", () => {
  it("adds the pane at the chosen edge and focuses it", () => {
    const left = openPane(SINGLE_PANE_LAYOUT, { id: "a", href: "/email", edge: "left" });
    expect(ids(left)).toEqual(["a", PRIMARY_PANE_ID]);
    expect(left.focusedPaneId).toBe("a");

    const right = openPane(left, { id: "b", href: "/calendar", edge: "right" });
    expect(ids(right)).toEqual(["a", PRIMARY_PANE_ID, "b"]);
    expect(right.focusedPaneId).toBe("b");
  });

  it("gives the new pane an equal share", () => {
    const layout = openPane(SINGLE_PANE_LAYOUT, { id: "a", href: "/email", edge: "right" });
    expect(layout.panes.map((entry) => entry.weight)).toEqual([1, 1]);
  });
});

describe("splitEdge", () => {
  it("opens on the right of a lone or rightmost focused pane, otherwise on the left", () => {
    expect(splitEdge(SINGLE_PANE_LAYOUT)).toBe("right");
    const split = openPane(SINGLE_PANE_LAYOUT, { id: "a", href: "/email", edge: "right" });
    expect(splitEdge(split)).toBe("right");
    expect(splitEdge({ ...split, focusedPaneId: PRIMARY_PANE_ID })).toBe("left");
  });
});

describe("closePane", () => {
  const split = openPane(openPane(SINGLE_PANE_LAYOUT, { id: "a", href: "/email", edge: "left" }), {
    id: "b",
    href: "/calendar",
    edge: "right",
  });

  it("removes a side pane and moves focus to its neighbour", () => {
    const { layout, promotedHref } = closePane(split, "b");
    expect(ids(layout)).toEqual(["a", PRIMARY_PANE_ID]);
    expect(layout.focusedPaneId).toBe(PRIMARY_PANE_ID);
    expect(promotedHref).toBeNull();
  });

  it("promotes the left neighbour when the primary pane closes", () => {
    const { layout, promotedHref } = closePane(split, PRIMARY_PANE_ID);
    expect(ids(layout)).toEqual([PRIMARY_PANE_ID, "b"]);
    expect(promotedHref).toBe("/email");
    expect(layout.panes[0]?.href).toBe("");
  });

  it("keeps focus on the promoted pane when it was focused", () => {
    const focusedOnA = { ...split, focusedPaneId: "a" };
    expect(closePane(focusedOnA, PRIMARY_PANE_ID).layout.focusedPaneId).toBe(PRIMARY_PANE_ID);
  });

  it("never closes the last pane", () => {
    expect(closePane(SINGLE_PANE_LAYOUT, PRIMARY_PANE_ID).layout).toBe(SINGLE_PANE_LAYOUT);
  });

  it("closes every side pane at once", () => {
    expect(closeSidePanes(split)).toEqual(SINGLE_PANE_LAYOUT);
  });
});

describe("flipPane", () => {
  it("swaps two panes", () => {
    const layout = openPane(SINGLE_PANE_LAYOUT, { id: "a", href: "/email", edge: "right" });
    expect(ids(flipPane(layout, "a"))).toEqual(["a", PRIMARY_PANE_ID]);
    expect(ids(flipPane(layout, PRIMARY_PANE_ID))).toEqual(["a", PRIMARY_PANE_ID]);
  });
});

describe("focusAdjacentPane", () => {
  it("stops at the ends", () => {
    const layout = openPane(SINGLE_PANE_LAYOUT, { id: "a", href: "/email", edge: "right" });
    expect(focusAdjacentPane(layout, "left").focusedPaneId).toBe(PRIMARY_PANE_ID);
    expect(focusAdjacentPane(layout, "right").focusedPaneId).toBe("a");
  });
});

describe("resizeAtDivider", () => {
  it("clamps both sides to the minimum share", () => {
    const layout = openPane(SINGLE_PANE_LAYOUT, { id: "a", href: "/email", edge: "right" });
    const resized = resizeAtDivider(layout, 0, 0.95, 0.2);
    expect(resized.panes[0]?.weight).toBeCloseTo(1.6);
    expect(resized.panes[1]?.weight).toBeCloseTo(0.4);
    expect(equalizePanes(resized).panes.map((entry) => entry.weight)).toEqual([1, 1]);
  });
});

describe("resolveVisiblePanes", () => {
  const four: PaneLayout = {
    panes: ["a", "b", PRIMARY_PANE_ID, "c"].map((id) => ({
      id,
      href: id === PRIMARY_PANE_ID ? "" : `/${id}`,
      weight: 1,
    })),
    focusedPaneId: "c",
  };

  it("fits panes by width", () => {
    expect(paneCapacity(300)).toBe(1);
    expect(paneCapacity(1000)).toBe(2);
    expect(paneCapacity(3440)).toBe(9);
  });

  it("shows everything when it fits", () => {
    expect(resolveVisiblePanes(four, 4).collapsedLeft).toEqual([]);
  });

  it("keeps the focused pane visible and collapses the rest to their sides", () => {
    const { visible, collapsedLeft, collapsedRight } = resolveVisiblePanes(four, 2);
    expect(visible.map((entry) => entry.id)).toEqual([PRIMARY_PANE_ID, "c"]);
    expect(collapsedLeft.map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(collapsedRight).toEqual([]);
  });
});

describe("setPaneHref", () => {
  it("ignores the primary pane, which the URL owns", () => {
    expect(setPaneHref(SINGLE_PANE_LAYOUT, PRIMARY_PANE_ID, "/email")).toBe(SINGLE_PANE_LAYOUT);
  });
});

describe("normalizePaneLayout", () => {
  it("falls back to a single pane without a primary pane", () => {
    expect(
      normalizePaneLayout({ panes: [{ id: "a", href: "/email", weight: 1 }], focusedPaneId: "a" }),
    ).toBe(SINGLE_PANE_LAYOUT);
  });

  it("drops side panes without a usable location and repairs focus", () => {
    const layout = normalizePaneLayout({
      panes: [
        { id: PRIMARY_PANE_ID, href: "", weight: 1 },
        { id: "a", href: "email", weight: 1 },
        { id: "b", href: "/email", weight: -3 },
      ],
      focusedPaneId: "a",
    });
    expect(ids(layout)).toEqual([PRIMARY_PANE_ID, "b"]);
    expect(layout.panes[1]?.weight).toBe(1);
    expect(layout.focusedPaneId).toBe(PRIMARY_PANE_ID);
  });
});
