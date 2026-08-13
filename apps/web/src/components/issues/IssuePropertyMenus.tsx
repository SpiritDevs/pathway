/**
 * The property editors shared by the row, the bulk bar, and the new-issue dialog.
 *
 * Every one of them is opened from inside a clickable row, so each wraps its trigger in a guard
 * that stops the click before the row reads it as "open the detail sheet".
 *
 * @module components/issues/IssuePropertyMenus
 */
import type {
  Issue,
  IssueAssignee,
  IssueLabel,
  IssueLabelId,
  IssuePriority,
  IssueStatus,
  IssueStatusId,
  ProjectId,
} from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import { PlusIcon } from "lucide-react";
import type { ReactElement, ReactNode } from "react";

import { cn } from "~/lib/utils";
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
  MenuTrigger,
} from "../ui/menu";
import {
  IssueAssigneeGlyph,
  IssueLabelDot,
  IssuePriorityIcon,
  IssueStatusDot,
} from "./IssueGlyphs";
import { issueAssigneeOptionValue, issueAssigneeOptions } from "./issueDetail.logic";
import {
  ISSUE_PRIORITY_LABELS,
  ISSUE_PRIORITY_ORDER,
  issueLabelSelectionState,
} from "./issuesList.logic";

/**
 * `display: contents` keeps the guard out of the row's flex layout while still sitting on the
 * bubble path, which is the only thing it is here for.
 */
export function IssuePropertyGuard({ children }: { children: ReactNode }) {
  return (
    <span
      className="contents"
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {children}
    </span>
  );
}

const ASSIGNEE_OPTIONS = issueAssigneeOptions(PROVIDER_CLIENT_DEFINITIONS);

/** Shared assignment menu for triage and other property surfaces. */
export function IssueAssigneeMenu({
  value,
  onSelect,
  trigger,
  align = "start",
}: {
  value: IssueAssignee | null;
  onSelect: (assignee: IssueAssignee | null) => void;
  trigger: ReactElement;
  align?: "start" | "center" | "end";
}) {
  const current = issueAssigneeOptionValue(value);
  return (
    <IssuePropertyGuard>
      <Menu>
        <MenuTrigger render={trigger} />
        <MenuPopup align={align} className="min-w-52" side="bottom">
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
                <MenuRadioItem closeOnClick key={option.value} value={option.value}>
                  <span className="flex min-w-0 items-center gap-2">
                    <IssueAssigneeGlyph assignee={option.assignee} className="size-4" />
                    <span className="truncate">{option.label}</span>
                  </span>
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuGroup>
        </MenuPopup>
      </Menu>
    </IssuePropertyGuard>
  );
}

export function IssueStatusMenu({
  statuses,
  value,
  onSelect,
  trigger,
  align = "start",
}: {
  statuses: ReadonlyArray<IssueStatus>;
  /** Null when the selection spans several statuses, or on a triage item that has none. */
  value: IssueStatusId | null;
  onSelect: (statusId: IssueStatusId) => void;
  trigger: ReactElement;
  align?: "start" | "center" | "end";
}) {
  return (
    <IssuePropertyGuard>
      <Menu>
        <MenuTrigger render={trigger} />
        <MenuPopup align={align} className="min-w-48" side="bottom">
          <MenuGroup>
            <MenuGroupLabel>Status</MenuGroupLabel>
            <MenuRadioGroup
              value={value ?? ""}
              onValueChange={(next) => {
                if (next !== value) onSelect(next as IssueStatusId);
              }}
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
          </MenuGroup>
        </MenuPopup>
      </Menu>
    </IssuePropertyGuard>
  );
}

export function IssuePriorityMenu({
  value,
  onSelect,
  trigger,
  align = "start",
}: {
  value: IssuePriority | null;
  onSelect: (priority: IssuePriority) => void;
  trigger: ReactElement;
  align?: "start" | "center" | "end";
}) {
  return (
    <IssuePropertyGuard>
      <Menu>
        <MenuTrigger render={trigger} />
        <MenuPopup align={align} className="min-w-44" side="bottom">
          <MenuGroup>
            <MenuGroupLabel>Priority</MenuGroupLabel>
            <MenuRadioGroup
              value={value ?? ""}
              onValueChange={(next) => {
                if (next !== value) onSelect(next as IssuePriority);
              }}
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
          </MenuGroup>
        </MenuPopup>
      </Menu>
    </IssuePropertyGuard>
  );
}

/**
 * Multi-select, and deliberately per-issue: `issues.bulkUpdate` replaces the whole label array, so
 * a bulk patch would flatten two issues with different labels into whichever set was computed
 * first. `onToggle` is called once per issue and the caller writes them one at a time.
 */
export function IssueLabelsMenu({
  labels,
  issues,
  onToggle,
  trigger,
  align = "start",
  emptyHint = "No labels yet — add them in Settings → Labels.",
}: {
  labels: ReadonlyArray<IssueLabel>;
  /** The issues the menu is editing: one from a row, many from the bulk bar. */
  issues: ReadonlyArray<Issue>;
  onToggle: (labelId: IssueLabelId, add: boolean) => void;
  trigger: ReactElement;
  align?: "start" | "center" | "end";
  emptyHint?: string;
}) {
  return (
    <IssuePropertyGuard>
      <Menu>
        <MenuTrigger render={trigger} />
        <MenuPopup align={align} className="min-w-52" side="bottom">
          <MenuGroup>
            <MenuGroupLabel>Labels</MenuGroupLabel>
            {labels.length === 0 ? (
              <p className="px-2 py-1.5 text-xs text-muted-foreground">{emptyHint}</p>
            ) : (
              labels.map((label) => {
                const state = issueLabelSelectionState(issues, label.id);
                return (
                  <MenuCheckboxItem
                    checked={state === "all"}
                    key={label.id}
                    onCheckedChange={() => onToggle(label.id, state !== "all")}
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
          </MenuGroup>
        </MenuPopup>
      </Menu>
    </IssuePropertyGuard>
  );
}

const NO_PROJECT_VALUE = "";

export function IssueProjectMenu({
  projects,
  value,
  onSelect,
  onCreateProject,
  trigger,
  align = "start",
  nullLabel = "No project",
}: {
  projects: ReadonlyArray<EnvironmentProject>;
  value: ProjectId | null;
  onSelect: (projectId: ProjectId | null) => void;
  /**
   * Opens the quick-create dialog. Present only where creating from here makes sense — the
   * tracker's whole reason for nullable `workspaceRoot` is that filing an issue should not
   * require leaving to go set a directory up first.
   */
  onCreateProject?: () => void;
  trigger: ReactElement;
  align?: "start" | "center" | "end";
  /** What a null selection means in this caller: absence, inheritance, or a default route. */
  nullLabel?: string;
}) {
  return (
    <IssuePropertyGuard>
      <Menu>
        <MenuTrigger render={trigger} />
        <MenuPopup align={align} className="min-w-52" side="bottom">
          <MenuGroup>
            <MenuGroupLabel>Project</MenuGroupLabel>
            <MenuRadioGroup
              value={value ?? NO_PROJECT_VALUE}
              onValueChange={(next) => {
                onSelect(next === NO_PROJECT_VALUE ? null : (next as ProjectId));
              }}
            >
              <MenuRadioItem closeOnClick value={NO_PROJECT_VALUE}>
                <span className="text-muted-foreground">{nullLabel}</span>
              </MenuRadioItem>
              {projects.map((project) => (
                <MenuRadioItem closeOnClick key={project.id} value={project.id}>
                  <span className="truncate">{project.title}</span>
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuGroup>
          {onCreateProject ? (
            <>
              <MenuSeparator />
              <MenuItem closeOnClick onClick={onCreateProject}>
                <PlusIcon className="size-3.5 text-muted-foreground" />
                <span>Create project…</span>
              </MenuItem>
            </>
          ) : null}
        </MenuPopup>
      </Menu>
    </IssuePropertyGuard>
  );
}

/** The bulk bar's destructive action, kept behind a menu so a stray click cannot fire it. */
export function IssueDeleteMenu({
  count,
  onConfirm,
  trigger,
  className,
}: {
  count: number;
  onConfirm: () => void;
  trigger: ReactElement;
  className?: string;
}) {
  return (
    <IssuePropertyGuard>
      <Menu>
        <MenuTrigger render={trigger} />
        <MenuPopup align="end" className={cn("min-w-52", className)} side="top">
          <MenuGroup>
            <MenuGroupLabel>
              Delete {count} {count === 1 ? "issue" : "issues"}?
            </MenuGroupLabel>
          </MenuGroup>
          <MenuSeparator />
          <MenuItem onClick={onConfirm} variant="destructive">
            Delete
          </MenuItem>
        </MenuPopup>
      </Menu>
    </IssuePropertyGuard>
  );
}
