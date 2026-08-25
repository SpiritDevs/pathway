/**
 * The just-in-time "this project has no directory" modal.
 *
 * `docs/internals/decisions/0006-issue-tracker.md` chose promotion over hiding: a rootless project
 * stays listed everywhere, and the surface that actually needs a path — the composer, git actions,
 * the file explorer — raises this and continues once a directory is set. So the dialog resolves
 * with the attached root rather than merely closing, and `AttachProjectDirectoryHost` (mounted once
 * near the router root, like `ConfirmDialogHost`) is what lets `useEnsureProjectWorkspace` hand
 * that root back to the interrupted action.
 *
 * @module components/projects/AttachProjectDirectoryDialog
 */
import type { EnvironmentId } from "@spiritdevs/contracts";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";

import { useEnvironments } from "~/state/environments";
import { useUnscopedProjects } from "~/state/entities";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { environmentBrowsePlatform } from "./ProjectDirectoryField";
import { ProjectDirectorySection } from "./ProjectDirectorySection";
import {
  EMPTY_ATTACH_PROJECT_DIRECTORY_DRAFT,
  planAttachProjectDirectory,
  type AttachProjectDirectoryDraft,
  type ProjectWorkspacePromptResult,
  type ProjectWorkspaceTarget,
} from "./projectWorkspace.logic";
import {
  completeProjectWorkspacePromptClose,
  readProjectWorkspacePromptState,
  registerProjectWorkspacePromptHost,
  respondToProjectWorkspacePrompt,
  subscribeProjectWorkspacePrompt,
} from "./projectWorkspacePrompt";
import { useAttachProjectDirectory } from "./useProjectWorkspaceCommands";

/**
 * Roots already spoken for in this environment, so the dialog can say so on the field instead of
 * letting the server answer `Active project '<id>' already exists for workspace root '<path>'.`
 */
export function useOccupiedWorkspaceRoots(
  environmentId: EnvironmentId | null,
  exceptProjectId?: string,
): ReadonlyArray<string> {
  const projects = useUnscopedProjects();
  return useMemo(
    () =>
      environmentId === null
        ? []
        : projects.flatMap((project) =>
            project.environmentId === environmentId &&
            project.id !== exceptProjectId &&
            project.workspaceRoot !== null
              ? [project.workspaceRoot]
              : [],
          ),
    [environmentId, exceptProjectId, projects],
  );
}

export function useEnvironmentBrowsePlatform(environmentId: EnvironmentId | null): string {
  const { environments } = useEnvironments();
  return useMemo(() => {
    const environment = environments.find((candidate) => candidate.environmentId === environmentId);
    return environmentBrowsePlatform(environment?.serverConfig?.environment.platform.os);
  }, [environmentId, environments]);
}

export function AttachProjectDirectoryDialog({
  open,
  project,
  reason,
  onOpenChange,
  onOpenChangeComplete,
  onAttached,
}: {
  open: boolean;
  project: ProjectWorkspaceTarget | null;
  reason?: string | null;
  onOpenChange: (open: boolean) => void;
  onOpenChangeComplete?: (open: boolean) => void;
  onAttached: (workspaceRoot: string) => void;
}) {
  const environmentId = project?.environmentId ?? null;
  const platform = useEnvironmentBrowsePlatform(environmentId);
  const occupiedWorkspaceRoots = useOccupiedWorkspaceRoots(environmentId, project?.id);
  const attachDirectory = useAttachProjectDirectory();
  const [draft, setDraft] = useState<AttachProjectDirectoryDraft>(
    EMPTY_ATTACH_PROJECT_DIRECTORY_DRAFT,
  );
  const [submitting, setSubmitting] = useState(false);
  const [writeError, setWriteError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setDraft(EMPTY_ATTACH_PROJECT_DIRECTORY_DRAFT);
    setSubmitting(false);
    setWriteError(null);
  }, [open, project?.id]);

  const plan = useMemo(
    () =>
      planAttachProjectDirectory({
        draft,
        platform,
        currentProjectCwd: null,
        occupiedWorkspaceRoots,
      }),
    [draft, occupiedWorkspaceRoots, platform],
  );

  const submit = () => {
    if (plan.kind !== "attach" || submitting || project === null) return;
    setSubmitting(true);
    setWriteError(null);
    void (async () => {
      const outcome = await attachDirectory({
        environmentId: project.environmentId,
        projectId: project.id,
        plan,
      });
      setSubmitting(false);
      if (!outcome.ok) {
        setWriteError(outcome.message);
        return;
      }
      onAttached(outcome.value);
    })();
  };

  return (
    <Dialog
      onOpenChange={(next) => {
        if (!submitting) onOpenChange(next);
      }}
      {...(onOpenChangeComplete ? { onOpenChangeComplete } : {})}
      open={open}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Set a directory for {project?.title ?? "this project"}</DialogTitle>
          <DialogDescription>
            {reason ??
              "This project was created from a name alone. Pick the directory its work happens in."}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-3">
          <ProjectDirectorySection
            autoFocus
            currentProjectCwd={null}
            disabled={submitting}
            draft={draft}
            environmentId={environmentId}
            onChange={setDraft}
            platform={platform}
          />
          {plan.kind === "invalid" ? (
            <p className="text-xs text-destructive-foreground">{plan.message}</p>
          ) : writeError !== null ? (
            <p className="text-xs text-destructive-foreground">{writeError}</p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button
            disabled={submitting}
            onClick={() => onOpenChange(false)}
            size="sm"
            type="button"
            variant="outline"
          >
            Cancel
          </Button>
          <Button
            disabled={plan.kind !== "attach" || submitting}
            onClick={submit}
            size="sm"
            type="button"
          >
            {submitting ? "Attaching…" : "Attach directory"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/** Mount once, near the router root. Renders whatever `requestProjectWorkspace` asks for. */
export function AttachProjectDirectoryHost() {
  const state = useSyncExternalStore(
    subscribeProjectWorkspacePrompt,
    readProjectWorkspacePromptState,
    readProjectWorkspacePromptState,
  );

  useEffect(() => registerProjectWorkspacePromptHost(), []);

  const request = state.status === "idle" ? null : state.request;
  const respond = (result: ProjectWorkspacePromptResult) => {
    respondToProjectWorkspacePrompt(result);
  };

  return (
    <AttachProjectDirectoryDialog
      onAttached={(workspaceRoot) => respond({ workspaceRoot })}
      onOpenChange={(next) => {
        if (!next) respond(null);
      }}
      onOpenChangeComplete={(next) => {
        if (!next) completeProjectWorkspacePromptClose();
      }}
      open={state.status === "prompting"}
      project={request?.project ?? null}
      reason={request?.reason ?? null}
    />
  );
}
