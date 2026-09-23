/**
 * Planning for the Create project dialog: one project, any number of environment folders, and an
 * optional repository shared by all of them.
 *
 * A new repository is created once, on the first folder's environment, and every other folder
 * clones it. Creating a repository per environment would leave unrelated histories to reconcile.
 *
 * @module components/projects/createProject.logic
 */
import { inferProjectTitleFromPath } from "@spiritdevs/client-runtime/state/projects";
import type { EnvironmentId } from "@spiritdevs/contracts";
import type { SourceControlRepositoryVisibility } from "@spiritdevs/contracts";

import { planAttachProjectDirectory } from "./projectWorkspace.logic";

export type ProjectSourceMode = "folders" | "clone" | "new_repo";

export interface ProjectFolderDraft {
  /** Stable React key; rows can be removed from the middle. */
  readonly key: string;
  readonly environmentId: EnvironmentId | null;
  readonly path: string;
  /** Set when the folder browser's Create Directory row was chosen. */
  readonly createIfMissing: boolean;
}

export interface NewRepositoryDraft {
  readonly owner: string;
  /** Empty means "derive from the project name". */
  readonly name: string;
  readonly visibility: SourceControlRepositoryVisibility;
}

export interface CreateProjectDraft {
  readonly name: string;
  readonly mode: ProjectSourceMode;
  readonly folders: ReadonlyArray<ProjectFolderDraft>;
  /** Clone mode: `owner/name` or a Git URL. */
  readonly cloneSource: string;
  readonly newRepository: NewRepositoryDraft;
}

export type CloneSource = { readonly repository: string } | { readonly remoteUrl: string };

export interface PlannedFolder {
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string;
  readonly createIfMissing: boolean;
}

export type CreateProjectPlan =
  | { readonly kind: "incomplete" }
  | { readonly kind: "invalid"; readonly message: string }
  | {
      readonly kind: "create";
      readonly title: string;
      readonly folders: ReadonlyArray<PlannedFolder>;
      readonly source:
        | { readonly kind: "folders" }
        | { readonly kind: "clone"; readonly clone: CloneSource }
        | {
            readonly kind: "new_repo";
            readonly repository: string;
            readonly visibility: SourceControlRepositoryVisibility;
          };
    };

const OWNER_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*)\/[A-Za-z0-9._-]+$/;

/** `owner/name` targets the provider; anything URL-shaped is cloned as given. */
export function parseCloneSource(input: string): CloneSource | null {
  const value = input.trim().replace(/\.git$/, "");
  if (value.length === 0) return null;
  if (/^(?:[a-z+]+:\/\/|git@)/i.test(input.trim())) return { remoteUrl: input.trim() };
  return OWNER_NAME.test(value) ? { repository: value } : null;
}

/** GitHub-safe repository name derived from a project name. */
export function repositoryNameFromProjectName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 100);
}

/** The typed name, else the first folder's basename. */
export function createProjectTitle(draft: Pick<CreateProjectDraft, "name" | "folders">): string {
  const typed = draft.name.trim();
  if (typed.length > 0) return typed;
  const firstPath = draft.folders[0]?.path.trim() ?? "";
  return firstPath.length > 0 ? inferProjectTitleFromPath(firstPath.replace(/[\\/]+$/, "")) : "";
}

export function planCreateProject(input: {
  readonly draft: CreateProjectDraft;
  readonly platformFor: (environmentId: EnvironmentId) => string;
  readonly occupiedWorkspaceRootsFor: (environmentId: EnvironmentId) => ReadonlyArray<string>;
}): CreateProjectPlan {
  const { draft } = input;
  const title = createProjectTitle(draft);
  if (draft.mode !== "folders" && draft.folders.length === 0) {
    return { kind: "invalid", message: "Add a folder for the repository." };
  }
  const folders: PlannedFolder[] = [];
  const environments = new Set<EnvironmentId>();
  for (const folder of draft.folders) {
    if (folder.environmentId === null) return { kind: "incomplete" };
    if (environments.has(folder.environmentId)) {
      return { kind: "invalid", message: "Each environment can hold one folder for a project." };
    }
    environments.add(folder.environmentId);
    const attach = planAttachProjectDirectory({
      draft: { path: folder.path, createIfMissing: folder.createIfMissing, initializeGit: false },
      platform: input.platformFor(folder.environmentId),
      currentProjectCwd: null,
      occupiedWorkspaceRoots: input.occupiedWorkspaceRootsFor(folder.environmentId),
    });
    if (attach.kind !== "attach") return attach;
    folders.push({
      environmentId: folder.environmentId,
      workspaceRoot: attach.workspaceRoot,
      // Cloning and creating a repository both make the folder themselves.
      createIfMissing: draft.mode === "folders" ? attach.createWorkspaceRootIfMissing : false,
    });
  }
  if (title.length === 0) return { kind: "incomplete" };

  switch (draft.mode) {
    case "folders":
      return { kind: "create", title, folders, source: { kind: "folders" } };
    case "clone": {
      if (draft.cloneSource.trim().length === 0) return { kind: "incomplete" };
      const clone = parseCloneSource(draft.cloneSource);
      if (clone === null) {
        return { kind: "invalid", message: "Enter a repository as owner/name or a Git URL." };
      }
      return { kind: "create", title, folders, source: { kind: "clone", clone } };
    }
    case "new_repo": {
      const owner = draft.newRepository.owner.trim();
      const name = draft.newRepository.name.trim() || repositoryNameFromProjectName(title);
      if (owner.length === 0 || name.length === 0) return { kind: "incomplete" };
      const repository = `${owner}/${name}`;
      if (!OWNER_NAME.test(repository)) {
        return {
          kind: "invalid",
          message: "Repository names can use letters, numbers, . _ and -.",
        };
      }
      return {
        kind: "create",
        title,
        folders,
        source: { kind: "new_repo", repository, visibility: draft.newRepository.visibility },
      };
    }
  }
}
