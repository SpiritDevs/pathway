/**
 * Attaching a second machine's checkout to a project that already has one.
 *
 * A project is one thing with many checkouts (ADR 0011), but every existing entry point creates a
 * checkout on the machine you happen to be sitting at. This is the other direction: pick one of the
 * environments this account is connected to, browse *its* filesystem, and point the project at the
 * copy already sitting there.
 *
 * Grouping is by repository identity, so a directory holding the same git repository folds into
 * this project by itself; one that holds something else becomes its own project instead, which is
 * what the description tells you before you commit to a path.
 *
 * @module components/projects/AddProjectConnectionDialog
 */
import type { EnvironmentId } from "@spiritdevs/contracts";
import { useEffect, useMemo, useState } from "react";

import { useEnvironments } from "~/state/environments";
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
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import {
  useEnvironmentBrowsePlatform,
  useOccupiedWorkspaceRoots,
} from "./AttachProjectDirectoryDialog";
import { ProjectDirectorySection } from "./ProjectDirectorySection";
import {
  EMPTY_ATTACH_PROJECT_DIRECTORY_DRAFT,
  planQuickCreateProject,
  type AttachProjectDirectoryDraft,
} from "./projectWorkspace.logic";
import { useQuickCreateProject } from "./useProjectWorkspaceCommands";

export function AddProjectConnectionDialog({
  open,
  projectTitle,
  connectedEnvironmentIds,
  onOpenChange,
}: {
  open: boolean;
  /** The name the new entry takes, so both checkouts present as one project. */
  readonly projectTitle: string;
  /** Environments this project already has a checkout on; they are not offered again. */
  readonly connectedEnvironmentIds: ReadonlyArray<EnvironmentId>;
  onOpenChange: (open: boolean) => void;
}) {
  const { environments } = useEnvironments();
  const quickCreateProject = useQuickCreateProject();
  const [environmentId, setEnvironmentId] = useState<EnvironmentId | null>(null);
  const [directory, setDirectory] = useState<AttachProjectDirectoryDraft>(
    EMPTY_ATTACH_PROJECT_DIRECTORY_DRAFT,
  );
  const [submitting, setSubmitting] = useState(false);
  const [writeError, setWriteError] = useState<string | null>(null);

  // Only connected environments: browsing is a live call against the environment's own
  // filesystem, so an offline machine could offer nothing but a text field and a failure.
  const candidates = useMemo(
    () =>
      environments.filter(
        (environment) =>
          environment.connection.phase === "connected" &&
          !connectedEnvironmentIds.includes(environment.environmentId),
      ),
    [connectedEnvironmentIds, environments],
  );
  // Derived rather than stored, so an environment list that settles a moment after the dialog
  // opens still gets a default without an effect that could wipe a half-typed path.
  const selectedEnvironmentId = environmentId ?? candidates[0]?.environmentId ?? null;

  useEffect(() => {
    if (!open) return;
    setEnvironmentId(null);
    setDirectory(EMPTY_ATTACH_PROJECT_DIRECTORY_DRAFT);
    setSubmitting(false);
    setWriteError(null);
  }, [open]);

  const platform = useEnvironmentBrowsePlatform(selectedEnvironmentId);
  const occupiedWorkspaceRoots = useOccupiedWorkspaceRoots(selectedEnvironmentId);
  const plan = useMemo(
    () =>
      planQuickCreateProject({
        draft: { name: projectTitle, directory },
        platform,
        currentProjectCwd: null,
        occupiedWorkspaceRoots,
      }),
    [directory, occupiedWorkspaceRoots, platform, projectTitle],
  );
  // A name with no directory is a valid quick-create but not a valid connection: the whole point
  // here is the checkout on the other machine.
  const ready =
    plan.kind === "create" && plan.workspaceRoot !== null && selectedEnvironmentId !== null;

  const submit = () => {
    if (!ready || submitting || plan.kind !== "create" || selectedEnvironmentId === null) return;
    setSubmitting(true);
    setWriteError(null);
    void (async () => {
      const outcome = await quickCreateProject({ environmentId: selectedEnvironmentId, plan });
      setSubmitting(false);
      if (!outcome.ok) {
        setWriteError(outcome.message);
        return;
      }
      onOpenChange(false);
    })();
  };

  return (
    <Dialog
      onOpenChange={(next) => {
        if (!submitting) onOpenChange(next);
      }}
      open={open}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add a connection</DialogTitle>
          <DialogDescription>
            Point “{projectTitle}” at the copy on another environment. A directory holding the same
            repository joins this project automatically.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-3">
          {candidates.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No other connected environment is available. Connect one, or wait for it to come
              online, and its directories become browsable here.
            </p>
          ) : (
            <>
              <Select
                aria-label="Environment"
                disabled={submitting}
                onValueChange={(next) => {
                  if (next === null) return;
                  setEnvironmentId(next as EnvironmentId);
                  setDirectory(EMPTY_ATTACH_PROJECT_DIRECTORY_DRAFT);
                }}
                value={selectedEnvironmentId}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Choose an environment">
                    {candidates.find(
                      (candidate) => candidate.environmentId === selectedEnvironmentId,
                    )?.label ?? null}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {candidates.map((candidate) => (
                    <SelectItem key={candidate.environmentId} value={candidate.environmentId}>
                      {candidate.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
              <ProjectDirectorySection
                currentProjectCwd={null}
                disabled={submitting}
                draft={directory}
                environmentId={selectedEnvironmentId}
                onChange={setDirectory}
                platform={platform}
              />
            </>
          )}
          {writeError === null ? null : <p className="text-xs text-destructive">{writeError}</p>}
        </DialogPanel>
        <DialogFooter>
          <Button disabled={submitting} onClick={() => onOpenChange(false)} variant="outline">
            Cancel
          </Button>
          <Button disabled={!ready || submitting} onClick={submit}>
            {submitting ? "Adding…" : "Add connection"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
