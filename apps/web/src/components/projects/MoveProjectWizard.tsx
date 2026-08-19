/**
 * Moving a project, and everything filed against it, to another company.
 *
 * A stepper rather than a confirm dialog, because the move is a migration and most of it is
 * lossy: statuses and labels have to be re-pointed at the destination company's values, and every
 * issue key is re-issued under its prefix. The obvious mappings are proposed automatically; the
 * rest are left blank on purpose. Nothing is written until the review step, which states plainly
 * what will not survive.
 *
 * @module components/projects/MoveProjectWizard
 */
import { useAtomValue } from "@effect/atom-react";
import type { CompanyId } from "@spiritdevs/contracts/company";
import { AlertTriangleIcon, ArrowRightIcon, CheckIcon, FolderSyncIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { companyListAtom } from "~/cloud/activeCompany";
import { useEnvironmentControl } from "~/cloud/useEnvironmentControl";
import { useCompanyIssuesStore } from "~/state/issues";
import { toastManager } from "~/components/ui/toast";
import { cn } from "~/lib/utils";
import { Badge } from "../ui/badge";
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
  matchMapping,
  matchesAreComplete,
  proposeMatches,
  type NamedValue,
  type ProposedMatch,
} from "./projectMigration.logic";
import type { WorkspaceProject } from "./workspaceProjects.logic";

const STEPS = ["Destination", "Statuses", "Labels", "Review"] as const;
type Step = (typeof STEPS)[number];

function StepHeader({
  current,
  steps,
}: {
  readonly current: Step;
  readonly steps: readonly Step[];
}) {
  return (
    <ol className="mb-5 flex flex-wrap items-center gap-1.5 text-xs" aria-label="Migration steps">
      {steps.map((step, index) => {
        const currentIndex = steps.indexOf(current);
        const state = index < currentIndex ? "done" : index === currentIndex ? "current" : "todo";
        return (
          <li key={step} className="flex items-center gap-1.5">
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded-full px-2 py-0.5",
                state === "current" && "bg-primary/10 font-medium text-primary",
                state === "done" && "text-muted-foreground",
                state === "todo" && "text-muted-foreground/60",
              )}
              aria-current={state === "current" ? "step" : undefined}
            >
              {state === "done" ? <CheckIcon className="size-3" aria-hidden /> : null}
              {step}
            </span>
            {index < steps.length - 1 ? (
              <ArrowRightIcon className="size-3 text-muted-foreground/40" aria-hidden />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

function MappingStep({
  what,
  source,
  target,
  matches,
  onChange,
  unmatchedNote,
}: {
  readonly what: string;
  readonly source: ReadonlyArray<NamedValue>;
  readonly target: ReadonlyArray<NamedValue>;
  readonly matches: ReadonlyArray<ProposedMatch>;
  readonly onChange: (sourceId: string, targetId: string | null) => void;
  readonly unmatchedNote: string;
}) {
  const nameById = new Map(source.map((value) => [value.id, value.name]));
  if (source.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        This project&rsquo;s issues use no {what}, so there is nothing to map.
      </p>
    );
  }
  return (
    <div className="space-y-1">
      <p className="mb-3 text-sm text-muted-foreground">{unmatchedNote}</p>
      {matches.map((match) => (
        <div
          key={match.sourceId}
          className="flex flex-col gap-2 border-b py-2.5 last:border-b-0 sm:flex-row sm:items-center sm:gap-3"
        >
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <span className="truncate text-sm">{nameById.get(match.sourceId)}</span>
            {match.confidence === "close" ? <Badge variant="secondary">Suggested</Badge> : null}
          </div>
          <ArrowRightIcon
            aria-hidden
            className="hidden size-3.5 shrink-0 text-muted-foreground sm:block"
          />
          <Select
            value={match.targetId}
            onValueChange={(next) => onChange(match.sourceId, (next as string | null) ?? null)}
            aria-label={`Destination for ${nameById.get(match.sourceId)}`}
          >
            <SelectTrigger className="w-full sm:w-56">
              <SelectValue placeholder="Choose…" />
            </SelectTrigger>
            <SelectPopup>
              {target.map((value) => (
                <SelectItem key={value.id} value={value.id}>
                  {value.name}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
      ))}
    </div>
  );
}

export function MoveProjectWizard({
  project,
  open,
  onOpenChange,
  initialDestination = null,
}: {
  readonly project: WorkspaceProject;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Settings already has a company dropdown, so it can skip the duplicate destination step. */
  readonly initialDestination?: CompanyId | null;
}) {
  const companies = useAtomValue(companyListAtom);
  const control = useEnvironmentControl();
  const [step, setStep] = useState<Step>("Destination");
  const [destination, setDestination] = useState<CompanyId | null>(null);
  const [statusMatches, setStatusMatches] = useState<ReadonlyArray<ProposedMatch>>([]);
  const [labelMatches, setLabelMatches] = useState<ReadonlyArray<ProposedMatch>>([]);
  const [moving, setMoving] = useState(false);
  const steps = initialDestination === null ? STEPS : STEPS.slice(1);

  const sourceCompanyId = (project.companyIds[0] ?? null) as CompanyId | null;
  const sourceStore = useCompanyIssuesStore(sourceCompanyId).store;
  const destinationStore = useCompanyIssuesStore(destination).store;
  const destinationCompany = companies.find((company) => company.id === destination) ?? null;

  useEffect(() => {
    if (!open) return;
    setDestination(initialDestination);
    setStatusMatches([]);
    setLabelMatches([]);
    setStep(initialDestination === null ? "Destination" : "Statuses");
  }, [initialDestination, open]);

  const projectIds = useMemo(() => {
    const ids = new Set<string>();
    if (project.cloudProjectId !== null) ids.add(project.cloudProjectId);
    if (project.group !== null) {
      ids.add(String(project.group.id));
      for (const member of project.group.memberProjects) ids.add(String(member.id));
    }
    return ids;
  }, [project]);

  const movingIssues = useMemo(
    () =>
      [...sourceStore.issuesById.values()].filter(
        (issue) => issue.projectId !== null && projectIds.has(String(issue.projectId)),
      ),
    [projectIds, sourceStore.issuesById],
  );

  // Only the values the moving issues actually use need a decision. Mapping a company's entire
  // workflow when the project touches three statuses is busywork.
  const usedStatuses = useMemo<ReadonlyArray<NamedValue>>(() => {
    const used = new Set(movingIssues.map((issue) => String(issue.statusId)));
    return sourceStore.statuses
      .filter((status) => used.has(String(status.id)))
      .map((status) => ({ id: String(status.id), name: status.name, category: status.category }));
  }, [movingIssues, sourceStore.statuses]);

  const usedLabels = useMemo<ReadonlyArray<NamedValue>>(() => {
    const used = new Set(movingIssues.flatMap((issue) => issue.labelIds.map(String)));
    return sourceStore.labels
      .filter((label) => used.has(String(label.id)))
      .map((label) => ({ id: String(label.id), name: label.name }));
  }, [movingIssues, sourceStore.labels]);

  const destinationStatuses = useMemo<ReadonlyArray<NamedValue>>(
    () =>
      destinationStore.statuses.map((status) => ({
        id: String(status.id),
        name: status.name,
        category: status.category,
      })),
    [destinationStore.statuses],
  );
  const destinationLabels = useMemo<ReadonlyArray<NamedValue>>(
    () => destinationStore.labels.map((label) => ({ id: String(label.id), name: label.name })),
    [destinationStore.labels],
  );

  useEffect(() => {
    if (!open || initialDestination === null || step !== "Statuses") return;
    setStatusMatches((current) => {
      const destinationJustLoaded =
        destinationStatuses.length > 0 && current.every((match) => match.targetId === null);
      return current.length === 0 || destinationJustLoaded
        ? proposeMatches(usedStatuses, destinationStatuses)
        : current;
    });
  }, [destinationStatuses, initialDestination, open, step, usedStatuses]);

  const chooseDestination = (companyId: CompanyId) => {
    setDestination(companyId);
    setStatusMatches([]);
    setLabelMatches([]);
  };

  const goToStatuses = () => {
    setStatusMatches(proposeMatches(usedStatuses, destinationStatuses));
    setStep("Statuses");
  };
  const goToLabels = () => {
    setLabelMatches(proposeMatches(usedLabels, destinationLabels));
    setStep("Labels");
  };

  const setMatch = (setter: typeof setStatusMatches, sourceId: string, targetId: string | null) => {
    setter((current) =>
      current.map((match) =>
        match.sourceId === sourceId ? { ...match, targetId, confidence: "exact" } : match,
      ),
    );
  };

  const statusesReady = usedStatuses.length === 0 || matchesAreComplete(statusMatches);
  const droppedLabelCount = labelMatches.filter((match) => match.targetId === null).length;

  const move = async () => {
    if (control === null || sourceCompanyId === null || destination === null || moving) return;
    setMoving(true);
    try {
      const result = await control.moveProjectToCompany({
        fromCompanyId: sourceCompanyId,
        toCompanyId: destination,
        projectId: project.cloudProjectId ?? "",
        statusMapping: matchMapping(statusMatches),
        labelMapping: matchMapping(labelMatches),
      });
      toastManager.add({
        type: "success",
        title: `Moved to ${destinationCompany?.name ?? "the new company"}`,
        description: [
          `${result.movedIssues} ${result.movedIssues === 1 ? "issue" : "issues"} re-keyed`,
          `${result.movedThreads} ${result.movedThreads === 1 ? "thread" : "threads"} moved`,
          `${result.movedIssueAssets} related ${result.movedIssueAssets === 1 ? "record" : "records"} moved`,
          ...(result.canceledAutomationJobs > 0
            ? [`${result.canceledAutomationJobs} active automation canceled`]
            : []),
          ...(result.detachedSlackWatches > 0
            ? [
                `${result.detachedSlackWatches} Slack ${result.detachedSlackWatches === 1 ? "watch" : "watches"} detached`,
              ]
            : []),
        ].join(" · "),
      });
      onOpenChange(false);
      setStep("Destination");
      setDestination(null);
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: "Could not move the project",
        description: cause instanceof Error ? cause.message : "An error occurred.",
      });
    } finally {
      setMoving(false);
    }
  };

  const candidates = companies.filter(
    (company) => !project.companyIds.includes(String(company.id)),
  );

  return (
    <Dialog open={open} onOpenChange={(next) => !moving && onOpenChange(next)}>
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Move {project.displayName}</DialogTitle>
          <DialogDescription>
            The project and everything associated with it move together to another company.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {moving ? (
            <div className="space-y-4 py-2" role="status" aria-live="polite">
              <div className="flex items-start gap-3 rounded-lg border border-primary/20 bg-primary/5 p-4">
                <FolderSyncIcon aria-hidden className="mt-0.5 size-5 shrink-0 text-primary" />
                <div>
                  <p className="text-sm font-medium">Moving project data…</p>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    This runs as one atomic migration. Keep this window open until it commits;
                    connected replicas reconcile from the company feeds immediately afterwards.
                  </p>
                </div>
              </div>
              <ul className="space-y-2 text-sm text-muted-foreground">
                <li>Project details and environment connections</li>
                <li>
                  {movingIssues.length} {movingIssues.length === 1 ? "issue" : "issues"}, including
                  comments, files, checklists, relations, and linked threads
                </li>
                <li>Agent thread metadata, milestones, and captured email</li>
                <li>Automation cleanup and source-only integration detachment</li>
                <li>Source cleanup and destination sync</li>
              </ul>
            </div>
          ) : (
            <StepHeader current={step} steps={steps} />
          )}

          {!moving && step === "Destination" ? (
            candidates.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                There is no other company to move this project to.
              </p>
            ) : (
              <div className="space-y-1">
                {candidates.map((company) => (
                  <button
                    key={company.id}
                    type="button"
                    onClick={() => chooseDestination(company.id)}
                    className={cn(
                      "flex w-full items-center justify-between rounded-lg border px-3 py-2.5 text-start outline-none transition-colors hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring",
                      destination === company.id
                        ? "border-primary bg-primary/5"
                        : "border-border/70",
                    )}
                  >
                    <span className="text-sm font-medium">{company.name}</span>
                    <span className="text-xs text-muted-foreground">
                      Keys become {company.issueKeyPrefix}-…
                    </span>
                  </button>
                ))}
              </div>
            )
          ) : null}

          {!moving && step === "Statuses" ? (
            <MappingStep
              what="statuses"
              source={usedStatuses}
              target={destinationStatuses}
              matches={statusMatches}
              onChange={(sourceId, targetId) => setMatch(setStatusMatches, sourceId, targetId)}
              unmatchedNote="Every status has to have a home in the new company. Matching names are filled in already."
            />
          ) : null}

          {!moving && step === "Labels" ? (
            <MappingStep
              what="labels"
              source={usedLabels}
              target={destinationLabels}
              matches={labelMatches}
              onChange={(sourceId, targetId) => setMatch(setLabelMatches, sourceId, targetId)}
              unmatchedNote="A label left unmapped is removed from its issues when they move."
            />
          ) : null}

          {!moving && step === "Review" ? (
            <div className="space-y-4">
              <div className="rounded-lg border border-warning/30 bg-warning/5 p-3">
                <p className="flex items-center gap-2 text-sm font-medium">
                  <AlertTriangleIcon aria-hidden className="size-4 text-warning" />
                  Issue keys change and cannot be changed back
                </p>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  {movingIssues.length} {movingIssues.length === 1 ? "issue" : "issues"} will be
                  re-keyed under {destinationCompany?.issueKeyPrefix ?? "the new prefix"}. Any key
                  you have linked, quoted, or referenced in a commit will no longer resolve.
                </p>
              </div>
              <ul className="space-y-1.5 text-sm text-muted-foreground">
                <li>Milestones move with the project.</li>
                <li>Thread metadata, comments, files, checklists, and links move with it.</li>
                <li>In-flight automation is canceled so it cannot write into the old company.</li>
                <li>
                  Slack channel watches remain with their integration and detach from the project.
                </li>
                <li>Cycles do not: moved issues leave their cycle behind.</li>
                <li>Team visibility resets — issues arrive company-wide.</li>
                {droppedLabelCount > 0 ? (
                  <li className="text-warning">
                    {droppedLabelCount} unmapped{" "}
                    {droppedLabelCount === 1 ? "label is" : "labels are"} removed.
                  </li>
                ) : null}
              </ul>
            </div>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          {!moving && steps.indexOf(step) > 0 ? (
            <Button
              variant="outline"
              onClick={() => {
                const previous = steps[steps.indexOf(step) - 1];
                if (previous) setStep(previous);
              }}
              disabled={moving}
            >
              Back
            </Button>
          ) : null}
          {moving ? (
            <Button disabled>Moving…</Button>
          ) : step === "Destination" ? (
            <Button disabled={destination === null} onClick={goToStatuses}>
              Continue
            </Button>
          ) : step === "Statuses" ? (
            <Button disabled={!statusesReady} onClick={goToLabels}>
              Continue
            </Button>
          ) : step === "Labels" ? (
            <Button onClick={() => setStep("Review")}>Continue</Button>
          ) : (
            <Button variant="destructive" onClick={() => void move()}>
              Accept and move
            </Button>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
