import type { EnvironmentId, ProjectId } from "@spiritdevs/contracts";
import type { DraftProjectRef, DraftThreadEnvMode } from "../composerDraftStore";

interface ThreadContextLike {
  environmentId: EnvironmentId;
  projectId: ProjectId | null;
}

interface NewThreadHandler {
  (
    projectRef: DraftProjectRef,
    options?: {
      branch?: string | null;
      worktreePath?: string | null;
      envMode?: DraftThreadEnvMode;
      startFromOrigin?: boolean;
    },
    // The opened draft's identity, which most callers have no use for.
  ): Promise<unknown>;
}

export interface ChatThreadActionContext {
  readonly activeDraftThread: ThreadContextLike | null;
  readonly activeThread: ThreadContextLike | undefined;
  readonly defaultProjectRef: DraftProjectRef | null;
  readonly handleNewThread: NewThreadHandler;
}

export function resolveNewDraftStartFromOrigin(input: {
  envMode: DraftThreadEnvMode;
  newWorktreesStartFromOrigin: boolean;
}): boolean {
  return input.envMode === "worktree" && input.newWorktreesStartFromOrigin;
}

export function resolveThreadActionProjectRef(
  context: ChatThreadActionContext,
): DraftProjectRef | null {
  if (context.activeThread) {
    return {
      environmentId: context.activeThread.environmentId,
      projectId: context.activeThread.projectId,
    };
  }
  if (context.activeDraftThread) {
    return {
      environmentId: context.activeDraftThread.environmentId,
      projectId: context.activeDraftThread.projectId,
    };
  }
  return context.defaultProjectRef;
}

// New threads inherit only the *project* from the current context. Branch,
// worktree, and env mode always come from the user's configured defaults —
// carrying them over from the viewed thread meant "new thread" silently
// reused checkouts and branches. Explicit affordances (branch toolbar's
// "new thread in this worktree") pass those options to handleNewThread
// directly instead.
export async function startNewThreadFromContext(
  context: ChatThreadActionContext,
): Promise<boolean> {
  const projectRef = resolveThreadActionProjectRef(context);
  if (!projectRef) {
    return false;
  }

  await context.handleNewThread(projectRef);
  return true;
}
