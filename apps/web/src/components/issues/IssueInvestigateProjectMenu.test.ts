import { describe, expect, it } from "vite-plus/test";
import type { EnvironmentProject } from "@spiritdevs/client-runtime/state/models";
import { EnvironmentId, ProjectId } from "@spiritdevs/contracts";

import { directInvestigateProjectId } from "./IssueInvestigateProjectMenu";

const environmentId = EnvironmentId.make("environment-investigate");
const project = (id: string, workspaceRoot = `/work/${id}`): EnvironmentProject => ({
  id: ProjectId.make(id),
  environmentId,
  title: id,
  workspaceRoot,
  repositoryIdentity: null,
  faviconPath: null,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-08-17T00:00:00.000Z",
  updatedAt: "2026-08-17T00:00:00.000Z",
});

describe("directInvestigateProjectId", () => {
  const alpha = project("alpha");
  const beta = project("beta");

  it("uses the issue's selected project without opening a chooser", () => {
    expect(directInvestigateProjectId([alpha, beta], beta.id)).toBe(beta.id);
  });

  it("uses the only eligible project when the issue has none", () => {
    expect(directInvestigateProjectId([alpha], null)).toBe(alpha.id);
  });

  it("uses the only eligible project when the assigned project cannot investigate", () => {
    expect(directInvestigateProjectId([alpha], ProjectId.make("rootless"))).toBe(alpha.id);
  });

  it("keeps the chooser for multiple unassigned projects", () => {
    expect(directInvestigateProjectId([alpha, beta], null)).toBeNull();
  });
});
