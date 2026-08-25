/**
 * The launch-time gate that gives every project an owner.
 *
 * A project belongs to a company (ADR 0011), and an unassigned checkout is invisible to anything
 * company-scoped — you cannot file an issue against it or share it. Rather than let that rot
 * quietly, this asks once, on launch, and blocks until every project has an answer. "Personal" is
 * always one of those answers: a member's own workspace is permanent and is where side projects,
 * scratch checkouts, and anything not work belong.
 *
 * @module components/projects/AssignProjectCompanyDialog
 */
import { useAtomValue } from "@effect/atom-react";
import {
  mapAtomCommandResult,
  settlePromise,
  squashAtomCommandFailure,
} from "@spiritdevs/client-runtime/state/runtime";
import type { CompanyId } from "@spiritdevs/contracts/company";
import { FolderKanbanIcon, Trash2Icon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { companyListAtom } from "~/cloud/activeCompany";
import { useEnvironmentControl } from "~/cloud/useEnvironmentControl";
import { toastManager } from "~/components/ui/toast";
import { readLocalApi } from "~/localApi";
import { projectEnvironment } from "~/state/projects";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { useUnscopedWorkspaceProjects } from "./useWorkspaceProjects";
import { unassignedWorkspaceProjects, type WorkspaceProject } from "./workspaceProjects.logic";

/**
 * The answer for a row that belongs to nobody but the person answering.
 *
 * It is not a company id: an account provisioned straight into an organization has no personal
 * workspace to name yet, and refusing to offer the choice until one exists is how side projects
 * end up filed against an employer.
 */
const PERSONAL_WORKSPACE = "personal-workspace";

/** A destination a row can be assigned to: a company, or the personal workspace. */
interface AssignmentTarget {
  readonly id: string;
  readonly name: string;
}

/** One row's chosen destination, keyed by project key. */
type Assignments = ReadonlyMap<string, string>;

function ProjectRow({
  project,
  targets,
  value,
  onChange,
  onDelete,
  deleting,
}: {
  readonly project: WorkspaceProject;
  readonly targets: ReadonlyArray<AssignmentTarget>;
  readonly value: string | null;
  readonly onChange: (targetId: string) => void;
  readonly onDelete: () => void;
  readonly deleting: boolean;
}) {
  const checkouts = project.group?.memberProjects ?? [];
  return (
    <div className="flex flex-col gap-2 border-b py-3 last:border-b-0 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <div className="flex min-w-0 items-start gap-2.5">
        <FolderKanbanIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{project.displayName}</p>
          {checkouts.length > 0 ? (
            <p className="truncate text-xs text-muted-foreground">
              {checkouts[0]?.workspaceRoot ?? "No directory"}
              {checkouts.length > 1 ? ` · +${checkouts.length - 1} more` : ""}
            </p>
          ) : null}
        </div>
      </div>
      <Select
        value={value}
        onValueChange={(next) => {
          if (next !== null) onChange(next);
        }}
        aria-label={`Owner for ${project.displayName}`}
      >
        <SelectTrigger className="w-full sm:w-56">
          <SelectValue placeholder="Choose an owner">
            {targets.find((target) => target.id === value)?.name}
          </SelectValue>
        </SelectTrigger>
        <SelectPopup>
          {targets.map((target) => (
            <SelectItem key={target.id} value={target.id}>
              {target.name}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={`Delete ${project.displayName}`}
        title="Delete this project instead of assigning it"
        disabled={deleting}
        onClick={onDelete}
        className="shrink-0 text-muted-foreground hover:text-destructive"
      >
        <Trash2Icon className="size-4" />
      </Button>
    </div>
  );
}

export function AssignProjectCompanyDialog() {
  const projects = useUnscopedWorkspaceProjects();
  const companies = useAtomValue(companyListAtom);
  const control = useEnvironmentControl();
  const [assignments, setAssignments] = useState<Assignments>(new Map());
  const [saving, setSaving] = useState(false);
  const [dismissedFor, setDismissedFor] = useState<ReadonlyArray<string>>([]);

  const unassigned = useMemo(() => {
    const pending = unassignedWorkspaceProjects(projects);
    return pending.filter((project) => !dismissedFor.includes(project.projectKey));
  }, [dismissedFor, projects]);

  // Nothing to ask about until the company list has loaded, and nothing to ask *with* if the user
  // has no company at all — that is onboarding's job, not this dialog's.
  const open = unassigned.length > 0 && companies.length > 0 && control !== null;

  // The personal workspace is offered whether or not the account has one yet; choosing it is what
  // creates it. Everything else is a company this person is already a member of.
  const targets = useMemo<ReadonlyArray<AssignmentTarget>>(
    () =>
      companies.some((company) => company.workspaceKind === "personal")
        ? companies
        : [...companies, { id: PERSONAL_WORKSPACE, name: "Personal workspace" }],
    [companies],
  );

  const setAssignment = useCallback((projectKey: string, targetId: string) => {
    setAssignments((current) => new Map(current).set(projectKey, targetId));
  }, []);

  const deleteProject = useAtomCommand(projectEnvironment.delete, { reportFailure: false });
  const [deletingKey, setDeletingKey] = useState<string | null>(null);

  // The escape hatch: a project you refuse to give an owner can be deleted instead, so this gate
  // can never hold the app hostage. Deletion is local-first — it removes the checkout's project
  // records (and their threads) on every machine that has one; there is nothing cloud-side yet,
  // because being unassigned is exactly what this dialog is about.
  const removeProject = async (project: WorkspaceProject) => {
    if (deletingKey !== null || saving) return;
    const checkouts = project.group?.memberProjects ?? [];
    if (checkouts.length === 0) {
      setDismissedFor((current) => [...current, project.projectKey]);
      return;
    }
    const api = readLocalApi();
    if (api === undefined) return;
    const confirmed = await settlePromise(() =>
      api.dialogs.confirm(
        [
          `Delete project "${project.displayName}" instead of assigning it?`,
          ...checkouts.map((checkout) => `Path: ${checkout.workspaceRoot ?? "No directory"}`),
          "This deletes its project entries and their threads, not the files on disk.",
          "This action cannot be undone.",
        ].join("\n"),
        { variant: "destructive" },
      ),
    );
    if (confirmed._tag === "Failure" || !confirmed.value) return;
    setDeletingKey(project.projectKey);
    try {
      for (const checkout of checkouts) {
        const result = mapAtomCommandResult(
          await deleteProject({
            environmentId: checkout.environmentId,
            input: { projectId: checkout.id, force: true },
          }),
          () => undefined,
        );
        if (result._tag === "Failure") {
          const error = squashAtomCommandFailure(result);
          toastManager.add({
            type: "error",
            title: `Could not delete "${project.displayName}"`,
            description: error instanceof Error ? error.message : "An error occurred.",
          });
          return;
        }
      }
      setDismissedFor((current) => [...current, project.projectKey]);
    } finally {
      setDeletingKey(null);
    }
  };

  const complete = unassigned.every((project) => assignments.has(project.projectKey));

  const save = async () => {
    if (control === null || !complete || saving) return;
    setSaving(true);
    const assigned: string[] = [];
    // Resolved once per save: the first row that picks the personal workspace provisions it, and
    // every later row lands in that same workspace rather than racing a second one into existence.
    let personalWorkspaceId: CompanyId | null = null;
    const resolveTarget = async (targetId: string): Promise<CompanyId> => {
      if (targetId !== PERSONAL_WORKSPACE) return targetId as CompanyId;
      personalWorkspaceId ??= await control.provisionPersonalWorkspace();
      return personalWorkspaceId;
    };
    try {
      for (const project of unassigned) {
        const targetId = assignments.get(project.projectKey);
        if (targetId === undefined) continue;
        const checkouts = project.group?.memberProjects ?? [];
        if (checkouts.length === 0) continue;
        const companyId = await resolveTarget(targetId);
        // Register every checkout, not just the first: the same project on a second machine is the
        // same project, and binding only one would leave the others unassigned on next launch.
        for (const checkout of checkouts) {
          await control.ensureEnvironmentProject({ companyId, project: checkout });
        }
        assigned.push(project.projectKey);
      }
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: "Could not assign every project",
        description: cause instanceof Error ? cause.message : "An error occurred.",
      });
      // Whatever did land stays landed; the next launch asks about the rest.
      setDismissedFor((current) => [...current, ...assigned]);
      setSaving(false);
      return;
    }
    setDismissedFor((current) => [...current, ...assigned]);
    setSaving(false);
  };

  return (
    <Dialog open={open} onOpenChange={() => undefined}>
      <DialogPopup className="max-w-2xl" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Which company owns these projects?</DialogTitle>
          <DialogDescription>
            A project belongs to a company so its issues, milestones, and members have somewhere to
            live. Pick your personal workspace for anything that is only yours.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col">
            {unassigned.map((project) => (
              <ProjectRow
                key={project.projectKey}
                project={project}
                targets={targets}
                value={assignments.get(project.projectKey) ?? null}
                onChange={(targetId) => setAssignment(project.projectKey, targetId)}
                onDelete={() => void removeProject(project)}
                deleting={deletingKey === project.projectKey}
              />
            ))}
          </div>
          <div className="mt-5 flex justify-end">
            <Button disabled={!complete || saving} onClick={() => void save()}>
              {saving ? "Assigning…" : "Assign projects"}
            </Button>
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
