/**
 * Pure decisions behind rootless projects — see
 * `docs/internals/decisions/0006-issue-tracker.md` ("Projects").
 *
 * `workspaceRoot` is nullable, so a project can be created from a name alone. The record's rule is
 * that such a project stays *visible* everywhere and a surface that genuinely needs a path prompts
 * for one just in time. Three shapes of decision follow from that and all three live here, away
 * from the dialogs that render them:
 *
 * - `ensureProjectWorkspaceDecision` — the one branch every call site repeats: run, prompt, or the
 *   project is gone. Call sites stay one-liners because this returns the prompt target too.
 * - `planAttachProjectDirectory` — validating the typed path against the *target environment's*
 *   platform before dispatching, so a bad path is a sentence in the dialog rather than an
 *   `OrchestrationDispatchCommandError` toast after the modal has closed.
 * - `planQuickCreateProject` — the name-only fast path, with the optional directory section folded
 *   into the same result so the caller dispatches one create (plus an optional `vcs.init`) either
 *   way.
 *
 * @module components/projects/projectWorkspace.logic
 */
import {
  inferProjectTitleFromPath,
  isExplicitRelativeProjectPath,
  isUnsupportedWindowsProjectPath,
  resolveProjectPathForDispatch,
} from "@spiritdevs/client-runtime/state/projects";
import type { EnvironmentId, ProjectId } from "@spiritdevs/contracts";

// ── Ensuring a workspace root ──────────────────────────────────────────

/** The slice of a project this module needs. Anything project-shaped satisfies it. */
export interface ProjectWorkspaceTarget {
  readonly environmentId: EnvironmentId;
  readonly id: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string | null;
}

export type EnsureProjectWorkspaceDecision =
  /** No project at all — the caller has nothing to prompt about, so it should bail silently. */
  | { readonly kind: "unavailable" }
  | { readonly kind: "ready"; readonly workspaceRoot: string }
  /** No directory yet: provision one below the user's home rather than asking. */
  | {
      readonly kind: "provision";
      readonly project: ProjectWorkspaceTarget;
      readonly workspaceRoot: string;
    }
  | { readonly kind: "prompt"; readonly project: ProjectWorkspaceTarget };

/**
 * Whether an action that needs a directory can run, and if not, how to get one.
 *
 * A project with no directory used to stop and ask. It now provisions a scratch folder instead:
 * not every project is a git checkout, and someone starting a thread has already said what they
 * want — a file picker in the way of that is a question with an obvious answer. `prompt` remains
 * for the explicit "choose a different directory" path.
 *
 * A worktree path is deliberately *not* accepted as a substitute here: a worktree always hangs off
 * a rooted project, so a rootless project can never present one, and letting one stand in would
 * make this function answer "ready" for a state the server rejects.
 */
export function ensureProjectWorkspaceDecision(
  project: ProjectWorkspaceTarget | null | undefined,
): EnsureProjectWorkspaceDecision {
  if (!project) {
    return { kind: "unavailable" };
  }
  const workspaceRoot = project.workspaceRoot?.trim() ?? "";
  if (workspaceRoot.length === 0) {
    return { kind: "provision", project, workspaceRoot: scratchWorkspaceRoot(project) };
  }
  return { kind: "ready", workspaceRoot };
}

/**
 * The directory a command should run in: the worktree when there is one, else the project root,
 * else nothing. This is `projectScriptCwd` widened to a nullable root — `@spiritdevs/shared` keeps the
 * strict signature because the server only ever calls it with a rooted project.
 */
export function projectWorkspaceCwd(input: {
  readonly workspaceRoot: string | null | undefined;
  readonly worktreePath?: string | null | undefined;
}): string | null {
  return input.worktreePath ?? input.workspaceRoot ?? null;
}

/**
 * `PATHWAY_PROJECT_ROOT` for a project whose root may be absent.
 *
 * The `cwd` fallback is not a guess: the only way a rootless project reaches a terminal at all is
 * through a just-attached root passed in as `cwd`, so pointing the variable at it keeps the script
 * contract intact rather than exporting an empty string.
 */
export function projectWorkspaceRuntimeEnv(input: {
  readonly workspaceRoot: string | null | undefined;
  readonly cwd: string;
  readonly worktreePath?: string | null | undefined;
  readonly extraEnv?: Record<string, string> | undefined;
}): Record<string, string> {
  const env: Record<string, string> = {
    PATHWAY_PROJECT_ROOT: input.workspaceRoot ?? input.cwd,
  };
  if (input.worktreePath) {
    env.PATHWAY_WORKTREE_PATH = input.worktreePath;
  }
  return input.extraEnv ? { ...env, ...input.extraEnv } : env;
}

/** Sidebar/menu label for a project row: the path when there is one, the title otherwise. */
export function projectWorkspaceLabel(
  project: Pick<ProjectWorkspaceTarget, "title" | "workspaceRoot">,
): string {
  return project.workspaceRoot ?? project.title;
}

// ── Attaching a directory ──────────────────────────────────────────────

export interface AttachProjectDirectoryDraft {
  readonly path: string;
  /** Create the directory when it does not exist, rather than failing the dispatch. */
  readonly createIfMissing: boolean;
  /** Run `vcs.init` in the directory once it is attached. */
  readonly initializeGit: boolean;
}

export const EMPTY_ATTACH_PROJECT_DIRECTORY_DRAFT: AttachProjectDirectoryDraft = {
  path: "",
  createIfMissing: true,
  initializeGit: false,
};

export type AttachProjectDirectoryPlan =
  | { readonly kind: "incomplete" }
  | { readonly kind: "invalid"; readonly message: string }
  | {
      readonly kind: "attach";
      readonly workspaceRoot: string;
      readonly createWorkspaceRootIfMissing: boolean;
      readonly initializeGit: boolean;
    };

/**
 * Validate a typed directory against the environment it will be attached in.
 *
 * `incomplete` and `invalid` are separate so the submit button can be disabled on an empty field
 * without the field also shouting an error at someone who has not typed yet.
 */
export function planAttachProjectDirectory(input: {
  readonly draft: AttachProjectDirectoryDraft;
  /** The *target* environment's `platform.os`, not the browser's. */
  readonly platform: string;
  /** Only a project on the same environment can anchor a relative path. */
  readonly currentProjectCwd: string | null;
  /** Active projects in the target environment; a root may back only one of them. */
  readonly occupiedWorkspaceRoots?: ReadonlyArray<string>;
}): AttachProjectDirectoryPlan {
  const raw = input.draft.path.trim();
  if (raw.length === 0) {
    return { kind: "incomplete" };
  }
  if (isUnsupportedWindowsProjectPath(raw, input.platform)) {
    return { kind: "invalid", message: "Windows-style paths are only supported on Windows." };
  }
  if (isExplicitRelativeProjectPath(raw) && !input.currentProjectCwd) {
    return { kind: "invalid", message: "Relative paths require an active project." };
  }
  const workspaceRoot = resolveProjectPathForDispatch(raw, input.currentProjectCwd);
  if (workspaceRoot.length === 0) {
    return { kind: "incomplete" };
  }
  // The server refuses this with `Active project '<id>' already exists for workspace root …`;
  // saying so here keeps the dialog open on the field the person has to change.
  if (input.occupiedWorkspaceRoots?.includes(workspaceRoot)) {
    return { kind: "invalid", message: "Another project already uses this directory." };
  }
  return {
    kind: "attach",
    workspaceRoot,
    createWorkspaceRootIfMissing: input.draft.createIfMissing,
    initializeGit: input.draft.initializeGit,
  };
}

/**
 * The `project.meta.update` payload that attaches a root.
 *
 * `createWorkspaceRootIfMissing` is only sent when true: the field is `Schema.optional(Boolean)`
 * and `exactOptionalPropertyTypes` is on, so an explicit `false` is noise on the wire.
 */
export function attachProjectDirectoryUpdateInput(input: {
  readonly projectId: ProjectId;
  readonly workspaceRoot: string;
  readonly createWorkspaceRootIfMissing: boolean;
}): {
  readonly projectId: ProjectId;
  readonly workspaceRoot: string;
  readonly createWorkspaceRootIfMissing?: boolean;
} {
  return {
    projectId: input.projectId,
    workspaceRoot: input.workspaceRoot,
    ...(input.createWorkspaceRootIfMissing ? { createWorkspaceRootIfMissing: true } : {}),
  };
}

/**
 * Whether `vcs.init` should run, and it must run *before* the attach dispatch:
 * `RepositoryIdentityResolver` negative-caches "no identity" per path for 60s, so initialising
 * after the project points at the directory leaves it looking non-git for up to a minute.
 */
export function shouldInitializeGitBeforeAttach(plan: AttachProjectDirectoryPlan): boolean {
  return plan.kind === "attach" && plan.initializeGit;
}

// ── Quick project creation ─────────────────────────────────────────────

export interface QuickCreateProjectDraft {
  readonly name: string;
  /** The expanded "set a directory now" section, or null when it is collapsed. */
  readonly directory: AttachProjectDirectoryDraft | null;
}

export const EMPTY_QUICK_CREATE_PROJECT_DRAFT: QuickCreateProjectDraft = {
  name: "",
  directory: null,
};

export type QuickCreateProjectPlan =
  | { readonly kind: "incomplete" }
  | { readonly kind: "invalid"; readonly message: string }
  | {
      readonly kind: "create";
      readonly title: string;
      readonly workspaceRoot: string | null;
      readonly createWorkspaceRootIfMissing: boolean;
      readonly initializeGit: boolean;
    };

/**
 * The name-only fast path, plus the optional directory section.
 *
 * A collapsed directory section is a rootless create, not an error — that is the whole point of
 * the dialog. An expanded-but-empty one is `incomplete`: someone who opened the section meant to
 * fill it in, and creating rootless behind their back would be a surprise.
 */
export function planQuickCreateProject(input: {
  readonly draft: QuickCreateProjectDraft;
  readonly platform: string;
  readonly currentProjectCwd: string | null;
  readonly occupiedWorkspaceRoots?: ReadonlyArray<string>;
}): QuickCreateProjectPlan {
  const title = input.draft.name.trim();
  const directory = input.draft.directory;
  if (title.length === 0 && (directory === null || directory.path.trim().length === 0)) {
    return { kind: "incomplete" };
  }
  if (directory === null) {
    return {
      kind: "create",
      title,
      workspaceRoot: null,
      createWorkspaceRootIfMissing: false,
      initializeGit: false,
    };
  }
  const attach = planAttachProjectDirectory({
    draft: directory,
    platform: input.platform,
    currentProjectCwd: input.currentProjectCwd,
    ...(input.occupiedWorkspaceRoots
      ? { occupiedWorkspaceRoots: input.occupiedWorkspaceRoots }
      : {}),
  });
  if (attach.kind !== "attach") {
    return attach;
  }
  return {
    kind: "create",
    // A directory with no typed name names the project after its basename, the same rule the
    // add-project flow already applies.
    title: title.length > 0 ? title : inferProjectTitleFromPath(attach.workspaceRoot),
    workspaceRoot: attach.workspaceRoot,
    createWorkspaceRootIfMissing: attach.createWorkspaceRootIfMissing,
    initializeGit: attach.initializeGit,
  };
}

// ── Scratch workspaces ────────────────────────────────────

/**
 * Where Pathway puts a directory it makes for you, below the user's home.
 *
 * `~` rather than an absolute path: the server expands it, so the same value is correct on a Mac,
 * on Windows, and on a remote environment whose home the client has never seen.
 */
export const SCRATCH_WORKSPACE_PARENT = "~/Pathway Projects";

const UNSAFE_FOLDER_CHARACTERS = /[<>:"/\\|?*\u0000-\u001F]/g;

/**
 * A directory name safe on every platform this runs on.
 *
 * Windows reserves several punctuation characters, and it silently strips a trailing dot or space,
 * which would quietly fold two distinct project names into one directory.
 */
export function scratchWorkspaceFolderName(title: string, projectId: string): string {
  const cleaned = title
    .replaceAll(UNSAFE_FOLDER_CHARACTERS, " ")
    .replaceAll(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/, "");
  // A title made entirely of punctuation leaves nothing to name a folder after, and a short id
  // beats a folder called "-".
  return cleaned.length === 0 ? `project-${projectId.slice(0, 8)}` : cleaned;
}

/**
 * The workspace root to create for a project that has none.
 *
 * A project without a repository still needs somewhere to put scratch files, so rather than
 * refusing the action or making someone choose a folder before they have decided anything,
 * Pathway provisions one. Stable per project rather than per session: files left there have to
 * still be there next time, which a `mkdtemp` directory would not be.
 */
export function scratchWorkspaceRoot(project: {
  readonly id: string;
  readonly title: string;
}): string {
  return `${SCRATCH_WORKSPACE_PARENT}/${scratchWorkspaceFolderName(project.title, project.id)}`;
}

// ── Dialog result plumbing ─────────────────────────────────────────────

/**
 * What a prompt hands back to the action that opened it. `null` is a cancel, and every call site
 * treats it as "do nothing" rather than "carry on rootless".
 */
export type ProjectWorkspacePromptResult = { readonly workspaceRoot: string } | null;

export interface QuickCreateProjectResult {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string | null;
}

/**
 * Fold a prompt's answer back into the value the caller was after.
 *
 * The pre-existing root wins over a late answer: a second prompt can only resolve after the
 * project already gained a root, and preferring the stale dialog value would attach-then-ignore.
 */
export function resolveEnsuredWorkspaceRoot(input: {
  readonly workspaceRoot: string | null | undefined;
  readonly promptResult: ProjectWorkspacePromptResult;
}): string | null {
  const existing = input.workspaceRoot?.trim() ?? "";
  if (existing.length > 0) {
    return existing;
  }
  const prompted = input.promptResult?.workspaceRoot.trim() ?? "";
  return prompted.length > 0 ? prompted : null;
}
