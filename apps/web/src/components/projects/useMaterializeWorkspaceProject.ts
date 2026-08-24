/**
 * Giving a company project somewhere to actually run.
 *
 * A project is owned by a company and can exist with no checkout anywhere (ADR 0011). That is fine
 * for planning, but agents run in a directory on a machine, so the first time somebody starts work
 * in such a project it has to be materialised: a local project on this environment, pointed at a
 * provisioned folder, bound back to the company project it came from.
 *
 * Doing this on selection rather than refusing the selection is the point — the person has already
 * said which project they mean, and answering that with "you cannot" would be a dead end.
 *
 * @module components/projects/useMaterializeWorkspaceProject
 */
import type { EnvironmentId, ProjectId } from "@spiritdevs/contracts";
import type { CompanyId } from "@spiritdevs/contracts/company";
import { useCallback } from "react";

import { useEnvironmentControl } from "~/cloud/useEnvironmentControl";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { scratchWorkspaceRoot } from "./projectWorkspace.logic";
import { useQuickCreateProject } from "./useProjectWorkspaceCommands";
import type { WorkspaceProject } from "./workspaceProjects.logic";

export interface MaterializedWorkspaceProject {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly workspaceRoot: string;
}

export type MaterializeOutcome =
  | { readonly ok: true; readonly value: MaterializedWorkspaceProject }
  | { readonly ok: false; readonly message: string | null };

export function useMaterializeWorkspaceProject() {
  const createProject = useQuickCreateProject();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const control = useEnvironmentControl();

  return useCallback(
    async (project: WorkspaceProject): Promise<MaterializeOutcome> => {
      const existing = project.group?.memberProjects[0];
      if (existing !== undefined) {
        // Already runnable somewhere. `useEnsureProjectWorkspace` handles a checkout that merely
        // lacks a directory, so there is nothing to materialise here.
        return {
          ok: true,
          value: {
            environmentId: existing.environmentId,
            projectId: existing.id,
            workspaceRoot: existing.workspaceRoot ?? "",
          },
        };
      }
      if (primaryEnvironmentId === null) {
        return { ok: false, message: "Connect an environment before starting work here." };
      }

      const workspaceRoot = scratchWorkspaceRoot({
        id: project.cloudProjectId ?? project.projectKey,
        title: project.displayName,
      });
      const created = await createProject({
        environmentId: primaryEnvironmentId,
        plan: {
          kind: "create",
          title: project.displayName,
          workspaceRoot,
          createWorkspaceRootIfMissing: true,
          initializeGit: false,
        },
      });
      if (!created.ok) return created;

      // Bind it back to the company project so issues filed against the planning-only project keep
      // resolving to this checkout. A failure here leaves a usable local project rather than
      // unwinding the create, so the person can still work; the binding retries on next use.
      const companyId = project.companyIds[0];
      if (companyId !== undefined && control !== null) {
        try {
          await control.ensureEnvironmentProject({
            companyId: companyId as CompanyId,
            ...(project.cloudProjectId === null ? {} : { cloudProjectId: project.cloudProjectId }),
            project: {
              environmentId: created.value.environmentId,
              id: created.value.projectId,
              title: project.displayName,
              workspaceRoot,
            },
          });
        } catch {
          // Deliberately swallowed: see above.
        }
      }

      return {
        ok: true,
        value: {
          environmentId: created.value.environmentId,
          projectId: created.value.projectId,
          workspaceRoot,
        },
      };
    },
    [control, createProject, primaryEnvironmentId],
  );
}
