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

export function useEnsureProjectWorkspace(
  project: ProjectWorkspaceTarget | null | undefined,
): EnsureProjectWorkspace {
  const decision = useMemo(() => ensureProjectWorkspaceDecision(project), [project]);

  const ensureWorkspaceRoot = useCallback(
    async (reason?: string): Promise<string | null> => {
      if (decision.kind === "unavailable") return null;
      if (decision.kind === "ready") return decision.workspaceRoot;
      const promptResult = await requestProjectWorkspace({
        project: decision.project,
        reason: reason ?? null,
      });
      // The project object captured above is a snapshot; re-reading its root from the snapshot
      // would miss the attach that just happened, which is why the prompt answers with the path.
      return resolveEnsuredWorkspaceRoot({ workspaceRoot: null, promptResult });
    },
    [decision],
  );

  return {
    workspaceRoot: decision.kind === "ready" ? decision.workspaceRoot : null,
    isRootless: decision.kind === "prompt",
    ensureWorkspaceRoot,
  };
}
