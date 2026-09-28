import { describe, expect, it } from "@effect/vitest";

import { resolvePaneDropZone, resolveRailDragTarget, type RailDragGeometry } from "./railDrag";

const geometry: RailDragGeometry = {
  railRight: 56,
  row: { left: 56, top: 44, width: 900, height: 700 },
  viewport: { width: 956, height: 744 },
};

describe("resolvePaneDropZone", () => {
  it("splits the row into thirds", () => {
    expect(resolvePaneDropZone(60, geometry.row)).toBe("left");
    expect(resolvePaneDropZone(355, geometry.row)).toBe("left");
    expect(resolvePaneDropZone(356, geometry.row)).toBe("center");
    expect(resolvePaneDropZone(655, geometry.row)).toBe("center");
    expect(resolvePaneDropZone(656, geometry.row)).toBe("right");
    expect(resolvePaneDropZone(950, geometry.row)).toBe("right");
  });
});

describe("resolveRailDragTarget", () => {
  it("reorders while the pointer is over the rail", () => {
    expect(resolveRailDragTarget({ x: 20, y: 300 }, geometry)).toEqual({ kind: "rail" });
    expect(resolveRailDragTarget({ x: 56, y: 300 }, geometry)).toEqual({ kind: "rail" });
  });

  it("targets a drop zone once the pointer crosses into the content", () => {
    expect(resolveRailDragTarget({ x: 57, y: 300 }, geometry)).toEqual({
      kind: "pane",
      zone: "left",
    });
    expect(resolveRailDragTarget({ x: 500, y: 10 }, geometry)).toEqual({
      kind: "pane",
      zone: "center",
    });
    expect(resolveRailDragTarget({ x: 900, y: 300 }, geometry)).toEqual({
      kind: "pane",
      zone: "right",
    });
  });

  it("leaves the window past any viewport edge", () => {
    expect(resolveRailDragTarget({ x: -1, y: 300 }, geometry)).toEqual({ kind: "outside" });
    expect(resolveRailDragTarget({ x: 957, y: 300 }, geometry)).toEqual({ kind: "outside" });
    expect(resolveRailDragTarget({ x: 400, y: -1 }, geometry)).toEqual({ kind: "outside" });
    expect(resolveRailDragTarget({ x: 400, y: 745 }, geometry)).toEqual({ kind: "outside" });
  });
});
