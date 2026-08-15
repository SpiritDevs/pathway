/**
 * The right-click menu shared by the issues list rows and the board cards.
 *
 * One menu for the whole page rather than one per row: a virtualized list and a board column both
 * hold more rows than a popup root should be mounted for, so the page keeps a single instance and
 * anchors it to the pointer. It is deliberately dumb — every press hands a patch back to the page,
 * which decides whether that is one write or a bulk one. See `issueContextMenu.logic.ts`.
 *
 * @module components/issues/IssueContextMenu
 */
import type {
  Issue,
  IssueCycle,
  IssueCycleId,
  IssueLabel,
  IssueLabelId,
  IssueMilestone,
  IssueMilestoneId,
  IssuePatch,
  IssuePriority,
  IssueStatus,
  IssueStatusId,
  ProjectId,
} from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import {
  CalendarIcon,
  CalendarRangeIcon,
  CircleDotIcon,
  CopyIcon,
  EraserIcon,
  FlagIcon,
  FolderIcon,
  PanelRightOpenIcon,
  SignalHighIcon,
  TagIcon,
  Trash2Icon,
  UserIcon,
  WandSparklesIcon,
} from "lucide-react";
import { useMemo } from "react";

import { PROVIDER_CLIENT_DEFINITIONS } from "../settings/providerDriverMeta";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuShortcut,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  IssueAssigneeGlyph,
  IssueLabelDot,
  IssuePriorityIcon,
  IssueStatusDot,
} from "./IssueGlyphs";
import { issueAssigneeOptionValue, issueAssigneeOptions } from "./issueDetail.logic";
import {
  ISSUE_CONTEXT_MENU_COPY_FIELDS,
  ISSUE_CONTEXT_MENU_COPY_LABELS,
  ISSUE_CONTEXT_MENU_REMOVE_FIELDS,
  ISSUE_CONTEXT_MENU_REMOVE_LABELS,
  issueContextMenuLabel,
  issueContextMenuMilestones,
  issueContextMenuProjectId,
  issueContextMenuRemovable,
  issueContextMenuRemovePatch,
  issueDueDateQuickOptions,
  sharedIssueMenuValue,
  type IssueContextMenuCopyField,
} from "./issueContextMenu.logic";
import {
  ISSUE_PRIORITY_LABELS,
  ISSUE_PRIORITY_ORDER,
  issueLabelSelectionState,
} from "./issuesList.logic";

/** The driver list is a module constant, so the options built from it can be one too. */
const ASSIGNEE_OPTIONS = issueAssigneeOptions(PROVIDER_CLIENT_DEFINITIONS);

/** A null `value` means "clear it": the same sentinel every nullable picker in the tracker uses. */
const NONE_VALUE = "";

export interface IssueContextMenuTarget {
  /** The rows the presses write to — one, or the whole selection the right-click landed inside. */
  readonly issues: ReadonlyArray<Issue>;
  /** Viewport coordinates of the click, which is what the popup anchors to. */
  readonly x: number;
  readonly y: number;
}

export interface IssueContextMenuProps {
  /** Null while the menu is shut. */
  readonly target: IssueContextMenuTarget | null;
  readonly onClose: () => void;
  readonly statuses: ReadonlyArray<IssueStatus>;
  readonly labels: ReadonlyArray<IssueLabel>;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  /** Every milestone on the tracker; the menu narrows them to the targets' shared project. */
  readonly milestones: ReadonlyArray<IssueMilestone>;
  readonly cycles: ReadonlyArray<IssueCycle>;
  /** `YYYY-MM-DD`, so the quick due dates agree with the rest of the view about "today". */
  readonly today: string;
  /** Why Investigate cannot run, or null when it can. Only ever set for a single target. */
  readonly investigateBlockReason: string | null;
  readonly onOpen: (issue: Issue) => void;
  readonly onInvestigate: (issue: Issue) => void;
  /** `label` names the property in the failure toast: "Failed to change the status". */
  readonly onPatch: (patch: IssuePatch, label: string) => void;
  /** Per issue rather than one patch: `labelIds` replaces the array, so a shared one would flatten. */
  readonly onToggleLabel: (labelId: IssueLabelId, add: boolean) => void;
  readonly onCopy: (field: IssueContextMenuCopyField) => void;
  readonly onDelete: () => void;
}

export function IssueContextMenu({
  target,
  onClose,
  statuses,
  labels,
  projects,
  milestones,
  cycles,
  today,
  investigateBlockReason,
  onOpen,
  onInvestigate,
  onPatch,
  onToggleLabel,
  onCopy,
  onDelete,
}: IssueContextMenuProps) {
  const x = target?.x ?? 0;
  const y = target?.y ?? 0;
  // A zero-size rect at the pointer: the popup's own collision handling does the rest, which is
  // what keeps a menu opened near the bottom edge from running off the viewport.
  const anchor = useMemo(() => ({ getBoundingClientRect: () => new DOMRect(x, y, 0, 0) }), [x, y]);

  if (target === null) return null;

  const issues = target.issues;
  const single = issues.length === 1 ? (issues[0] ?? null) : null;
  const projectId = issueContextMenuProjectId(issues);
  const projectMilestones = issueContextMenuMilestones(milestones, projectId);
  const sharedStatusId = sharedIssueMenuValue(issues.map((issue) => issue.statusId));
  const sharedPriority = sharedIssueMenuValue(issues.map((issue) => issue.priority));
  const sharedAssignee = sharedIssueMenuValue(
    issues.map((issue) => issueAssigneeOptionValue(issue.assignee)),
  );
  const sharedProject = sharedIssueMenuValue(issues.map((issue) => issue.projectId ?? NONE_VALUE));
  const sharedMilestone = sharedIssueMenuValue(
    issues.map((issue) => issue.milestoneId ?? NONE_VALUE),
  );
  const sharedCycle = sharedIssueMenuValue(issues.map((issue) => issue.cycleId ?? NONE_VALUE));
  const sharedDueDate = sharedIssueMenuValue(issues.map((issue) => issue.dueDate ?? NONE_VALUE));
  const removable = ISSUE_CONTEXT_MENU_REMOVE_FIELDS.filter((field) =>
    issueContextMenuRemovable(issues, field),
  );

  return (
    <Menu
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      open
    >
      {/* Base UI still needs a registered trigger for a controlled, pointer-anchored menu. It
          owns the root/submenu floating tree and keeps submenu hover from dismissing the root. */}
      <MenuTrigger
        className="pointer-events-none fixed size-0"
        nativeButton={false}
        render={<span />}
        style={{ left: x, top: y }}
        tabIndex={-1}
      >
        <span className="sr-only">Issue actions</span>
      </MenuTrigger>
      <MenuPopup align="start" anchor={anchor} className="min-w-60" side="inline-end">
        <MenuGroup>
          <MenuGroupLabel>{issueContextMenuLabel(issues)}</MenuGroupLabel>
        </MenuGroup>

        {single === null ? null : (
          <MenuItem onClick={() => onOpen(single)}>
            <PanelRightOpenIcon />
            <span>Open</span>
            <MenuShortcut>↵</MenuShortcut>
          </MenuItem>
        )}

        <MenuSeparator />

        <MenuSub>
          <MenuSubTrigger>
            <CircleDotIcon />
            <span>Status</span>
          </MenuSubTrigger>
          <MenuSubPopup className="min-w-48">
            <MenuRadioGroup
              onValueChange={(next) => {
                if (next !== sharedStatusId) {
                  onPatch({ statusId: next as IssueStatusId }, "status");
                }
              }}
              value={sharedStatusId}
            >
              {statuses.map((status) => (
                <MenuRadioItem closeOnClick key={status.id} value={status.id}>
                  <span className="flex min-w-0 items-center gap-2">
                    <IssueStatusDot status={status} />
                    <span className="truncate">{status.name}</span>
                  </span>
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuSubPopup>
        </MenuSub>

        <MenuSub>
          <MenuSubTrigger>
            <SignalHighIcon />
            <span>Priority</span>
          </MenuSubTrigger>
          <MenuSubPopup className="min-w-44">
            <MenuRadioGroup
              onValueChange={(next) => {
                if (next !== sharedPriority) {
                  onPatch({ priority: next as IssuePriority }, "priority");
                }
              }}
              value={sharedPriority}
            >
              {ISSUE_PRIORITY_ORDER.map((priority) => (
                <MenuRadioItem closeOnClick key={priority} value={priority}>
                  <span className="flex min-w-0 items-center gap-2">
                    <IssuePriorityIcon priority={priority} />
                    <span className="truncate">{ISSUE_PRIORITY_LABELS[priority]}</span>
                  </span>
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuSubPopup>
        </MenuSub>

        <MenuSub>
          <MenuSubTrigger>
            <UserIcon />
            <span>Assignee</span>
          </MenuSubTrigger>
          <MenuSubPopup className="min-w-52">
            <MenuRadioGroup
              onValueChange={(next) => {
                const option = ASSIGNEE_OPTIONS.find((candidate) => candidate.value === next);
                if (option !== undefined && next !== sharedAssignee) {
                  onPatch({ assignee: option.assignee }, "assignee");
                }
              }}
              value={sharedAssignee}
            >
              {ASSIGNEE_OPTIONS.map((option) => (
                <MenuRadioItem closeOnClick key={option.value} value={option.value}>
                  <span className="flex min-w-0 items-center gap-2">
                    <IssueAssigneeGlyph assignee={option.assignee} className="size-4" />
                    <span className="truncate">{option.label}</span>
                  </span>
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuSubPopup>
        </MenuSub>

        <MenuSub>
          <MenuSubTrigger>
            <TagIcon />
            <span>Labels</span>
          </MenuSubTrigger>
          {/* The only submenu that stays open on a press: labels are a set, and closing after each
              one would make wearing three of them three round trips. */}
          <MenuSubPopup className="min-w-52">
            {labels.length === 0 ? (
              <p className="px-2 py-1.5 text-xs text-muted-foreground">
                No labels yet — add them in Settings → Labels.
              </p>
            ) : (
              labels.map((label) => {
                const state = issueLabelSelectionState(issues, label.id);
                return (
                  <MenuCheckboxItem
                    checked={state === "all"}
                    key={label.id}
                    onCheckedChange={() => onToggleLabel(label.id, state !== "all")}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <IssueLabelDot color={label.color} />
                      <span className="truncate">{label.name}</span>
                      {state === "some" ? (
                        <span className="ms-auto shrink-0 text-[10px] text-muted-foreground">
                          some
                        </span>
                      ) : null}
                    </span>
                  </MenuCheckboxItem>
                );
              })
            )}
          </MenuSubPopup>
        </MenuSub>

        <MenuSub>
          <MenuSubTrigger>
            <FolderIcon />
            <span>Project</span>
          </MenuSubTrigger>
          <MenuSubPopup className="min-w-52">
            <MenuRadioGroup
              onValueChange={(next) => {
                if (next === sharedProject) return;
                onPatch({ projectId: next === NONE_VALUE ? null : (next as ProjectId) }, "project");
              }}
              value={sharedProject}
            >
              <MenuRadioItem closeOnClick value={NONE_VALUE}>
                <span className="text-muted-foreground">No project</span>
              </MenuRadioItem>
              {projects.map((project) => (
                <MenuRadioItem closeOnClick key={project.id} value={project.id}>
                  <span className="truncate">{project.title}</span>
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuSubPopup>
        </MenuSub>

        <MenuSub>
          <MenuSubTrigger>
            <FlagIcon />
            <span>Milestone</span>
          </MenuSubTrigger>
          <MenuSubPopup className="min-w-52">
            {projectId === null ? (
              <p className="px-2 py-1.5 text-xs text-muted-foreground">
                Milestones belong to a project. Put these issues in one first.
              </p>
            ) : projectMilestones.length === 0 ? (
              <p className="px-2 py-1.5 text-xs text-muted-foreground">
                This project has no milestones yet.
              </p>
            ) : (
              <MenuRadioGroup
                onValueChange={(next) => {
                  if (next === sharedMilestone) return;
                  onPatch(
                    { milestoneId: next === NONE_VALUE ? null : (next as IssueMilestoneId) },
                    "milestone",
                  );
                }}
                value={sharedMilestone}
              >
                <MenuRadioItem closeOnClick value={NONE_VALUE}>
                  <span className="text-muted-foreground">No milestone</span>
                </MenuRadioItem>
                {projectMilestones.map((milestone) => (
                  <MenuRadioItem closeOnClick key={milestone.id} value={milestone.id}>
                    <span className="truncate">{milestone.name}</span>
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            )}
          </MenuSubPopup>
        </MenuSub>

        <MenuSub>
          <MenuSubTrigger>
            <CalendarRangeIcon />
            <span>Cycle</span>
          </MenuSubTrigger>
          <MenuSubPopup className="min-w-52">
            <MenuRadioGroup
              onValueChange={(next) => {
                if (next === sharedCycle) return;
                onPatch({ cycleId: next === NONE_VALUE ? null : (next as IssueCycleId) }, "cycle");
              }}
              value={sharedCycle}
            >
              <MenuRadioItem closeOnClick value={NONE_VALUE}>
                <span className="text-muted-foreground">No cycle</span>
              </MenuRadioItem>
              {cycles.map((cycle) => (
                <MenuRadioItem closeOnClick key={cycle.id} value={cycle.id}>
                  <span className="truncate">{cycle.name}</span>
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuSubPopup>
        </MenuSub>

        <MenuSub>
          <MenuSubTrigger>
            <CalendarIcon />
            <span>Due date</span>
          </MenuSubTrigger>
          <MenuSubPopup className="min-w-48">
            <MenuRadioGroup
              onValueChange={(next) => {
                if (next === sharedDueDate) return;
                onPatch({ dueDate: next === NONE_VALUE ? null : next }, "due date");
              }}
              value={sharedDueDate}
            >
              {issueDueDateQuickOptions(today).map((option) => (
                <MenuRadioItem closeOnClick key={option.value} value={option.value}>
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate">{option.label}</span>
                    <span className="ms-auto shrink-0 text-[11px] tabular-nums text-muted-foreground">
                      {option.value.slice(5)}
                    </span>
                  </span>
                </MenuRadioItem>
              ))}
              <MenuRadioItem closeOnClick value={NONE_VALUE}>
                <span className="text-muted-foreground">No due date</span>
              </MenuRadioItem>
            </MenuRadioGroup>
          </MenuSubPopup>
        </MenuSub>

        <MenuSeparator />

        {single === null ? null : (
          <InvestigateItem
            blockReason={investigateBlockReason}
            onClick={() => onInvestigate(single)}
          />
        )}

        <MenuSub>
          <MenuSubTrigger>
            <CopyIcon />
            <span>Copy</span>
          </MenuSubTrigger>
          <MenuSubPopup className="min-w-48">
            {ISSUE_CONTEXT_MENU_COPY_FIELDS.map((field) => (
              <MenuItem key={field} onClick={() => onCopy(field)}>
                <span className="truncate">{ISSUE_CONTEXT_MENU_COPY_LABELS[field]}</span>
              </MenuItem>
            ))}
          </MenuSubPopup>
        </MenuSub>

        {removable.length === 0 ? null : (
          <MenuSub>
            <MenuSubTrigger>
              <EraserIcon />
              <span>Remove</span>
            </MenuSubTrigger>
            <MenuSubPopup className="min-w-44">
              {removable.map((field) => (
                <MenuItem
                  key={field}
                  onClick={() =>
                    onPatch(
                      issueContextMenuRemovePatch(field),
                      ISSUE_CONTEXT_MENU_REMOVE_LABELS[field].toLowerCase(),
                    )
                  }
                >
                  <span className="truncate">{ISSUE_CONTEXT_MENU_REMOVE_LABELS[field]}</span>
                </MenuItem>
              ))}
            </MenuSubPopup>
          </MenuSub>
        )}

        <MenuSeparator />

        {/* Nested rather than immediate: delete is the one press here that costs a round trip to
            undo, and a menu is a surface the pointer sweeps across. */}
        <MenuSub>
          <MenuSubTrigger>
            <Trash2Icon />
            <span>Delete</span>
          </MenuSubTrigger>
          <MenuSubPopup className="min-w-52">
            <MenuGroup>
              <MenuGroupLabel>
                Delete {issues.length} {issues.length === 1 ? "issue" : "issues"}?
              </MenuGroupLabel>
            </MenuGroup>
            <MenuSeparator />
            <MenuItem onClick={onDelete} variant="destructive">
              Delete
            </MenuItem>
          </MenuSubPopup>
        </MenuSub>
      </MenuPopup>
    </Menu>
  );
}

/** Disabled items swallow hover, so the reason rides on a wrapper the tooltip can still see. */
function InvestigateItem({
  blockReason,
  onClick,
}: {
  blockReason: string | null;
  onClick: () => void;
}) {
  const item = (
    <MenuItem disabled={blockReason !== null} onClick={onClick}>
      <WandSparklesIcon />
      <span>Investigate</span>
    </MenuItem>
  );

  return blockReason === null ? (
    item
  ) : (
    <Tooltip>
      <TooltipTrigger render={<span className="block cursor-not-allowed" />}>{item}</TooltipTrigger>
      <TooltipPopup side="inline-end">{blockReason}</TooltipPopup>
    </Tooltip>
  );
}
