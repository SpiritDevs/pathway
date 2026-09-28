import { describe, expect, it } from "vite-plus/test";

import { issuesSidebarProjects } from "./issuesSidebarProjects.logic";

const project = (id: string, archived = false) => ({
  id,
  title: id,
  projectIds: [id, `${id}-alias`],
  archived,
});

const PROJECTS = [
  project("alpha"),
  project("boca"),
  project("empty"),
  project("pinned-empty"),
  project("old", true),
];

const titles = (projects: ReadonlyArray<{ readonly title: string }>) =>
  projects.map(({ title }) => title);

describe("issuesSidebarProjects", () => {
  const base = {
    projects: PROJECTS,
    pinnedIds: ["pinned-empty", "boca"],
    // Counted through an alias: a task may name any id the logical project answers to.
    issueCounts: new Map([
      ["alpha-alias", 2],
      ["boca", 1],
      ["old", 5],
    ]),
    isActive: () => false,
    query: "",
    showAll: false,
  };

  it("lists projects with tasks, pins whatever is pinned, and holds back the rest", () => {
    const result = issuesSidebarProjects(base);

    expect(titles(result.pinned)).toEqual(["boca", "pinned-empty"]);
    expect(titles(result.listed)).toEqual(["alpha"]);
    expect(result.hiddenCount).toBe(1);
    expect(titles(result.archived)).toEqual(["old"]);
  });

  it("keeps the filtered project listed and shows everything on request or search", () => {
    expect(
      titles(issuesSidebarProjects({ ...base, isActive: (p) => p.id === "empty" }).listed),
    ).toEqual(["alpha", "empty"]);
    expect(titles(issuesSidebarProjects({ ...base, showAll: true }).listed)).toEqual([
      "alpha",
      "empty",
    ]);
    const searched = issuesSidebarProjects({ ...base, query: " EMP " });
    expect(titles(searched.pinned)).toEqual(["pinned-empty"]);
    expect(titles(searched.listed)).toEqual(["empty"]);
    expect(searched.hiddenCount).toBe(0);
  });
});
