/**
 * Attaching a second machine's checkout to a project that already has one.
 *
 * A project is one thing with many checkouts (ADR 0011), but every existing entry point creates a
 * checkout on the machine you happen to be sitting at. This is the other direction: pick one of the
 * environments this account is connected to, browse *its* filesystem, and point the project at the
 * copy already sitting there.
 *
 * The local checkout and its company-project binding are completed as one UI operation. Repository
 * identity remains a recovery path for a checkout left behind by an interrupted cloud write.
 *
 * @module components/projects/AddProjectConnectionDialog
 */
import type { EnvironmentId, ProjectId } from "@spiritdevs/contracts";
import { useEffect, useMemo, useState } from "react";

import { useEnvironmentControl } from "~/cloud/useEnvironmentControl";
import { useClientSettings, useUpdateClientSettings } from "~/hooks/useSettings";
import { useEnvironments } from "~/state/environments";
import { useProjects } from "~/state/entities";
import { useIssueProjectOptions } from "../issues/useIssueProjectOptions";
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
import { useEnvironmentBrowsePlatform } from "./AttachProjectDirectoryDialog";
import {
  addProjectConnection,
  findReusableProjectConnection,
  type ProjectConnectionCheckout,
} from "./addProjectConnection.logic";
import { ProjectDirectorySection } from "./ProjectDirectorySection";
import {
  EMPTY_ATTACH_PROJECT_DIRECTORY_DRAFT,
  planQuickCreateProject,
  type AttachProjectDirectoryDraft,
} from "./projectWorkspace.logic";
import { useQuickCreateProject } from "./useProjectWorkspaceCommands";
import { projectRepositoryChoiceSettings } from "./projectRepositoryChoice.logic";

export function AddProjectConnectionDialog({
  open,
  projectId,
  projectKey,
  projectTitle,
  onOpenChange,
}: {
  open: boolean;
  /** Any local id represented by the company project being connected. */
  readonly projectId: ProjectId;
  /** The exact logical project this new physical checkout joins. */
  readonly projectKey: string;
  /** The name the new entry takes, so both checkouts present as one project. */
  readonly projectTitle: string;
  onOpenChange: (open: boolean) => void;
}) {
  const { environments } = useEnvironments();
  const environmentControl = useEnvironmentControl();
  const issueProjects = useIssueProjectOptions();
  const projects = useProjects();
  const clientSettings = useClientSettings();
  const updateClientSettings = useUpdateClientSettings();
  const quickCreateProject = useQuickCreateProject();
  const [environmentId, setEnvironmentId] = useState<EnvironmentId | null>(null);
  const [directory, setDirectory] = useState<AttachProjectDirectoryDraft>(
    EMPTY_ATTACH_PROJECT_DIRECTORY_DRAFT,
  );
  const [submitting, setSubmitting] = useState(false);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [pendingCheckout, setPendingCheckout] = useState<{
    readonly environmentId: EnvironmentId;
    readonly requestedWorkspaceRoot: string;
    readonly checkout: ProjectConnectionCheckout;
  } | null>(null);

  const companyProject = useMemo(
    () => issueProjects.find((project) => project.projectIds.includes(projectId)) ?? null,
    [issueProjects, projectId],
  );

  // Only connected environments: browsing is a live call against the environment's own
  // filesystem, so an offline machine could offer nothing but a text field and a failure.
  const candidates = useMemo(
    () => environments.filter((environment) => environment.connection.phase === "connected"),
    [environments],
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
  const plan = useMemo(
    () =>
      planQuickCreateProject({
        draft: { name: projectTitle, directory },
        platform,
        currentProjectCwd: null,
      }),
    [directory, platform, projectTitle],
  );
  // A name with no directory is a valid quick-create but not a valid connection: the whole point
  // here is the checkout on the other machine.
  const ready =
    plan.kind === "create" &&
    plan.workspaceRoot !== null &&
    selectedEnvironmentId !== null &&
    environmentControl !== null &&
    companyProject?.companyId != null &&
    companyProject.companyProject !== null;

  const submit = () => {
    if (
      !ready ||
      submitting ||
      plan.kind !== "create" ||
      plan.workspaceRoot === null ||
      selectedEnvironmentId === null ||
      environmentControl === null ||
      companyProject?.companyId == null ||
      companyProject.companyProject === null
    ) {
      return;
    }
    const requestedWorkspaceRoot = plan.workspaceRoot;
    const companyId = companyProject.companyId;
    const cloudProjectId = companyProject.companyProject.id;
    setSubmitting(true);
    setWriteError(null);
    void (async () => {
      const remembered =
        pendingCheckout?.environmentId === selectedEnvironmentId &&
        pendingCheckout.requestedWorkspaceRoot === requestedWorkspaceRoot
          ? pendingCheckout.checkout
          : null;
      const existingCheckout =
        remembered ??
        findReusableProjectConnection({
          projects,
          environmentId: selectedEnvironmentId,
          workspaceRoot: requestedWorkspaceRoot,
        });
      const outcome = await addProjectConnection({
        existingCheckout,
        createCheckout: () => quickCreateProject({ environmentId: selectedEnvironmentId, plan }),
        bindCheckout: (checkout) =>
          environmentControl.ensureEnvironmentProject({
            companyId,
            cloudProjectId,
            project: checkout,
          }),
      });
      setSubmitting(false);
      if (!outcome.ok) {
        if (outcome.checkout !== null) {
          setPendingCheckout({
            environmentId: selectedEnvironmentId,
            requestedWorkspaceRoot,
            checkout: outcome.checkout,
          });
        }
        setWriteError(outcome.message);
        return;
      }
      updateClientSettings(
        projectRepositoryChoiceSettings({
          settings: clientSettings,
          environmentId: outcome.checkout.environmentId,
          workspaceRoot: outcome.checkout.workspaceRoot ?? requestedWorkspaceRoot,
          choice: { kind: "existing", projectKey },
        }),
      );
      setPendingCheckout(null);
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
            Choose any connected environment and directory for “{projectTitle}”. Multiple
            directories on the same environment can run work concurrently.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-3">
          {candidates.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No connected environment is available. Connect one, or wait for it to come online, and
              its directories become browsable here.
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
          {companyProject?.companyId == null || companyProject.companyProject === null ? (
            <p className="text-xs text-muted-foreground">
              This project's company connection is still syncing.
            </p>
          ) : null}
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
