import { EnvironmentId, ProjectId } from "@spiritdevs/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { ensureProjectWorkspaceRoot } from "./useEnsureProjectWorkspace";

const project = {
  environmentId: EnvironmentId.make("environment-1"),
  id: ProjectId.make("project-1"),
  title: "Pathway",
  workspaceRoot: null,
};

describe("ensureProjectWorkspaceRoot", () => {
  it("returns an existing workspace without writing", async () => {
    const provisionWorkspace = vi.fn();
    await expect(
      ensureProjectWorkspaceRoot({
        project: { ...project, workspaceRoot: "/code/pathway" },
        provisionWorkspace,
      }),
    ).resolves.toBe("/code/pathway");
    expect(provisionWorkspace).not.toHaveBeenCalled();
  });

  it("provisions a scratch workspace for a rootless project", async () => {
    const provisionWorkspace = vi.fn().mockResolvedValue("/server/userdata/project-workspaces/id");
    const workspaceRoot = "/server/userdata/project-workspaces/id";

    await expect(ensureProjectWorkspaceRoot({ project, provisionWorkspace })).resolves.toBe(
      workspaceRoot,
    );
    expect(provisionWorkspace).toHaveBeenCalledWith(project);
  });
});
