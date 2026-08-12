import { describe, expect, it } from "vite-plus/test";

import {
  searchableSetting,
  searchSettings,
  SETTINGS_NAV_GROUPS,
  SETTINGS_SEARCH_ITEMS,
  SETTINGS_SECTION_LABELS,
  type SettingsSearchItem,
} from "./settingsSearch";

const ITEMS: ReadonlyArray<SettingsSearchItem> = [
  {
    id: "word-wrap",
    title: "Word wrap",
    to: "/settings/general",
  },
  {
    id: "network-access",
    title: "Network access",
    to: "/settings/connections",
  },
  {
    id: "providers",
    title: "Providers",
    to: "/settings/providers",
  },
  {
    id: "provider-updates",
    title: "Update checks",
    to: "/settings/general",
  },
  {
    id: "automatic-updates",
    title: "Automatic updates",
    to: "/settings/general",
  },
];

describe("searchSettings", () => {
  it("matches only setting titles", () => {
    expect(searchSettings("word", ITEMS).map((item) => item.id)).toEqual(["word-wrap"]);
    expect(searchSettings("network", ITEMS).map((item) => item.id)).toEqual(["network-access"]);
    expect(searchSettings("connections", ITEMS)).toEqual([]);
    expect(searchSettings("claude", ITEMS)).toEqual([]);
  });

  it("matches normalized title substrings", () => {
    expect(searchSettings("  WORD   WRAP  ", ITEMS).map((item) => item.id)).toEqual(["word-wrap"]);
    expect(searchSettings("glass").map((item) => item.id)).toEqual(["setting-glass-opacity"]);
    expect(searchSettings("xyzzy")).toEqual([]);
  });

  it("keeps catalog order for multiple title matches", () => {
    expect(searchSettings("update", ITEMS).map((item) => item.id)).toEqual([
      "provider-updates",
      "automatic-updates",
    ]);
  });

  it("returns no results for an empty query", () => {
    expect(searchSettings("   ", ITEMS)).toEqual([]);
  });

  it("keeps catalog result ids unique", () => {
    const ids = SETTINGS_SEARCH_ITEMS.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("serves anchor props to panels from the catalog", () => {
    expect(searchableSetting("word-wrap")).toEqual({ id: "word-wrap", title: "Word wrap" });
    expect(searchableSetting("archive")).toEqual({ id: "archive", title: "Archived threads" });
  });

  it("routes appearance settings to their current section", () => {
    expect(searchSettings("theme")[0]).toMatchObject({
      id: "theme",
      to: "/settings/appearance",
    });
    expect(searchSettings("word wrap")[0]).toMatchObject({
      id: "word-wrap",
      to: "/settings/appearance",
    });
    expect(searchSettings("environment identification")[0]).toMatchObject({
      id: "environment-identification",
      to: "/settings/appearance",
      targetId: "appearance",
    });
  });

  it("routes usage analytics to its Settings section", () => {
    expect(searchSettings("usage analytics")[0]).toMatchObject({
      id: "usage",
      to: "/settings/usage",
    });
  });

  it("routes issue settings to their Settings sections", () => {
    expect(searchSettings("issue statuses")[0]).toMatchObject({
      id: "issue-statuses",
      to: "/settings/issues-statuses",
    });
    expect(searchSettings("issue labels")[0]).toMatchObject({
      id: "issue-labels",
      to: "/settings/issues-labels",
    });
    expect(searchSettings("import issues")[0]).toMatchObject({
      id: "issue-import",
      to: "/settings/issues-import",
    });
  });
});

describe("SETTINGS_NAV_GROUPS", () => {
  const groupedPaths = SETTINGS_NAV_GROUPS.flatMap((group) => group.paths);

  it("places every settings section in exactly one group", () => {
    expect([...groupedPaths].sort()).toEqual(Object.keys(SETTINGS_SECTION_LABELS).sort());
  });

  it("keeps the record in sidebar order", () => {
    expect(groupedPaths).toEqual(Object.keys(SETTINGS_SECTION_LABELS));
  });

  it("groups the tracker pages under Issues", () => {
    expect(SETTINGS_NAV_GROUPS.map((group) => group.label)).toEqual([
      "Workspace",
      "Agents",
      "Issues",
      "System",
    ]);
    expect(SETTINGS_NAV_GROUPS.find((group) => group.label === "Issues")?.paths).toEqual([
      "/settings/issues-statuses",
      "/settings/issues-labels",
      "/settings/issues-import",
      "/settings/issues-enrichment",
    ]);
  });
});
