/**
 * The Tasks sidebar's project right-click menu, and the actions behind it.
 *
 * Archive is company-owned and reversible: the project, its tasks, and its milestones leave the
 * tracker and come back on restore. Delete is the same removal as project settings — for a company
 * project that takes its tasks, milestones, and captured email with it, everywhere.
 *
 * @module components/issues/IssuesProjectMenu
 */
import {
  mapAtomCommandResult,
  settlePromise,
  type AtomCommandResult,
} from "@spiritdevs/client-runtime/state/runtime";
import type { CompanyId } from "@spiritdevs/contracts/company";
import { useNavigate } from "@tanstack/react-router";
import { AsyncResult } from "effect/unstable/reactivity";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  CopyIcon,
  FolderOpenIcon,
  PencilIcon,
  PinIcon,
  PinOffIcon,
  PlusIcon,
  SettingsIcon,
  Trash2Icon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { useEnvironmentControl } from "~/cloud/useEnvironmentControl";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { readLocalApi } from "~/localApi";
import { useThreadShells } from "~/state/entities";
import { projectEnvironment } from "~/state/projects";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  clearRemovedProjectDrafts,
  companyProjectRemovalFailure,
  removeCompanyProjectFromOwners,
} from "../projects/projectRemoval";
import { useWorkspaceProjects } from "../projects/useWorkspaceProjects";
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
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { reportIssueWriteFailure } from "./issueWriteFeedback";
import type { IssueProjectOption } from "./useIssueProjectOptions";

export interface IssuesProjectMenuTarget {
  readonly project: IssueProjectOption;
  readonly x: number;
  readonly y: number;
}

function reportProjectFailure(title: string, description: string) {
  toastManager.add(stackedThreadToast({ type: "error", title, description }));
}

/**
 * Everything the menu can do to a project. `onRemoved` runs after a delete lands so the sidebar can
 * drop its pin and any filter still naming the project.
 */
function useIssuesProjectActions({
  onRemoved,
}: {
  onRemoved: (project: IssueProjectOption) => void;
}) {
  const navigate = useNavigate();
  const environmentControl = useEnvironmentControl();
  const workspaceProjects = useWorkspaceProjects();
  const threads = useThreadShells();
  const deleteProject = useAtomCommand(projectEnvironment.delete, { reportFailure: false });
  const { copyToClipboard } = useCopyToClipboard<{ path: string }>({
    onCopy: ({ path }) =>
      toastManager.add({ type: "success", title: "Path copied", description: path }),
    onError: (error) => reportProjectFailure("Failed to copy path", error.message),
  });

  /** The `/projects/$projectKey` segment, found through any id the project answers to. */
  const projectKeyFor = (project: IssueProjectOption): string | null =>
    workspaceProjects.find(
      (candidate) =>
        (candidate.cloudProjectId !== null &&
          project.projectIds.some((id) => id === candidate.cloudProjectId)) ||
        (candidate.group?.memberProjects.some((member) => project.projectIds.includes(member.id)) ??
          false),
    )?.projectKey ?? null;

  /** Resolves true once every owning company has taken the change. */
  const setArchived = async (project: IssueProjectOption, archived: boolean): Promise<boolean> => {
    const companyProject = project.companyProject;
    const verb = archived ? "archive" : "restore";
    if (companyProject === null || environmentControl === null || project.companyIds.length === 0) {
      reportProjectFailure(
        `Failed to ${verb} "${project.title}"`,
        "Only a company project can be archived, and company controls are not available.",
      );
      return false;
    }
    try {
      for (const companyId of project.companyIds) {
        await environmentControl.setCompanyProjectArchived({
          companyId,
          cloudProjectId: companyProject.id,
          archived,
        });
      }
    } catch (error) {
      reportProjectFailure(
        `Failed to ${verb} "${project.title}"`,
        error instanceof Error ? error.message : "An error occurred.",
      );
      return false;
    }
    toastManager.add({
      type: "success",
      title: archived ? `Archived "${project.title}"` : `Restored "${project.title}"`,
      description: archived
        ? "Its tasks and milestones are out of the tracker until you restore it from Archived."
        : "Its tasks and milestones are back in the tracker.",
    });
    return true;
  };

  const remove = async (project: IssueProjectOption, taskCount: number) => {
    const api = readLocalApi();
    if (!api) return;
    const members = project.environmentProjects;
    const memberKeys = new Set(members.map((member) => `${member.environmentId}:${member.id}`));
    const projectThreads = threads.filter((thread) =>
      memberKeys.has(`${thread.environmentId}:${thread.projectId}`),
    );
    const confirmed = await settlePromise(() =>
      api.dialogs.confirm(
        [
          `Delete project "${project.title}"?`,
          project.companyProject === null
            ? "This removes the project entries, not the files on disk."
            : `This deletes the company project from every Pathway app, with its ${taskCount} task${taskCount === 1 ? "" : "s"}, milestones, captured emails, and connected automation. Files on disk are not touched.`,
          ...(projectThreads.length > 0
            ? [
                `Its ${projectThreads.length} thread${projectThreads.length === 1 ? "" : "s"} and their conversation history are deleted too.`,
              ]
            : []),
          "This action cannot be undone.",
        ].join("\n"),
        { variant: "destructive" },
      ),
    );
    if (confirmed._tag === "Failure" || !confirmed.value) return;

    const failureTitle = `Failed to delete "${project.title}"`;
    if (project.companyProject !== null) {
      if (environmentControl === null || project.companyIds.length === 0) {
        reportProjectFailure(
          failureTitle,
          project.companyIds.length === 0
            ? "The project's company ownership is still syncing. Try again shortly."
            : "Company project controls are not available.",
        );
        return;
      }
      const failure = companyProjectRemovalFailure(
        await removeCompanyProjectFromOwners({
          environmentControl,
          companyIds: project.companyIds as ReadonlyArray<CompanyId>,
          cloudProjectId: project.companyProject.id,
        }),
      );
      if (failure !== null) {
        reportProjectFailure(failureTitle, failure);
        return;
      }
    } else {
      for (const member of members) {
        const result = mapAtomCommandResult(
          await deleteProject({
            environmentId: member.environmentId,
            input: { projectId: member.id, force: true },
          }),
          () => undefined,
        );
        if (reportIssueWriteFailure(failureTitle, result)) return;
      }
    }
    clearRemovedProjectDrafts(members, projectThreads);
    onRemoved(project);
  };

  return {
    projectKeyFor,
    setArchived,
    remove,
    copyPath: (path: string) => copyToClipboard(path, { path }),
    openProject: (projectKey: string) =>
      void navigate({ to: "/projects/$projectKey", params: { projectKey } }),
    openSettings: (projectKey: string) =>
      void navigate({ to: "/settings/projects/$projectKey", params: { projectKey } }),
  };
}

/**
 * The menu itself, anchored at the pointer like the task list's. Mount it only while open: its
 * actions hold a cloud connection and thread subscriptions the sidebar should not carry otherwise.
 *
 * An archive or delete outlives the popup — delete asks for confirmation after it closes — so the
 * menu reports `onClose` only once the chosen action settles, keeping that connection alive.
 */
export function IssuesProjectContextMenu({
  target,
  pinned,
  taskCount,
  onClose,
  onTogglePin,
  onNewTask,
  onRename,
  onForget,
}: {
  target: IssuesProjectMenuTarget;
  pinned: boolean;
  taskCount: number;
  onClose: () => void;
  onTogglePin: () => void;
  onNewTask: () => void;
  onRename: () => void;
  /** The project is leaving the list: drop its pin and any filter still naming it. */
  onForget: () => void;
}) {
  const { project, x, y } = target;
  const actions = useIssuesProjectActions({ onRemoved: onForget });
  const [open, setOpen] = useState(true);
  const running = useRef(false);
  const anchor = useMemo(() => ({ getBoundingClientRect: () => new DOMRect(x, y, 0, 0) }), [x, y]);

  /** Item handlers run before the item closes the menu, so the close below sees `running`. */
  const run = (action: () => void | Promise<void>) => {
    running.current = true;
    setOpen(false);
    void Promise.resolve().then(action).finally(onClose);
  };

  const projectKey = actions.projectKeyFor(project);
  const path = project.localProject?.workspaceRoot ?? null;
  const hasCheckout = project.environmentProjects.length > 0;

  return (
    <Menu
      onOpenChange={(nextOpen) => {
        if (nextOpen) return;
        setOpen(false);
        if (!running.current) onClose();
      }}
      open={open}
    >
      {/* Base UI still needs a registered trigger for a controlled, pointer-anchored menu. */}
      <MenuTrigger
        className="pointer-events-none fixed size-0"
        nativeButton={false}
        render={<span />}
        style={{ left: x, top: y }}
        tabIndex={-1}
      >
        <span className="sr-only">Project actions</span>
      </MenuTrigger>
      <MenuPopup align="start" anchor={anchor} className="min-w-48" side="inline-end">
        <MenuGroup>
          <MenuGroupLabel className="truncate">{project.title}</MenuGroupLabel>
        </MenuGroup>
        {project.archived ? null : (
          <>
            <MenuItem onClick={() => run(onTogglePin)}>
              {pinned ? <PinOffIcon /> : <PinIcon />}
              {pinned ? "Unpin" : "Pin to top"}
            </MenuItem>
            <MenuItem onClick={() => run(onNewTask)}>
              <PlusIcon />
              New task
            </MenuItem>
            <MenuSeparator />
            <MenuItem
              disabled={projectKey === null}
              onClick={() => projectKey !== null && run(() => actions.openProject(projectKey))}
            >
              <FolderOpenIcon />
              Open project
            </MenuItem>
            <MenuItem
              disabled={projectKey === null}
              onClick={() => projectKey !== null && run(() => actions.openSettings(projectKey))}
            >
              <SettingsIcon />
              Project settings
            </MenuItem>
            <MenuItem
              disabled={path === null}
              onClick={() => path !== null && run(() => actions.copyPath(path))}
            >
              <CopyIcon />
              Copy path
            </MenuItem>
            {/* A title lives on each checkout and the company name follows it, so a project with
                no checkout has nothing to rename yet. */}
            <MenuItem disabled={!hasCheckout} onClick={() => run(onRename)}>
              <PencilIcon />
              Rename…
            </MenuItem>
          </>
        )}
        <MenuSeparator />
        <MenuItem
          disabled={project.companyProject === null}
          onClick={() =>
            run(async () => {
              const archived = !project.archived;
              if ((await actions.setArchived(project, archived)) && archived) onForget();
            })
          }
        >
          {project.archived ? <ArchiveRestoreIcon /> : <ArchiveIcon />}
          {project.archived ? "Restore" : "Archive"}
        </MenuItem>
        <MenuItem
          onClick={() => run(() => actions.remove(project, taskCount))}
          variant="destructive"
        >
          <Trash2Icon />
          Delete…
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

/** Renames every checkout of the project; the company project picks the title up from them. */
export function RenameIssueProjectDialog({
  project,
  onOpenChange,
}: {
  project: IssueProjectOption | null;
  onOpenChange: (open: boolean) => void;
}) {
  const updateProject = useAtomCommand(projectEnvironment.update, { reportFailure: false });
  const nameRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (project === null) return;
    setName(project.title);
    setSubmitting(false);
    const frame = window.requestAnimationFrame(() => nameRef.current?.select());
    return () => window.cancelAnimationFrame(frame);
  }, [project]);

  const title = name.trim();
  const submit = () => {
    if (project === null || title === "" || submitting) return;
    if (title === project.title) {
      onOpenChange(false);
      return;
    }
    setSubmitting(true);
    void (async () => {
      let result: AtomCommandResult<void, unknown> = AsyncResult.success(undefined);
      for (const member of project.environmentProjects) {
        result = mapAtomCommandResult(
          await updateProject({
            environmentId: member.environmentId,
            input: { projectId: member.id, title, titleIsCustom: true },
          }),
          () => undefined,
        );
        if (result._tag === "Failure") break;
      }
      setSubmitting(false);
      if (reportIssueWriteFailure("Failed to rename the project", result)) return;
      onOpenChange(false);
    })();
  };

  return (
    <Dialog
      onOpenChange={(open) => {
        if (!submitting) onOpenChange(open);
      }}
      open={project !== null}
    >
      <DialogPopup className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Rename project</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <Input
            aria-label="Project name"
            onChange={(event) => setName(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              submit();
            }}
            ref={nameRef}
            value={name}
          />
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
          <Button disabled={title === "" || submitting} onClick={submit} size="sm" type="button">
            Rename
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
