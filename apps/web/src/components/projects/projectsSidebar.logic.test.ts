import { describe, expect, it } from "vite-plus/test";

import { projectKeyFromProjectsPathname } from "./projectsSidebar.logic";

describe("projectKeyFromProjectsPathname", () => {
  it("reads and decodes a project dashboard route", () => {
    expect(projectKeyFromProjectsPathname("/projects/pathway%20desktop")).toBe("pathway desktop");
  });

  it("ignores the projects index, nested paths, and invalid encoding", () => {
    expect(projectKeyFromProjectsPathname("/projects")).toBeNull();
    expect(projectKeyFromProjectsPathname("/projects/pathway/settings")).toBeNull();
    expect(projectKeyFromProjectsPathname("/projects/%E0%A4%A")).toBeNull();
  });
});
