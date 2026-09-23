import type { EnvironmentId } from "@spiritdevs/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  createProjectTitle,
  parseCloneSource,
  planCreateProject,
  repositoryNameFromProjectName,
  type CreateProjectDraft,
} from "./createProject.logic";

const LAPTOP = "laptop" as EnvironmentId;
const STUDIO = "studio" as EnvironmentId;

const draft = (overrides: Partial<CreateProjectDraft> = {}): CreateProjectDraft => ({
  name: "",
  mode: "folders",
  folders: [],
  cloneSource: "",
  newRepository: { owner: "", name: "", visibility: "private" },
  ...overrides,
});
const folder = (environmentId: EnvironmentId, path: string, createIfMissing = false) => ({
  key: `${environmentId}:${path}`,
  environmentId,
  path,
  createIfMissing,
});
const plan = (value: CreateProjectDraft, occupied: readonly string[] = []) =>
  planCreateProject({
    draft: value,
    platformFor: () => "MacIntel",
    occupiedWorkspaceRootsFor: () => occupied,
  });

describe("create project planning", () => {
  it("names the project after the first folder until a name is typed", () => {
    expect(createProjectTitle({ name: "", folders: [folder(LAPTOP, "/code/boca/")] })).toBe("boca");
    expect(createProjectTitle({ name: " Boca ", folders: [folder(LAPTOP, "/code/boca")] })).toBe(
      "Boca",
    );
  });

  it("allows a folder-less project but rejects two folders on one environment", () => {
    expect(plan(draft({ name: "Planning" }))).toMatchObject({ kind: "create", folders: [] });
    expect(
      plan(draft({ folders: [folder(LAPTOP, "/code/a"), folder(LAPTOP, "/code/b")] })),
    ).toEqual({ kind: "invalid", message: "Each environment can hold one folder for a project." });
    expect(plan(draft({ folders: [folder(LAPTOP, "/code/a")] }), ["/code/a"])).toEqual({
      kind: "invalid",
      message: "Another project already uses this directory.",
    });
  });

  it("links one folder per environment and keeps Create Directory only for plain folders", () => {
    const folders = [folder(LAPTOP, "/code/boca", true), folder(STUDIO, "/work/boca", true)];
    expect(plan(draft({ folders }))).toMatchObject({
      kind: "create",
      title: "boca",
      folders: [
        { environmentId: LAPTOP, workspaceRoot: "/code/boca", createIfMissing: true },
        { environmentId: STUDIO, workspaceRoot: "/work/boca", createIfMissing: true },
      ],
    });
    expect(plan(draft({ mode: "clone", cloneSource: "spiritdevs/boca", folders }))).toMatchObject({
      source: { kind: "clone", clone: { repository: "spiritdevs/boca" } },
      folders: [{ createIfMissing: false }, { createIfMissing: false }],
    });
  });

  it("derives a new repository from the project name and requires a folder", () => {
    expect(plan(draft({ mode: "new_repo", name: "Boca Site" }))).toEqual({
      kind: "invalid",
      message: "Add a folder for the repository.",
    });
    expect(
      plan(
        draft({
          mode: "new_repo",
          name: "Boca Site",
          folders: [folder(LAPTOP, "/code/boca")],
          newRepository: { owner: "spiritdevs", name: "", visibility: "public" },
        }),
      ),
    ).toMatchObject({
      source: { kind: "new_repo", repository: "spiritdevs/boca-site", visibility: "public" },
    });
  });

  it("parses clone sources and repository names", () => {
    expect(parseCloneSource("spiritdevs/boca.git")).toEqual({ repository: "spiritdevs/boca" });
    expect(parseCloneSource("git@github.com:spiritdevs/boca.git")).toEqual({
      remoteUrl: "git@github.com:spiritdevs/boca.git",
    });
    expect(parseCloneSource("https://gitlab.com/a/b")).toEqual({
      remoteUrl: "https://gitlab.com/a/b",
    });
    expect(parseCloneSource("not a repo")).toBeNull();
    expect(repositoryNameFromProjectName("  My App (v2)! ")).toBe("my-app-v2");
  });
});
