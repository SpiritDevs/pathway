/**
 * The two writes rootless projects need: attach a directory to an existing project, and create a
 * project (with or without one).
 *
 * Both live here rather than in their dialogs because the quick-create dialog performs the attach
 * write too — a name plus an expanded directory section is one `project.create` carrying the root,
 * not a create followed by an attach.
 *
 * @module components/projects/useProjectWorkspaceCommands
 */
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@spiritdevs/client-runtime/state/runtime";
import type { EnvironmentId, ProjectId } from "@spiritdevs/contracts";
import { useCallback } from "react";

import { newProjectId } from "~/lib/utils";
import { projectEnvironment } from "~/state/projects";
import { useAtomCommand } from "~/state/use-atom-command";
import { vcsEnvironment } from "~/state/vcs";
import {
  attachProjectDirectoryUpdateInput,
  type AttachProjectDirectoryPlan,
  type QuickCreateProjectPlan,
  type QuickCreateProjectResult,
} from "./projectWorkspace.logic";

export type ProjectWorkspaceWriteOutcome<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly message: string | null };

function failureOutcome(result: {
  readonly _tag: "Failure";
  readonly cause: unknown;
}): ProjectWorkspaceWriteOutcome<never> {
  // An interrupt is a disconnect or an unmount, not something to shout about.
  if (isAtomCommandInterrupted(result as never)) {
    return { ok: false, message: null };
  }
  const error = squashAtomCommandFailure(result as never);
  return { ok: false, message: error instanceof Error ? error.message : "An error occurred." };
}

/**
 * Attach a directory to an existing project.
 *
 * `vcs.init` runs *before* the meta update on purpose: `RepositoryIdentityResolver` negative-caches
 * "no identity" per path for 60 seconds, so initialising after the project points at the directory
 * would leave it looking non-git for up to a minute.
 */
export function useAttachProjectDirectory() {
  const updateProject = useAtomCommand(projectEnvironment.update, { reportFailure: false });
  const initRepository = useAtomCommand(vcsEnvironment.init, { reportFailure: false });

  return useCallback(
    async (input: {
      readonly environmentId: EnvironmentId;
      readonly projectId: ProjectId;
      readonly plan: Extract<AttachProjectDirectoryPlan, { kind: "attach" }>;
    }): Promise<ProjectWorkspaceWriteOutcome<string>> => {
      const { environmentId, plan, projectId } = input;
      if (plan.initializeGit) {
        const initResult = await initRepository({
          environmentId,
          input: { cwd: plan.workspaceRoot },
        });
        if (initResult._tag === "Failure") {
          return failureOutcome(initResult);
        }
      }
      const updateResult = await updateProject({
        environmentId,
        input: attachProjectDirectoryUpdateInput({
          projectId,
          workspaceRoot: plan.workspaceRoot,
          createWorkspaceRootIfMissing: plan.createWorkspaceRootIfMissing,
        }),
      });
      if (updateResult._tag === "Failure") {
        return failureOutcome(updateResult);
      }
      return { ok: true, value: plan.workspaceRoot };
    },
    [initRepository, updateProject],
  );
}

/**
 * Create a project, rootless or rooted.
 *
 * `defaultModelSelection` is deliberately not sent: it is a per-environment provider default the
 * add-project flow resolves from a provider list this dialog has no reason to load, and the server
 * treats its absence as "use the environment default" anyway.
 */
export function useQuickCreateProject() {
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });
  const initRepository = useAtomCommand(vcsEnvironment.init, { reportFailure: false });

  return useCallback(
    async (input: {
      readonly environmentId: EnvironmentId;
      readonly plan: Extract<QuickCreateProjectPlan, { kind: "create" }>;
    }): Promise<ProjectWorkspaceWriteOutcome<QuickCreateProjectResult>> => {
      const { environmentId, plan } = input;
      if (plan.workspaceRoot !== null && plan.initializeGit) {
        const initResult = await initRepository({
          environmentId,
          input: { cwd: plan.workspaceRoot },
        });
        if (initResult._tag === "Failure") {
          return failureOutcome(initResult);
        }
      }
      const projectId = newProjectId();
      const createResult = await createProject({
        environmentId,
        input: {
          projectId,
          title: plan.title,
          workspaceRoot: plan.workspaceRoot,
          ...(plan.workspaceRoot !== null && plan.createWorkspaceRootIfMissing
            ? { createWorkspaceRootIfMissing: true }
            : {}),
        },
      });
      if (createResult._tag === "Failure") {
        return failureOutcome(createResult);
      }
      return {
        ok: true,
        value: {
          environmentId,
          projectId,
          title: plan.title,
          workspaceRoot: plan.workspaceRoot,
        },
      };
    },
    [createProject, initRepository],
  );
}
