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
import type { CompanyId } from "@spiritdevs/contracts/company";
import { FolderKanbanIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { companyListAtom } from "~/cloud/activeCompany";
import { useEnvironmentControl } from "~/cloud/useEnvironmentControl";
import { toastManager } from "~/components/ui/toast";
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
import { useWorkspaceProjects } from "./useWorkspaceProjects";
import { unassignedWorkspaceProjects, type WorkspaceProject } from "./workspaceProjects.logic";

/** One row's chosen destination, keyed by project key. */
type Assignments = ReadonlyMap<string, CompanyId>;

function ProjectRow({
  project,
  companies,
  value,
  onChange,
}: {
  readonly project: WorkspaceProject;
  readonly companies: ReadonlyArray<{ readonly id: CompanyId; readonly name: string }>;
  readonly value: CompanyId | null;
  readonly onChange: (companyId: CompanyId) => void;
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
        onValueChange={(next) => onChange(next as CompanyId)}
        aria-label={`Company for ${project.displayName}`}
      >
        <SelectTrigger className="w-full sm:w-56">
          <SelectValue placeholder="Choose a company">
            {companies.find((company) => company.id === value)?.name}
          </SelectValue>
        </SelectTrigger>
        <SelectPopup>
          {companies.map((company) => (
            <SelectItem key={company.id} value={company.id}>
              {company.name}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </div>
  );
}

export function AssignProjectCompanyDialog() {
  const projects = useWorkspaceProjects();
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

  const setAssignment = useCallback((projectKey: string, companyId: CompanyId) => {
    setAssignments((current) => new Map(current).set(projectKey, companyId));
  }, []);

  const complete = unassigned.every((project) => assignments.has(project.projectKey));

  const save = async () => {
    if (control === null || !complete || saving) return;
    setSaving(true);
    const assigned: string[] = [];
    try {
      for (const project of unassigned) {
        const companyId = assignments.get(project.projectKey);
        if (companyId === undefined) continue;
        const checkouts = project.group?.memberProjects ?? [];
        if (checkouts.length === 0) continue;
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
                companies={companies}
                value={assignments.get(project.projectKey) ?? null}
                onChange={(companyId) => setAssignment(project.projectKey, companyId)}
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
