import type { EnvironmentId, ProjectInspectDirectoryResult } from "@spiritdevs/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  canCreateProjectRepository,
  createProjectTitle,
  inspectProjectFolder,
  planCreateProject,
  projectFolderRepositoryError,
  repositoryNameFromProjectName,
  type CreateProjectDraft,
} from "./createProject.logic";

const LAPTOP = "laptop" as EnvironmentId;
const STUDIO = "studio" as EnvironmentId;
const NO_GIT = { repositoryIdentity: null, repositoryRoot: null };
const repository = (name: string): ProjectInspectDirectoryResult => ({
  repositoryRoot: `/code/${name}`,
  repositoryIdentity: {
    canonicalKey: `github.com/spiritdevs/${name}`,
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: `https://github.com/spiritdevs/${name}.git`,
    },
  },
});
const draft = (overrides: Partial<CreateProjectDraft> = {}): CreateProjectDraft => ({
  name: "",
  createRepository: false,
  folders: [],
  newRepository: { owner: "", name: "", visibility: "private" },
  ...overrides,
});
const folder = (
  environmentId: EnvironmentId,
  path: string,
  createIfMissing = false,
  inspection: ProjectInspectDirectoryResult | null = NO_GIT,
) => ({ key: `${environmentId}:${path}`, environmentId, path, createIfMissing, inspection });
const plan = (value: CreateProjectDraft, occupied: readonly string[] = []) =>
  planCreateProject({
    draft: value,
    platformFor: () => "MacIntel",
    occupiedWorkspaceRootsFor: () => occupied,
  });

describe("create project planning", () => {
  it("detects Git in a new folder's parent", async () => {
    const inspect = vi.fn().mockResolvedValueOnce(NO_GIT).mockResolvedValueOnce(repository("boca"));
    const attached = await inspectProjectFolder(folder(LAPTOP, "/code/boca/new/", true), inspect);
    expect(attached.inspection).toEqual(repository("boca"));
    expect(inspect.mock.calls).toEqual([["/code/boca/new/"], ["/code/boca/"]]);
    expect(canCreateProjectRepository([attached])).toBe(false);
  });

  it("detects a repository created in a pending new directory before submission", async () => {
    const inspect = vi.fn().mockResolvedValue(repository("other"));
    const attached = await inspectProjectFolder(folder(STUDIO, "/work/new", true), inspect);
    expect(inspect).toHaveBeenCalledExactlyOnceWith("/work/new");
    expect(
      projectFolderRepositoryError([
        folder(LAPTOP, "/code/boca", false, repository("boca")),
        attached,
      ]),
    ).not.toBeNull();
  });

  it("does not treat inspection failures or unknown Git status as a plain folder", async () => {
    const selected = folder(LAPTOP, "/code/boca");
    await expect(
      inspectProjectFolder(selected, async () => {
        throw new Error("Disconnected");
      }),
    ).rejects.toThrow("Disconnected");
    await expect(
      inspectProjectFolder(selected, async () => ({ repositoryIdentity: null })),
    ).rejects.toThrow("Update Pathway");
  });

  it("names the project after the first attached folder until a name is typed", () => {
    expect(createProjectTitle({ name: "", folders: [folder(LAPTOP, "~/", false, null)] })).toBe("");
    expect(createProjectTitle({ name: "", folders: [folder(LAPTOP, "/code/boca/")] })).toBe("boca");
    expect(createProjectTitle({ name: " Boca ", folders: [folder(LAPTOP, "/code/boca")] })).toBe(
      "Boca",
    );
  });

  it("allows a folder-less project but rejects two folders on one environment", () => {
    expect(plan(draft({ name: "Planning" }))).toMatchObject({ kind: "create", folders: [] });
    expect(
      plan(draft({ folders: [folder(LAPTOP, "/code/a"), folder(LAPTOP, "/code/b")] })),
    ).toEqual({
      kind: "invalid",
      message: "Each environment can hold one folder for a project.",
    });
    expect(plan(draft({ folders: [folder(LAPTOP, "/code/a")] }), ["/code/a"])).toEqual({
      kind: "invalid",
      message: "Another project already uses this directory.",
    });
  });

  it("requires attachment even when a name and directory have been typed", () => {
    const folders = [folder(LAPTOP, "/code/a", false, null)];
    expect(plan(draft({ name: "A", folders }))).toEqual({ kind: "incomplete" });
    expect(canCreateProjectRepository(folders)).toBe(false);
  });

  it("links one folder per environment and creates missing plain folders", () => {
    expect(
      plan(
        draft({
          folders: [folder(LAPTOP, "/code/boca", true), folder(STUDIO, "/work/boca", true)],
        }),
      ),
    ).toMatchObject({
      kind: "create",
      title: "boca",
      source: { kind: "folders" },
      folders: [
        { environmentId: LAPTOP, workspaceRoot: "/code/boca", createIfMissing: true },
        { environmentId: STUDIO, workspaceRoot: "/work/boca", createIfMissing: true },
      ],
    });
  });

  it("offers repository creation only when every attached folder is known to have no Git", () => {
    const plain = folder(LAPTOP, "/code/boca");
    expect(canCreateProjectRepository([])).toBe(false);
    expect(canCreateProjectRepository([plain])).toBe(true);
    expect(canCreateProjectRepository([plain, folder(STUDIO, "/work/boca", false, null)])).toBe(
      false,
    );
    expect(
      canCreateProjectRepository([plain, folder(STUDIO, "/work/boca", false, repository("boca"))]),
    ).toBe(false);
    expect(
      canCreateProjectRepository([
        folder(LAPTOP, "/local", false, { repositoryRoot: "/local", repositoryIdentity: null }),
      ]),
    ).toBe(false);
  });

  it("accepts matching checkouts on different environments", () => {
    const folders = [
      folder(LAPTOP, "/code/boca", false, repository("boca")),
      folder(STUDIO, "/work/boca", false, repository("boca")),
    ];
    expect(projectFolderRepositoryError(folders)).toBeNull();
    expect(plan(draft({ folders }))).toMatchObject({ kind: "create", source: { kind: "folders" } });
  });

  it("rejects different repositories, including ones without a remote", () => {
    const first = folder(LAPTOP, "/code/boca", false, repository("boca"));
    for (const inspection of [
      repository("pathway"),
      { repositoryRoot: "/local", repositoryIdentity: null },
    ]) {
      const folders = [first, folder(STUDIO, "/work/other", false, inspection)];
      expect(projectFolderRepositoryError(folders)).toContain("only use one Git repository");
      expect(plan(draft({ folders }))).toMatchObject({ kind: "invalid" });
    }
  });

  it("does not create another repository when Git is detected in a later folder", () => {
    const folders = [
      folder(LAPTOP, "/plain"),
      folder(STUDIO, "/code/boca", false, repository("boca")),
    ];
    expect(plan(draft({ folders, createRepository: true }))).toMatchObject({
      kind: "create",
      source: { kind: "folders" },
    });
  });

  it("derives one new repository from the name and lets repository setup create the folders", () => {
    const folders = [folder(LAPTOP, "/code/boca", true), folder(STUDIO, "/work/boca", true)];
    expect(
      plan(
        draft({
          createRepository: true,
          name: "Boca Site",
          folders,
          newRepository: { owner: "spiritdevs", name: "", visibility: "public" },
        }),
      ),
    ).toMatchObject({
      source: { kind: "new_repo", repository: "spiritdevs/boca-site", visibility: "public" },
      folders: [{ createIfMissing: false }, { createIfMissing: false }],
    });
    expect(plan(draft({ createRepository: true, folders }))).toEqual({ kind: "incomplete" });
    expect(repositoryNameFromProjectName("  My App (v2)! ")).toBe("my-app-v2");
  });
});
