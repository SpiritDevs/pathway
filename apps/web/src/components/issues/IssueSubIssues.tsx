/**
 * The sub-issues section of the detail sheet.
 *
 * Sub-issues are real issues — their own key, status, and place in the list — which is what
 * separates them from todos. So a row here is a link that re-points `?issue=` rather than an
 * editor, and the rollup counts by status *category*, the same rule the tabs use.
 *
 * @module components/issues/IssueSubIssues
 */
import type { Issue, IssueLabel, IssueStatus, IssueStatusId } from "@spiritdevs/contracts";
import { ChevronDownIcon, ChevronRightIcon, PlusIcon } from "lucide-react";
import { useState } from "react";

import type { IssueChildRollup } from "~/state/issues";
import { Button } from "../ui/button";
import { InlineSubIssueComposer } from "./InlineSubIssueComposer";
import { IssueProgressRing } from "./IssueGlyphs";
import { IssueStatusGlyphFor } from "./IssueSelectors";

export function IssueSubIssues({
  subIssues,
  rollup,
  statusById,
  onOpenIssue,
  parent,
  statuses,
  labels,
  composerOpen,
  onComposerOpenChange,
}: {
  /** The rollup's `childIds` already resolved to rows, in the rollup's order. */
  subIssues: ReadonlyArray<Issue>;
  rollup: IssueChildRollup;
  statusById: ReadonlyMap<IssueStatusId, IssueStatus>;
  onOpenIssue: (issue: Issue) => void;
  parent: Issue;
  statuses: ReadonlyArray<IssueStatus>;
  labels: ReadonlyArray<IssueLabel>;
  composerOpen: boolean;
  onComposerOpenChange: (open: boolean) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);

  const openComposer = () => {
    setCollapsed(false);
    onComposerOpenChange(true);
  };

  return (
    <section className="flex flex-col gap-2">
      {subIssues.length === 0 ? (
        <button
          aria-expanded={composerOpen}
          className="flex min-h-8 items-center gap-1.5 rounded-md px-1.5 text-start text-[13px] text-muted-foreground outline-none hover:bg-accent/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          onClick={openComposer}
          type="button"
        >
          <PlusIcon className="size-3.5" />
          Add sub-issues
        </button>
      ) : (
        <>
          <div className="flex min-h-8 items-center gap-1">
            <button
              aria-expanded={!collapsed}
              className="flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-xs font-medium text-muted-foreground outline-none hover:bg-accent/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => setCollapsed((current) => !current)}
              type="button"
            >
              {collapsed ? (
                <ChevronRightIcon className="size-3" />
              ) : (
                <ChevronDownIcon className="size-3" />
              )}
              <span>Sub-issues</span>
              <span className="flex items-center gap-1 text-[11px] font-normal tabular-nums">
                <IssueProgressRing done={rollup.done} total={rollup.total} />
                {rollup.done}/{rollup.total}
              </span>
            </button>
            <Button
              aria-label="Add sub-issue"
              className="ms-auto text-muted-foreground"
              onClick={openComposer}
              size="icon-xs"
              variant="ghost"
            >
              <PlusIcon />
            </Button>
          </div>

          {collapsed ? null : (
            <ul className="flex flex-col">
              {subIssues.map((child) => (
                <li key={child.id}>
                  <button
                    className="flex min-h-8 w-full items-center gap-2 rounded-md px-2 text-start text-[13px] outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => onOpenIssue(child)}
                    type="button"
                  >
                    <IssueStatusGlyphFor issue={child} statusById={statusById} />
                    <span className="min-w-0 flex-1 truncate">{child.title}</span>
                    <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                      {child.key}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      <InlineSubIssueComposer
        labels={labels}
        onOpenChange={onComposerOpenChange}
        open={composerOpen}
        parent={parent}
        statuses={statuses}
      />
    </section>
  );
}
