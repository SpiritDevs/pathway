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
import { scopedProjectKey, scopeProjectRef } from "@spiritdevs/client-runtime/environment";
import { newProjectId } from "~/lib/utils";
import { ProjectOwnerSelect, useProjectOwner } from "./ProjectOwnerSelect";
import { PERSONAL_PROJECT_OWNER } from "./projectOwner.logic";
import {
  markProjectAutomaticAssignmentPending,
  clearProjectAutomaticAssignmentPending,
} from "./projectAutomaticAssignmentState";
import type { EnvironmentId } from "@spiritdevs/contracts";
import { CompanyId } from "@spiritdevs/contracts/company";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { useClientSettings, useUpdateClientSettings } from "~/hooks/useSettings";
import { useEnvironmentControl } from "~/cloud/useEnvironmentControl";
import type { SidebarProjectSnapshot } from "~/sidebarProjectGrouping";
import { useEnvironments } from "~/state/environments";
import { projectEnvironment } from "~/state/projects";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
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
import { useProjectGroups } from "./useProjectGroups";
import { useWorkspaceProjects } from "./useWorkspaceProjects";
import { ProjectRepositoryChoiceDialog } from "./ProjectRepositoryChoiceDialog";
import {
  findProjectsForRepository,
  projectRepositoryChoiceSettings,
  type ProjectRepositoryChoice,
} from "./projectRepositoryChoice.logic";

export function QuickCreateProjectDialog({
  open,
  environmentId,
  onOpenChange,
  onCreated,
  initialOwner,
  startThread = false,
}: {
  open: boolean;
  initialOwner?: string;
  /** Agent Threads needs a runnable folder; issue creation can stay planning-only. */
  startThread?: boolean;
  /** Where the project lands. Issues are environment-scoped, so callers pass the primary id. */
  environmentId: EnvironmentId | null;
  onOpenChange: (open: boolean) => void;
  onCreated?: (result: QuickCreateProjectResult, companyId: CompanyId) => void | Promise<void>;
}) {
  const platform = useEnvironmentBrowsePlatform(environmentId);
  const occupiedWorkspaceRoots = useOccupiedWorkspaceRoots(environmentId);
  const quickCreateProject = useQuickCreateProject();
  const inspectProjectDirectory = useAtomCommand(projectEnvironment.inspectDirectory, {
    reportFailure: false,
  });
  const { environments } = useEnvironments();
  const projectGroups = useProjectGroups();
  const workspaceProjects = useWorkspaceProjects();
  const { owner, setSelectedOwner, options } = useProjectOwner(initialOwner);
  const environmentControl = useEnvironmentControl();
  const clientSettings = useClientSettings();
  const updateClientSettings = useUpdateClientSettings();
  const nameRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<QuickCreateProjectDraft>(EMPTY_QUICK_CREATE_PROJECT_DRAFT);
  const [submitting, setSubmitting] = useState(false);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [repositoryChoiceCandidates, setRepositoryChoiceCandidates] = useState<
    ReadonlyArray<{
      readonly group: SidebarProjectSnapshot;
      readonly companyId: CompanyId | null;
      readonly cloudProjectId: string | null;
    }>
  >([]);

  useEffect(() => {
    if (!open) return;
    setSelectedOwner(initialOwner ?? null);
    setDraft(EMPTY_QUICK_CREATE_PROJECT_DRAFT);
    setSubmitting(false);
    setWriteError(null);
    setRepositoryChoiceCandidates([]);
    const frame = window.requestAnimationFrame(() => nameRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [open, initialOwner, setSelectedOwner]);

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

  const create = (choice: ProjectRepositoryChoice | null) => {
    if (plan.kind !== "create" || submitting || environmentId === null) return;
    setSubmitting(true);
    setWriteError(null);
    void (async () => {
      if (environmentControl === null) {
        setWriteError("Connect to Pathway Cloud to create a project.");
        setSubmitting(false);
        return;
      }
      const projectId = newProjectId();
      const assignmentKey = scopedProjectKey(scopeProjectRef(environmentId, projectId));
      try {
        const companyId =
          owner === PERSONAL_PROJECT_OWNER
            ? await environmentControl.provisionPersonalWorkspace()
            : CompanyId.make(owner);
        const selectedTarget =
          choice?.kind === "existing"
            ? repositoryChoiceCandidates.find(
                (candidate) => candidate.group.projectKey === choice.projectKey,
              )
            : null;
        markProjectAutomaticAssignmentPending(assignmentKey, {
          companyId: selectedTarget?.companyId ?? companyId,
          cloudProjectId: selectedTarget?.cloudProjectId ?? null,
          ...(choice?.kind === "new" ? { matchRepository: false } : {}),
        });
        const outcome = await quickCreateProject({ environmentId, plan, projectId });
        if (!outcome.ok) {
          setWriteError(outcome.message);
          return;
        }
        if (choice !== null && outcome.value.workspaceRoot !== null) {
          updateClientSettings(
            projectRepositoryChoiceSettings({
              settings: clientSettings,
              environmentId,
              workspaceRoot: outcome.value.workspaceRoot,
              choice,
            }),
          );
        }
        await environmentControl.ensureEnvironmentProject({
          companyId: selectedTarget?.companyId ?? companyId,
          ...(selectedTarget?.cloudProjectId != null
            ? { cloudProjectId: selectedTarget.cloudProjectId }
            : choice?.kind === "new"
              ? { matchRepository: false }
              : {}),
          project: {
            environmentId: outcome.value.environmentId,
            id: outcome.value.projectId,
            title: outcome.value.title,
            workspaceRoot: outcome.value.workspaceRoot,
            internalWorkspaceRoot: outcome.value.internalWorkspaceRoot ?? null,
            repositoryIdentity: outcome.value.repositoryIdentity ?? null,
          },
        });
        setRepositoryChoiceCandidates([]);
        try {
          await onCreated?.(outcome.value, selectedTarget?.companyId ?? companyId);
        } catch (cause) {
          toastManager.add({
            type: "error",
            title: "Project created, but the thread could not open",
            description: cause instanceof Error ? cause.message : "An error occurred.",
          });
        }
        onOpenChange(false);
      } catch (cause) {
        toastManager.add({
          type: "error",
          title: "Could not save project ownership",
          description: cause instanceof Error ? cause.message : "An error occurred.",
        });
      } finally {
        clearProjectAutomaticAssignmentPending(assignmentKey);
        setSubmitting(false);
      }
    })();
  };

  const submit = () => {
    if (plan.kind !== "create" || submitting || environmentId === null) return;
    const workspaceRoot = plan.workspaceRoot;
    const environment = environments.find((candidate) => candidate.environmentId === environmentId);
    if (
      workspaceRoot === null ||
      environment?.descriptor?.capabilities.projectDirectoryInspection !== true
    ) {
      create(null);
      return;
    }

    setSubmitting(true);
    setWriteError(null);
    void inspectProjectDirectory({ environmentId, input: { cwd: workspaceRoot } }).then(
      (inspection) => {
        setSubmitting(false);
        if (inspection._tag === "Success") {
          const candidates = findProjectsForRepository(
            projectGroups,
            inspection.value.repositoryIdentity,
          );
          if (candidates.length > 0) {
            setRepositoryChoiceCandidates(
              candidates.map((group) => {
                const workspaceProject = workspaceProjects.find(
                  (project) => project.group?.projectKey === group.projectKey,
                );
                return {
                  group,
                  companyId:
                    workspaceProject?.companyIds[0] === undefined
                      ? null
                      : CompanyId.make(workspaceProject.companyIds[0]),
                  cloudProjectId: workspaceProject?.cloudProjectId ?? null,
                };
              }),
            );
            return;
          }
        }
        create(null);
      },
    );
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
        <ProjectOwnerSelect
          owner={owner}
          options={options}
          onChange={setSelectedOwner}
          disabled={submitting}
        />
        <DialogHeader>
          <DialogTitle>New project</DialogTitle>
          <DialogDescription>
            {startThread
              ? "Name your project. Files are kept in Pathway until you attach your own directory."
              : "A project can be a name on its own. Attach a directory whenever the work needs one."}
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
      <ProjectRepositoryChoiceDialog
        candidates={repositoryChoiceCandidates.map((candidate) => candidate.group)}
        onConfirm={create}
        onOpenChange={(next) => {
          if (!next) setRepositoryChoiceCandidates([]);
        }}
        open={repositoryChoiceCandidates.length > 0}
        projectName={draft.name.trim() || "this directory"}
        submitting={submitting}
      />
    </Dialog>
  );
}
