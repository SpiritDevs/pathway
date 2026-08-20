import { describe, expect, it } from "vite-plus/test";

import {
  canResizeNewIssueDialog,
  issueProjectsForCompany,
  resolveAvailableIssueProjectId,
  resolveIssueProjectOptionId,
} from "./newIssueDialog.logic";

describe("new issue dialog sizing", () => {
  it("offers resizing when the compact dialog is shorter than the 90% viewport cap", () => {
    expect(canResizeNewIssueDialog({ dialogHeight: 260, viewportHeight: 1_000 })).toBe(true);
  });

  it("hides resizing when content has already grown the dialog to its cap", () => {
    expect(canResizeNewIssueDialog({ dialogHeight: 900, viewportHeight: 1_000 })).toBe(false);
  });

  it("ignores sub-pixel differences at the cap", () => {
    expect(canResizeNewIssueDialog({ dialogHeight: 899.5, viewportHeight: 1_000 })).toBe(false);
  });
});

describe("new issue project selection", () => {
  const projects = [{ id: "cloud-project" }];

  it("keeps a project replicated by the active tracker", () => {
    expect(resolveAvailableIssueProjectId("cloud-project", projects)).toBe("cloud-project");
  });

  it("drops an environment-local project that is absent from the cloud tracker", () => {
    expect(resolveAvailableIssueProjectId("local-project", projects)).toBeNull();
  });

  it("maps a physical checkout to its logical project choice", () => {
    expect(
      resolveIssueProjectOptionId("remote-pathway", [
        {
          id: "cloud-pathway",
          projectIds: ["local-pathway", "remote-pathway"],
        },
      ]),
    ).toBe("cloud-pathway");
  });
});

describe("new issue dialog project destinations", () => {
  const acmeOnly = { id: "project-acme", title: "Acme app", companyIds: ["company-acme"] };
  const boltOnly = { id: "project-bolt", title: "Bolt app", companyIds: ["company-bolt"] };
  const shared = {
    id: "project-shared",
    title: "Shared tooling",
    companyIds: ["company-acme", "company-bolt"],
  };
  const local = { id: "project-local", title: "Scratch checkout", companyIds: [] };
  const projects = [acmeOnly, boltOnly, shared, local];

  it("shows every project when no company has been chosen", () => {
    expect(issueProjectsForCompany(projects, null)).toEqual(projects);
  });

  it("narrows to one company, including projects that company shares", () => {
    expect(issueProjectsForCompany(projects, "company-acme")).toEqual([acmeOnly, shared, local]);
  });

  it("keeps a project with no known owner rather than emptying the menu", () => {
    // A local checkout seen before any company replica loads has no provenance. Filtering it out
    // hid every project in the picker whenever the persisted company had no live replica.
    expect(issueProjectsForCompany([local], "company-acme")).toEqual([local]);
  });
});
