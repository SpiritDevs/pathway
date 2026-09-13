/**
 * One-liner access to "the directory this project runs in, prompting for one if it has none".
 *
 * Every path-needing surface reduces to the same two lines:
 *
 * ```ts
 * const cwd = await ensureWorkspaceRoot();
 * if (cwd === null) return; // cancelled, or the project vanished
 * ```
 *
 * which is what keeps the rootless-projects change from spraying modal state through the tree.
 * `workspaceRoot` and `isRootless` are there for the render pass — a row that wants to show an
 * "attach a directory" affordance instead of a path.
 *
 * @module hooks/useEnsureProjectWorkspace
 */
import { useCallback, useMemo } from "react";

import {
  ensureProjectWorkspaceDecision,
  resolveEnsuredWorkspaceRoot,
  type ProjectWorkspaceTarget,
} from "../components/projects/projectWorkspace.logic";
import { requestProjectWorkspace } from "../components/projects/projectWorkspacePrompt";
import { useProvisionInternalWorkspace } from "../components/projects/useProjectWorkspaceCommands";

export interface EnsureProjectWorkspace {
  /** The project's root, or null when it has none (or there is no project). */
  readonly workspaceRoot: string | null;
  /** True only for a real project that has no root — false when there is no project at all. */
  readonly isRootless: boolean;
  /**
   * Resolve the root, raising the attach modal when there is none. Null means "do nothing": the
   * person cancelled, or the caller has no project to prompt about.
   */
  readonly ensureWorkspaceRoot: (reason?: string) => Promise<string | null>;
}

export async function ensureProjectWorkspaceRoot(input: {
  readonly project: ProjectWorkspaceTarget | null | undefined;
  readonly provisionWorkspace: ReturnType<typeof useProvisionInternalWorkspace>;
  readonly reason?: string;
}): Promise<string | null> {
  const decision = ensureProjectWorkspaceDecision(input.project);
  if (decision.kind === "unavailable") return null;
  if (decision.kind === "ready") return decision.workspaceRoot;
  if (decision.kind === "provision") {
    const workspaceRoot = await input.provisionWorkspace(decision.project);
    if (workspaceRoot !== null) return workspaceRoot;
  }
  const promptResult = await requestProjectWorkspace({
    project: decision.project,
    reason: input.reason ?? null,
  });
  return resolveEnsuredWorkspaceRoot({ workspaceRoot: null, promptResult });
}

export function useEnsureProjectWorkspace(
  project: ProjectWorkspaceTarget | null | undefined,
): EnsureProjectWorkspace {
  const decision = useMemo(() => ensureProjectWorkspaceDecision(project), [project]);

  const provisionWorkspace = useProvisionInternalWorkspace();

  const ensureWorkspaceRoot = useCallback(
    (reason?: string) =>
      ensureProjectWorkspaceRoot({
        project,
        provisionWorkspace,
        ...(reason === undefined ? {} : { reason }),
      }),
    [provisionWorkspace, project],
  );

  return {
    workspaceRoot: decision.kind === "ready" ? decision.workspaceRoot : null,
    isRootless: decision.kind === "provision" || decision.kind === "prompt",
    ensureWorkspaceRoot,
  };
}
