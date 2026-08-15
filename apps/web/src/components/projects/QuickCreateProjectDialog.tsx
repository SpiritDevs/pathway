/**
 * "New project" as a single text field.
 *
 * The tracker's whole reason for nullable `workspaceRoot` is that a planning container should cost
 * one line of typing (`docs/internals/decisions/0006-issue-tracker.md`, "Projects"), so the default
 * shape here is a name and nothing else. The directory section is collapsed behind a disclosure and
 * reuses the attach dialog's internals verbatim, which is what makes "name now, directory later"
 * and "both now" the same code path.
 *
 * @module components/projects/QuickCreateProjectDialog
 */
import type { EnvironmentId } from "@spiritdevs/contracts";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

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
import { Input } from "../ui/input";
import {
  useEnvironmentBrowsePlatform,
  useOccupiedWorkspaceRoots,
} from "./AttachProjectDirectoryDialog";
import { ProjectDirectorySection } from "./ProjectDirectorySection";
import {
  EMPTY_ATTACH_PROJECT_DIRECTORY_DRAFT,
  EMPTY_QUICK_CREATE_PROJECT_DRAFT,
  planQuickCreateProject,
  type QuickCreateProjectDraft,
  type QuickCreateProjectResult,
} from "./projectWorkspace.logic";
import { useQuickCreateProject } from "./useProjectWorkspaceCommands";

export function QuickCreateProjectDialog({
  open,
  environmentId,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  /** Where the project lands. Issues are environment-scoped, so callers pass the primary id. */
  environmentId: EnvironmentId | null;
  onOpenChange: (open: boolean) => void;
  onCreated?: (result: QuickCreateProjectResult) => void;
}) {
  const platform = useEnvironmentBrowsePlatform(environmentId);
  const occupiedWorkspaceRoots = useOccupiedWorkspaceRoots(environmentId);
  const quickCreateProject = useQuickCreateProject();
  const nameRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<QuickCreateProjectDraft>(EMPTY_QUICK_CREATE_PROJECT_DRAFT);
  const [submitting, setSubmitting] = useState(false);
  const [writeError, setWriteError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setDraft(EMPTY_QUICK_CREATE_PROJECT_DRAFT);
    setSubmitting(false);
    setWriteError(null);
    const frame = window.requestAnimationFrame(() => nameRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  const plan = useMemo(
    () =>
      planQuickCreateProject({
        draft,
        platform,
        currentProjectCwd: null,
        occupiedWorkspaceRoots,
      }),
    [draft, occupiedWorkspaceRoots, platform],
  );

  const submit = () => {
    if (plan.kind !== "create" || submitting || environmentId === null) return;
    setSubmitting(true);
    setWriteError(null);
    void (async () => {
      const outcome = await quickCreateProject({ environmentId, plan });
      setSubmitting(false);
      if (!outcome.ok) {
        setWriteError(outcome.message);
        return;
      }
      onCreated?.(outcome.value);
      onOpenChange(false);
    })();
  };

  const directoryOpen = draft.directory !== null;

  return (
    <Dialog
      onOpenChange={(next) => {
        if (!submitting) onOpenChange(next);
      }}
      open={open}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>New project</DialogTitle>
          <DialogDescription>
            A project can be a name on its own. Attach a directory whenever the work needs one.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-3">
          <Input
            aria-label="Project name"
            disabled={submitting}
            onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
            onKeyDown={(event) => {
              // Enter submits from the name field only: inside the directory section it would
              // fire while someone is halfway through typing a path.
              if (event.key !== "Enter") return;
              event.preventDefault();
              submit();
            }}
            placeholder="Project name"
            ref={nameRef}
            value={draft.name}
          />
          <button
            className="flex items-center gap-1 text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            disabled={submitting}
            onClick={() =>
              setDraft((current) => ({
                ...current,
                directory: current.directory === null ? EMPTY_ATTACH_PROJECT_DIRECTORY_DRAFT : null,
              }))
            }
            type="button"
          >
            {directoryOpen ? (
              <ChevronDownIcon className="size-3.5" />
            ) : (
              <ChevronRightIcon className="size-3.5" />
            )}
            Set a directory now
          </button>
          {draft.directory !== null ? (
            <ProjectDirectorySection
              currentProjectCwd={null}
              disabled={submitting}
              draft={draft.directory}
              environmentId={environmentId}
              onChange={(directory) => setDraft((current) => ({ ...current, directory }))}
              platform={platform}
            />
          ) : null}
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
            disabled={plan.kind !== "create" || submitting || environmentId === null}
            onClick={submit}
            size="sm"
            type="button"
          >
            {submitting ? "Creating…" : "Create project"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
