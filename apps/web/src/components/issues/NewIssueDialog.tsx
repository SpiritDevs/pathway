/**
 * Create-issue modal. "Create more" keeps the dialog open with the pickers intact, which is the
 * shape of the only bulk entry path stage 1 has that is not a CSV.
 *
 * @module components/issues/NewIssueDialog
 */
import { ISSUE_MAX_PARENT_DEPTH } from "@t3tools/contracts";
import type {
  Issue,
  IssueCreateInput,
  IssueCycleId,
  IssueId,
  IssueLabel,
  IssueLabelId,
  IssueMilestoneId,
  IssuePriority,
  IssueStatus,
  IssueStatusId,
  ProjectId,
} from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import { AsyncResult } from "effect/unstable/reactivity";
import {
  CalendarRangeIcon,
  CircleDotIcon,
  FlagIcon,
  FolderIcon,
  GitBranchIcon,
  SignalHighIcon,
  TagIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  useCreateIssue,
  useIssueCycles,
  useIssueMilestonesForProject,
  useIssuesStore,
} from "~/state/issues";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { QuickCreateProjectDialog } from "../projects/QuickCreateProjectDialog";
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
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Textarea } from "../ui/textarea";
import { reportIssueWriteFailure } from "./issueWriteFeedback";
import { IssueLabelDot, IssuePriorityIcon, IssueStatusDot } from "./IssueGlyphs";
import {
  IssueLabelsMenu,
  IssuePriorityMenu,
  IssueProjectMenu,
  IssueStatusMenu,
} from "./IssuePropertyMenus";
import {
  IssueCyclePicker,
  IssueMilestonePicker,
  IssueSearchList,
  IssueStatusGlyphFor,
} from "./IssueSelectors";
import { buildIssueTreeIndex, issueAncestorDepth, searchIssues } from "./issueDetail.logic";
import { ISSUE_PRIORITY_LABELS, toggleIssueLabelIds } from "./issuesList.logic";

const PICKER_CLASS =
  "flex h-7 items-center gap-1.5 rounded-md border border-input px-2 text-xs text-foreground outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring";

/**
 * The parents a *new* issue may take. It is a leaf by construction, so the whole rule reduces to
 * "the candidate is not already at the cap" — no subtree to carry and nothing it can be an
 * ancestor of.
 */
function ParentPicker({
  issues,
  value,
  statusById,
  onSelect,
  trigger,
}: {
  issues: ReadonlyMap<IssueId, Issue>;
  value: Issue | null;
  statusById: ReadonlyMap<IssueStatusId, IssueStatus>;
  onSelect: (parentId: IssueId | null) => void;
  trigger: React.ReactElement;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const results = useMemo(() => {
    const tree = buildIssueTreeIndex(issues.values());
    const allowed = [...tree.byId.values()].filter(
      (candidate) => issueAncestorDepth(tree, candidate.id) + 1 <= ISSUE_MAX_PARENT_DEPTH,
    );
    return searchIssues(allowed, { query });
  }, [issues, query]);

  return (
    <Popover
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
      open={open}
    >
      <PopoverTrigger render={trigger} />
      <PopoverPopup align="start" className="w-72 p-1.5">
        <IssueSearchList
          emptyHint="No issue can take a sub-issue here."
          onPick={(picked) => {
            onSelect(picked.id);
            setOpen(false);
          }}
          onQueryChange={setQuery}
          placeholder="Search by key or title…"
          query={query}
          renderStatusGlyph={(candidate) => (
            <IssueStatusGlyphFor issue={candidate} statusById={statusById} />
          )}
          results={results}
        />
        {value === null ? null : (
          <button
            className="mt-1.5 w-full border-t border-border/60 px-1.5 pt-1.5 text-start text-[13px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => {
              onSelect(null);
              setOpen(false);
            }}
            type="button"
          >
            No parent
          </button>
        )}
      </PopoverPopup>
    </Popover>
  );
}

export function NewIssueDialog({
  open,
  onOpenChange,
  statuses,
  labels,
  projects,
  defaultStatusId,
  defaultProjectId,
  defaultMilestoneId = null,
  defaultCycleId = null,
  defaultParentId = null,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  statuses: ReadonlyArray<IssueStatus>;
  labels: ReadonlyArray<IssueLabel>;
  projects: ReadonlyArray<EnvironmentProject>;
  /** The tab's first status, so a new issue lands where the user is looking. */
  defaultStatusId: IssueStatusId | null;
  defaultProjectId: ProjectId | null;
  defaultMilestoneId?: IssueMilestoneId | null;
  defaultCycleId?: IssueCycleId | null;
  /** Set by "Add sub-issue", which is the only path that opens this dialog with a parent. */
  defaultParentId?: IssueId | null;
}) {
  const createIssue = useCreateIssue();
  const store = useIssuesStore();
  const cycles = useIssueCycles();
  const titleRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [statusId, setStatusId] = useState<IssueStatusId | null>(defaultStatusId);
  const [priority, setPriority] = useState<IssuePriority>("none");
  const [projectId, setProjectId] = useState<ProjectId | null>(defaultProjectId);
  const [milestoneId, setMilestoneId] = useState<IssueMilestoneId | null>(defaultMilestoneId);
  const [cycleId, setCycleId] = useState<IssueCycleId | null>(defaultCycleId);
  const [parentId, setParentId] = useState<IssueId | null>(defaultParentId);
  const [labelIds, setLabelIds] = useState<ReadonlyArray<IssueLabelId>>([]);
  const [showMore, setShowMore] = useState(false);
  const [createMore, setCreateMore] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [quickCreateProjectOpen, setQuickCreateProjectOpen] = useState(false);
  const primaryEnvironmentId = usePrimaryEnvironmentId();

  const milestones = useIssueMilestonesForProject(projectId);

  // Reopening starts from the current tab and filter rather than from whatever the last create
  // left behind. "More" opens expanded when something arrived in it — a sub-issue create, a
  // milestone-filtered list — so the field that is already set is visible.
  useEffect(() => {
    if (!open) return;
    setTitle("");
    setDescription("");
    setStatusId(defaultStatusId);
    setPriority("none");
    setProjectId(defaultProjectId);
    setMilestoneId(defaultMilestoneId);
    setCycleId(defaultCycleId);
    setParentId(defaultParentId);
    setLabelIds([]);
    setShowMore(defaultMilestoneId !== null || defaultCycleId !== null || defaultParentId !== null);
    setSubmitting(false);
    const frame = window.requestAnimationFrame(() => titleRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [
    defaultCycleId,
    defaultMilestoneId,
    defaultParentId,
    defaultProjectId,
    defaultStatusId,
    open,
  ]);

  const selectedStatus = statuses.find((status) => status.id === statusId) ?? null;
  const selectedProject = projects.find((project) => project.id === projectId) ?? null;
  const selectedLabels = labels.filter((label) => labelIds.includes(label.id));
  const selectedMilestone = milestones.find((milestone) => milestone.id === milestoneId) ?? null;
  const selectedCycle = cycles.find((cycle) => cycle.id === cycleId) ?? null;
  const selectedParent = parentId === null ? null : (store.issuesById.get(parentId) ?? null);
  const statusById = useMemo(
    () => new Map(statuses.map((status) => [status.id, status])),
    [statuses],
  );
  const canSubmit = title.trim().length > 0 && !submitting;

  const submit = async () => {
    const trimmed = title.trim();
    if (trimmed.length === 0 || submitting) return;
    setSubmitting(true);
    const input: IssueCreateInput = {
      title: trimmed,
      ...(description.length > 0 ? { description } : {}),
      ...(statusId === null ? {} : { statusId }),
      ...(priority === "none" ? {} : { priority }),
      ...(projectId === null ? {} : { projectId }),
      // A milestone belongs to a project, so it only travels with one.
      ...(milestoneId === null || projectId === null ? {} : { milestoneId }),
      ...(cycleId === null ? {} : { cycleId }),
      ...(parentId === null ? {} : { parentId }),
      ...(labelIds.length > 0 ? { labelIds } : {}),
    };
    const result = await createIssue(input);
    setSubmitting(false);
    // The dialog stays open on a refusal with the draft intact: the server can reject a create the
    // form cannot pre-empt (a status deleted from another tab, a tracker with no statuses at all).
    if (reportIssueWriteFailure("Failed to create the issue", result)) return;
    if (!AsyncResult.isSuccess(result)) return;
    if (createMore) {
      setTitle("");
      setDescription("");
      titleRef.current?.focus();
      return;
    }
    onOpenChange(false);
  };

  return (
    <>
      {/* Sibling, not nested: a dialog inside a dialog's popup would close with it. */}
      <QuickCreateProjectDialog
        environmentId={primaryEnvironmentId}
        onCreated={(created) => {
          setProjectId(created.projectId);
          setMilestoneId(null);
        }}
        onOpenChange={setQuickCreateProjectOpen}
        open={quickCreateProjectOpen}
      />
      <Dialog
        onOpenChange={(nextOpen) => {
          if (!submitting) onOpenChange(nextOpen);
        }}
        open={open}
      >
        <DialogPopup className="max-w-xl">
          <DialogHeader>
            <DialogTitle>New issue</DialogTitle>
            <DialogDescription>
              {selectedProject === null
                ? "Tracked on this environment."
                : `Tracked in ${selectedProject.title}.`}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-3">
            <Input
              aria-label="Issue title"
              onChange={(event) => setTitle(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                void submit();
              }}
              placeholder="Issue title"
              ref={titleRef}
              value={title}
            />
            <Textarea
              aria-label="Issue description"
              className="min-h-24"
              onChange={(event) => setDescription(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return;
                event.preventDefault();
                void submit();
              }}
              placeholder="Add a description…"
              value={description}
            />
            <div className="flex flex-wrap items-center gap-1.5">
              <IssueStatusMenu
                onSelect={setStatusId}
                statuses={statuses}
                trigger={
                  <button className={PICKER_CLASS} type="button">
                    {selectedStatus === null ? (
                      <CircleDotIcon className="size-3.5 text-muted-foreground" />
                    ) : (
                      <IssueStatusDot status={selectedStatus} />
                    )}
                    {selectedStatus?.name ?? "Status"}
                  </button>
                }
                value={statusId}
              />
              <IssuePriorityMenu
                onSelect={setPriority}
                trigger={
                  <button className={PICKER_CLASS} type="button">
                    {priority === "none" ? (
                      <SignalHighIcon className="size-3.5 text-muted-foreground" />
                    ) : (
                      <IssuePriorityIcon priority={priority} />
                    )}
                    {priority === "none" ? "Priority" : ISSUE_PRIORITY_LABELS[priority]}
                  </button>
                }
                value={priority}
              />
              <IssueProjectMenu
                onCreateProject={() => setQuickCreateProjectOpen(true)}
                onSelect={(next) => {
                  setProjectId(next);
                  // A milestone belongs to the project it was picked in; keeping it across a move
                  // would send the server one it refuses.
                  setMilestoneId(null);
                }}
                projects={projects}
                trigger={
                  <button className={PICKER_CLASS} type="button">
                    <FolderIcon className="size-3.5 text-muted-foreground" />
                    {selectedProject?.title ?? "Project"}
                  </button>
                }
                value={projectId}
              />
              <IssueLabelsMenu
                issues={[]}
                labels={labels}
                onToggle={(labelId) =>
                  setLabelIds((current) => toggleIssueLabelIds(current, labelId))
                }
                trigger={
                  <button className={PICKER_CLASS} type="button">
                    <TagIcon className="size-3.5 text-muted-foreground" />
                    {selectedLabels.length === 0 ? "Labels" : `${selectedLabels.length} labels`}
                  </button>
                }
              />
              {showMore ? null : (
                <button
                  className="h-7 rounded-md px-2 text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => setShowMore(true)}
                  type="button"
                >
                  More…
                </button>
              )}
            </div>

            {showMore ? (
              <div className="flex flex-wrap items-center gap-1.5">
                <IssueMilestonePicker
                  hasProject={projectId !== null}
                  milestones={milestones}
                  onSelect={setMilestoneId}
                  trigger={
                    <button className={PICKER_CLASS} type="button">
                      <FlagIcon className="size-3.5 text-muted-foreground" />
                      {selectedMilestone?.name ?? "Milestone"}
                    </button>
                  }
                  value={milestoneId}
                />
                <IssueCyclePicker
                  cycles={cycles}
                  onSelect={setCycleId}
                  trigger={
                    <button className={PICKER_CLASS} type="button">
                      <CalendarRangeIcon className="size-3.5 text-muted-foreground" />
                      {selectedCycle?.name ?? "Cycle"}
                    </button>
                  }
                  value={cycleId}
                />
                <ParentPicker
                  issues={store.issuesById}
                  onSelect={setParentId}
                  statusById={statusById}
                  trigger={
                    <button className={PICKER_CLASS} type="button">
                      <GitBranchIcon className="size-3.5 text-muted-foreground" />
                      <span className="max-w-40 truncate">
                        {selectedParent === null ? "Parent" : selectedParent.key}
                      </span>
                    </button>
                  }
                  value={selectedParent}
                />
              </div>
            ) : null}

            {selectedLabels.length === 0 ? null : (
              <div className="flex flex-wrap gap-1">
                {selectedLabels.map((label) => (
                  <span
                    className="flex items-center gap-1 rounded-full border border-border/60 px-1.5 py-px text-[11px] text-muted-foreground"
                    key={label.id}
                  >
                    <IssueLabelDot className="size-1.5" color={label.color} />
                    {label.name}
                  </span>
                ))}
              </div>
            )}
          </DialogPanel>
          <DialogFooter className="items-center">
            <Label className="me-auto flex items-center gap-2 text-xs text-muted-foreground">
              <Checkbox
                checked={createMore}
                onCheckedChange={(checked) => setCreateMore(checked === true)}
              />
              Create more
            </Label>
            <Button
              disabled={submitting}
              onClick={() => onOpenChange(false)}
              size="sm"
              type="button"
              variant="outline"
            >
              Cancel
            </Button>
            <Button disabled={!canSubmit} onClick={() => void submit()} size="sm" type="button">
              Create issue
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
