import { describe, expect, it } from "vite-plus/test";

import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import {
  attachProjectDirectoryUpdateInput,
  EMPTY_ATTACH_PROJECT_DIRECTORY_DRAFT,
  EMPTY_QUICK_CREATE_PROJECT_DRAFT,
  ensureProjectWorkspaceDecision,
  planAttachProjectDirectory,
  planQuickCreateProject,
  projectWorkspaceCwd,
  projectWorkspaceLabel,
  projectWorkspaceRuntimeEnv,
  resolveEnsuredWorkspaceRoot,
  shouldInitializeGitBeforeAttach,
  type AttachProjectDirectoryPlan,
  type ProjectWorkspaceTarget,
} from "./projectWorkspace.logic";

const MAC = "MacIntel";

function project(workspaceRoot: string | null): ProjectWorkspaceTarget {
  return {
    environmentId: "env-1" as EnvironmentId,
    id: "proj-1" as ProjectId,
    title: "Tracker",
    workspaceRoot,
  };
}

describe("ensureProjectWorkspaceDecision", () => {
  it("reports a rooted project as ready", () => {
    expect(ensureProjectWorkspaceDecision(project("/code/tracker"))).toEqual({
      kind: "ready",
      workspaceRoot: "/code/tracker",
    });
  });

  it("prompts for a rootless project, carrying the project so the caller stays a one-liner", () => {
    const decision = ensureProjectWorkspaceDecision(project(null));
    expect(decision.kind).toBe("prompt");
    expect(decision.kind === "prompt" && decision.project.id).toBe("proj-1");
  });

  it("treats a whitespace-only root as absent rather than as a path", () => {
    expect(ensureProjectWorkspaceDecision(project("   ")).kind).toBe("prompt");
  });

  it("is unavailable — not a prompt — when there is no project to prompt about", () => {
    expect(ensureProjectWorkspaceDecision(null)).toEqual({ kind: "unavailable" });
    expect(ensureProjectWorkspaceDecision(undefined)).toEqual({ kind: "unavailable" });
  });
});

describe("projectWorkspaceCwd", () => {
  it("prefers the worktree, falls back to the root, and answers null for neither", () => {
    expect(projectWorkspaceCwd({ workspaceRoot: "/root", worktreePath: "/wt" })).toBe("/wt");
    expect(projectWorkspaceCwd({ workspaceRoot: "/root", worktreePath: null })).toBe("/root");
    expect(projectWorkspaceCwd({ workspaceRoot: null })).toBeNull();
  });
});

describe("projectWorkspaceRuntimeEnv", () => {
  it("exports the project root when there is one", () => {
    expect(
      projectWorkspaceRuntimeEnv({ workspaceRoot: "/root", cwd: "/wt", worktreePath: "/wt" }),
    ).toEqual({ PATHWAY_PROJECT_ROOT: "/root", PATHWAY_WORKTREE_PATH: "/wt" });
  });

  it("falls back to the cwd rather than exporting an empty root", () => {
    expect(projectWorkspaceRuntimeEnv({ workspaceRoot: null, cwd: "/just/attached" })).toEqual({
      PATHWAY_PROJECT_ROOT: "/just/attached",
    });
  });

  it("lets extra env win, matching projectScriptRuntimeEnv", () => {
    expect(
      projectWorkspaceRuntimeEnv({
        workspaceRoot: "/root",
        cwd: "/root",
        extraEnv: { PATHWAY_PROJECT_ROOT: "/override", EXTRA: "1" },
      }),
    ).toEqual({ PATHWAY_PROJECT_ROOT: "/override", EXTRA: "1" });
  });
});

describe("projectWorkspaceLabel", () => {
  it("falls back to the title so a rootless row is never blank", () => {
    expect(projectWorkspaceLabel({ title: "Tracker", workspaceRoot: null })).toBe("Tracker");
    expect(projectWorkspaceLabel({ title: "Tracker", workspaceRoot: "/code" })).toBe("/code");
  });
});

describe("planAttachProjectDirectory", () => {
  const base = {
    platform: MAC,
    currentProjectCwd: null,
  };

  it("is incomplete, not invalid, before anything is typed", () => {
    expect(
      planAttachProjectDirectory({ ...base, draft: EMPTY_ATTACH_PROJECT_DIRECTORY_DRAFT }),
    ).toEqual({ kind: "incomplete" });
  });

  it("resolves a path and carries the create flag through", () => {
    expect(
      planAttachProjectDirectory({
        ...base,
        draft: { path: "/code/tracker/", createIfMissing: true, initializeGit: true },
      }),
    ).toEqual({
      kind: "attach",
      workspaceRoot: "/code/tracker",
      createWorkspaceRootIfMissing: true,
      initializeGit: true,
    });
  });

  it("rejects a Windows path off Windows before the dispatch can fail", () => {
    const plan = planAttachProjectDirectory({
      ...base,
      draft: { path: "C:\\code", createIfMissing: false, initializeGit: false },
    });
    expect(plan.kind).toBe("invalid");
  });

  it("rejects a relative path with nothing to resolve it against", () => {
    expect(
      planAttachProjectDirectory({
        ...base,
        draft: { path: "./sub", createIfMissing: false, initializeGit: false },
      }),
    ).toEqual({ kind: "invalid", message: "Relative paths require an active project." });
  });

  it("accepts the same relative path once an active project can anchor it", () => {
    const plan = planAttachProjectDirectory({
      platform: MAC,
      currentProjectCwd: "/code/other",
      draft: { path: "./sub", createIfMissing: false, initializeGit: false },
    });
    expect(plan.kind).toBe("attach");
  });

  it("refuses a root another active project already holds", () => {
    expect(
      planAttachProjectDirectory({
        ...base,
        draft: { path: "/code/taken", createIfMissing: false, initializeGit: false },
        occupiedWorkspaceRoots: ["/code/taken"],
      }),
    ).toEqual({ kind: "invalid", message: "Another project already uses this directory." });
  });
});

describe("attachProjectDirectoryUpdateInput", () => {
  it("omits the create flag when false, since the field is optional on the wire", () => {
    expect(
      attachProjectDirectoryUpdateInput({
        projectId: "proj-1" as ProjectId,
        workspaceRoot: "/code",
        createWorkspaceRootIfMissing: false,
      }),
    ).toEqual({ projectId: "proj-1", workspaceRoot: "/code" });
  });

  it("sends it when true", () => {
    expect(
      attachProjectDirectoryUpdateInput({
        projectId: "proj-1" as ProjectId,
        workspaceRoot: "/code",
        createWorkspaceRootIfMissing: true,
      }),
    ).toEqual({
      projectId: "proj-1",
      workspaceRoot: "/code",
      createWorkspaceRootIfMissing: true,
    });
  });
});

describe("shouldInitializeGitBeforeAttach", () => {
  it("only fires for a valid plan that asked for it", () => {
    const attach: AttachProjectDirectoryPlan = {
      kind: "attach",
      workspaceRoot: "/code",
      createWorkspaceRootIfMissing: false,
      initializeGit: true,
    };
    expect(shouldInitializeGitBeforeAttach(attach)).toBe(true);
    expect(shouldInitializeGitBeforeAttach({ ...attach, initializeGit: false })).toBe(false);
    expect(shouldInitializeGitBeforeAttach({ kind: "incomplete" })).toBe(false);
  });
});

describe("planQuickCreateProject", () => {
  const base = { platform: MAC, currentProjectCwd: null };

  it("is incomplete while both the name and the collapsed section are empty", () => {
    expect(planQuickCreateProject({ ...base, draft: EMPTY_QUICK_CREATE_PROJECT_DRAFT })).toEqual({
      kind: "incomplete",
    });
  });

  it("creates rootless from a name alone — the whole point of the dialog", () => {
    expect(
      planQuickCreateProject({ ...base, draft: { name: "  Tracker  ", directory: null } }),
    ).toEqual({
      kind: "create",
      title: "Tracker",
      workspaceRoot: null,
      createWorkspaceRootIfMissing: false,
      initializeGit: false,
    });
  });

  it("stays incomplete when the directory section is open but empty, rather than silently creating rootless", () => {
    expect(
      planQuickCreateProject({
        ...base,
        draft: { name: "Tracker", directory: EMPTY_ATTACH_PROJECT_DIRECTORY_DRAFT },
      }),
    ).toEqual({ kind: "incomplete" });
  });

  it("creates rooted when both are filled in", () => {
    expect(
      planQuickCreateProject({
        ...base,
        draft: {
          name: "Tracker",
          directory: { path: "/code/tracker", createIfMissing: true, initializeGit: true },
        },
      }),
    ).toEqual({
      kind: "create",
      title: "Tracker",
      workspaceRoot: "/code/tracker",
      createWorkspaceRootIfMissing: true,
      initializeGit: true,
    });
  });

  it("names the project after the directory when only a directory was given", () => {
    const plan = planQuickCreateProject({
      ...base,
      draft: {
        name: "",
        directory: { path: "/code/tracker", createIfMissing: false, initializeGit: false },
      },
    });
    expect(plan).toMatchObject({ kind: "create", title: "tracker" });
  });

  it("surfaces the directory validation error rather than creating a nameless project", () => {
    expect(
      planQuickCreateProject({
        ...base,
        draft: {
          name: "Tracker",
          directory: { path: "C:\\code", createIfMissing: false, initializeGit: false },
        },
      }).kind,
    ).toBe("invalid");
  });
});

describe("resolveEnsuredWorkspaceRoot", () => {
  it("prefers a root that already exists over a late dialog answer", () => {
    expect(
      resolveEnsuredWorkspaceRoot({
        workspaceRoot: "/already/there",
        promptResult: { workspaceRoot: "/from/dialog" },
      }),
    ).toBe("/already/there");
  });

  it("uses the prompt result when there was no root", () => {
    expect(
      resolveEnsuredWorkspaceRoot({
        workspaceRoot: null,
        promptResult: { workspaceRoot: "/from/dialog" },
      }),
    ).toBe("/from/dialog");
  });

  it("answers null on a cancel, which every call site reads as do-nothing", () => {
    expect(resolveEnsuredWorkspaceRoot({ workspaceRoot: null, promptResult: null })).toBeNull();
  });
});
