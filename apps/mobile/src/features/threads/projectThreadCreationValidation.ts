import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export class ProjectThreadTaskRequiredError extends Schema.TaggedErrorClass<ProjectThreadTaskRequiredError>()(
  "ProjectThreadTaskRequiredError",
  {
    environmentId: EnvironmentId,
    projectId: ProjectId,
    environmentMode: Schema.Literals(["local", "worktree"]),
  },
) {
  override get message(): string {
    return "Enter a task before starting the thread.";
  }
}

export class ProjectThreadBaseBranchRequiredError extends Schema.TaggedErrorClass<ProjectThreadBaseBranchRequiredError>()(
  "ProjectThreadBaseBranchRequiredError",
  {
    environmentId: EnvironmentId,
    projectId: ProjectId,
  },
) {
  override get message(): string {
    return "Select a base branch before creating a worktree.";
  }
}

/**
 * Shown wherever a rootless project blocks thread creation. Mobile has no
 * attach-directory flow in this stage, so the copy points at the desktop app
 * instead of offering an action.
 */
export const PROJECT_DIRECTORY_REQUIRED_MESSAGE =
  "This project has no directory yet. Attach one from the desktop app to start tasks here.";

export class ProjectThreadWorkspaceRootRequiredError extends Schema.TaggedErrorClass<ProjectThreadWorkspaceRootRequiredError>()(
  "ProjectThreadWorkspaceRootRequiredError",
  {
    environmentId: EnvironmentId,
    projectId: ProjectId,
  },
) {
  override get message(): string {
    return PROJECT_DIRECTORY_REQUIRED_MESSAGE;
  }
}

export const ProjectThreadCreationValidationError = Schema.Union([
  ProjectThreadTaskRequiredError,
  ProjectThreadBaseBranchRequiredError,
  ProjectThreadWorkspaceRootRequiredError,
]);
export type ProjectThreadCreationValidationError = typeof ProjectThreadCreationValidationError.Type;

export function validateProjectThreadCreation(input: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly environmentMode: "local" | "worktree";
  readonly branch: string | null;
  readonly initialMessageText: string;
}): ProjectThreadCreationValidationError | null {
  if (input.initialMessageText.trim().length === 0) {
    return new ProjectThreadTaskRequiredError({
      environmentId: input.environmentId,
      projectId: input.projectId,
      environmentMode: input.environmentMode,
    });
  }
  if (input.environmentMode === "worktree" && !input.branch) {
    return new ProjectThreadBaseBranchRequiredError({
      environmentId: input.environmentId,
      projectId: input.projectId,
    });
  }
  return null;
}
