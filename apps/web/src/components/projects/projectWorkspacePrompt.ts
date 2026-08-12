/**
 * The just-in-time "attach a directory" prompt, as a module-level store.
 *
 * Modelled on `src/confirmDialog.ts`: a single host renders the dialog near the router root and
 * every call site awaits a promise, so a surface that needs a path stays a one-liner
 * (`const root = await ensureWorkspaceRoot()`) instead of hoisting dialog state through the tree.
 * Requests queue rather than stack — two rootless actions fired in a row would otherwise race two
 * modals for the same project.
 *
 * @module components/projects/projectWorkspacePrompt
 */
import type {
  ProjectWorkspacePromptResult,
  ProjectWorkspaceTarget,
} from "./projectWorkspace.logic";

export interface ProjectWorkspacePromptRequest {
  readonly project: ProjectWorkspaceTarget;
  /** What the person was trying to do, shown so the modal does not read as a random interruption. */
  readonly reason: string | null;
}

export type ProjectWorkspacePromptState =
  | { readonly status: "idle" }
  | { readonly status: "prompting"; readonly request: ProjectWorkspacePromptRequest }
  | { readonly status: "closing"; readonly request: ProjectWorkspacePromptRequest };

interface PendingPrompt extends ProjectWorkspacePromptRequest {
  readonly resolve: (result: ProjectWorkspacePromptResult) => void;
}

const idleState: ProjectWorkspacePromptState = { status: "idle" };
let state: ProjectWorkspacePromptState = idleState;
let activePrompt: PendingPrompt | null = null;
let queuedPrompts: PendingPrompt[] = [];
let registeredHostCount = 0;
const listeners = new Set<() => void>();

function publish(next: ProjectWorkspacePromptState): void {
  state = next;
  for (const listener of listeners) {
    listener();
  }
}

function cancelAll(): void {
  activePrompt?.resolve(null);
  for (const prompt of queuedPrompts) {
    prompt.resolve(null);
  }
  activePrompt = null;
  queuedPrompts = [];
}

export function readProjectWorkspacePromptState(): ProjectWorkspacePromptState {
  return state;
}

export function subscribeProjectWorkspacePrompt(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Registers the host; unmounting the last one cancels whatever it was showing. */
export function registerProjectWorkspacePromptHost(): () => void {
  registeredHostCount += 1;
  let registered = true;

  return () => {
    if (!registered) return;
    registered = false;
    registeredHostCount = Math.max(0, registeredHostCount - 1);
    if (registeredHostCount === 0) {
      cancelAll();
      publish(idleState);
    }
  };
}

/**
 * Ask for a directory for `project`. Resolves with the attached root, or null when the person
 * cancelled — or when no host is mounted, so a caller on a hostless surface degrades to "do
 * nothing" rather than hanging on a promise nothing can settle.
 */
export function requestProjectWorkspace(
  request: ProjectWorkspacePromptRequest,
): Promise<ProjectWorkspacePromptResult> {
  if (registeredHostCount === 0) {
    return Promise.resolve(null);
  }
  return new Promise<ProjectWorkspacePromptResult>((resolve) => {
    const pending: PendingPrompt = { ...request, resolve };
    if (activePrompt || state.status === "closing") {
      queuedPrompts.push(pending);
      return;
    }
    activePrompt = pending;
    publish({ status: "prompting", request });
  });
}

export function respondToProjectWorkspacePrompt(result: ProjectWorkspacePromptResult): void {
  if (state.status !== "prompting" || !activePrompt) return;
  const prompt = activePrompt;
  activePrompt = null;
  prompt.resolve(result);
  publish({ status: "closing", request: state.request });
}

export function completeProjectWorkspacePromptClose(): void {
  if (state.status !== "closing") return;
  const next = queuedPrompts.shift();
  if (!next) {
    publish(idleState);
    return;
  }
  activePrompt = next;
  publish({ status: "prompting", request: { project: next.project, reason: next.reason } });
}

export function resetProjectWorkspacePromptForTests(): void {
  cancelAll();
  registeredHostCount = 0;
  publish(idleState);
  listeners.clear();
}
