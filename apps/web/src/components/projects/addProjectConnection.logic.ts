import { findProjectByPath } from "@spiritdevs/client-runtime/state/projects";
import type { EnvironmentProject } from "@spiritdevs/client-runtime/state/models";
import type { EnvironmentId } from "@spiritdevs/contracts";

import type { ProjectWorkspaceWriteOutcome } from "./useProjectWorkspaceCommands";
import type { QuickCreateProjectResult } from "./projectWorkspace.logic";

export type ProjectConnectionCheckout = Pick<
  EnvironmentProject,
  "environmentId" | "id" | "workspaceRoot" | "title" | "repositoryIdentity"
>;

export type AddProjectConnectionOutcome =
  | { readonly ok: true; readonly checkout: ProjectConnectionCheckout }
  | {
      readonly ok: false;
      readonly message: string | null;
      /** Retained so a failed cloud write can be retried without creating the checkout again. */
      readonly checkout: ProjectConnectionCheckout | null;
    };

/** Reuses only the checkout already occupying this directory. Two directories for the same Git
 * repository are valid concurrent connections and must remain distinct physical checkouts. */
export function findReusableProjectConnection(input: {
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string;
}): ProjectConnectionCheckout | null {
  const candidates = input.projects.filter(
    (project) => project.environmentId === input.environmentId && project.workspaceRoot !== null,
  );
  const pathMatch = findProjectByPath(candidates, input.workspaceRoot);
  return pathMatch ?? null;
}

function checkoutFromCreateResult(result: QuickCreateProjectResult): ProjectConnectionCheckout {
  return {
    environmentId: result.environmentId,
    id: result.projectId,
    workspaceRoot: result.workspaceRoot,
    title: result.title,
    repositoryIdentity: result.repositoryIdentity ?? null,
  };
}

/**
 * Completes both halves of adding a connection before reporting success: the environment-local
 * checkout first, then its explicit company-project binding in Convex.
 */
export async function addProjectConnection(input: {
  readonly existingCheckout: ProjectConnectionCheckout | null;
  readonly createCheckout: () => Promise<ProjectWorkspaceWriteOutcome<QuickCreateProjectResult>>;
  readonly bindCheckout: (checkout: ProjectConnectionCheckout) => Promise<void>;
}): Promise<AddProjectConnectionOutcome> {
  let checkout = input.existingCheckout;
  if (checkout === null) {
    const created = await input.createCheckout();
    if (!created.ok) return { ...created, checkout: null };
    checkout = checkoutFromCreateResult(created.value);
  }

  try {
    await input.bindCheckout(checkout);
    return { ok: true, checkout };
  } catch (cause) {
    return {
      ok: false,
      message: cause instanceof Error ? cause.message : "Failed to connect project.",
      checkout,
    };
  }
}
