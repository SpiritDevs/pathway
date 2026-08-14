/**
 * Accepting a triage item: status, project, priority, and assignment in ONE write.
 *
 * The workflow fields and investigation choice are deliberate. Applying them one at a time would
 * put the issue on a board halfway through being triaged, which is the state triage exists to keep
 * out of the board — so the dialog confirms once and the server writes once, per selected item.
 *
 * The same dialog does a bulk accept: the fields are the selection's shared defaults, and the
 * confirm loops the write. There is no bulk RPC because there is no bulk *decision* — a status and
 * a project chosen once are what makes the loop honest.
 *
 * @module components/issues/TriageAcceptDialog
 */
import type { EnvironmentProject } from "@spiritdevs/client-runtime/state/models";
import type {
  Issue,
  IssueAssignee,
  IssuePriority,
  IssueStatus,
  IssueStatusId,
  ProjectId,
} from "@spiritdevs/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { CircleDotIcon, FolderIcon, PlayIcon, SignalHighIcon } from "lucide-react";
import { useEffect, useEffectEvent, useMemo, useState } from "react";

import { cn } from "~/lib/utils";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { useInvestigatedIssueIds, useIssueEnrichmentRuns, useTriageAccept } from "~/state/issues";
import { QuickCreateProjectDialog } from "../projects/QuickCreateProjectDialog";
import { PROVIDER_CLIENT_DEFINITION_BY_VALUE } from "../settings/providerDriverMeta";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Label } from "../ui/label";
import { Spinner } from "../ui/spinner";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { IssueAssigneeGlyph, IssuePriorityIcon, IssueStatusDot } from "./IssueGlyphs";
import {
  IssueAssigneeMenu,
  IssuePriorityMenu,
  IssueProjectMenu,
  IssueStatusMenu,
} from "./IssuePropertyMenus";
import { ISSUE_INVESTIGATE_BLOCK_REASONS } from "./issueEnrichment.logic";
import { reportIssueWriteFailure } from "./issueWriteFeedback";
import { ISSUE_PRIORITY_LABELS } from "./issuesList.logic";
import {
  triageAcceptDefaults,
  triageAcceptInput,
  triageAcceptLabel,
  triageInvestigateBlock,
  issueAlreadyInvestigated,
  issueHasCompletedInvestigation,
  type TriageAcceptDraft,
} from "./triage.logic";

const PICKER_CLASS =
  "flex h-8 w-full items-center gap-1.5 rounded-md border border-input px-2 text-[13px] text-foreground outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring";

/**
 * What the picker reads as. A teammate falls back to their membership rather than to a bare
 * "Member": the picker's whole job is saying which one of them is about to own this.
 */
function assigneeLabel(assignee: IssueAssignee | null): string {
  if (assignee === null) return "Unassigned";
  switch (assignee.kind) {
    case "user":
      return "You";
    case "member":
      return assignee.membershipId;
    case "agent":
      return PROVIDER_CLIENT_DEFINITION_BY_VALUE[assignee.provider]?.label ?? assignee.provider;
  }
}

export function TriageAcceptDialog({
  open,
  onOpenChange,
  issues,
  statuses,
  projects,
  onAccepted,
  onStartTask,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** One row's issue, or the whole selection. Empty closes the dialog rather than rendering it. */
  issues: ReadonlyArray<Issue>;
  statuses: ReadonlyArray<IssueStatus>;
  projects: ReadonlyArray<EnvironmentProject>;
  /** Fired once, after every write in a bulk accept has come back. */
  onAccepted?: () => void;
  /** Fired after a single eligible issue is accepted and ready for its assigned agent. */
  onStartTask?: (issue: Issue) => void;
}) {
  const acceptTriage = useTriageAccept();
  const investigatedIssueIds = useInvestigatedIssueIds();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const [draft, setDraft] = useState<TriageAcceptDraft>({
    statusId: null,
    projectId: null,
    priority: "none",
    assignee: null,
    runEnrichment: false,
  });
  const [submittingAction, setSubmittingAction] = useState<"accept" | "start" | null>(null);
  const [quickCreateProjectOpen, setQuickCreateProjectOpen] = useState(false);

  const workspaceRoots = useMemo(
    () =>
      new Map<string, string | null>(
        projects.map((project) => [project.id, project.workspaceRoot]),
      ),
    [projects],
  );

  const singleIssue = issues.length === 1 ? (issues[0] ?? null) : null;
  // The durable half of "already investigated": the live id set only knows runs this connection
  // saw, so an issue Slack routing investigated yesterday is invisible to it after a reload. The
  // run rows outlive the connection. Only read for a single selection — a bulk accept has no one
  // issue to read, and its per-issue reads would be a round trip each.
  const { runs: enrichmentRuns } = useIssueEnrichmentRuns(
    open && singleIssue !== null ? singleIssue.id : null,
  );

  // The page above rebuilds `issues` on every render, so the ids are what identify the selection
  // this dialog was opened on.
  const selectionKey = issues.map((issue) => issue.id).join(",");
  const resetDraft = useEffectEvent(() => {
    setDraft(
      triageAcceptDefaults({
        issues,
        statuses,
        workspaceRoots,
        investigatedIssueIds,
        enrichmentRuns,
      }),
    );
    setSubmittingAction(null);
  });

  // Reopening starts from the selection's defaults rather than from whatever the last accept left
  // behind: a second item is a second decision, and it usually has a different auto-tag.
  useEffect(() => {
    if (!open) return;
    resetDraft();
  }, [open, selectionKey]);

  const anyAlreadyInvestigated = issues.some((issue) =>
    issueAlreadyInvestigated(issue, investigatedIssueIds, enrichmentRuns),
  );

  // The runs read lands a beat after the dialog opens, so the defaults above were computed without
  // it. Withdraw the offer when it arrives, and only ever withdraw: by the time this fires the
  // checkbox may be a choice somebody made, and re-ticking it would overrule them.
  const withdrawEnrichment = useEffectEvent(() => {
    setDraft((current) => (current.runEnrichment ? { ...current, runEnrichment: false } : current));
  });
  useEffect(() => {
    if (!open || !anyAlreadyInvestigated) return;
    withdrawEnrichment();
  }, [open, anyAlreadyInvestigated]);

  const investigateBlock = triageInvestigateBlock({
    projectId: draft.projectId,
    workspaceRoots,
  });
  const selectedStatus = statuses.find((status) => status.id === draft.statusId) ?? null;
  const selectedProject = projects.find((project) => project.id === draft.projectId) ?? null;
  const selectedAssigneeLabel = assigneeLabel(draft.assignee);
  const alreadyInvestigated =
    singleIssue !== null && issueHasCompletedInvestigation(singleIssue, enrichmentRuns);
  const submitting = submittingAction !== null;
  const canSubmit = draft.statusId !== null && issues.length > 0 && !submitting;
  const startTaskBlockReason =
    investigateBlock === null
      ? draft.runEnrichment
        ? "Turn off Investigate after accepting before starting the task."
        : null
      : ISSUE_INVESTIGATE_BLOCK_REASONS[investigateBlock];
  const canStartTask =
    canSubmit &&
    singleIssue !== null &&
    alreadyInvestigated &&
    draft.assignee?.kind === "agent" &&
    startTaskBlockReason === null;

  const submit = (action: "accept" | "start") => {
    if (!canSubmit || (action === "start" && !canStartTask)) return;
    setSubmittingAction(action);
    void (async () => {
      let accepted = 0;
      let acceptedIssue: Issue | null = null;
      let refusal: string | null = null;
      let failed = false;
      for (const issue of issues) {
        const input = triageAcceptInput({
          issue,
          draft,
          investigateBlocked: investigateBlock !== null,
        });
        if (input === null) continue;
        const result = await acceptTriage(input);
        if (reportIssueWriteFailure("Failed to accept the issue", result)) {
          failed = true;
          continue;
        }
        if (!AsyncResult.isSuccess(result)) continue;
        accepted += 1;
        acceptedIssue = result.value.issue;
        // An investigation that could not start does not undo the accept — the server reports the
        // refusal alongside it, and one sentence covers a bulk run of identical refusals.
        if (refusal === null) refusal = result.value.enrichmentRefusal;
      }
      setSubmittingAction(null);
      if (accepted > 0) {
        toastManager.add(
          stackedThreadToast({
            type: "success",
            title:
              accepted === 1
                ? `${issues[0]?.key ?? "Issue"} accepted`
                : `${accepted} issues accepted`,
            ...(refusal === null ? {} : { description: refusal }),
          }),
        );
      }
      // A partial failure keeps the dialog up with the choices intact: the rows that were refused
      // are still in the queue, and retrying should not mean re-picking a status.
      if (failed) return;
      onAccepted?.();
      onOpenChange(false);
      if (action === "start" && acceptedIssue !== null) onStartTask?.(acceptedIssue);
    })();
  };

  const patch = (next: Partial<TriageAcceptDraft>) =>
    setDraft((current) => ({ ...current, ...next }));

  return (
    <>
      {/* Sibling, not nested: a dialog inside a dialog's popup would close with it. */}
      <QuickCreateProjectDialog
        environmentId={primaryEnvironmentId}
        onCreated={(created) => patch({ projectId: created.projectId, runEnrichment: true })}
        onOpenChange={setQuickCreateProjectOpen}
        open={quickCreateProjectOpen}
      />
      <Dialog
        onOpenChange={(next) => {
          if (!submitting) onOpenChange(next);
        }}
        open={open}
      >
        <DialogPopup className="max-w-md">
          <DialogHeader>
            <DialogTitle>{triageAcceptLabel(issues)}</DialogTitle>
            <DialogDescription>
              Status, project, priority, and assignment are set in one write, which is what takes
              these out of triage and into the workflow.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-3">
            <div className="space-y-1">
              <span className="text-xs text-muted-foreground">Status</span>
              <IssueStatusMenu
                onSelect={(statusId: IssueStatusId) => patch({ statusId })}
                statuses={statuses}
                trigger={
                  <button className={PICKER_CLASS} type="button">
                    {selectedStatus === null ? (
                      <CircleDotIcon className="size-3.5 text-muted-foreground" />
                    ) : (
                      <IssueStatusDot status={selectedStatus} />
                    )}
                    <span
                      className={cn("truncate", selectedStatus === null && "text-muted-foreground")}
                    >
                      {selectedStatus?.name ?? "Pick a status"}
                    </span>
                  </button>
                }
                value={draft.statusId}
              />
            </div>

            <div className="space-y-1">
              <span className="text-xs text-muted-foreground">Assigned agent</span>
              <IssueAssigneeMenu
                onSelect={(assignee: IssueAssignee | null) => patch({ assignee })}
                trigger={
                  <button className={PICKER_CLASS} disabled={submitting} type="button">
                    <IssueAssigneeGlyph assignee={draft.assignee} className="size-3.5" />
                    <span
                      className={cn("truncate", draft.assignee === null && "text-muted-foreground")}
                    >
                      {selectedAssigneeLabel}
                    </span>
                  </button>
                }
                value={draft.assignee}
              />
            </div>

            <div className="space-y-1">
              <span className="text-xs text-muted-foreground">Project</span>
              <IssueProjectMenu
                onCreateProject={() => setQuickCreateProjectOpen(true)}
                onSelect={(projectId: ProjectId | null) =>
                  patch({
                    projectId,
                    // The checkbox is a property of the project just chosen, not of the dialog:
                    // picking a rooted project after opening on "no project" re-offers the run,
                    // and picking a rootless one takes the offer away.
                    runEnrichment: triageInvestigateBlock({ projectId, workspaceRoots }) === null,
                  })
                }
                projects={projects}
                trigger={
                  <button className={PICKER_CLASS} type="button">
                    <FolderIcon className="size-3.5 text-muted-foreground" />
                    <span
                      className={cn(
                        "truncate",
                        selectedProject === null && "text-muted-foreground",
                      )}
                    >
                      {selectedProject?.title ?? "No project"}
                    </span>
                  </button>
                }
                value={draft.projectId}
              />
            </div>

            <div className="space-y-1">
              <span className="text-xs text-muted-foreground">Priority</span>
              <IssuePriorityMenu
                onSelect={(priority: IssuePriority) => patch({ priority })}
                trigger={
                  <button className={PICKER_CLASS} type="button">
                    {draft.priority === "none" ? (
                      <SignalHighIcon className="size-3.5 text-muted-foreground" />
                    ) : (
                      <IssuePriorityIcon priority={draft.priority} />
                    )}
                    <span
                      className={cn(
                        "truncate",
                        draft.priority === "none" && "text-muted-foreground",
                      )}
                    >
                      {ISSUE_PRIORITY_LABELS[draft.priority]}
                    </span>
                  </button>
                }
                value={draft.priority}
              />
            </div>

            <div className="space-y-1">
              <Label className="flex items-start gap-2 text-[13px] text-foreground">
                <Checkbox
                  checked={draft.runEnrichment && investigateBlock === null}
                  disabled={investigateBlock !== null}
                  onCheckedChange={(checked) => patch({ runEnrichment: checked === true })}
                />
                Investigate after accepting
              </Label>
              <p className="ps-6 text-[11px] text-muted-foreground">
                {investigateBlock === null
                  ? "Runs the model read-only over the project's directory and appends what it found."
                  : ISSUE_INVESTIGATE_BLOCK_REASONS[investigateBlock]}
              </p>
            </div>
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
            <Button disabled={!canSubmit} onClick={() => submit("accept")} size="sm" type="button">
              {submittingAction === "accept" ? <Spinner className="size-3.5" /> : null}
              {triageAcceptLabel(issues)}
            </Button>
            {singleIssue !== null && alreadyInvestigated && draft.assignee?.kind === "agent" ? (
              <Button
                className="border-emerald-800 bg-emerald-700 text-white shadow-emerald-950/20 hover:bg-emerald-800 dark:border-emerald-600 dark:bg-emerald-700 dark:hover:bg-emerald-600"
                disabled={!canStartTask}
                onClick={() => submit("start")}
                size="sm"
                title={
                  startTaskBlockReason === null
                    ? "Accept this issue and start its assigned agent."
                    : startTaskBlockReason
                }
                type="button"
              >
                {submittingAction === "start" ? <Spinner className="size-3.5" /> : <PlayIcon />}
                Start Task
              </Button>
            ) : null}
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
