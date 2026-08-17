/**
 * The properties rail inside the issue detail sheet.
 *
 * Six rows, each one editor. Status, priority, and project reuse the menus the list row already
 * uses so the same press does the same thing in both places; assignee and labels are here because
 * neither exists on a row — a row shows a glyph, and the label editor has to be able to create a
 * label, which a `Menu` cannot host an input for.
 *
 * @module components/issues/IssueDetailProperties
 */
import type {
  Issue,
  IssueAssignee,
  IssueCycle,
  IssueCycleId,
  IssueDate,
  IssueId,
  IssueLabel,
  IssueLabelId,
  IssueMilestone,
  IssueMilestoneId,
  IssuePriority,
  IssueStatus,
  IssueStatusId,
  ProjectId,
} from "@spiritdevs/contracts";
import {
  CalendarIcon,
  CalendarRangeIcon,
  FlagIcon,
  FolderIcon,
  GitBranchIcon,
  MonitorIcon,
  TagIcon,
  XIcon,
} from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { useSlackChannelNames } from "~/state/issues";
import { QuickCreateProjectDialog } from "../projects/QuickCreateProjectDialog";
import { PROVIDER_CLIENT_DEFINITIONS } from "../settings/providerDriverMeta";
import { Button } from "../ui/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "../ui/menu";
import {
  IssueAssigneeGlyph,
  IssueLabelDot,
  IssuePriorityIcon,
  IssueStatusDot,
} from "./IssueGlyphs";
import {
  IssueCyclePicker,
  IssueMilestonePicker,
  IssueParentPicker,
  IssueStatusGlyphFor,
} from "./IssueSelectors";
import { IssueLabelsPicker } from "./IssueLabelsPicker";
import { IssuePriorityMenu, IssueProjectMenu, IssueStatusMenu } from "./IssuePropertyMenus";
import { IssueSlackSourceChip } from "./IssueSlackSourceChip";
import { slackSourceChip } from "./triage.logic";
import {
  issueAssigneeOptionValue,
  issueAssigneeOptions,
  issueDueDateInputValue,
  isCompleteIssueDate,
} from "./issueDetail.logic";
import { issueAssigneeDisplayName, useIssueMemberDirectory } from "./issueMemberDirectory";
import { ISSUE_PRIORITY_LABELS } from "./issuesList.logic";
import type { IssueProjectOption } from "./useIssueProjectOptions";

const ROW_CONTROL_CLASS =
  "flex min-h-7 w-full min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-start text-[13px] text-foreground outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring";

const PLACEHOLDER_CLASS = "text-muted-foreground";

export interface IssueEnvironmentOption {
  readonly value: string;
  readonly label: string;
  readonly status: string;
  readonly disabled: boolean;
}

function PropertyRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-2">
      <span className="mt-1.5 w-20 shrink-0 text-xs text-muted-foreground">{label}</span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

function IssueAssigneeMenu({
  value,
  onSelect,
}: {
  value: IssueAssignee | null;
  onSelect: (assignee: IssueAssignee | null) => void;
}) {
  const memberDirectory = useIssueMemberDirectory();
  const ASSIGNEE_OPTIONS = useMemo(
    () =>
      issueAssigneeOptions(
        PROVIDER_CLIENT_DEFINITIONS,
        memberDirectory.assignableMembers,
        memberDirectory.currentMembershipId,
      ),
    [memberDirectory.assignableMembers, memberDirectory.currentMembershipId],
  );
  const current = issueAssigneeOptionValue(value);
  const selected = ASSIGNEE_OPTIONS.find((option) => option.value === current);
  const selectedLabel = selected?.label ?? issueAssigneeDisplayName(memberDirectory, value);
  return (
    <Menu>
      <MenuTrigger
        render={
          <button className={ROW_CONTROL_CLASS} type="button">
            <IssueAssigneeGlyph assignee={value} className="size-4" label={selectedLabel} />
            <span className={cn("truncate", value === null && PLACEHOLDER_CLASS)}>
              {selectedLabel}
            </span>
          </button>
        }
      />
      <MenuPopup align="start" className="min-w-52" side="bottom">
        <MenuGroup>
          <MenuGroupLabel>Assignee</MenuGroupLabel>
          <MenuRadioGroup
            onValueChange={(next) => {
              const option = ASSIGNEE_OPTIONS.find((candidate) => candidate.value === next);
              if (option !== undefined) onSelect(option.assignee);
            }}
            value={current}
          >
            {ASSIGNEE_OPTIONS.map((option) => (
              <MenuRadioItem key={option.value} value={option.value}>
                <span className="flex min-w-0 items-center gap-2">
                  <IssueAssigneeGlyph
                    assignee={option.assignee}
                    className="size-4"
                    label={option.label}
                  />
                  <span className="truncate">{option.label}</span>
                </span>
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}

/**
 * Native picker: a calendar is a solved problem, and this one already speaks the `YYYY-MM-DD`
 * calendar-day shape the contract stores. The draft exists because a native date field reports
 * `""` for every half-typed state, so committing on change would clear the date halfway through
 * retyping it — a complete value commits immediately (that is the calendar popup), anything else
 * waits for the blur.
 */
function IssueDueDateField({
  issue,
  onCommit,
}: {
  issue: Issue;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const stored = issueDueDateInputValue(issue);

  return (
    <div className={cn(ROW_CONTROL_CLASS, "hover:bg-transparent")}>
      <CalendarIcon className="size-3.5 shrink-0 text-muted-foreground" />
      <input
        aria-label="Due date"
        className="min-w-0 flex-1 bg-transparent text-[13px] tabular-nums outline-none [color-scheme:light] dark:[color-scheme:dark]"
        onBlur={() => {
          const next = draft;
          setDraft(null);
          if (next !== null && next !== stored) onCommit(next);
        }}
        onChange={(event) => {
          const next = event.currentTarget.value;
          if (isCompleteIssueDate(next)) {
            setDraft(null);
            onCommit(next);
            return;
          }
          setDraft(next);
        }}
        type="date"
        value={draft ?? stored}
      />
      {stored === "" ? null : (
        <Button
          aria-label="Clear due date"
          className="text-muted-foreground"
          onClick={() => {
            setDraft(null);
            onCommit("");
          }}
          size="icon-xs"
          variant="ghost"
        >
          <XIcon />
        </Button>
      )}
    </div>
  );
}

export function IssueDetailProperties({
  issue,
  status,
  statuses,
  statusById,
  labels,
  projects,
  projectTitle,
  environmentOptions,
  environmentValue,
  milestones,
  cycles,
  issues,
  parent,
  onStatus,
  onPriority,
  onAssignee,
  onProject,
  onEnvironment,
  onToggleLabel,
  onCreateLabel,
  onDueDate,
  onMilestone,
  onCreateMilestone,
  onCycle,
  onParent,
}: {
  issue: Issue;
  status: IssueStatus | null;
  statuses: ReadonlyArray<IssueStatus>;
  statusById: ReadonlyMap<IssueStatusId, IssueStatus>;
  labels: ReadonlyArray<IssueLabel>;
  projects: ReadonlyArray<IssueProjectOption>;
  projectTitle: string | null;
  environmentOptions: ReadonlyArray<IssueEnvironmentOption>;
  environmentValue: string | null;
  /** Already narrowed to the issue's project; empty when it has none. */
  milestones: ReadonlyArray<IssueMilestone>;
  cycles: ReadonlyArray<IssueCycle>;
  /** The whole tracker, for the parent picker's depth rule. */
  issues: ReadonlyMap<IssueId, Issue>;
  parent: Issue | null;
  onStatus: (statusId: IssueStatusId) => void;
  onPriority: (priority: IssuePriority) => void;
  onAssignee: (assignee: IssueAssignee | null) => void;
  onProject: (projectId: ProjectId | null) => void;
  onEnvironment: (physicalProjectKey: string) => void;
  onToggleLabel: (labelId: IssueLabelId) => void;
  onCreateLabel: (input: { readonly name: string; readonly color: string }) => Promise<boolean>;
  onDueDate: (value: string) => void;
  onMilestone: (milestoneId: IssueMilestoneId | null) => void;
  onCreateMilestone: (input: {
    readonly name: string;
    readonly targetDate: IssueDate | null;
  }) => Promise<IssueMilestoneId | null>;
  onCycle: (cycleId: IssueCycleId | null) => void;
  onParent: (parentId: IssueId | null) => void;
}) {
  const milestone = milestones.find((candidate) => candidate.id === issue.milestoneId) ?? null;
  const cycle = cycles.find((candidate) => candidate.id === issue.cycleId) ?? null;
  const hasProject = issue.projectId !== null;
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const channelNames = useSlackChannelNames();
  const [quickCreateProjectOpen, setQuickCreateProjectOpen] = useState(false);
  const selectedEnvironment =
    environmentOptions.find((option) => option.value === environmentValue) ?? null;

  return (
    <div className="flex flex-col gap-1.5">
      <QuickCreateProjectDialog
        environmentId={primaryEnvironmentId}
        onCreated={(created) => onProject(created.projectId)}
        onOpenChange={setQuickCreateProjectOpen}
        open={quickCreateProjectOpen}
      />
      <PropertyRow label="Status">
        <IssueStatusMenu
          onSelect={onStatus}
          statuses={statuses}
          trigger={
            <button className={ROW_CONTROL_CLASS} type="button">
              {status === null ? (
                <span className="size-3.5 shrink-0 rounded-full border border-dashed border-border" />
              ) : (
                <IssueStatusDot status={status} />
              )}
              <span className={cn("truncate", status === null && PLACEHOLDER_CLASS)}>
                {status?.name ?? "No status"}
              </span>
            </button>
          }
          value={status?.id ?? null}
        />
      </PropertyRow>

      <PropertyRow label="Priority">
        <IssuePriorityMenu
          onSelect={onPriority}
          trigger={
            <button className={ROW_CONTROL_CLASS} type="button">
              <IssuePriorityIcon priority={issue.priority} />
              <span className={cn("truncate", issue.priority === "none" && PLACEHOLDER_CLASS)}>
                {ISSUE_PRIORITY_LABELS[issue.priority]}
              </span>
            </button>
          }
          value={issue.priority}
        />
      </PropertyRow>

      <PropertyRow label="Assignee">
        <IssueAssigneeMenu onSelect={onAssignee} value={issue.assignee} />
      </PropertyRow>

      <PropertyRow label="Labels">
        <IssueLabelsPicker
          labels={labels}
          onCreate={onCreateLabel}
          onToggle={onToggleLabel}
          selectedLabelIds={issue.labelIds}
          trigger={
            <button className={cn(ROW_CONTROL_CLASS, "flex-wrap")} type="button">
              {labels.every((label) => !issue.labelIds.includes(label.id)) ? (
                <>
                  <TagIcon className="size-3.5 text-muted-foreground" />
                  <span className={PLACEHOLDER_CLASS}>Add labels</span>
                </>
              ) : (
                labels
                  .filter((label) => issue.labelIds.includes(label.id))
                  .map((label) => (
                    <span
                      className="flex max-w-full items-center gap-1 rounded-full border border-border/60 px-1.5 py-px text-[11px] text-muted-foreground"
                      key={label.id}
                    >
                      <IssueLabelDot className="size-1.5" color={label.color} />
                      <span className="truncate">{label.name}</span>
                    </span>
                  ))
              )}
            </button>
          }
        />
      </PropertyRow>

      <PropertyRow label="Project">
        <IssueProjectMenu
          onCreateProject={() => setQuickCreateProjectOpen(true)}
          onSelect={onProject}
          projects={projects}
          trigger={
            <button className={ROW_CONTROL_CLASS} type="button">
              <FolderIcon className="size-3.5 shrink-0 text-muted-foreground" />
              <span className={cn("truncate", projectTitle === null && PLACEHOLDER_CLASS)}>
                {projectTitle ?? "No project"}
              </span>
            </button>
          }
          value={issue.projectId}
        />
      </PropertyRow>

      <PropertyRow label="Environment">
        <Menu>
          <MenuTrigger
            render={
              <button
                aria-label="Agent environment"
                className={ROW_CONTROL_CLASS}
                disabled={!hasProject || environmentOptions.length === 0}
                type="button"
              >
                <MonitorIcon className="size-3.5 shrink-0 text-muted-foreground" />
                <span className={cn("truncate", selectedEnvironment === null && PLACEHOLDER_CLASS)}>
                  {selectedEnvironment?.label ??
                    (hasProject ? "No environment" : "Needs a project")}
                </span>
              </button>
            }
          />
          <MenuPopup align="start" className="min-w-56" side="bottom">
            <MenuGroup>
              <MenuGroupLabel>Run agents in</MenuGroupLabel>
              <MenuRadioGroup onValueChange={onEnvironment} value={environmentValue ?? undefined}>
                {environmentOptions.map((option) => (
                  <MenuRadioItem disabled={option.disabled} key={option.value} value={option.value}>
                    <span className="flex min-w-0 flex-1 items-center gap-2">
                      <MonitorIcon className="size-3.5" />
                      <span className="min-w-0 flex-1 truncate">{option.label}</span>
                      <span className="shrink-0 text-[11px] text-muted-foreground">
                        {option.status}
                      </span>
                    </span>
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuGroup>
          </MenuPopup>
        </Menu>
      </PropertyRow>

      <PropertyRow label="Milestone">
        <IssueMilestonePicker
          hasProject={hasProject}
          milestones={milestones}
          onCreate={onCreateMilestone}
          onSelect={onMilestone}
          trigger={
            <button
              className={cn(ROW_CONTROL_CLASS, !hasProject && "cursor-default")}
              title={hasProject ? undefined : "Milestones belong to a project."}
              type="button"
            >
              <FlagIcon className="size-3.5 shrink-0 text-muted-foreground" />
              <span className={cn("truncate", milestone === null && PLACEHOLDER_CLASS)}>
                {milestone?.name ?? (hasProject ? "No milestone" : "Needs a project")}
              </span>
            </button>
          }
          value={issue.milestoneId}
        />
      </PropertyRow>

      <PropertyRow label="Cycle">
        <IssueCyclePicker
          cycles={cycles}
          onSelect={onCycle}
          trigger={
            <button className={ROW_CONTROL_CLASS} type="button">
              <CalendarRangeIcon className="size-3.5 shrink-0 text-muted-foreground" />
              <span className={cn("truncate", cycle === null && PLACEHOLDER_CLASS)}>
                {cycle?.name ?? "No cycle"}
              </span>
            </button>
          }
          value={issue.cycleId}
        />
      </PropertyRow>

      <PropertyRow label="Sub-issue of">
        <IssueParentPicker
          issue={issue}
          issues={issues}
          onSelect={onParent}
          renderStatusGlyph={(candidate) => (
            <IssueStatusGlyphFor issue={candidate} statusById={statusById} />
          )}
          trigger={
            <button className={ROW_CONTROL_CLASS} type="button">
              <GitBranchIcon className="size-3.5 shrink-0 text-muted-foreground" />
              <span className={cn("truncate", parent === null && PLACEHOLDER_CLASS)}>
                {parent === null ? "No parent" : `${parent.key} ${parent.title}`}
              </span>
            </button>
          }
        />
      </PropertyRow>

      <PropertyRow label="Due date">
        <IssueDueDateField issue={issue} onCommit={onDueDate} />
      </PropertyRow>

      {/* Read-only, unlike every row above it: where an issue came from is a fact about how it got
          here, and the thread the bot posts its updates into is keyed on it. */}
      {issue.slackSource === null ? null : (
        <PropertyRow label="Source">
          <div className={cn(ROW_CONTROL_CLASS, "hover:bg-transparent")}>
            <IssueSlackSourceChip chip={slackSourceChip(issue.slackSource, channelNames)} />
          </div>
        </PropertyRow>
      )}
    </div>
  );
}
