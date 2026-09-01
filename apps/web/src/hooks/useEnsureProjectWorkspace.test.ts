import { EnvironmentId, ProjectId } from "@spiritdevs/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { scratchWorkspaceRoot } from "../components/projects/projectWorkspace.logic";
import { ensureProjectWorkspaceRoot } from "./useEnsureProjectWorkspace";

const project = {
  environmentId: EnvironmentId.make("environment-1"),
  id: ProjectId.make("project-1"),
  title: "Pathway",
  workspaceRoot: null,
};

describe("ensureProjectWorkspaceRoot", () => {
  it("returns an existing workspace without writing", async () => {
    const attachDirectory = vi.fn();
    await expect(
      ensureProjectWorkspaceRoot({
        project: { ...project, workspaceRoot: "/code/pathway" },
        attachDirectory,
      }),
    ).resolves.toBe("/code/pathway");
    expect(attachDirectory).not.toHaveBeenCalled();
  });

  it("provisions a scratch workspace for a rootless project", async () => {
    const attachDirectory = vi.fn().mockResolvedValue({ ok: true, value: "/unused" });
    const workspaceRoot = scratchWorkspaceRoot(project);

    await expect(ensureProjectWorkspaceRoot({ project, attachDirectory })).resolves.toBe(
      workspaceRoot,
    );
    expect(attachDirectory).toHaveBeenCalledWith({
      environmentId: project.environmentId,
      projectId: project.id,
      plan: {
        kind: "attach",
        workspaceRoot,
        createWorkspaceRootIfMissing: true,
        initializeGit: false,
      },
    });
  });
});
