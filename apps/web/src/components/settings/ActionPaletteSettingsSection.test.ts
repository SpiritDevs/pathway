import { describe, expect, it } from "vite-plus/test";

import { resolveActionPaletteSections } from "../chat/actionPaletteSections";
import {
  reorderActionPaletteSectionGroup,
  setActionPaletteSectionVisibility,
} from "./ActionPaletteSettingsSection";

describe("action palette list updates", () => {
  const defaults = resolveActionPaletteSections([]);

  it("reorders active areas without mixing visibility groups", () => {
    const sections = setActionPaletteSectionVisibility(defaults, "usage", false);
    const reordered = reorderActionPaletteSectionGroup(
      sections,
      true,
      "development-environments",
      "workspace",
    );

    expect(
      reordered
        .filter(({ visible }) => visible)
        .map(({ id }) => id)
        .slice(0, 3),
    ).toEqual(["development-environments", "workspace", "actions"]);
    expect(reordered.at(-1)).toMatchObject({ id: "usage", visible: false });
  });

  it("reorders inactive areas independently", () => {
    const withInactive = setActionPaletteSectionVisibility(
      setActionPaletteSectionVisibility(defaults, "usage", false),
      "actions",
      false,
    );
    const reordered = reorderActionPaletteSectionGroup(withInactive, false, "actions", "usage");

    expect(reordered.filter(({ visible }) => !visible).map(({ id }) => id)).toEqual([
      "actions",
      "usage",
    ]);
  });

  it("moves a disabled area to the end of Inactive", () => {
    const sections = setActionPaletteSectionVisibility(defaults, "usage", false);

    expect(sections.filter(({ visible }) => visible).some(({ id }) => id === "usage")).toBe(false);
    expect(sections.at(-1)).toMatchObject({ id: "usage", visible: false });
  });

  it("moves an enabled area to the end of Active", () => {
    const disabled = setActionPaletteSectionVisibility(defaults, "usage", false);
    const enabled = setActionPaletteSectionVisibility(disabled, "usage", true);
    const active = enabled.filter(({ visible }) => visible);

    expect(active.at(-1)).toMatchObject({ id: "usage", visible: true });
    expect(enabled.filter(({ visible }) => !visible)).toEqual([]);
  });

  it("ignores drops outside the selected visibility group", () => {
    const sections = setActionPaletteSectionVisibility(defaults, "usage", false);

    expect(reorderActionPaletteSectionGroup(sections, true, "workspace", "usage")).toBe(sections);
  });
});
