/**
 * New project: a name and icon, a Focus, and one folder per environment.
 *
 * Attached folders determine the Git repository, or can be seeded by a new GitHub repository.
 * A new repository is created once, on the first folder's environment; every
 * other folder clones it, so all checkouts share one history. A project may also have no folder
 * at all, which is what the issue flows that open this dialog rely on.
 *
 * @module components/projects/CreateProjectDialog
 */
import { useAtomValue } from "@effect/atom-react";
import { scopedProjectKey, scopeProjectRef } from "@spiritdevs/client-runtime/environment";
import {
  ALL_FOCUS_ID,
  CONVERSATIONS_FOCUS_ID,
  sortFocuses,
} from "@spiritdevs/client-runtime/state/focuses";
import type { EnvironmentId, ProjectId } from "@spiritdevs/contracts";
import type { ProjectIcon } from "@spiritdevs/contracts/cloudProject";
import { CompanyId } from "@spiritdevs/contracts/company";
import { FocusProjectKey, type FocusId } from "@spiritdevs/contracts/focus";
import { FolderIcon, PlusIcon, XIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { activeFocusIdAtom, focusListAtom, focusMutationsAtom } from "~/cloud/focusReadModel";
import { useEnvironmentControl } from "~/cloud/useEnvironmentControl";
import { useClientSettings, useUpdateClientSettings } from "~/hooks/useSettings";
import { derivePhysicalProjectKeyFromPath } from "~/logicalProject";
import { newProjectId } from "~/lib/utils";
import { useEnvironments } from "~/state/environments";
import { useUnscopedProjects } from "~/state/entities";
import { projectEnvironment } from "~/state/projects";
import { useEnvironmentQuery } from "~/state/query";
import { sourceControlEnvironment } from "~/state/sourceControl";
import { useAtomCommand } from "~/state/use-atom-command";
import { vcsEnvironment } from "~/state/vcs";
import { squashAtomCommandFailure } from "@spiritdevs/client-runtime/state/runtime";
import type { SidebarProjectSnapshot } from "~/sidebarProjectGrouping";
import { FocusIcon } from "../focus/FocusIcon";
import { IconColorPicker, LIBRARY_ICON_COLORS } from "../focus/IconColorPicker";
import { ProjectFavicon } from "../ProjectFavicon";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";
import { Switch } from "../ui/switch";
import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group";
import { environmentBrowsePlatform, ProjectDirectoryField } from "./ProjectDirectoryField";
import {
  clearProjectAutomaticAssignmentPending,
  markProjectAutomaticAssignmentPending,
} from "./projectAutomaticAssignmentState";
import { PERSONAL_PROJECT_OWNER } from "./projectOwner.logic";
import { ProjectOwnerSelect, useProjectOwner } from "./ProjectOwnerSelect";
import { ProjectRepositoryChoiceDialog } from "./ProjectRepositoryChoiceDialog";
import {
  findProjectsForRepository,
  projectRepositoryChoiceSettings,
  type ProjectRepositoryChoice,
} from "./projectRepositoryChoice.logic";
import type { QuickCreateProjectResult } from "./projectWorkspace.logic";
import { useQuickCreateProject } from "./useProjectWorkspaceCommands";
import { useProjectGroups } from "./useProjectGroups";
import { useWorkspaceProjects } from "./useWorkspaceProjects";
import {
  canCreateProjectRepository,
  createProjectTitle,
  folderHasRepository,
  inspectProjectFolder,
  projectFolderRepositoryError,
  planCreateProject,
  repositoryNameFromProjectName,
  type CreateProjectPlan,
  type CreateProjectDraft,
  type ProjectFolderDraft,
} from "./createProject.logic";

const NO_FOCUS = "none";
const EMPTY_OWNERS: ReadonlyArray<{ readonly login: string }> = [];

let folderKeySeed = 0;
const emptyFolder = (environmentId: EnvironmentId | null): ProjectFolderDraft => ({
  key: `folder-${++folderKeySeed}`,
  environmentId,
  path: "~/",
  createIfMissing: false,
  inspection: null,
});

const EMPTY_DRAFT: CreateProjectDraft = {
  name: "",
  createRepository: false,
  folders: [],
  newRepository: { owner: "", name: "", visibility: "private" },
};

interface RepositoryChoiceCandidate {
  readonly group: SidebarProjectSnapshot;
  readonly companyId: CompanyId | null;
  readonly cloudProjectId: string | null;
}

export function CreateProjectDialog({
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
  /** Where a folder-less project lands, and the first folder's default environment. */
  environmentId: EnvironmentId | null;
  onOpenChange: (open: boolean) => void;
  onCreated?: (result: QuickCreateProjectResult, companyId: CompanyId) => void | Promise<void>;
}) {
  const { environments } = useEnvironments();
  const projects = useUnscopedProjects();
  const projectGroups = useProjectGroups();
  const workspaceProjects = useWorkspaceProjects();
  const focuses = useAtomValue(focusListAtom);
  const activeFocusId = useAtomValue(activeFocusIdAtom);
  const focusMutations = useAtomValue(focusMutationsAtom);
  const environmentControl = useEnvironmentControl();
  const clientSettings = useClientSettings();
  const updateClientSettings = useUpdateClientSettings();
  const { owner, setSelectedOwner, options: ownerOptions } = useProjectOwner(initialOwner);
  const quickCreateProject = useQuickCreateProject();
  const cloneRepository = useAtomCommand(sourceControlEnvironment.cloneRepository, {
    reportFailure: false,
  });
  const publishRepository = useAtomCommand(sourceControlEnvironment.publishRepository, {
    reportFailure: false,
  });
  const initRepository = useAtomCommand(vcsEnvironment.init, { reportFailure: false });
  const inspectProjectDirectory = useAtomCommand(projectEnvironment.inspectDirectory, {
    reportFailure: false,
  });

  const nameRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<CreateProjectDraft>(EMPTY_DRAFT);
  const [icon, setIcon] = useState<ProjectIcon | null>(null);
  const [focusChoice, setFocusChoice] = useState<string>(NO_FOCUS);
  const [progress, setProgress] = useState<string | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [repositoryChoiceCandidates, setRepositoryChoiceCandidates] = useState<
    ReadonlyArray<RepositoryChoiceCandidate>
  >([]);
  const submitting = progress !== null;

  const connectedEnvironments = useMemo(
    () => environments.filter((environment) => environment.connection.phase === "connected"),
    [environments],
  );
  const orderedFocuses = useMemo(() => sortFocuses(focuses), [focuses]);

  useEffect(() => {
    if (!open) return;
    setSelectedOwner(initialOwner ?? null);
    const firstEnvironment =
      connectedEnvironments.find((candidate) => candidate.environmentId === environmentId)
        ?.environmentId ??
      connectedEnvironments[0]?.environmentId ??
      null;
    // Agent Threads always wants somewhere to run; issue flows start with just a name.
    setDraft({ ...EMPTY_DRAFT, folders: startThread ? [emptyFolder(firstEnvironment)] : [] });
    setIcon(null);
    setFocusChoice(
      activeFocusId === ALL_FOCUS_ID || activeFocusId === CONVERSATIONS_FOCUS_ID
        ? NO_FOCUS
        : activeFocusId,
    );
    setProgress(null);
    setWriteError(null);
    setRepositoryChoiceCandidates([]);
    const frame = window.requestAnimationFrame(() => nameRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
    // Reset only when the dialog opens; later environment/focus changes must not wipe input.
  }, [open]);

  const firstFolder = draft.folders[0] ?? null;
  const canCreateRepository = canCreateProjectRepository(draft.folders);
  const creatingRepository = draft.createRepository && canCreateRepository;
  const availableEnvironments = connectedEnvironments.filter(
    (environment) =>
      !draft.folders.some((folder) => folder.environmentId === environment.environmentId),
  );
  const selectedFocus = orderedFocuses.find((focus) => focus.id === focusChoice);
  const ownersQuery = useEnvironmentQuery(
    open && creatingRepository && firstFolder?.environmentId
      ? sourceControlEnvironment.repositoryOwners({
          environmentId: firstFolder.environmentId,
          input: { provider: "github" },
        })
      : null,
  );
  const repositoryOwners = ownersQuery.data?.owners ?? EMPTY_OWNERS;
  // The signed-in account owns a new repository until the user picks an organization.
  const repositoryOwner = draft.newRepository.owner || (repositoryOwners[0]?.login ?? "");

  const planDraft = (value: CreateProjectDraft) =>
    planCreateProject({
      draft: { ...value, newRepository: { ...value.newRepository, owner: repositoryOwner } },
      platformFor: (id) =>
        environmentBrowsePlatform(
          environments.find((candidate) => candidate.environmentId === id)?.serverConfig
            ?.environment.platform.os,
        ),
      occupiedWorkspaceRootsFor: (id) =>
        projects.flatMap((project) =>
          project.environmentId === id && project.workspaceRoot !== null
            ? [project.workspaceRoot]
            : [],
        ),
    });
  const plan = planDraft(draft);

  const updateFolder = (key: string, patch: Partial<ProjectFolderDraft>) => {
    setWriteError(null);
    setDraft((current) => ({
      ...current,
      folders: current.folders.map((folder) =>
        folder.key === key ? { ...folder, ...patch, inspection: null } : folder,
      ),
    }));
  };
  const addFolder = () =>
    setDraft((current) => {
      const used = new Set(current.folders.map((folder) => folder.environmentId));
      const next =
        connectedEnvironments.find((candidate) => !used.has(candidate.environmentId))
          ?.environmentId ?? null;
      return next === null
        ? current
        : { ...current, folders: [...current.folders, emptyFolder(next)] };
    });

  const inspectFolder = async (folder: ProjectFolderDraft) => {
    const environment = environments.find(
      (candidate) => candidate.environmentId === folder.environmentId,
    );
    if (!folder.environmentId || environment?.connection.phase !== "connected") {
      throw new Error("Connect this environment before attaching a folder.");
    }
    if (environment.descriptor?.capabilities.projectDirectoryInspection !== true) {
      throw new Error("Update Pathway on this environment to check the folder's Git repository.");
    }
    const targetEnvironmentId = folder.environmentId;
    return inspectProjectFolder(folder, (cwd) =>
      unwrap(
        inspectProjectDirectory({
          environmentId: targetEnvironmentId,
          input: { cwd },
        }),
      ),
    );
  };

  const attachFolder = async (key: string, path: string, createIfMissing: boolean) => {
    if (submitting) return false;
    const folder = draft.folders.find((candidate) => candidate.key === key);
    if (!folder) return false;
    setProgress("Checking folder…");
    setWriteError(null);
    try {
      const attached = await inspectFolder({ ...folder, path, createIfMissing });
      const folders = draft.folders.map((candidate) =>
        candidate.key === key ? attached : candidate,
      );
      const error = projectFolderRepositoryError(folders);
      if (error) throw new Error(error);
      setDraft((current) => ({
        ...current,
        createRepository: folderHasRepository(attached) ? false : current.createRepository,
        folders: current.folders.map((candidate) => (candidate.key === key ? attached : candidate)),
      }));
      return true;
    } catch (cause) {
      setWriteError(cause instanceof Error ? cause.message : "The folder could not be checked.");
      return false;
    } finally {
      setProgress(null);
    }
  };

  const run = (
    choice: ProjectRepositoryChoice | null,
    created: Extract<CreateProjectPlan, { kind: "create" }>,
  ) => {
    if (environmentControl === null) {
      setWriteError("Connect to Pathway Cloud to create a project.");
      setProgress(null);
      return;
    }
    const existingTarget =
      choice?.kind === "existing"
        ? (repositoryChoiceCandidates.find(
            (candidate) => candidate.group.projectKey === choice.projectKey,
          ) ?? null)
        : null;
    setProgress("Creating…");
    setWriteError(null);
    void (async () => {
      const results: QuickCreateProjectResult[] = [];
      let grouping: Parameters<typeof projectRepositoryChoiceSettings>[0]["settings"] = {
        sidebarProjectGroupAssignments: clientSettings.sidebarProjectGroupAssignments,
        sidebarProjectGroupingOverrides: clientSettings.sidebarProjectGroupingOverrides,
      };
      let companyId: CompanyId | null = null;
      let cloudProjectId: string | null = existingTarget?.cloudProjectId ?? null;
      // Rows after the first link to the shared repository rather than making their own.
      let sharedRemoteUrl: string | null = null;
      const pendingKeys: string[] = [];
      try {
        companyId =
          existingTarget?.companyId ??
          (owner === PERSONAL_PROJECT_OWNER
            ? await environmentControl.provisionPersonalWorkspace()
            : CompanyId.make(owner));
        const folders =
          created.folders.length > 0
            ? created.folders
            : environmentId === null
              ? []
              : [{ environmentId, workspaceRoot: null, createIfMissing: false }];
        if (folders.length === 0) throw new Error("Connect an environment to create a project.");

        for (const [index, folder] of folders.entries()) {
          let workspaceRoot = folder.workspaceRoot;
          if (workspaceRoot !== null && created.source.kind === "new_repo" && index === 0) {
            setProgress("Creating repository…");
            await unwrap(
              initRepository({
                environmentId: folder.environmentId,
                input: { cwd: workspaceRoot, createDirectory: true },
              }),
            );
            const published = await unwrap(
              publishRepository({
                environmentId: folder.environmentId,
                input: {
                  cwd: workspaceRoot,
                  provider: "github",
                  repository: created.source.repository,
                  visibility: created.source.visibility,
                },
              }),
            );
            sharedRemoteUrl = published.remoteUrl;
          } else if (workspaceRoot !== null && sharedRemoteUrl !== null) {
            setProgress(
              folders.length > 1 ? `Cloning (${index + 1}/${folders.length})…` : "Cloning…",
            );
            const cloned = await unwrap(
              cloneRepository({
                environmentId: folder.environmentId,
                input: {
                  destinationPath: workspaceRoot,
                  remoteUrl: sharedRemoteUrl,
                },
              }),
            );
            workspaceRoot = cloned.cwd;
          }

          setProgress(
            folders.length > 1 ? `Adding folder ${index + 1} of ${folders.length}…` : "Creating…",
          );
          const projectId: ProjectId = newProjectId();
          const assignmentKey = scopedProjectKey(scopeProjectRef(folder.environmentId, projectId));
          pendingKeys.push(assignmentKey);
          markProjectAutomaticAssignmentPending(assignmentKey, {
            companyId,
            cloudProjectId,
            ...(cloudProjectId === null && choice?.kind !== "existing"
              ? { matchRepository: false }
              : {}),
          });
          const outcome = await quickCreateProject({
            environmentId: folder.environmentId,
            projectId,
            plan: {
              kind: "create",
              title: created.title,
              workspaceRoot,
              createWorkspaceRootIfMissing: folder.createIfMissing,
              initializeGit: false,
            },
          });
          if (!outcome.ok) throw new Error(outcome.message ?? "The project could not be created.");
          results.push(outcome.value);

          const boundCloudProjectId = await environmentControl.ensureEnvironmentProject({
            companyId,
            // Repository matching outranks an explicit id on the backend; this project's folders
            // must join it, not an older project that happens to share the repository. Only a
            // chosen existing project with no cloud id yet is found by its repository.
            ...(cloudProjectId !== null ? { cloudProjectId } : {}),
            ...(cloudProjectId === null && choice?.kind === "existing"
              ? {}
              : { matchRepository: false }),
            project: {
              environmentId: outcome.value.environmentId,
              id: outcome.value.projectId,
              title: outcome.value.title,
              workspaceRoot: outcome.value.workspaceRoot,
              internalWorkspaceRoot: outcome.value.internalWorkspaceRoot ?? null,
              repositoryIdentity: outcome.value.repositoryIdentity ?? null,
            },
          });
          cloudProjectId ??= boundCloudProjectId;

          if (outcome.value.workspaceRoot !== null) {
            const first = results[0]!;
            grouping = projectRepositoryChoiceSettings({
              settings: grouping,
              environmentId: outcome.value.environmentId,
              workspaceRoot: outcome.value.workspaceRoot,
              choice:
                choice?.kind === "existing"
                  ? choice
                  : index === 0 || first.workspaceRoot === null
                    ? { kind: "new" }
                    : {
                        kind: "existing",
                        projectKey: derivePhysicalProjectKeyFromPath(
                          first.environmentId,
                          first.workspaceRoot,
                        ),
                      },
            });
          }
        }
        updateClientSettings(grouping);

        setProgress("Finishing…");
        if (icon !== null && cloudProjectId !== null) {
          await environmentControl.setCompanyProjectIcon({ companyId, cloudProjectId, icon });
        }
        if (focusChoice !== NO_FOCUS && focusMutations !== null) {
          for (const result of results) {
            await focusMutations.assignProject({
              focusId: focusChoice as FocusId,
              projectKey: FocusProjectKey.make(`${result.environmentId}:${result.projectId}`),
            });
          }
        }
        setRepositoryChoiceCandidates([]);
        onOpenChange(false);
        try {
          await onCreated?.(results[0]!, companyId);
        } catch (cause) {
          toastManager.add({
            type: "error",
            title: "Project created, but the thread could not open",
            description: cause instanceof Error ? cause.message : "An error occurred.",
          });
        }
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : "An error occurred.";
        if (results.length === 0) {
          setWriteError(message);
        } else {
          // Something already exists; retrying would duplicate it, so hand over to settings.
          toastManager.add({
            type: "error",
            title: `Created “${created.title}”, but setup did not finish`,
            description: `${message} Finish the remaining folders from the project's Connections settings.`,
          });
          updateClientSettings(grouping);
          onOpenChange(false);
        }
      } finally {
        for (const key of pendingKeys) clearProjectAutomaticAssignmentPending(key);
        setProgress(null);
      }
    })();
  };

  const submit = (choice: ProjectRepositoryChoice | null = null) => {
    if (plan.kind !== "create" || submitting) return;
    setProgress("Checking folders…");
    setWriteError(null);
    void (async () => {
      try {
        // Recheck every environment before any writes, including while confirming a project match.
        const folders = await Promise.all(draft.folders.map(inspectFolder));
        const verifiedDraft = { ...draft, folders };
        const verifiedPlan = planDraft(verifiedDraft);
        setDraft(verifiedDraft);
        if (verifiedPlan.kind !== "create") {
          throw new Error(
            verifiedPlan.kind === "invalid"
              ? verifiedPlan.message
              : "Attach each folder before creating the project.",
          );
        }
        if (plan.source.kind === "new_repo" && verifiedPlan.source.kind !== "new_repo") {
          throw new Error(
            "A selected folder now contains Git. Review the attached folders before creating the project.",
          );
        }
        const repository =
          folders.find(folderHasRepository)?.inspection?.repositoryIdentity ?? null;
        if (
          choice?.kind === "existing" &&
          !findProjectsForRepository(projectGroups, repository).some(
            (group) => group.projectKey === choice.projectKey,
          )
        ) {
          throw new Error(
            "The folder's Git repository changed. Review the folders and choose the project again.",
          );
        }
        const candidates =
          choice === null ? findProjectsForRepository(projectGroups, repository) : [];
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
          setProgress(null);
          return;
        }
        run(choice, verifiedPlan);
      } catch (cause) {
        setWriteError(cause instanceof Error ? cause.message : "The folders could not be checked.");
        setRepositoryChoiceCandidates([]);
        setProgress(null);
      }
    })();
  };

  const title = createProjectTitle(draft);
  const errorMessage = plan.kind === "invalid" ? plan.message : (writeError ?? null);

  return (
    <Dialog
      onOpenChange={(next) => {
        if (!submitting) onOpenChange(next);
      }}
      open={open}
    >
      <DialogPopup className="max-w-lg" aria-describedby={undefined}>
        <ProjectOwnerSelect
          owner={owner}
          options={ownerOptions}
          onChange={setSelectedOwner}
          disabled={submitting}
        />
        <DialogHeader>
          <DialogTitle>New project</DialogTitle>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <div className="flex items-center gap-2">
            <ProjectIconButton
              icon={icon}
              onIconChange={setIcon}
              disabled={submitting}
              firstFolder={
                firstFolder?.environmentId && plan.kind === "create" && plan.folders[0]
                  ? {
                      environmentId: firstFolder.environmentId,
                      workspaceRoot: plan.folders[0].workspaceRoot,
                    }
                  : null
              }
            />
            <Input
              aria-label="Project name"
              ref={nameRef}
              disabled={submitting}
              placeholder={title || "Project name"}
              value={draft.name}
              onChange={(event) => {
                const name = event.currentTarget.value;
                setDraft((current) => ({ ...current, name }));
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                submit();
              }}
            />
          </div>

          <label className="flex items-center justify-between gap-3 text-sm">
            <span className="font-medium">Focus</span>
            <Select
              value={focusChoice}
              disabled={submitting}
              onValueChange={(value) => value && setFocusChoice(value)}
              items={[
                { value: NO_FOCUS, label: "None" },
                ...orderedFocuses.map((focus) => ({ value: focus.id, label: focus.name })),
              ]}
            >
              <SelectTrigger
                size="sm"
                aria-label="Focus"
                className="ml-auto w-auto min-w-0 max-w-[75%]"
              >
                <SelectValue>
                  <span className="flex min-w-0 items-center gap-2">
                    {selectedFocus ? (
                      <FocusIcon
                        iconName={selectedFocus.iconName}
                        color={selectedFocus.accentColor}
                        className="size-3.5 shrink-0"
                      />
                    ) : null}
                    <span className="truncate">{selectedFocus?.name ?? "None"}</span>
                  </span>
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value={NO_FOCUS}>None</SelectItem>
                {orderedFocuses.map((focus) => (
                  <SelectItem key={focus.id} value={focus.id}>
                    <span className="flex items-center gap-2">
                      <FocusIcon
                        iconName={focus.iconName}
                        color={focus.accentColor}
                        className="size-3.5"
                      />
                      {focus.name}
                    </span>
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </label>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">Folders</span>
              {availableEnvironments.length > 0 ? (
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  disabled={submitting}
                  onClick={addFolder}
                >
                  <PlusIcon />
                  Add environment
                </Button>
              ) : null}
            </div>
            {draft.folders.length === 0 ? (
              <p className="rounded-lg border border-dashed border-border/70 px-3 py-4 text-center text-xs text-muted-foreground">
                No folder yet. The project keeps its files in Pathway until you add one.
              </p>
            ) : (
              draft.folders.map((folder, index) => (
                <FolderRow
                  key={folder.key}
                  folder={folder}
                  note={
                    creatingRepository
                      ? index === 0
                        ? "The repository is created here."
                        : "Clones the new repository into this folder. The folder must be empty."
                      : folder.inspection
                        ? folderHasRepository(folder)
                          ? "Git repository detected."
                          : "No Git repository in this folder."
                        : null
                  }
                  environments={connectedEnvironments.filter(
                    (candidate) =>
                      candidate.environmentId === folder.environmentId ||
                      !draft.folders.some(
                        (other) => other.environmentId === candidate.environmentId,
                      ),
                  )}
                  platform={environmentBrowsePlatform(
                    environments.find(
                      (candidate) => candidate.environmentId === folder.environmentId,
                    )?.serverConfig?.environment.platform.os,
                  )}
                  disabled={submitting}
                  removable
                  onChange={(patch) => updateFolder(folder.key, patch)}
                  onConfirm={(path, createIfMissing) =>
                    attachFolder(folder.key, path, createIfMissing)
                  }
                  onRemove={() => {
                    setWriteError(null);
                    setDraft((current) => ({
                      ...current,
                      folders: current.folders.filter((candidate) => candidate.key !== folder.key),
                    }));
                  }}
                />
              ))
            )}
          </div>

          {canCreateRepository ? (
            <div className="space-y-3">
              <label className="flex items-center justify-between gap-3 text-sm font-medium">
                Create Git Repository
                <Switch
                  checked={creatingRepository}
                  disabled={submitting}
                  onCheckedChange={(createRepository) =>
                    setDraft((current) => ({ ...current, createRepository }))
                  }
                />
              </label>
              {creatingRepository ? (
                <NewRepositoryFields
                  draft={draft}
                  owner={repositoryOwner}
                  owners={repositoryOwners.map((candidate) => candidate.login)}
                  loadingOwners={ownersQuery.isPending && firstFolder?.environmentId != null}
                  disabled={submitting}
                  onChange={(newRepository) =>
                    setDraft((current) => ({ ...current, newRepository }))
                  }
                />
              ) : null}
            </div>
          ) : null}

          {errorMessage ? (
            <p role="alert" className="text-xs text-destructive-foreground">
              {errorMessage}
            </p>
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
            disabled={plan.kind !== "create" || submitting}
            onClick={() => submit()}
            size="sm"
            type="button"
          >
            {progress ?? "Create project"}
          </Button>
        </DialogFooter>
      </DialogPopup>
      <ProjectRepositoryChoiceDialog
        candidates={repositoryChoiceCandidates.map((candidate) => candidate.group)}
        onConfirm={(choice) => submit(choice)}
        onOpenChange={(next) => {
          if (!next) setRepositoryChoiceCandidates([]);
        }}
        open={repositoryChoiceCandidates.length > 0}
        projectName={title || "this directory"}
        submitting={submitting}
      />
    </Dialog>
  );
}

async function unwrap<A>(
  result: Promise<{ readonly _tag: "Success"; readonly value: A } | { readonly _tag: "Failure" }>,
): Promise<A> {
  const settled = await result;
  if (settled._tag === "Success") return settled.value;
  const error = squashAtomCommandFailure(settled as never);
  throw error instanceof Error ? error : new Error("The operation could not be completed.");
}

/** Shows the chosen library icon, else the favicon detected in the first folder. */
function ProjectIconButton(props: {
  readonly icon: ProjectIcon | null;
  readonly firstFolder: { environmentId: EnvironmentId; workspaceRoot: string } | null;
  readonly disabled: boolean;
  readonly onIconChange: (icon: ProjectIcon | null) => void;
}) {
  const draftIcon = props.icon ?? { name: "Code2", color: LIBRARY_ICON_COLORS[0] };
  return (
    <Popover>
      <PopoverTrigger
        disabled={props.disabled}
        aria-label="Project icon"
        title="Project icon"
        className="flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-lg border border-input bg-background outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
      >
        {props.icon !== null ? (
          <FocusIcon iconName={props.icon.name} color={props.icon.color} className="size-4" />
        ) : props.firstFolder !== null ? (
          <ProjectFavicon
            environmentId={props.firstFolder.environmentId}
            cwd={props.firstFolder.workspaceRoot}
            className="size-4"
          />
        ) : (
          <FolderIcon className="size-4 text-muted-foreground" />
        )}
      </PopoverTrigger>
      <PopoverPopup align="start" className="w-80">
        <IconColorPicker
          subject="Project"
          iconName={draftIcon.name}
          color={draftIcon.color}
          onIconChange={(name) => props.onIconChange({ ...draftIcon, name })}
          onColorChange={(color) => props.onIconChange({ ...draftIcon, color })}
        />
        <Button
          className="mt-3"
          size="xs"
          variant="outline"
          disabled={props.icon === null}
          onClick={() => props.onIconChange(null)}
        >
          Use detected icon
        </Button>
      </PopoverPopup>
    </Popover>
  );
}

function NewRepositoryFields(props: {
  readonly draft: CreateProjectDraft;
  readonly owner: string;
  readonly owners: ReadonlyArray<string>;
  readonly loadingOwners: boolean;
  readonly disabled: boolean;
  readonly onChange: (next: CreateProjectDraft["newRepository"]) => void;
}) {
  const repository = props.draft.newRepository;
  const placeholder =
    repositoryNameFromProjectName(createProjectTitle(props.draft)) || "repository";
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1.3fr)] items-center gap-1.5">
      {props.owners.length > 0 ? (
        <Select
          value={props.owner}
          disabled={props.disabled}
          onValueChange={(owner) => owner && props.onChange({ ...repository, owner })}
        >
          <SelectTrigger size="sm" aria-label="Repository owner">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            {props.owners.map((login) => (
              <SelectItem key={login} value={login}>
                {login}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      ) : (
        <Input
          aria-label="Repository owner"
          placeholder={props.loadingOwners ? "Loading…" : "owner"}
          spellCheck={false}
          disabled={props.disabled}
          value={repository.owner}
          onChange={(event) => props.onChange({ ...repository, owner: event.currentTarget.value })}
        />
      )}
      <span className="text-muted-foreground">/</span>
      <Input
        aria-label="Repository name"
        placeholder={placeholder}
        spellCheck={false}
        disabled={props.disabled}
        value={repository.name}
        onChange={(event) => props.onChange({ ...repository, name: event.currentTarget.value })}
      />
      <ToggleGroup
        value={[repository.visibility]}
        onValueChange={(value) => {
          const visibility = value[0] as "private" | "public" | undefined;
          if (visibility) props.onChange({ ...repository, visibility });
        }}
        size="sm"
        variant="outline"
        className="col-span-3"
        disabled={props.disabled}
      >
        <ToggleGroupItem value="private" className="flex-1">
          Private
        </ToggleGroupItem>
        <ToggleGroupItem value="public" className="flex-1">
          Public
        </ToggleGroupItem>
      </ToggleGroup>
    </div>
  );
}

function FolderRow(props: {
  readonly folder: ProjectFolderDraft;
  readonly note: string | null;
  readonly environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
  }>;
  readonly platform: string;
  readonly disabled: boolean;
  readonly removable: boolean;
  readonly onChange: (patch: Partial<ProjectFolderDraft>) => void;
  readonly onConfirm: (path: string, createIfMissing: boolean) => Promise<boolean>;
  readonly onRemove: () => void;
}) {
  const { folder } = props;
  return (
    <div className="space-y-2 rounded-lg border border-border/70 p-2.5">
      <div className="flex items-center gap-2">
        <Select
          value={folder.environmentId}
          disabled={props.disabled}
          onValueChange={(environmentId) =>
            environmentId &&
            props.onChange({
              environmentId: environmentId as EnvironmentId,
              path: "~/",
              createIfMissing: false,
            })
          }
        >
          <SelectTrigger size="sm" aria-label="Environment" className="min-w-0 flex-1">
            <SelectValue placeholder="Choose an environment">
              {props.environments.find(
                (candidate) => candidate.environmentId === folder.environmentId,
              )?.label ?? null}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {props.environments.map((candidate) => (
              <SelectItem key={candidate.environmentId} value={candidate.environmentId}>
                {candidate.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        {props.removable ? (
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label="Remove folder"
            disabled={props.disabled}
            onClick={props.onRemove}
          >
            <XIcon />
          </Button>
        ) : null}
      </div>
      <ProjectDirectoryField
        key={folder.environmentId}
        environmentId={folder.environmentId}
        platform={props.platform}
        currentProjectCwd={null}
        value={folder.path}
        disabled={props.disabled || folder.environmentId === null}
        onChange={(path, createIfMissing) => props.onChange({ path, createIfMissing })}
        onConfirm={props.onConfirm}
      />
      {props.note ? <p className="text-xs text-muted-foreground">{props.note}</p> : null}
    </div>
  );
}
