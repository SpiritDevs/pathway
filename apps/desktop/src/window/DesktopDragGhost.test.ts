import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

vi.mock("electron", () => ({}));

import { buildDragGhostHtml, DRAG_GHOST_MARGIN, dragGhostPosition } from "./DesktopDragGhost.ts";

const ghost = {
  label: "Email",
  iconSvg: '<svg viewBox="0 0 24 24"><path d="M0 0"/></svg>',
  width: 96,
  height: 32,
  offsetX: 20,
  offsetY: 10,
  background: "rgb(255, 255, 255)",
  foreground: "rgb(17, 17, 17)",
  border: "rgb(229, 229, 229)",
  fontFamily: '"Inter", system-ui',
  fontSize: "14px",
};

describe("drag ghost", () => {
  it("keeps the chip's grip on the cursor", () => {
    expect(dragGhostPosition({ x: 500, y: 300 }, ghost)).toEqual({
      x: 500 - 20 - DRAG_GHOST_MARGIN,
      y: 300 - 10 - DRAG_GHOST_MARGIN,
    });
  });

  it("draws the icon and label", () => {
    const html = buildDragGhostHtml(ghost);
    expect(html).toContain(ghost.iconSvg);
    expect(html).toContain("<span>Email</span>");
    expect(html).toContain("width:96px");
  });

  it("escapes the label and drops markup that is not an icon", () => {
    const html = buildDragGhostHtml({
      ...ghost,
      label: "<b>Mail</b>",
      iconSvg: "<img src=x>",
    });
    expect(html).toContain("&lt;b&gt;Mail&lt;/b&gt;");
    expect(html).not.toContain("<img");
  });

  it("falls back when a style value could break out of its declaration", () => {
    const html = buildDragGhostHtml({ ...ghost, background: "red;} body{display:none" });
    expect(html).toContain("background:#ffffff");
  });
});
