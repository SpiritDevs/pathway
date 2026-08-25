import { useAtomValue } from "@effect/atom-react";
import { connectionStatusTitle } from "@spiritdevs/client-runtime/connection";
import {
  isAtomCommandInterrupted,
  mapAtomCommandResult,
  settlePromise,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@spiritdevs/client-runtime/state/runtime";
import { scopeProjectRef } from "@spiritdevs/client-runtime/environment";
import { AsyncResult } from "effect/unstable/reactivity";
import {
  deriveProjectGroupingOverrideKey,
  selectProjectGroupingSettings,
} from "../../logicalProject";
import type {
  ModelSelection,
  ProviderDriverKind,
  SidebarProjectGroupingMode,
  PathwayProjectFileScript,
  ThreadEnvMode,
} from "@spiritdevs/contracts";
import type { CompanyId } from "@spiritdevs/contracts/company";
import { resolveEnvModeLabel } from "../BranchToolbar.logic";
import { createModelSelection } from "@spiritdevs/shared/model";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@spiritdevs/shared/keybindings";
import { Link, useNavigate } from "@tanstack/react-router";
import * as Cause from "effect/Cause";
import {
  ArrowLeftIcon,
  CheckIcon,
  ChevronDownIcon,
  CopyIcon,
  EllipsisIcon,
  MonitorIcon,
  PlusIcon,
  SettingsIcon,
  StarIcon,
  Trash2Icon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { isElectron } from "../../env";
import {
  useClientSettings,
  useUpdateClientSettings,
  usePrimarySettings,
} from "../../hooks/useSettings";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { usePathwayProjectFileState } from "../../hooks/usePathwayProjectFileScripts";
import { shortcutLabelForCommand } from "../../keybindings";
import { keybindingValueForCommand } from "../../lib/projectScriptKeybindings";
import { readLocalApi } from "../../localApi";
import { companyListAtom } from "../../cloud/activeCompany";
import type { EnvironmentControlClient } from "../../cloud/environmentControl";
import {
  buildProjectScript,
  commandForProjectScript,
  nextProjectScriptId,
} from "../../projectScripts";
import { decodeProjectScriptKeybindingRule } from "../../lib/projectScriptKeybindings";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  resolveDefaultProviderModelSelection,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  type SidebarProjectGroupMember,
  type SidebarProjectSnapshot,
} from "../../sidebarProjectGrouping";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { useThreadShells } from "../../state/entities";
import { projectEnvironment } from "../../state/projects";
import { primaryServerProvidersAtom, serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import { ProjectEmailCaptureSection } from "../email/ProjectEmailCaptureSection";
import { ProjectFavicon } from "../ProjectFavicon";
import { AddProjectConnectionDialog } from "../projects/AddProjectConnectionDialog";
import { AttachProjectDirectoryDialog } from "../projects/AttachProjectDirectoryDialog";
import { MoveProjectWizard } from "../projects/MoveProjectWizard";
import { PendingProjectSetup } from "../projects/PendingProjectSetup";
import {
  buildProjectConnectionCatalog,
  deriveProjectConnectionMetadata,
  type ProjectConnectionMetadata,
  projectConnectionPlatformLabel,
} from "../projects/projectConnectionMetadata";
import { useProjectGroups } from "../projects/useProjectGroups";
import { useWorkspaceProjects } from "../projects/useWorkspaceProjects";
import type { WorkspaceProject } from "../projects/workspaceProjects.logic";
import {
  EMPTY_PROJECT_SCRIPT_INPUT,
  editorRequestForScript,
  ProjectScriptEditorDialog,
  ScriptIcon,
  type NewProjectScriptInput,
  type ProjectScriptEditorRequest,
} from "../projectScriptEditor";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { ProjectFaviconPickerDialog } from "./ProjectFaviconPickerDialog";
import { useCompanySettings, type CompanySettings } from "./company/useCompanySettings";
import { useEnvironmentControl } from "./company/useEnvironmentControl";

export const PROJECT_GROUPING_MODE_LABELS: Record<SidebarProjectGroupingMode, string> = {
  repository: "Group by repository",
  repository_path: "Group by repository path",
  separate: "Keep separate",
};

function memberKey(member: { environmentId: string; id: string }): string {
  return `${member.environmentId}:${member.id}`;
}

export function ProjectSettingsPanel({ projectKey }: { projectKey: string }) {
  const groups = useProjectGroups();
  const workspaceProjects = useWorkspaceProjects();
  const navigate = useNavigate();
  const companySettings = useCompanySettings();
  const environmentControl = useEnvironmentControl();

  const selected = groups.find((group) => group.projectKey === projectKey) ?? null;

  // Remember the members of the last rendered group so a grouping-rule change
  // (which changes the group key) can follow the project to its new group.
  const lastSelectionRef = useRef<{ key: string; memberKeys: string[] } | null>(null);
  useEffect(() => {
    if (!selected) return;
    lastSelectionRef.current = {
      key: selected.projectKey,
      memberKeys: selected.memberProjects.map((member) => member.physicalProjectKey),
    };
  }, [selected]);

  // A grouping-rule change replaces the group key mid-visit; follow the
  // project to its new key instead of parking on the not-found state.
  useEffect(() => {
    if (selected !== null) return;
    const last = lastSelectionRef.current;
    if (last?.key !== projectKey) return;
    const successor = groups.find((group) =>
      group.memberProjects.some((member) => last.memberKeys.includes(member.physicalProjectKey)),
    );
    if (successor) {
      void navigate({
        to: "/settings/projects/$projectKey",
        params: { projectKey: successor.projectKey },
        replace: true,
        hashScrollIntoView: false,
      });
    }
  }, [groups, navigate, projectKey, selected]);

  if (!selected) {
    // A company project with no checkout has no group to edit — everything on this page belongs to
    // a directory on a machine. Its shared identity can still be deleted from Convex here.
    const checkoutlessProject = workspaceProjects.find(
      (project) => project.projectKey === projectKey && project.group === null,
    );
    if (checkoutlessProject !== undefined) {
      return (
        <CheckoutlessProjectSettings
          project={checkoutlessProject}
          environmentControl={environmentControl}
        />
      );
    }
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-center text-sm text-muted-foreground">
        {groups.length === 0
          ? "Add a project from the sidebar to configure it here."
          : "This project is no longer available."}
      </div>
    );
  }
  return (
    <ProjectDetail
      key={selected.projectKey}
      group={selected}
      workspaceProject={
        workspaceProjects.find((project) => project.projectKey === selected.projectKey) ?? null
      }
      companyContext={{
        companyId: companySettings.companyId,
        replica: companySettings.replica,
        environmentControl,
      }}
    />
  );
}

interface ProjectCompanyContext {
  readonly companyId: CompanySettings["companyId"];
  readonly replica: CompanySettings["replica"];
  readonly environmentControl: EnvironmentControlClient | null;
}

function owningCompanyIds(workspaceProject: WorkspaceProject): ReadonlyArray<CompanyId> {
  return [...new Set(workspaceProject.companyIds)].map((companyId) => companyId as CompanyId);
}

/** What one "remove this project everywhere" attempt actually accomplished. */
interface CompanyProjectRemoval {
  /** How many owning workspaces reported that they removed a live project. */
  readonly removed: number;
  /** One message per workspace whose delete threw, in the order they were asked. */
  readonly failures: ReadonlyArray<string>;
}

/**
 * Deletes one cloud project from every workspace listed as an owner.
 *
 * Two rules matter here, and both come from the same failure: a project that stayed on screen
 * after the user removed it.
 *
 * Every owner is asked even after one of them fails. Stopping at the first error is what leaves a
 * project deleted in the workspaces asked before it and alive in the ones after it — and the one
 * still holding it is the one that keeps rendering it in the list.
 *
 * The count of *actual* removals is what the caller reports on, not the absence of an exception. A
 * workspace that has no live project with this id answers `deleted: false` rather than throwing,
 * because asking the wrong owner is a normal part of this loop; treating that quiet answer as
 * success is what let the UI navigate away from a project it had not removed.
 */
async function removeCompanyProjectFromOwners(input: {
  readonly environmentControl: EnvironmentControlClient;
  readonly companyIds: ReadonlyArray<CompanyId>;
  readonly cloudProjectId: string;
}): Promise<CompanyProjectRemoval> {
  let removed = 0;
  const failures: string[] = [];
  for (const companyId of input.companyIds) {
    try {
      const result = await input.environmentControl.deleteCompanyProject({
        companyId,
        cloudProjectId: input.cloudProjectId,
      });
      if (result.deleted) removed += 1;
    } catch (error) {
      failures.push(
        error instanceof Error ? error.message : "The cloud project could not be removed.",
      );
    }
  }
  return { removed, failures };
}

/** The message for a removal that finished without deleting the project the user was looking at. */
function companyProjectRemovalFailure(removal: CompanyProjectRemoval): string | null {
  if (removal.failures.length > 0) return removal.failures[0]!;
  if (removal.removed === 0) {
    return "No workspace you can manage still owns this project. Reload to refresh the list.";
  }
  return null;
}

/** The company-owned settings that still apply when no environment has a local checkout. */
export function CheckoutlessProjectSettings({
  project,
  environmentControl,
}: {
  readonly project: WorkspaceProject;
  readonly environmentControl: EnvironmentControlClient | null;
}) {
  const navigate = useNavigate();
  const [isRemoving, setIsRemoving] = useState(false);

  const removeProject = useCallback(async () => {
    const api = readLocalApi();
    if (!api || project.cloudProjectId === null || isRemoving) return;

    const confirmed = await settlePromise(() =>
      api.dialogs.confirm(
        [
          `Remove project "${project.displayName}"?`,
          "This removes the company project from every Pathway app. Files on disk are not touched.",
          "This action cannot be undone.",
        ].join("\n"),
        { variant: "destructive" },
      ),
    );
    if (confirmed._tag === "Failure" || !confirmed.value) return;

    const companyIds = owningCompanyIds(project);
    if (environmentControl === null || companyIds.length === 0) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: `Failed to remove "${project.displayName}"`,
          description:
            companyIds.length === 0
              ? "The project's company ownership is still syncing. Try again shortly."
              : "Company project controls are not available.",
        }),
      );
      return;
    }

    setIsRemoving(true);
    try {
      const removal = await removeCompanyProjectFromOwners({
        environmentControl,
        companyIds,
        cloudProjectId: project.cloudProjectId,
      });
      const failure = companyProjectRemovalFailure(removal);
      if (failure !== null) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: `Failed to remove "${project.displayName}"`,
            description: failure,
          }),
        );
        return;
      }
      void navigate({ to: "/settings/projects", replace: true });
    } finally {
      setIsRemoving(false);
    }
  }, [environmentControl, isRemoving, navigate, project]);

  return (
    <SettingsPageContainer className="max-w-3xl">
      <SettingsSection title="Pending setup">
        <PendingProjectSetup key={project.projectKey} project={project} />
      </SettingsSection>
      <SettingsSection title="Danger">
        <SettingsRow
          title="Remove project"
          description="Deletes the company project from every Pathway app. Files on disk are not touched."
          control={
            <Button
              variant="destructive-outline"
              disabled={isRemoving}
              onClick={() => void removeProject()}
            >
              <Trash2Icon />
              {isRemoving ? "Removing…" : "Remove project"}
            </Button>
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}

export function ProjectDetail({
  group,
  workspaceProject = null,
  companyContext = null,
}: {
  group: SidebarProjectSnapshot;
  workspaceProject?: WorkspaceProject | null;
  companyContext?: ProjectCompanyContext | null;
}) {
  const navigate = useNavigate();
  const settings = usePrimarySettings();
  const { presentationById } = useEnvironments();
  // Captured mail belongs to the machine the listener runs on, so the capture section follows this
  // group's checkout on the primary environment and hides for a group that has none.
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const updateClientSettings = useUpdateClientSettings();
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const serverProviders = useAtomValue(primaryServerProvidersAtom);
  const threads = useThreadShells();
  const updateProject = useAtomCommand(projectEnvironment.update, { reportFailure: false });
  const deleteProject = useAtomCommand(projectEnvironment.delete, { reportFailure: false });
  const upsertKeybinding = useAtomCommand(serverEnvironment.upsertKeybinding, {
    reportFailure: false,
  });
  const removeKeybinding = useAtomCommand(serverEnvironment.removeKeybinding, {
    reportFailure: false,
  });
  const { copyToClipboard: copyPathToClipboard } = useCopyToClipboard<{ path: string }>({
    onCopy: ({ path }) => {
      toastManager.add({ type: "success", title: "Path copied", description: path });
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to copy path",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    },
  });

  const representative =
    group.memberProjects.find(
      (member) => member.environmentId === group.environmentId && member.id === group.id,
    ) ?? group.memberProjects[0]!;
  const captureProjectId =
    group.memberProjects.find((member) => member.environmentId === primaryEnvironmentId)?.id ??
    null;
  const faviconPath = representative.faviconPath ?? null;
  const companies = useAtomValue(companyListAtom) ?? [];
  const owningCompany =
    workspaceProject === null
      ? null
      : (companies.find((company) => workspaceProject.companyIds.includes(String(company.id))) ??
        null);
  const [moveDestination, setMoveDestination] = useState<CompanyId | null>(null);
  const [moveWizardOpen, setMoveWizardOpen] = useState(false);
  const connectionCatalog = useMemo(
    () => buildProjectConnectionCatalog(companyContext?.replica?.view.values() ?? []),
    [companyContext?.replica],
  );
  const projectConnections = deriveProjectConnectionMetadata({
    members: group.memberProjects,
    catalog: connectionCatalog,
  });
  const [addingConnection, setAddingConnection] = useState(false);
  const threadCountByMember = useMemo(() => {
    const counts = new Map<string, number>();
    for (const thread of threads) {
      const key = `${thread.environmentId}:${thread.projectId}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, [threads]);
  const reportFailure = useCallback((title: string, result: AtomCommandResult<void, unknown>) => {
    if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
    const error = squashAtomCommandFailure(result);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title,
        description: error instanceof Error ? error.message : "An error occurred.",
      }),
    );
  }, []);
  const [savingDefaultBindingId, setSavingDefaultBindingId] = useState<string | null>(null);
  const setDefaultConnection = useCallback(
    async (connection: ProjectConnectionMetadata) => {
      if (connection.isPreferred || savingDefaultBindingId !== null) return;

      const companyId = companyContext?.companyId ?? null;
      const cloudProjectId = workspaceProject?.cloudProjectId ?? null;
      const bindingId = connection.bindingId;
      const environmentControl = companyContext?.environmentControl ?? null;
      if (
        companyId === null ||
        cloudProjectId === null ||
        bindingId === null ||
        environmentControl === null
      ) {
        toastManager.add({
          type: "error",
          title: "Could not save the default environment",
          description:
            bindingId === null
              ? "This project is not connected to that environment."
              : "Company project controls are not available.",
        });
        return;
      }

      setSavingDefaultBindingId(bindingId);
      try {
        await environmentControl.setPreferredEnvironmentBinding({
          companyId,
          cloudProjectId,
          bindingId,
        });
      } catch (error) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not save the default environment",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      } finally {
        setSavingDefaultBindingId(null);
      }
    },
    [companyContext, savingDefaultBindingId, workspaceProject?.cloudProjectId],
  );

  // Group-shared fields live on each physical project record, so a
  // group-level edit fans out to every member.
  const updateAllMembers = useCallback(
    async (
      input: Partial<{
        title: string;
        titleIsCustom: boolean;
        defaultModelSelection: ModelSelection | null;
        defaultThreadEnvMode: ThreadEnvMode | null;
        faviconPath: string | null;
      }>,
      failureTitle: string,
    ): Promise<AtomCommandResult<void, unknown>> => {
      for (const member of group.memberProjects) {
        const result = mapAtomCommandResult(
          await updateProject({
            environmentId: member.environmentId,
            input: { projectId: member.id, ...input },
          }),
          () => undefined,
        );
        if (result._tag === "Failure") {
          // A partial fan-out is possible: earlier members already took the
          // write. Name the environment so the user knows where it stopped.
          reportFailure(
            group.memberProjects.length > 1
              ? `${failureTitle} on ${member.environmentLabel ?? "the current environment"}`
              : failureTitle,
            result,
          );
          return result;
        }
      }
      return AsyncResult.success(undefined);
    },
    [group.memberProjects, reportFailure, updateProject],
  );

  const renameGroup = useCallback(
    async (nextTitle: string) => {
      const title = nextTitle.trim();
      if (!title) {
        toastManager.add({ type: "warning", title: "Project title cannot be empty" });
        return;
      }
      if (title === group.displayName) return;
      await updateAllMembers({ title, titleIsCustom: true }, "Failed to rename project");
    },
    [group.displayName, group.memberProjects, updateAllMembers],
  );

  // ----- default model -----
  const storedSelection = representative.defaultModelSelection;
  const resolvedSelection = resolveDefaultProviderModelSelection(serverProviders, storedSelection);
  const instanceEntries = useMemo(
    () =>
      sortProviderInstanceEntries(
        applyProviderInstanceSettings(deriveProviderInstanceEntries(serverProviders), settings),
      ),
    [serverProviders, settings],
  );
  const modelOptionsByInstance = useMemo(
    () => getCustomModelOptionsByInstance(settings, serverProviders),
    [serverProviders, settings],
  );
  const activeEntry = instanceEntries.find(
    (entry) => entry.instanceId === resolvedSelection?.instanceId,
  );
  const setDefaultModel = useCallback(
    (selection: ModelSelection | null) =>
      void updateAllMembers({ defaultModelSelection: selection }, "Failed to update default model"),
    [updateAllMembers],
  );

  // ----- new-thread workspace mode -----
  const storedEnvMode = representative.defaultThreadEnvMode ?? null;
  const setDefaultThreadEnvMode = useCallback(
    (mode: ThreadEnvMode | null) =>
      void updateAllMembers(
        { defaultThreadEnvMode: mode },
        "Failed to update new-thread workspace",
      ),
    [updateAllMembers],
  );

  // ----- favicon -----
  const [faviconPickerOpen, setFaviconPickerOpen] = useState(false);
  const [isSavingFavicon, setIsSavingFavicon] = useState(false);
  const savingFaviconRef = useRef(false);
  const setFaviconPath = useCallback(
    async (faviconPath: string | null) => {
      if (savingFaviconRef.current) return;
      savingFaviconRef.current = true;
      setIsSavingFavicon(true);
      try {
        await updateAllMembers({ faviconPath }, "Failed to update project icon");
      } finally {
        savingFaviconRef.current = false;
        setIsSavingFavicon(false);
      }
    },
    [updateAllMembers],
  );

  // ----- connection selection and scripts -----
  const [selectedCheckoutKey, setSelectedCheckoutKey] = useState(representative.physicalProjectKey);
  const selectedCheckout =
    group.memberProjects.find((member) => member.physicalProjectKey === selectedCheckoutKey) ??
    representative;
  const [attachDirectoryOpen, setAttachDirectoryOpen] = useState(false);
  const selectedServerConfig = useAtomValue(
    serverEnvironment.configValueAtom(selectedCheckout.environmentId),
  );
  const keybindings = selectedServerConfig?.keybindings ?? DEFAULT_RESOLVED_KEYBINDINGS;
  const scripts = selectedCheckout.scripts;
  const [editorRequest, setEditorRequest] = useState<ProjectScriptEditorRequest | null>(null);
  // Script writes replace the whole array, so two overlapping writes computed
  // from the same snapshot would drop each other's changes. One at a time.
  const [isSavingScripts, setIsSavingScripts] = useState(false);
  const savingScriptsRef = useRef(false);
  const pathwayFile = usePathwayProjectFileState(
    selectedCheckout.environmentId,
    selectedCheckout.workspaceRoot,
  );
  // What the "Default" option resolves to while no override is set: the
  // repo's pathway.json value when present, otherwise the global setting.
  const inheritedEnvMode = pathwayFile.file?.defaultThreadEnvMode ?? settings.defaultThreadEnvMode;
  const inheritedEnvModeSource =
    pathwayFile.file?.defaultThreadEnvMode != null ? "pathway.json" : "global";
  const importableScripts = useMemo(
    () =>
      pathwayFile.scripts.filter(
        (fileScript) =>
          !scripts.some(
            (script) =>
              script.command === fileScript.command ||
              script.name.toLowerCase() === fileScript.name.toLowerCase(),
          ),
      ),
    [scripts, pathwayFile.scripts],
  );

  const persistScripts = useCallback(
    async (
      nextScripts: ReadonlyArray<ReturnType<typeof buildProjectScript>>,
      keybinding: string | null | undefined,
      keybindingCommand: ReturnType<typeof commandForProjectScript>,
    ): Promise<AtomCommandResult<void, unknown>> => {
      if (savingScriptsRef.current) {
        return AsyncResult.failure(
          Cause.fail(new Error("Another script change is still saving. Try again.")),
        );
      }
      savingScriptsRef.current = true;
      setIsSavingScripts(true);
      try {
        // Captured before the write so a cleared or deleted binding can be
        // removed from the keybindings config afterwards.
        const previousKeybinding = keybindingValueForCommand(keybindings, keybindingCommand);
        const updateResult = mapAtomCommandResult(
          await updateProject({
            environmentId: selectedCheckout.environmentId,
            input: { projectId: selectedCheckout.id, scripts: nextScripts },
          }),
          () => undefined,
        );
        if (updateResult._tag === "Failure") {
          reportFailure("Failed to save scripts", updateResult);
          return updateResult;
        }

        const keybindingRule = decodeProjectScriptKeybindingRule({
          keybinding,
          command: keybindingCommand,
        });
        if (!isElectron) return updateResult;
        const environmentIds = [selectedCheckout.environmentId];
        const previousTarget = previousKeybinding
          ? decodeProjectScriptKeybindingRule({
              keybinding: previousKeybinding,
              command: keybindingCommand,
            })
          : null;
        if (keybindingRule) {
          // `replace` swaps the command's previous rule instead of appending a
          // second one that would keep the old shortcut alive.
          const input =
            previousTarget && previousTarget.key !== keybindingRule.key
              ? { ...keybindingRule, replace: previousTarget }
              : keybindingRule;
          for (const environmentId of environmentIds) {
            const result = mapAtomCommandResult(
              await upsertKeybinding({ environmentId, input }),
              () => undefined,
            );
            if (result._tag === "Failure") {
              reportFailure("Failed to save keybinding", result);
              return result;
            }
          }
        } else if (previousTarget) {
          for (const environmentId of environmentIds) {
            const result = mapAtomCommandResult(
              await removeKeybinding({ environmentId, input: previousTarget }),
              () => undefined,
            );
            if (result._tag === "Failure") {
              reportFailure("Failed to remove keybinding", result);
              return result;
            }
          }
        }
        return updateResult;
      } finally {
        savingScriptsRef.current = false;
        setIsSavingScripts(false);
      }
    },
    [
      keybindings,
      removeKeybinding,
      reportFailure,
      selectedCheckout.environmentId,
      selectedCheckout.id,
      updateProject,
      upsertKeybinding,
    ],
  );

  const submitScript = useCallback(
    async (
      scriptId: string | null,
      input: NewProjectScriptInput,
    ): Promise<AtomCommandResult<void, unknown>> => {
      if (scriptId === null) {
        const nextId = nextProjectScriptId(
          input.name,
          scripts.map((script) => script.id),
        );
        const nextScript = buildProjectScript(nextId, input);
        const nextScripts = input.runOnWorktreeCreate
          ? [
              ...scripts.map((script) =>
                script.runOnWorktreeCreate ? { ...script, runOnWorktreeCreate: false } : script,
              ),
              nextScript,
            ]
          : [...scripts, nextScript];
        return persistScripts(nextScripts, input.keybinding, commandForProjectScript(nextId));
      }

      const updatedScript = buildProjectScript(scriptId, input);
      const nextScripts = scripts.map((script) =>
        script.id === scriptId
          ? updatedScript
          : input.runOnWorktreeCreate
            ? { ...script, runOnWorktreeCreate: false }
            : script,
      );
      return persistScripts(nextScripts, input.keybinding, commandForProjectScript(scriptId));
    },
    [persistScripts, scripts],
  );

  const deleteScript = useCallback(
    (scriptId: string) => {
      const nextScripts = scripts.filter((script) => script.id !== scriptId);
      void persistScripts(nextScripts, null, commandForProjectScript(scriptId));
    },
    [persistScripts, scripts],
  );

  const importFileScript = useCallback(
    async (fileScript: PathwayProjectFileScript) => {
      const payload: NewProjectScriptInput = {
        name: fileScript.name,
        command: fileScript.command,
        icon: fileScript.icon ?? "play",
        runOnWorktreeCreate: fileScript.runOnWorktreeCreate ?? false,
        keybinding: null,
        previewUrl: fileScript.previewUrl ?? null,
        autoOpenPreview: fileScript.previewUrl ? (fileScript.autoOpenPreview ?? false) : false,
      };
      const result = await submitScript(null, payload);
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        setEditorRequest({
          scriptId: null,
          initial: payload,
          error: error instanceof Error ? error.message : "Failed to import action.",
        });
      }
    },
    [submitScript],
  );

  // ----- connections -----
  const updateGroupingPreference = useCallback(
    (member: SidebarProjectGroupMember, selection: SidebarProjectGroupingMode | "inherit") => {
      const overrideKey = deriveProjectGroupingOverrideKey(member);
      const nextOverrides = { ...projectGroupingSettings.sidebarProjectGroupingOverrides };
      const nextAssignments = { ...projectGroupingSettings.sidebarProjectGroupAssignments };
      // Any explicit grouping choice is also the way out of a connection made through the
      // add-project decision dialog.
      delete nextAssignments[overrideKey];
      if (selection === "inherit") {
        delete nextOverrides[overrideKey];
      } else {
        nextOverrides[overrideKey] = selection;
      }
      updateClientSettings({
        sidebarProjectGroupAssignments: nextAssignments,
        sidebarProjectGroupingOverrides: nextOverrides,
      });
    },
    [
      projectGroupingSettings.sidebarProjectGroupAssignments,
      projectGroupingSettings.sidebarProjectGroupingOverrides,
      updateClientSettings,
    ],
  );

  const removeMembers = useCallback(
    async (members: ReadonlyArray<SidebarProjectGroupMember>) => {
      const api = readLocalApi();
      if (!api) return;

      const memberKeys = new Set(members.map(memberKey));
      const projectThreads = threads.filter((thread) =>
        memberKeys.has(`${thread.environmentId}:${thread.projectId}`),
      );
      const isWholeGroup = members.length === group.memberProjects.length;
      const singleMember = members.length === 1 ? members[0]! : null;
      const targetLabel = singleMember?.title ?? group.displayName;
      const confirmed = await settlePromise(() =>
        api.dialogs.confirm(
          [
            projectThreads.length > 0
              ? `Remove project "${targetLabel}" and delete its ${projectThreads.length} thread${projectThreads.length === 1 ? "" : "s"}?`
              : `Remove project "${targetLabel}"?`,
            ...(singleMember
              ? [
                  `Path: ${singleMember.workspaceRoot}`,
                  ...(singleMember.environmentLabel
                    ? [`Environment: ${singleMember.environmentLabel}`]
                    : []),
                ]
              : [`This removes ${members.length} grouped project entries.`]),
            ...(projectThreads.length > 0
              ? ["This permanently clears conversation history for those threads."]
              : []),
            isWholeGroup && workspaceProject?.cloudProjectId != null
              ? "This removes the company project and every checkout. Offline checkouts are removed when they reconnect; files on disk are not touched."
              : isWholeGroup
                ? "This removes only the project entries, not the files on disk."
                : "Other entries in this grouped project are unaffected.",
            "This action cannot be undone.",
          ].join("\n"),
          { variant: "destructive" },
        ),
      );
      if (confirmed._tag === "Failure" || !confirmed.value) return;

      const draftStore = useComposerDraftStore.getState();
      const clearMemberDrafts = () => {
        for (const member of members) {
          const projectRef = scopeProjectRef(member.environmentId, member.id);
          const projectDraftThread = draftStore.getDraftThreadByProjectRef(projectRef);
          if (projectDraftThread) {
            draftStore.clearDraftThread(projectDraftThread.draftId);
          }
          draftStore.clearProjectDraftThreadId(projectRef);
        }
      };

      if (workspaceProject?.cloudProjectId != null) {
        const companyIds = owningCompanyIds(workspaceProject);
        const environmentControl = companyContext?.environmentControl ?? null;
        if (environmentControl === null || companyIds.length === 0) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: `Failed to remove "${targetLabel}"`,
              description:
                companyIds.length === 0
                  ? "The project's company ownership is still syncing. Try again shortly."
                  : "Company project controls are not available.",
            }),
          );
          return;
        }
        if (isWholeGroup) {
          const removal = await removeCompanyProjectFromOwners({
            environmentControl,
            companyIds,
            cloudProjectId: workspaceProject.cloudProjectId,
          });
          const failure = companyProjectRemovalFailure(removal);
          if (failure !== null) {
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: `Failed to remove "${targetLabel}"`,
                description: failure,
              }),
            );
            return;
          }
        } else {
          try {
            for (const companyId of companyIds) {
              for (const member of members) {
                await environmentControl.releaseEnvironmentProject({
                  companyId,
                  environmentId: member.environmentId,
                  localProjectId: member.id,
                });
              }
            }
          } catch (error) {
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: `Failed to remove "${targetLabel}"`,
                description:
                  error instanceof Error
                    ? error.message
                    : "The cloud project could not be removed.",
              }),
            );
            return;
          }
        }
        clearMemberDrafts();
        if (isWholeGroup) {
          void navigate({ to: "/settings/projects", replace: true });
        }
        return;
      }

      for (const member of members) {
        const memberThreads = projectThreads.filter(
          (thread) =>
            thread.environmentId === member.environmentId && thread.projectId === member.id,
        );
        const result = mapAtomCommandResult(
          await deleteProject({
            environmentId: member.environmentId,
            input: {
              projectId: member.id,
              ...(memberThreads.length > 0 ? { force: true } : {}),
            },
          }),
          () => undefined,
        );
        if (result._tag === "Failure") {
          reportFailure(`Failed to remove "${member.title}"`, result);
          return;
        }
      }
      clearMemberDrafts();

      // The selected settings page just deleted itself; return to the project directory.
      if (isWholeGroup) {
        void navigate({ to: "/settings/projects", replace: true });
      }
    },
    [
      deleteProject,
      companyContext,
      group.displayName,
      group.memberProjects.length,
      navigate,
      reportFailure,
      threads,
      workspaceProject,
    ],
  );

  const removeConnection = useCallback(
    async (connection: ProjectConnectionMetadata, member: SidebarProjectGroupMember | null) => {
      // A project must always retain at least one connection. The disabled menu item also makes
      // this visible before the user tries, while this guard keeps the invariant independent of UI.
      if (projectConnections.length <= 1) return;

      const api = readLocalApi();
      if (!api) return;
      const connectionThreads = threads.filter(
        (thread) =>
          thread.environmentId === connection.environmentId &&
          thread.projectId === connection.localProjectId,
      );
      const confirmed = await settlePromise(() =>
        api.dialogs.confirm(
          [
            `Remove the connection to "${connection.environmentLabel}"?`,
            ...(connection.directory ? [`Path: ${connection.directory}`] : []),
            ...(connectionThreads.length > 0
              ? [
                  `This also deletes its ${connectionThreads.length} thread${connectionThreads.length === 1 ? "" : "s"} from Pathway.`,
                ]
              : []),
            "Other connections to this project are unaffected. Files on disk are not touched.",
            "This action cannot be undone.",
          ].join("\n"),
          { variant: "destructive" },
        ),
      );
      if (confirmed._tag === "Failure" || !confirmed.value) return;

      if (workspaceProject?.cloudProjectId != null) {
        const companyIds = owningCompanyIds(workspaceProject);
        const environmentControl = companyContext?.environmentControl ?? null;
        if (environmentControl === null || companyIds.length === 0) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: `Failed to remove "${connection.environmentLabel}"`,
              description:
                companyIds.length === 0
                  ? "The project's company ownership is still syncing. Try again shortly."
                  : "Company project controls are not available.",
            }),
          );
          return;
        }
        try {
          for (const companyId of companyIds) {
            await environmentControl.releaseEnvironmentProject({
              companyId,
              environmentId: connection.environmentId,
              localProjectId: connection.localProjectId,
            });
          }
        } catch (error) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: `Failed to remove "${connection.environmentLabel}"`,
              description:
                error instanceof Error
                  ? error.message
                  : "The project connection could not be removed.",
            }),
          );
          return;
        }
      } else if (member !== null) {
        const result = mapAtomCommandResult(
          await deleteProject({
            environmentId: member.environmentId,
            input: {
              projectId: member.id,
              ...(connectionThreads.length > 0 ? { force: true } : {}),
            },
          }),
          () => undefined,
        );
        if (result._tag === "Failure") {
          reportFailure(`Failed to remove "${connection.environmentLabel}"`, result);
          return;
        }
      } else {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: `Failed to remove "${connection.environmentLabel}"`,
            description: "This connection is not available in the current project data.",
          }),
        );
        return;
      }

      if (member !== null) {
        const draftStore = useComposerDraftStore.getState();
        const projectRef = scopeProjectRef(member.environmentId, member.id);
        const draftThread = draftStore.getDraftThreadByProjectRef(projectRef);
        if (draftThread) draftStore.clearDraftThread(draftThread.draftId);
        draftStore.clearProjectDraftThreadId(projectRef);

        if (member.physicalProjectKey === selectedCheckout.physicalProjectKey) {
          const replacement = group.memberProjects.find(
            (candidate) => candidate.physicalProjectKey !== member.physicalProjectKey,
          );
          if (replacement) setSelectedCheckoutKey(replacement.physicalProjectKey);
        }
      }
    },
    [
      companyContext,
      deleteProject,
      group.memberProjects,
      projectConnections.length,
      reportFailure,
      selectedCheckout.physicalProjectKey,
      threads,
      workspaceProject,
    ],
  );

  const selectedCheckoutOverrideKey = deriveProjectGroupingOverrideKey(selectedCheckout);
  const selectedCheckoutAssignment =
    projectGroupingSettings.sidebarProjectGroupAssignments[selectedCheckoutOverrideKey];
  const selectedCheckoutGrouping =
    selectedCheckoutAssignment !== undefined
      ? selectedCheckoutAssignment === selectedCheckoutOverrideKey
        ? "independent"
        : "linked"
      : (projectGroupingSettings.sidebarProjectGroupingOverrides?.[selectedCheckoutOverrideKey] ??
        "inherit");
  const selectedCheckoutLabel = selectedCheckout.environmentLabel ?? "This machine";

  return (
    <>
      <SettingsPageContainer>
        <div className="space-y-4">
          <Button
            render={<Link to="/settings/projects" resetScroll={false} />}
            size="sm"
            variant="ghost"
            className="-ms-2 w-fit text-muted-foreground"
          >
            <ArrowLeftIcon aria-hidden className="size-4" />
            Projects
          </Button>
          <SettingsSection title="Project">
            <SettingsRow
              title="Name"
              description="The shared name for this project group in the sidebar and thread lists."
              control={
                <Input
                  key={`${group.projectKey}:${group.displayName}`}
                  className="w-full sm:w-64"
                  aria-label="Project name"
                  defaultValue={group.displayName}
                  onBlur={(event) => {
                    void renameGroup(event.currentTarget.value);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                  }}
                />
              }
            />
            <SettingsRow
              title="Project icon"
              description={faviconPath ?? "Automatic"}
              resetAction={
                faviconPath !== null ? (
                  <SettingResetButton
                    label="project icon"
                    disabled={isSavingFavicon}
                    onClick={() => void setFaviconPath(null)}
                  />
                ) : null
              }
              control={
                <div className="flex items-center gap-2">
                  <ProjectFavicon
                    environmentId={representative.environmentId}
                    cwd={representative.workspaceRoot}
                    faviconPath={faviconPath}
                    className="size-6"
                  />
                  <Button
                    size="xs"
                    variant="outline"
                    type="button"
                    aria-label="Choose a project icon file"
                    // The picker browses the project's directory; there is nothing to browse until
                    // one is attached.
                    disabled={isSavingFavicon || representative.workspaceRoot === null}
                    onClick={() => setFaviconPickerOpen(true)}
                  >
                    Choose file
                  </Button>
                </div>
              }
            />
          </SettingsSection>
        </div>

        {workspaceProject !== null ? (
          <SettingsSection title="Company">
            <SettingsRow
              title="Company"
              description="The company owns this project and everything filed against it."
              control={
                <Select
                  value={owningCompany?.id ?? null}
                  disabled={
                    workspaceProject.cloudProjectId === null ||
                    owningCompany === null ||
                    companies.length < 2
                  }
                  onValueChange={(value) => {
                    if (value === null || value === owningCompany?.id) return;
                    setMoveDestination(value as CompanyId);
                    setMoveWizardOpen(true);
                  }}
                >
                  <SelectTrigger aria-label="Project company" className="w-full sm:w-64">
                    <SelectValue placeholder="No company">{owningCompany?.name}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="end" alignItemWithTrigger={false}>
                    {companies.map((company) => (
                      <SelectItem key={company.id} value={company.id}>
                        {company.name}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              }
            />
          </SettingsSection>
        ) : null}

        <SettingsSection
          title="Connections"
          headerAction={
            <Button onClick={() => setAddingConnection(true)} size="sm" variant="outline">
              <PlusIcon className="size-3.5" />
              Add connection
            </Button>
          }
        >
          <div className="space-y-2 px-3 py-3 sm:px-4">
            {projectConnections.map((connection) => {
              const connectionKey = `${connection.environmentId}:${connection.localProjectId}`;
              const member =
                group.memberProjects.find((candidate) => memberKey(candidate) === connectionKey) ??
                null;
              const environment = presentationById.get(connection.environmentId);
              const platformLabel = projectConnectionPlatformLabel(connection.platform);
              const threadCount = threadCountByMember.get(connectionKey) ?? 0;
              const isSelected = member?.physicalProjectKey === selectedCheckout.physicalProjectKey;
              const canRemoveConnection =
                projectConnections.length > 1 &&
                (workspaceProject?.cloudProjectId != null || member !== null);
              const statusLabel = environment
                ? connectionStatusTitle(environment.connection)
                : connection.bindingStatus === null
                  ? "Local"
                  : connection.bindingStatus[0]!.toUpperCase() + connection.bindingStatus.slice(1);
              return (
                <div
                  key={connectionKey}
                  className={
                    isSelected
                      ? "flex items-start rounded-xl border border-primary/45 bg-primary/[0.04]"
                      : "flex items-start rounded-xl border border-border/70 bg-muted/15"
                  }
                >
                  <button
                    aria-label={`Configure ${connection.environmentLabel}`}
                    aria-pressed={isSelected}
                    className="flex min-w-0 flex-1 items-start gap-3 rounded-xl px-3 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default"
                    disabled={member === null}
                    type="button"
                    onClick={() => {
                      if (member) setSelectedCheckoutKey(member.physicalProjectKey);
                    }}
                  >
                    <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                      <MonitorIcon className="size-3.5" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="text-sm font-medium text-foreground">
                          {connection.environmentLabel}
                        </span>
                        <span className="text-[11px] text-muted-foreground">{statusLabel}</span>
                        {connection.isPreferred ? (
                          <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                            New-thread default
                          </span>
                        ) : null}
                        <span className="ms-auto shrink-0 text-xs tabular-nums text-muted-foreground">
                          {threadCount === 1 ? "1 thread" : `${threadCount} threads`}
                        </span>
                      </div>
                      <code className="mt-1 block truncate font-mono text-xs text-muted-foreground">
                        {connection.directory ?? "No directory attached"}
                      </code>
                      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground/80">
                        {platformLabel ? <span>{platformLabel}</span> : null}
                        {connection.serverVersion ? (
                          <span>Pathway {connection.serverVersion}</span>
                        ) : null}
                        <span className="font-mono">{connection.environmentId}</span>
                        {connection.lastSeenAt !== null ? (
                          <span>Last seen {new Date(connection.lastSeenAt).toLocaleString()}</span>
                        ) : null}
                      </div>
                    </div>
                  </button>
                  <Menu>
                    <MenuTrigger
                      render={
                        <Button
                          aria-label={`Actions for ${connection.environmentLabel}`}
                          className="me-2 mt-2 shrink-0 text-muted-foreground"
                          size="icon-sm"
                          type="button"
                          variant="ghost"
                        />
                      }
                    >
                      <EllipsisIcon className="size-4" />
                    </MenuTrigger>
                    <MenuPopup align="end" className="min-w-48">
                      {workspaceProject?.cloudProjectId != null && connection.bindingId !== null ? (
                        <>
                          <MenuItem
                            disabled={connection.isPreferred || savingDefaultBindingId !== null}
                            onClick={() => void setDefaultConnection(connection)}
                          >
                            {connection.isPreferred ? (
                              <CheckIcon className="size-3.5" />
                            ) : (
                              <StarIcon className="size-3.5" />
                            )}
                            {savingDefaultBindingId === connection.bindingId
                              ? "Saving default…"
                              : connection.isPreferred
                                ? "New-thread default"
                                : "Set as new-thread default"}
                          </MenuItem>
                          <MenuSeparator />
                        </>
                      ) : null}
                      <MenuItem
                        disabled={connection.directory === null}
                        onClick={() => {
                          if (connection.directory) {
                            copyPathToClipboard(connection.directory, {
                              path: connection.directory,
                            });
                          }
                        }}
                      >
                        <CopyIcon className="size-3.5" />
                        Copy path
                      </MenuItem>
                      {connection.directory === null && member !== null ? (
                        <MenuItem
                          onClick={() => {
                            setSelectedCheckoutKey(member.physicalProjectKey);
                            setAttachDirectoryOpen(true);
                          }}
                        >
                          <PlusIcon className="size-3.5" />
                          Attach directory
                        </MenuItem>
                      ) : null}
                      <MenuSeparator />
                      <MenuItem
                        disabled={!canRemoveConnection}
                        variant="destructive"
                        onClick={() => void removeConnection(connection, member)}
                      >
                        <Trash2Icon className="size-3.5" />
                        Remove connection
                      </MenuItem>
                    </MenuPopup>
                  </Menu>
                </div>
              );
            })}
          </div>
          {addingConnection ? (
            <AddProjectConnectionDialog
              onOpenChange={setAddingConnection}
              open
              projectId={representative.id}
              projectKey={group.projectKey}
              projectTitle={group.displayName}
            />
          ) : null}
        </SettingsSection>

        <SettingsSection title="New threads">
          <SettingsRow
            title="Model"
            description="New threads in this project start with this model. Applies to every connection in this group."
            resetAction={
              storedSelection !== null ? (
                <SettingResetButton
                  label="project default model"
                  onClick={() => setDefaultModel(null)}
                />
              ) : null
            }
            control={
              resolvedSelection && activeEntry ? (
                <div className="flex flex-wrap items-center justify-end gap-1.5">
                  <ProviderModelPicker
                    activeInstanceId={resolvedSelection.instanceId}
                    model={resolvedSelection.model}
                    lockedProvider={null}
                    instanceEntries={instanceEntries}
                    modelOptionsByInstance={modelOptionsByInstance}
                    triggerVariant="outline"
                    triggerClassName="min-w-0 max-w-none shrink-0 text-foreground/90 hover:text-foreground"
                    onInstanceModelChange={(instanceId, model) => {
                      setDefaultModel(createModelSelection(instanceId, model));
                    }}
                  />
                  <TraitsPicker
                    provider={activeEntry.driverKind as ProviderDriverKind}
                    models={activeEntry.models}
                    model={resolvedSelection.model}
                    prompt=""
                    onPromptChange={() => {}}
                    modelOptions={resolvedSelection.options ?? []}
                    allowPromptInjectedEffort={false}
                    triggerVariant="outline"
                    triggerClassName="min-w-0 max-w-none shrink-0 text-foreground/90 hover:text-foreground"
                    onModelOptionsChange={(nextOptions) => {
                      setDefaultModel(
                        createModelSelection(
                          resolvedSelection.instanceId,
                          resolvedSelection.model,
                          nextOptions,
                        ),
                      );
                    }}
                  />
                </div>
              ) : (
                <span className="text-sm text-muted-foreground">No providers available</span>
              )
            }
          />
          <SettingsRow
            title="Workspace"
            description="Where new threads in this project start. Overrides pathway.json and the global default; applies to every connection in this group."
            resetAction={
              storedEnvMode !== null ? (
                <SettingResetButton
                  label="project workspace default"
                  onClick={() => setDefaultThreadEnvMode(null)}
                />
              ) : null
            }
            control={
              <Select
                value={storedEnvMode ?? "inherit"}
                onValueChange={(value) => {
                  if (value === "worktree" || value === "local") {
                    setDefaultThreadEnvMode(value);
                  } else if (value === "inherit") {
                    setDefaultThreadEnvMode(null);
                  }
                }}
              >
                <SelectTrigger aria-label="New-thread workspace">
                  <SelectValue>
                    {storedEnvMode === null
                      ? group.memberProjects.length > 1
                        ? "Default (per connection)"
                        : `Default (${resolveEnvModeLabel(inheritedEnvMode).toLowerCase()})`
                      : resolveEnvModeLabel(storedEnvMode)}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem value="inherit">
                    {group.memberProjects.length > 1
                      ? "Default (each connection's pathway.json or global setting)"
                      : `Default (${inheritedEnvModeSource}: ${resolveEnvModeLabel(inheritedEnvMode).toLowerCase()})`}
                  </SelectItem>
                  <SelectItem value="worktree">{resolveEnvModeLabel("worktree")}</SelectItem>
                  <SelectItem value="local">{resolveEnvModeLabel("local")}</SelectItem>
                </SelectPopup>
              </Select>
            }
          />
        </SettingsSection>

        <SettingsSection title="Connection settings">
          <SettingsRow
            title="Project grouping"
            description={`How the connection on ${selectedCheckoutLabel} joins project groups in the sidebar. Changing it can move you to a different project group.`}
            control={
              <Select
                value={selectedCheckoutGrouping}
                onValueChange={(value) => {
                  if (
                    value === "inherit" ||
                    value === "repository" ||
                    value === "repository_path" ||
                    value === "separate"
                  ) {
                    updateGroupingPreference(selectedCheckout, value);
                  }
                }}
              >
                <SelectTrigger aria-label={`Grouping rule for ${selectedCheckoutLabel}`}>
                  <SelectValue>
                    {selectedCheckoutGrouping === "independent"
                      ? "Independent project"
                      : selectedCheckoutGrouping === "linked"
                        ? `Linked to ${group.displayName}`
                        : selectedCheckoutGrouping === "inherit"
                          ? `Default (${PROJECT_GROUPING_MODE_LABELS[projectGroupingSettings.sidebarProjectGroupingMode]})`
                          : PROJECT_GROUPING_MODE_LABELS[selectedCheckoutGrouping]}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {selectedCheckoutGrouping === "independent" ? (
                    <SelectItem disabled hideIndicator value="independent">
                      Independent project
                    </SelectItem>
                  ) : selectedCheckoutGrouping === "linked" ? (
                    <SelectItem disabled hideIndicator value="linked">
                      Linked to {group.displayName}
                    </SelectItem>
                  ) : null}
                  <SelectItem hideIndicator value="inherit">
                    Use global default
                  </SelectItem>
                  <SelectItem hideIndicator value="repository">
                    {PROJECT_GROUPING_MODE_LABELS.repository}
                  </SelectItem>
                  <SelectItem hideIndicator value="repository_path">
                    {PROJECT_GROUPING_MODE_LABELS.repository_path}
                  </SelectItem>
                  <SelectItem hideIndicator value="separate">
                    {PROJECT_GROUPING_MODE_LABELS.separate}
                  </SelectItem>
                </SelectPopup>
              </Select>
            }
          />
          <div className="flex min-h-8 flex-col items-start gap-3 px-3 pt-4 sm:flex-row sm:items-center sm:justify-between sm:gap-4 sm:px-4">
            <div className="min-w-0">
              <h3 className="text-base font-semibold text-foreground">Actions</h3>
              <p className="text-pretty text-sm text-muted-foreground">
                Saved and run only through {selectedCheckoutLabel}.
              </p>
            </div>
            <div className="flex w-full flex-wrap gap-1.5 sm:w-auto sm:shrink-0 sm:justify-end">
              {importableScripts.length > 0 ? (
                <Menu>
                  <MenuTrigger
                    render={
                      <Button size="xs" variant="ghost" disabled={isSavingScripts} type="button" />
                    }
                  >
                    Import scripts
                    <ChevronDownIcon className="size-3.5" />
                  </MenuTrigger>
                  <MenuPopup align="end" className="w-72">
                    <MenuGroup>
                      <MenuGroupLabel>Import from pathway.json</MenuGroupLabel>
                      <p className="px-2 pb-2 text-pretty text-sm text-muted-foreground">
                        Add actions declared by this connection without editing them first.
                      </p>
                    </MenuGroup>
                    <MenuSeparator />
                    {importableScripts.map((fileScript) => (
                      <MenuItem
                        key={`${fileScript.name} ${fileScript.command}`}
                        onClick={() => void importFileScript(fileScript)}
                      >
                        <ScriptIcon icon={fileScript.icon ?? "play"} className="size-4 shrink-0" />
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-medium">{fileScript.name}</div>
                          <div className="truncate font-mono text-muted-foreground">
                            {fileScript.command}
                          </div>
                        </div>
                      </MenuItem>
                    ))}
                  </MenuPopup>
                </Menu>
              ) : null}
              <Button
                size="xs"
                variant="outline"
                disabled={isSavingScripts}
                onClick={() =>
                  setEditorRequest({ scriptId: null, initial: EMPTY_PROJECT_SCRIPT_INPUT })
                }
              >
                <PlusIcon className="size-3.5" />
                Add action
              </Button>
            </div>
          </div>
          {scripts.length === 0 ? (
            <p className="px-3 py-2 text-base text-muted-foreground sm:px-4 sm:text-sm">
              No actions configured for this connection.
            </p>
          ) : (
            scripts.map((script) => {
              const shortcutLabel = shortcutLabelForCommand(
                keybindings,
                commandForProjectScript(script.id),
              );
              return (
                <SettingsRow
                  key={script.id}
                  className="group py-2"
                  title={
                    <span className="flex min-w-0 items-center gap-2">
                      <ScriptIcon
                        icon={script.icon}
                        className="size-4 shrink-0 text-muted-foreground"
                      />
                      <span className="max-w-40 shrink-0 truncate">{script.name}</span>
                      <code className="min-w-0 flex-1 truncate font-mono font-normal text-muted-foreground">
                        {script.command}
                      </code>
                      {script.runOnWorktreeCreate ? (
                        <span className="shrink-0 rounded-sm border border-border/60 px-1.5 py-px text-[11px] font-normal text-muted-foreground">
                          setup
                        </span>
                      ) : null}
                      {script.previewUrl ? (
                        <span className="shrink-0 rounded-sm border border-border/60 px-1.5 py-px text-[11px] font-normal text-muted-foreground max-sm:hidden">
                          preview · desktop only
                        </span>
                      ) : null}
                    </span>
                  }
                  control={
                    <>
                      {shortcutLabel ? (
                        <span className="text-xs text-muted-foreground">{shortcutLabel}</span>
                      ) : null}
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        className="shrink-0 text-muted-foreground opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"
                        aria-label={`Edit ${script.name}`}
                        disabled={isSavingScripts}
                        onClick={() =>
                          setEditorRequest(editorRequestForScript(script, keybindings))
                        }
                      >
                        <SettingsIcon className="size-3.5" />
                      </Button>
                    </>
                  }
                />
              );
            })
          )}
          {pathwayFile.status === "invalid" ? (
            <SettingsRow
              title="pathway.json is invalid"
              description="A pathway.json exists for this connection but fails to parse, so every action and icon it declares is ignored. Check the JSON syntax and icon values."
              className="text-warning"
            />
          ) : null}
        </SettingsSection>

        {captureProjectId === null ? null : (
          <ProjectEmailCaptureSection
            projectId={captureProjectId}
            projectName={group.displayName}
          />
        )}

        <SettingsSection title="Danger">
          <SettingsRow
            title={
              group.memberProjects.length > 1 ? "Remove this project everywhere" : "Remove project"
            }
            description={
              group.memberProjects.length > 1
                ? `Deletes all ${group.memberProjects.length} connections and their threads on every machine. Files on disk are not touched.`
                : "Deletes the project entry and its threads. Files on disk are not touched."
            }
            control={
              <Button
                variant="destructive-outline"
                onClick={() => void removeMembers(group.memberProjects)}
              >
                <Trash2Icon />
                {group.memberProjects.length > 1 ? "Remove all entries" : "Remove project"}
              </Button>
            }
          />
        </SettingsSection>
      </SettingsPageContainer>

      <ProjectScriptEditorDialog
        request={editorRequest}
        scripts={scripts}
        onSubmit={submitScript}
        onDelete={deleteScript}
        onClose={() => setEditorRequest(null)}
      />
      {representative.workspaceRoot === null ? null : (
        <ProjectFaviconPickerDialog
          key={`${representative.environmentId}:${representative.workspaceRoot}:${faviconPickerOpen}`}
          cwd={representative.workspaceRoot}
          environmentId={representative.environmentId}
          onOpenChange={setFaviconPickerOpen}
          onSelect={setFaviconPath}
          open={faviconPickerOpen}
          projectName={group.displayName}
        />
      )}
      <AttachProjectDirectoryDialog
        onAttached={() => setAttachDirectoryOpen(false)}
        onOpenChange={setAttachDirectoryOpen}
        open={attachDirectoryOpen}
        project={selectedCheckout}
        reason="Threads, git actions, and the file explorer all run inside this directory."
      />
      {workspaceProject !== null && moveDestination !== null ? (
        <MoveProjectWizard
          project={workspaceProject}
          initialDestination={moveDestination}
          open={moveWizardOpen}
          onOpenChange={(open) => {
            setMoveWizardOpen(open);
            if (!open) setMoveDestination(null);
          }}
        />
      ) : null}
    </>
  );
}
