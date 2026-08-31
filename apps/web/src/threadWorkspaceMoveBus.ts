import type { EnvironmentId, ThreadId } from "@spiritdevs/contracts";

const THREAD_WORKSPACE_MOVE_EVENT = "pathway:open-thread-workspace-move";

export interface ThreadWorkspaceMoveTarget {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}

export function openThreadWorkspaceMove(target: ThreadWorkspaceMoveTarget): void {
  window.dispatchEvent(new CustomEvent(THREAD_WORKSPACE_MOVE_EVENT, { detail: target }));
}

export function onOpenThreadWorkspaceMove(
  listener: (target: ThreadWorkspaceMoveTarget) => void,
): () => void {
  const handler = (event: Event) => {
    listener((event as CustomEvent<ThreadWorkspaceMoveTarget>).detail);
  };
  window.addEventListener(THREAD_WORKSPACE_MOVE_EVENT, handler);
  return () => window.removeEventListener(THREAD_WORKSPACE_MOVE_EVENT, handler);
}
