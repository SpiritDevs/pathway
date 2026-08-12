import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";

import {
  PROJECT_DIRECTORY_REQUIRED_MESSAGE,
  ProjectThreadWorkspaceRootRequiredError,
  validateProjectThreadCreation,
} from "./projectThreadCreationValidation";

const environmentId = EnvironmentId.make("moonbase-terminal");
const projectId = ProjectId.make("pathway");

it("accepts a local thread with a task", () => {
  assert.equal(
    validateProjectThreadCreation({
      environmentId,
      projectId,
      environmentMode: "local",
      branch: null,
      initialMessageText: "Ship the launch checklist",
    }),
    null,
  );
});

it("rejects a worktree thread with no base branch", () => {
  const error = validateProjectThreadCreation({
    environmentId,
    projectId,
    environmentMode: "worktree",
    branch: null,
    initialMessageText: "Ship the launch checklist",
  });

  assert.equal(error?._tag, "ProjectThreadBaseBranchRequiredError");
});

// The rootless gate lives in `useCreateProjectThread` (it narrows the cwd it
// then passes to the server), so the copy is the contract the composer's
// disabled state and the failure alert share.
it("reports the shared directory-required copy for a rootless project", () => {
  const error = new ProjectThreadWorkspaceRootRequiredError({ environmentId, projectId });

  assert.equal(error._tag, "ProjectThreadWorkspaceRootRequiredError");
  assert.equal(error.message, PROJECT_DIRECTORY_REQUIRED_MESSAGE);
});
