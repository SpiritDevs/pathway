/**
 * The floating bar that appears once a selection covers more than one row.
 *
 * @module components/issues/IssuesBulkBar
 */
import type {
  Issue,
  IssueLabel,
  IssueLabelId,
  IssuePriority,
  IssueStatus,
  IssueStatusId,
  ProjectId,
} from "@spiritdevs/contracts";
import type { EnvironmentProject } from "@spiritdevs/client-runtime/state/models";
import {
  BotIcon,
  CircleDotIcon,
  SignalHighIcon,
  TagIcon,
  Trash2Icon,
  WandSparklesIcon,
  XIcon,
} from "lucide-react";

import { Button } from "../ui/button";
import {
  IssueDeleteMenu,
  IssueLabelsMenu,
  IssuePriorityMenu,
  IssueStatusMenu,
} from "./IssuePropertyMenus";
import { IssueInvestigateProjectMenu } from "./IssueInvestigateProjectMenu";

export function IssuesBulkBar({
  issues,
  statuses,
  labels,
  onStatus,
  onPriority,
  onToggleLabel,
  onDelete,
  onClear,
  projects,
  investigateDisabledReason,
  onInvestigate,
  askDisabledReason,
  onAsk,
}: {
  issues: ReadonlyArray<Issue>;
  statuses: ReadonlyArray<IssueStatus>;
  labels: ReadonlyArray<IssueLabel>;
  onStatus: (statusId: IssueStatusId) => void;
  onPriority: (priority: IssuePriority) => void;
  onToggleLabel: (labelId: IssueLabelId, add: boolean) => void;
  onDelete: () => void;
  onClear: () => void;
  projects: ReadonlyArray<EnvironmentProject>;
  investigateDisabledReason: string | null;
  onInvestigate: (projectId: ProjectId) => void;
  askDisabledReason: string | null;
  onAsk: () => void;
}) {
  // A shared value shows as the current one; a mixed selection shows nothing checked rather than
  // pretending the first row speaks for the rest.
  const sharedStatusId = sharedValue(issues.map((issue) => issue.statusId));
  const sharedPriority = sharedValue(issues.map((issue) => issue.priority));

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-4 z-20 flex justify-center px-4">
      <div
        className="pointer-events-auto flex items-center gap-1 rounded-xl border border-border/70 bg-popover/95 p-1 shadow-lg backdrop-blur-sm"
        role="toolbar"
        aria-label="Bulk issue actions"
      >
        <span className="px-2 text-xs tabular-nums text-muted-foreground">
          {issues.length} selected
        </span>
        <IssueStatusMenu
          align="center"
          onSelect={onStatus}
          statuses={statuses}
          trigger={
            <Button size="xs" variant="ghost">
              <CircleDotIcon />
              Status
            </Button>
          }
          value={sharedStatusId}
        />
        <IssuePriorityMenu
          align="center"
          onSelect={onPriority}
          trigger={
            <Button size="xs" variant="ghost">
              <SignalHighIcon />
              Priority
            </Button>
          }
          value={sharedPriority}
        />
        <IssueLabelsMenu
          align="center"
          issues={issues}
          labels={labels}
          onToggle={onToggleLabel}
          trigger={
            <Button size="xs" variant="ghost">
              <TagIcon />
              Label
            </Button>
          }
        />
        <IssueInvestigateProjectMenu
          align="center"
          currentProjectId={sharedValue(issues.map((issue) => issue.projectId))}
          disabledReason={investigateDisabledReason}
          onSelect={onInvestigate}
          projects={projects}
          side="top"
        >
          <WandSparklesIcon />
          Investigate
        </IssueInvestigateProjectMenu>
        <Button
          aria-label={`Ask AI about ${issues.length} selected ${issues.length === 1 ? "issue" : "issues"}`}
          disabled={askDisabledReason !== null}
          onClick={onAsk}
          size="icon-xs"
          title={askDisabledReason ?? "Ask AI"}
          variant="ghost"
        >
          <BotIcon />
        </Button>
        <IssueDeleteMenu
          count={issues.length}
          onConfirm={onDelete}
          trigger={
            <Button size="xs" variant="ghost">
              <Trash2Icon />
              Delete
            </Button>
          }
        />
        <Button aria-label="Clear selection" onClick={onClear} size="icon-xs" variant="ghost">
          <XIcon />
        </Button>
      </div>
    </div>
  );
}

function sharedValue<T>(values: ReadonlyArray<T>): T | null {
  const first = values[0];
  if (first === undefined) return null;
  return values.every((value) => value === first) ? first : null;
}
