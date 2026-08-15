/**
 * `/issues/milestones/$milestoneId` — one milestone: what it is, whether it will land, and the
 * issues inside it.
 *
 * Composed the way `IssuesTriageView` is rather than by reaching for `IssuesListPage`: the issue
 * section here is `buildIssuesView` + `buildIssuesListRows` + `IssueListRow` over a fixed
 * `milestoneIds` filter, with no tabs, no chips, and no URL state — the milestone *is* the filter,
 * and a filter bar that could take it off would be a page that stops being this page.
 *
 * There are deliberately no tabs and no activity feed. A milestone has no event log of its own;
 * inventing one from its issues' logs would be a second, quieter change history that disagrees
 * with the real one.
 *
 * @module components/issues/MilestoneDetailPage
 */
import { LegendList } from "@legendapp/list/react";
import { Link } from "@tanstack/react-router";
import {
  issueMilestoneStatusOn,
  type Issue,
  type IssueLabelId,
  type IssueMilestone,
  type IssuePriority,
  type IssueStatusId,
  type ProjectId,
} from "@spiritdevs/contracts";
import type { AtomCommandResult } from "@spiritdevs/client-runtime/state/runtime";
import {
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  MilestoneIcon,
  PlusIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import { useCommitOnBlur } from "~/hooks/useCommitOnBlur";
import { cn } from "~/lib/utils";
import { useProjects } from "~/state/entities";
import {
  todayIssueDate,
  useInvestigatingIssueIds,
  useIssueLabels,
  useIssueMilestoneCategoryCount,
  useIssueMilestoneProgress,
  useIssueMilestones,
  useIssueStatuses,
  useIssuesGrouped,
  useIssuesStore,
  useIssuesStoreStatus,
  useUpdateIssue,
  useUpdateIssueMilestone,
} from "~/state/issues";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "~/workspaceTitlebar";
import ChatMarkdown from "../ChatMarkdown";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../ui/empty";
import { Progress } from "../ui/progress";
import { SidebarInset } from "../ui/sidebar";
import { Spinner } from "../ui/spinner";
import { Textarea } from "../ui/textarea";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
import { IssueDetailSheet } from "./IssueDetailSheet";
import { IssueGroupHeader, IssueListRow } from "./IssueListRow";
import { issueAssigneeDisplayName, useIssueMemberDirectory } from "./issueMemberDirectory";
import { MilestoneBurnUpChart } from "./MilestoneBurnUpChart";
import { NewIssueDialog } from "./NewIssueDialog";
import { reportIssueWriteFailure } from "./issueWriteFeedback";
import {
  formatMilestoneDaysRemaining,
  formatMilestonePace,
  milestoneKpis,
  milestoneStartedCount,
  milestoneStatusPresentation,
  milestoneVerdictPresentation,
  type MilestonePaceVerdict,
} from "./milestoneDetail.logic";
import {
  DEFAULT_ISSUES_SORT_MODE,
  NO_ISSUES_LIST_FILTER,
  buildIssuesListRows,
  buildIssuesView,
  formatIssueDueDate,
  indexIssueLabels,
  toggleIssueLabelIds,
  type IssuesListRow as IssuesListRowModel,
} from "./issuesList.logic";

/** Same shape the cycle dialog's date fields use: native picker, themed to match the app. */
const DATE_INPUT_CLASS =
  "h-8 rounded-md border border-input bg-transparent px-2 text-sm tabular-nums outline-none [color-scheme:light] focus-visible:ring-2 focus-visible:ring-ring dark:[color-scheme:dark]";

/** A header is 32px and a row 36px; one estimate covers both, as it does on `/issues`. */
const ESTIMATED_ROW_HEIGHT = 36;

/**
 * The issue list is one section of a scrolling page, so it scrolls inside itself past this. Short
 * milestones get exactly the height they need and no empty gutter under the last row.
 */
const MAX_ISSUES_LIST_HEIGHT = 520;

export function MilestoneDetailPage({ milestoneId }: { milestoneId: string }) {
  const milestones = useIssueMilestones();
  const storeStatus = useIssuesStoreStatus();
  const milestone = milestones.find((candidate) => candidate.id === milestoneId) ?? null;

  if (milestone !== null) return <MilestoneDetail milestone={milestone} />;

  return (
    <MilestoneDetailShell name={null}>
      {storeStatus === "loading" ? (
        <div className="flex h-full items-center justify-center">
          <Spinner className="size-4 text-muted-foreground" />
        </div>
      ) : (
        <Empty className="h-full">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <MilestoneIcon />
            </EmptyMedia>
            <EmptyTitle>Milestone not found</EmptyTitle>
            <EmptyDescription>
              {storeStatus === "disconnected"
                ? "Milestones live on the machine you are connected to. Connect one to open this."
                : "It was deleted, or it belongs to another environment. Its issues are unaffected."}
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button render={<Link to="/issues/milestones" />} size="sm" variant="outline">
              All milestones
            </Button>
          </EmptyContent>
        </Empty>
      )}
    </MilestoneDetailShell>
  );
}

function MilestoneDetailShell({ name, children }: { name: string | null; children: ReactNode }) {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <header
          className={cn(
            "workspace-topbar drag-region px-3 transition-[padding-left] duration-200 ease-linear motion-reduce:transition-none sm:px-5",
            COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
          )}
        >
          <WorkspaceBreadcrumb ariaLabel="Milestone breadcrumb">
            <WorkspaceBreadcrumbItem>
              <Link
                className="outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                to="/issues/milestones"
              >
                Milestones
              </Link>
            </WorkspaceBreadcrumbItem>
            <WorkspaceBreadcrumbSeparator />
            <WorkspaceBreadcrumbItem className="truncate" current>
              {name ?? "Milestone"}
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      </div>
    </SidebarInset>
  );
}

function MilestoneDetail({ milestone }: { milestone: IssueMilestone }) {
  const memberDirectory = useIssueMemberDirectory();
  const store = useIssuesStore();
  const statuses = useIssueStatuses();
  const labels = useIssueLabels();
  const projects = useProjects();
  const grouping = useIssuesGrouped("all");
  const progress = useIssueMilestoneProgress().get(milestone.id) ?? { done: 0, total: 0 };
  const categoryCounts = useIssueMilestoneCategoryCount(milestone.id);
  const investigatingIssueIds = useInvestigatingIssueIds();
  const updateIssue = useUpdateIssue();
  const updateMilestone = useUpdateIssueMilestone();

  const [detailIssueKey, setDetailIssueKey] = useState<string | null>(null);
  const [newIssueOpen, setNewIssueOpen] = useState(false);
  const [descriptionDraft, setDescriptionDraft] = useState<string | null>(null);
  const [collapsedGroupIds, setCollapsedGroupIds] = useState<ReadonlySet<string>>(() => new Set());

  const today = useMemo(() => todayIssueDate(), []);
  const labelsById = useMemo(() => indexIssueLabels(labels), [labels]);
  const statusById = useMemo(
    () => new Map(statuses.map((status) => [status.id, status])),
    [statuses],
  );
  const projectTitles = useMemo(
    () => new Map<ProjectId, string>(projects.map((project) => [project.id, project.title])),
    [projects],
  );
  const filter = useMemo(
    () => ({ ...NO_ISSUES_LIST_FILTER, milestoneIds: [milestone.id] }),
    [milestone.id],
  );
  const view = useMemo(() => {
    const built = buildIssuesView({
      grouping,
      filter,
      today,
      groupBy: "status",
      sortMode: DEFAULT_ISSUES_SORT_MODE,
      projectTitles,
    });
    // Grouped by status the tab keeps every status column, empty ones included — right for
    // `/issues`, where the columns are the tab, and wrong here: a milestone holding three issues
    // would open on eight headers with nothing under them.
    return { ...built, groups: built.groups.filter((group) => group.issues.length > 0) };
  }, [filter, grouping, projectTitles, today]);
  const rows = useMemo(
    () => buildIssuesListRows(view, collapsedGroupIds),
    [collapsedGroupIds, view],
  );

  const kpis = milestoneKpis({ milestone, progress, today });
  const started = milestoneStartedCount(progress, categoryCounts);
  const status = issueMilestoneStatusOn(milestone, { ...progress, started }, today);
  const statusPresentation = milestoneStatusPresentation(status);
  const verdict = milestoneVerdictPresentation(kpis.verdict);
  const projectTitle = projectTitles.get(milestone.projectId) ?? null;

  // Nothing here is optimistic: a refused write leaves the field exactly as it was, which reads as
  // an edit that never registered unless it says so.
  const write = (title: string, run: () => Promise<AtomCommandResult<unknown, unknown>>) => {
    void (async () => {
      reportIssueWriteFailure(title, await run());
    })();
  };

  const nameProps = useCommitOnBlur(milestone.name, (next) => {
    const name = next.trim();
    // The contract refuses an empty name, so an emptied field reverts rather than erroring at it.
    if (name === "" || name === milestone.name) return;
    write("Failed to rename the milestone", () =>
      updateMilestone({ milestoneId: milestone.id, patch: { name } }),
    );
  });

  /**
   * On blur rather than on change: a native date input reports `""` while a segment is mid-edit,
   * so committing every change would clear the milestone's date the moment somebody retyped the
   * month. Blurring on an emptied field still clears it, which is the way back out.
   */
  const commitDate = (field: "startDate" | "targetDate", raw: string) => {
    const next = raw === "" ? null : raw;
    if (next === milestone[field]) return;
    write("Failed to change the dates", () =>
      updateMilestone({
        milestoneId: milestone.id,
        patch: field === "startDate" ? { startDate: next } : { targetDate: next },
      }),
    );
  };
  const startDateProps = useCommitOnBlur(milestone.startDate ?? "", (next) =>
    commitDate("startDate", next),
  );
  const targetDateProps = useCommitOnBlur(milestone.targetDate ?? "", (next) =>
    commitDate("targetDate", next),
  );

  const commitDescription = () => {
    const draft = descriptionDraft;
    setDescriptionDraft(null);
    if (draft === null) return;
    const trimmed = draft.trim();
    const next = trimmed === "" ? null : trimmed;
    if (next === milestone.description) return;
    write("Failed to save the description", () =>
      updateMilestone({ milestoneId: milestone.id, patch: { description: next } }),
    );
  };

  const openIssue = (issue: Issue) => setDetailIssueKey(issue.key);
  const toggleGroup = (groupId: string) => {
    setCollapsedGroupIds((current) => {
      const next = new Set(current);
      if (!next.delete(groupId)) next.add(groupId);
      return next;
    });
  };
  const setIssueStatus = (issue: Issue, statusId: IssueStatusId) => {
    write("Failed to change the status", () =>
      updateIssue({ issueId: issue.id, patch: { statusId } }),
    );
  };
  const setIssuePriority = (issue: Issue, priority: IssuePriority) => {
    write("Failed to change the priority", () =>
      updateIssue({ issueId: issue.id, patch: { priority } }),
    );
  };
  const toggleIssueLabel = (issue: Issue, labelId: IssueLabelId) => {
    write("Failed to change the labels", () =>
      updateIssue({
        issueId: issue.id,
        patch: { labelIds: toggleIssueLabelIds(issue.labelIds, labelId) },
      }),
    );
  };

  const renderItem = ({ item }: { item: IssuesListRowModel }) =>
    item.kind === "header" ? (
      <IssueGroupHeader onToggle={toggleGroup} row={item} />
    ) : (
      <IssueListRow
        assigneeLabel={issueAssigneeDisplayName(memberDirectory, item.issue.assignee)}
        active={detailIssueKey === item.issue.key}
        childRollup={null}
        investigating={investigatingIssueIds.has(item.issue.id)}
        issue={item.issue}
        labels={labels}
        labelsById={labelsById}
        onOpen={openIssue}
        onPriority={setIssuePriority}
        onRowClick={openIssue}
        onStatus={setIssueStatus}
        onToggleLabel={toggleIssueLabel}
        parentTitle={
          item.issue.parentId === null
            ? null
            : (store.issuesById.get(item.issue.parentId)?.title ?? null)
        }
        projectTitle={null}
        selected={false}
        status={statusById.get(item.issue.statusId) ?? null}
        statuses={statuses}
        today={today}
      />
    );

  return (
    <MilestoneDetailShell name={milestone.name}>
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-3 py-4 sm:px-5">
        <section className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge size="lg" variant={statusPresentation.tone}>
              {statusPresentation.label}
            </Badge>
            {projectTitle === null ? null : (
              <Link
                className="truncate text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                search={{ project: milestone.projectId }}
                to="/issues/milestones"
              >
                {projectTitle}
              </Link>
            )}
          </div>

          <input
            aria-label="Milestone name"
            className="w-full min-w-0 rounded-md border border-transparent bg-transparent px-1.5 py-0.5 text-xl font-semibold text-foreground outline-none hover:border-input focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/24"
            {...nameProps}
          />

          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              Starts
              <input className={DATE_INPUT_CLASS} type="date" {...startDateProps} />
            </label>
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              Target
              <input className={DATE_INPUT_CLASS} type="date" {...targetDateProps} />
            </label>
          </div>

          <div className="flex items-center gap-3">
            <Progress
              aria-label="Milestone completion"
              className="max-w-md"
              indicatorClassName={
                status === "completed"
                  ? "bg-success"
                  : status === "overdue"
                    ? "bg-error"
                    : "bg-primary"
              }
              value={kpis.ratio}
            />
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
              {kpis.done}/{kpis.total} done
            </span>
          </div>
        </section>

        <section aria-label="Milestone health" className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <MilestoneStatTile
            hint={kpis.total === 0 ? "No issues yet" : `${Math.round(kpis.ratio * 100)}% complete`}
            label="Completed"
            value={`${kpis.done}/${kpis.total}`}
          />
          <MilestoneStatTile
            hint={
              milestone.targetDate === null
                ? "No target date"
                : formatIssueDueDate(milestone.targetDate, today)
            }
            label="Days remaining"
            value={formatMilestoneDaysRemaining(kpis.daysRemaining)}
          />
          <MilestoneStatTile
            hint={
              kpis.requiredPace === null
                ? `Over ${kpis.elapsedDays} ${kpis.elapsedDays === 1 ? "day" : "days"}`
                : `Needs ${formatMilestonePace(kpis.requiredPace)}`
            }
            label="Pace"
            value={formatMilestonePace(kpis.pace)}
          />
          <MilestoneStatTile
            hint={
              // The icon and the word carry the verdict; the tone only reinforces them.
              <span
                className={cn("flex items-center gap-1", VERDICT_TEXT_CLASS[kpis.verdict])}
                data-testid="milestone-verdict"
              >
                <MilestoneVerdictIcon verdict={kpis.verdict} />
                {verdict.label}
              </span>
            }
            label="Projected finish"
            value={
              kpis.projectedFinish === null
                ? kpis.remaining === 0 && kpis.total > 0
                  ? "Complete"
                  : "—"
                : formatIssueDueDate(kpis.projectedFinish, today)
            }
          />
        </section>

        <section aria-label="Burn-up" data-testid="milestone-burn-up">
          <MilestoneBurnUpChart milestone={milestone} today={today} />
        </section>

        <section className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <h2 className="text-xs font-medium text-muted-foreground">Description</h2>
            {descriptionDraft === null ? (
              <Button
                className="ms-auto"
                onClick={() => setDescriptionDraft(milestone.description ?? "")}
                size="xs"
                variant="ghost"
              >
                {milestone.description === null ? "Add" : "Edit"}
              </Button>
            ) : (
              <div className="ms-auto flex items-center gap-1">
                <Button onClick={() => setDescriptionDraft(null)} size="xs" variant="ghost">
                  Cancel
                </Button>
                <Button onClick={commitDescription} size="xs" variant="outline">
                  Save
                </Button>
              </div>
            )}
          </div>
          {descriptionDraft === null ? (
            milestone.description === null || milestone.description.trim() === "" ? (
              <p className="text-[13px] text-muted-foreground">No description.</p>
            ) : (
              <ChatMarkdown className="text-[13px]" cwd={undefined} text={milestone.description} />
            )
          ) : (
            <Textarea
              aria-label="Milestone description"
              onChange={(event) => setDescriptionDraft(event.target.value)}
              placeholder="What has to be true for this milestone to be done? Markdown works."
              value={descriptionDraft}
            />
          )}
        </section>

        <section className="flex min-w-0 flex-col gap-2">
          <div className="flex items-center gap-2">
            <h2 className="text-xs font-medium text-muted-foreground">Issues</h2>
            <span className="text-xs tabular-nums text-muted-foreground/70">{view.total}</span>
            <Button
              className="ms-auto"
              onClick={() => setNewIssueOpen(true)}
              size="xs"
              variant="outline"
            >
              <PlusIcon />
              Add issue
            </Button>
          </div>
          {rows.length === 0 ? (
            <Empty className="rounded-lg border border-border/60 py-8">
              <EmptyHeader>
                <EmptyTitle>No issues in this milestone</EmptyTitle>
                <EmptyDescription>
                  Add a new one here, or open an issue that already exists and pick this milestone
                  in its properties — which is also how one leaves again.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <div
              className="overflow-hidden rounded-lg border border-border/60"
              style={{
                height: Math.min(MAX_ISSUES_LIST_HEIGHT, rows.length * ESTIMATED_ROW_HEIGHT),
              }}
            >
              <LegendList<IssuesListRowModel>
                aria-label={`Issues in ${milestone.name}`}
                className="scrollbar-gutter-both h-full min-h-0 overflow-x-hidden"
                data={rows}
                estimatedItemSize={ESTIMATED_ROW_HEIGHT}
                getItemType={getItemType}
                keyExtractor={keyExtractor}
                renderItem={renderItem}
                role="listbox"
              />
            </div>
          )}
        </section>
      </div>

      <NewIssueDialog
        defaultMilestoneId={milestone.id}
        defaultProjectId={milestone.projectId}
        defaultStatusId={view.groups[0]?.status?.id ?? statuses[0]?.id ?? null}
        labels={labels}
        onOpenChange={setNewIssueOpen}
        open={newIssueOpen}
        projects={projects}
        statuses={statuses}
      />

      <IssueDetailSheet
        issueKey={detailIssueKey}
        onClose={() => setDetailIssueKey(null)}
        onOpenIssueKey={setDetailIssueKey}
      />
    </MilestoneDetailShell>
  );
}

function MilestoneStatTile({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 rounded-lg border border-border/60 px-3 py-2">
      <span className="truncate text-[11px] font-medium text-muted-foreground">{label}</span>
      {/* Tabular figures: these count up in place off the live issue store, and proportional ones
          would shift the tile's text every time an issue is completed. */}
      <span className="truncate text-lg leading-6 font-semibold tabular-nums text-foreground">
        {value}
      </span>
      <span className="min-w-0 truncate text-[11px] text-muted-foreground">{hint}</span>
    </div>
  );
}

const VERDICT_TEXT_CLASS: Readonly<Record<MilestonePaceVerdict, string>> = {
  "at-risk": "text-warning-foreground",
  behind: "text-error-foreground",
  "on-track": "text-success-foreground",
  unknown: "text-muted-foreground",
};

function MilestoneVerdictIcon({ verdict }: { verdict: MilestonePaceVerdict }) {
  const className = "size-3.5 shrink-0";
  switch (verdict) {
    case "on-track":
      return <CircleCheckIcon aria-hidden className={className} />;
    case "at-risk":
      return <TriangleAlertIcon aria-hidden className={className} />;
    case "behind":
      return <CircleAlertIcon aria-hidden className={className} />;
    case "unknown":
      return <CircleDashedIcon aria-hidden className={className} />;
  }
}

function keyExtractor(row: IssuesListRowModel) {
  return row.id;
}

function getItemType(row: IssuesListRowModel) {
  return row.kind;
}
