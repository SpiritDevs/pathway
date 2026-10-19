/**
 * Turns a company-only project into a runnable checkout without leaving its settings sheet.
 *
 * The local project is created first, then explicitly bound to the existing company project. If
 * the cloud write fails, the created checkout is retained in state so Retry only repeats the bind
 * rather than creating a duplicate project or directory.
 *
 * @module components/projects/PendingProjectSetup
 */
import type { EnvironmentId } from "@spiritdevs/contracts";
import type { CompanyId } from "@spiritdevs/contracts/company";
import { useId, useMemo, useState } from "react";

import { useEnvironmentControl } from "~/cloud/useEnvironmentControl";
import { useEnvironments } from "~/state/environments";
import { Button } from "../ui/button";
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
  type QuickCreateProjectResult,
} from "./projectWorkspace.logic";
import { useQuickCreateProject } from "./useProjectWorkspaceCommands";
import type { WorkspaceProject } from "./workspaceProjects.logic";

// #region DEBUG
function debugPendingProjectSetup(
  event: string,
  fields: Readonly<Record<string, string | number | boolean | null>>,
): void {
  void fetch("/api/__debug/cloud-sync", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hypothesis: "H4", event, fields }),
  }).catch(() => undefined);
}
// #endregion DEBUG

export interface PendingProjectSetupProps {
  readonly project: WorkspaceProject;
}

export function PendingProjectSetup({ project }: PendingProjectSetupProps) {
  const environmentLabelId = useId();
  const { environments } = useEnvironments();
  const control = useEnvironmentControl();
  const createProject = useQuickCreateProject();
  const [environmentId, setEnvironmentId] = useState<EnvironmentId | null>(null);
  const [directory, setDirectory] = useState<AttachProjectDirectoryDraft>(
    EMPTY_ATTACH_PROJECT_DIRECTORY_DRAFT,
  );
  const [createdCheckout, setCreatedCheckout] = useState<QuickCreateProjectResult | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [complete, setComplete] = useState(false);

  const candidates = useMemo(
    () => environments.filter((environment) => environment.connection.phase === "connected"),
    [environments],
  );
  const selectedEnvironmentId =
    candidates.find((candidate) => candidate.environmentId === environmentId)?.environmentId ??
    candidates[0]?.environmentId ??
    null;
  const platform = useEnvironmentBrowsePlatform(selectedEnvironmentId);
  const occupiedWorkspaceRoots = useOccupiedWorkspaceRoots(selectedEnvironmentId);
  const plan = useMemo(
    () =>
      planQuickCreateProject({
        draft: { name: project.displayName, directory },
        platform,
        currentProjectCwd: null,
        occupiedWorkspaceRoots,
      }),
    [directory, occupiedWorkspaceRoots, platform, project.displayName],
  );
  const companyId = project.companyIds[0] as CompanyId | undefined;
  const canSubmit =
    !complete &&
    !submitting &&
    selectedEnvironmentId !== null &&
    control !== null &&
    companyId !== undefined &&
    project.cloudProjectId !== null &&
    (createdCheckout !== null || (plan.kind === "create" && plan.workspaceRoot !== null));

  const submit = async () => {
    if (!canSubmit || companyId === undefined || project.cloudProjectId === null) return;
    setSubmitting(true);
    setWriteError(null);
    // #region DEBUG
    debugPendingProjectSetup("pending-setup-submitted", {
      environmentSelected: selectedEnvironmentId !== null,
      checkoutAlreadyCreated: createdCheckout !== null,
    });
    // #endregion DEBUG
    try {
      let checkout = createdCheckout;
      if (checkout === null) {
        if (plan.kind !== "create" || selectedEnvironmentId === null) return;
        const created = await createProject({ environmentId: selectedEnvironmentId, plan });
        if (!created.ok) {
          // #region DEBUG
          debugPendingProjectSetup("pending-setup-create-failed", {
            messageAvailable: created.message !== null,
          });
          // #endregion DEBUG
          setWriteError(created.message);
          return;
        }
        checkout = created.value;
        setCreatedCheckout(checkout);
        // #region DEBUG
        debugPendingProjectSetup("pending-setup-checkout-created", {});
        // #endregion DEBUG
      }

      await control.ensureEnvironmentProject({
        companyId,
        cloudProjectId: project.cloudProjectId,
        project: {
          environmentId: checkout.environmentId,
          id: checkout.projectId,
          title: checkout.title,
          workspaceRoot: checkout.workspaceRoot,
        },
      });
      setComplete(true);
      // #region DEBUG
      debugPendingProjectSetup("pending-setup-completed", {});
      // #endregion DEBUG
    } catch (error) {
      // #region DEBUG
      debugPendingProjectSetup("pending-setup-link-failed", {
        errorType: error instanceof Error ? error.name : "unknown",
      });
      // #endregion DEBUG
      setWriteError(error instanceof Error ? error.message : "The checkout could not be attached.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form
      className="space-y-4 rounded-xl border border-border/70 bg-muted/15 p-3"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">Finish setting up this project</p>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Choose the machine and directory where agents will work. Pathway creates the local
          checkout and links it to this company project.
        </p>
      </div>

      {candidates.length === 0 ? (
        <p className="text-xs text-warning-foreground" role="status">
          Connect an environment before setting up this project.
        </p>
      ) : (
        <>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-foreground" id={environmentLabelId}>
              Environment
            </label>
            <Select
              aria-labelledby={environmentLabelId}
              disabled={submitting || createdCheckout !== null}
              onValueChange={(next) => {
                if (next === null) return;
                setEnvironmentId(next as EnvironmentId);
                setDirectory(EMPTY_ATTACH_PROJECT_DIRECTORY_DRAFT);
                setWriteError(null);
              }}
              value={selectedEnvironmentId}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Choose an environment">
                  {candidates.find((candidate) => candidate.environmentId === selectedEnvironmentId)
                    ?.label ?? null}
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
          </div>
          <ProjectDirectorySection
            currentProjectCwd={null}
            disabled={submitting || createdCheckout !== null}
            draft={directory}
            environmentId={selectedEnvironmentId}
            onChange={(next) => {
              setDirectory(next);
              setWriteError(null);
            }}
            platform={platform}
          />
        </>
      )}

      {plan.kind === "invalid" && createdCheckout === null ? (
        <p className="text-xs text-destructive-foreground" role="alert">
          {plan.message}
        </p>
      ) : writeError !== null ? (
        <p className="text-xs text-destructive-foreground" role="alert">
          {createdCheckout === null
            ? writeError
            : `The checkout was created, but its company link failed: ${writeError}`}
        </p>
      ) : complete ? (
        <p className="text-xs text-success" role="status">
          Setup complete. Project settings will appear when the checkout finishes syncing.
        </p>
      ) : companyId === undefined || project.cloudProjectId === null ? (
        <p className="text-xs text-warning-foreground" role="status">
          Project ownership is still syncing. Try again shortly.
        </p>
      ) : control === null ? (
        <p className="text-xs text-warning-foreground" role="status">
          Sign in to attach this checkout to its company project.
        </p>
      ) : null}

      <div className="flex justify-end">
        <Button disabled={!canSubmit} size="sm" type="submit">
          {complete
            ? "Setup complete"
            : submitting
              ? createdCheckout === null
                ? "Creating checkout…"
                : "Linking checkout…"
              : createdCheckout === null
                ? "Set up project"
                : "Retry company link"}
        </Button>
      </div>
    </form>
  );
}
