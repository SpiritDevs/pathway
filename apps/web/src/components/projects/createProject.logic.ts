/**
 * Planning for New project: one folder per environment and one shared Git repository.
 * Folder inspection decides whether repository creation is available.
 *
 * @module components/projects/createProject.logic
 */
import {
  getBrowseParentPath,
  inferProjectTitleFromPath,
} from "@spiritdevs/client-runtime/state/projects";
import type {
  EnvironmentId,
  ProjectInspectDirectoryResult,
  SourceControlRepositoryVisibility,
} from "@spiritdevs/contracts";

import { planAttachProjectDirectory } from "./projectWorkspace.logic";

export interface ProjectFolderDraft {
  /** Stable React key; rows can be removed from the middle. */
  readonly key: string;
  readonly environmentId: EnvironmentId | null;
  readonly path: string;
  /** Set when the folder browser's Create Directory row was chosen. */
  readonly createIfMissing: boolean;
  /** Only attached paths have an inspection; editing the path clears it. */
  readonly inspection: ProjectInspectDirectoryResult | null;
}

export interface NewRepositoryDraft {
  readonly owner: string;
  /** Empty means "derive from the project name". */
  readonly name: string;
  readonly visibility: SourceControlRepositoryVisibility;
}

export interface CreateProjectDraft {
  readonly name: string;
  readonly createRepository: boolean;
  readonly folders: ReadonlyArray<ProjectFolderDraft>;
  readonly newRepository: NewRepositoryDraft;
}

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
        | {
            readonly kind: "new_repo";
            readonly repository: string;
            readonly visibility: SourceControlRepositoryVisibility;
          };
    };

const OWNER_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*)\/[A-Za-z0-9._-]+$/;

export function folderHasRepository(folder: ProjectFolderDraft): boolean {
  return !!(folder.inspection?.repositoryRoot || folder.inspection?.repositoryIdentity);
}

/** New directories inherit their parent's repository, but may have been created since attachment. */
export async function inspectProjectFolder(
  folder: ProjectFolderDraft,
  inspect: (cwd: string) => Promise<ProjectInspectDirectoryResult>,
): Promise<ProjectFolderDraft> {
  let inspection = await inspect(folder.path);
  if (folder.createIfMissing && !folderHasRepository({ ...folder, inspection })) {
    const parent = getBrowseParentPath(folder.path.replace(/[\\/]+$/, ""));
    if (parent !== null) inspection = await inspect(parent);
  }
  if (inspection.repositoryRoot === undefined && inspection.repositoryIdentity === null) {
    throw new Error(
      "Update Pathway on this environment to detect Git repositories without a remote.",
    );
  }
  return { ...folder, inspection };
}

/** Matching checkouts are one repository; local repositories without remotes cannot be matched. */
export function projectFolderRepositoryError(
  folders: ReadonlyArray<ProjectFolderDraft>,
): string | null {
  const repositories = folders.filter(folderHasRepository);
  if (repositories.length < 2) return null;
  const key = repositories[0]?.inspection?.repositoryIdentity?.canonicalKey;
  return key &&
    repositories.every((folder) => folder.inspection?.repositoryIdentity?.canonicalKey === key)
    ? null
    : "A project can only use one Git repository. Choose a checkout of the same repository or a folder without Git.";
}

export function canCreateProjectRepository(folders: ReadonlyArray<ProjectFolderDraft>): boolean {
  return (
    folders.length > 0 &&
    folders.every((folder) => folder.inspection !== null && !folderHasRepository(folder))
  );
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

/** The typed name, else the first attached folder's basename. */
export function createProjectTitle(draft: Pick<CreateProjectDraft, "name" | "folders">): string {
  const typed = draft.name.trim();
  if (typed.length > 0) return typed;
  const first = draft.folders[0];
  const firstPath = first?.inspection ? first.path.trim() : "";
  return firstPath.length > 0 ? inferProjectTitleFromPath(firstPath.replace(/[\\/]+$/, "")) : "";
}

export function planCreateProject(input: {
  readonly draft: CreateProjectDraft;
  readonly platformFor: (environmentId: EnvironmentId) => string;
  readonly occupiedWorkspaceRootsFor: (environmentId: EnvironmentId) => ReadonlyArray<string>;
}): CreateProjectPlan {
  const { draft } = input;
  const title = createProjectTitle(draft);
  const repositoryError = projectFolderRepositoryError(draft.folders);
  if (repositoryError) return { kind: "invalid", message: repositoryError };
  const createRepository = draft.createRepository && canCreateProjectRepository(draft.folders);
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
    if (folder.inspection === null) return { kind: "incomplete" };
    folders.push({
      environmentId: folder.environmentId,
      workspaceRoot: attach.workspaceRoot,
      // Creating or cloning the new repository makes the folder itself.
      createIfMissing: createRepository ? false : attach.createWorkspaceRootIfMissing,
    });
  }
  if (title.length === 0) return { kind: "incomplete" };
  if (!createRepository) return { kind: "create", title, folders, source: { kind: "folders" } };

  const owner = draft.newRepository.owner.trim();
  const name = draft.newRepository.name.trim() || repositoryNameFromProjectName(title);
  if (owner.length === 0 || name.length === 0) return { kind: "incomplete" };
  const repository = `${owner}/${name}`;
  if (!OWNER_NAME.test(repository)) {
    return { kind: "invalid", message: "Repository names can use letters, numbers, . _ and -." };
  }
  return {
    kind: "create",
    title,
    folders,
    source: { kind: "new_repo", repository, visibility: draft.newRepository.visibility },
  };
}
