import { describe, expect, it } from "vite-plus/test";

import {
  ACTION_PALETTE_SECTION_DEFINITIONS,
  actionPalettePreferencesFromResolved,
  isDefaultActionPaletteConfiguration,
  resolveActionPaletteSections,
} from "./actionPaletteSections";

describe("action palette section registry", () => {
  it("resolves existing users to today's visible default order", () => {
    const sections = resolveActionPaletteSections([]);

    expect(sections.map(({ id }) => id)).toEqual([
      "workspace",
      "actions",
      "usage",
      "development-environments",
      "terminals",
      "issues",
      "version-control",
      "automations",
      "chats",
      "lineage",
    ]);
    expect(sections.every(({ visible }) => visible)).toBe(true);
    expect(isDefaultActionPaletteConfiguration(sections)).toBe(true);
  });

  it("keeps persisted visibility and ordering", () => {
    const sections = resolveActionPaletteSections([
      { id: "lineage", visible: true },
      { id: "workspace", visible: true },
      { id: "development-environments", visible: false },
      { id: "actions", visible: true },
      { id: "usage", visible: true },
      { id: "terminals", visible: true },
      { id: "issues", visible: true },
      { id: "version-control", visible: true },
      { id: "automations", visible: true },
      { id: "chats", visible: true },
    ]);

    expect(sections.map(({ id }) => id)).toEqual([
      "lineage",
      "workspace",
      "development-environments",
      "actions",
      "usage",
      "terminals",
      "issues",
      "version-control",
      "automations",
      "chats",
    ]);
    expect(sections.find(({ id }) => id === "development-environments")?.visible).toBe(false);
    expect(isDefaultActionPaletteConfiguration(sections)).toBe(false);
  });

  it("ignores unknown and duplicate ids without losing registered sections", () => {
    const sections = resolveActionPaletteSections([
      { id: "removed-section", visible: false },
      { id: "usage", visible: false },
      { id: "usage", visible: true },
    ]);

    expect(sections).toHaveLength(ACTION_PALETTE_SECTION_DEFINITIONS.length);
    expect(sections.some(({ id }) => id === ("removed-section" as never))).toBe(false);
    expect(sections.find(({ id }) => id === "usage")?.visible).toBe(false);
  });

  it("inserts sections missing from older preferences at their default position", () => {
    const preferences = actionPalettePreferencesFromResolved(
      resolveActionPaletteSections([]),
    ).filter(({ id }) => id !== "terminals");
    const sections = resolveActionPaletteSections(preferences);

    expect(sections.map(({ id }) => id).slice(2, 6)).toEqual([
      "usage",
      "development-environments",
      "terminals",
      "issues",
    ]);
  });
});
