/**
 * The sub-issues section of the detail sheet.
 *
 * Sub-issues are real issues — their own key, status, and place in the list — which is what
 * separates them from todos. So a row here is a link that re-points `?issue=` rather than an
 * editor, and the rollup counts by status *category*, the same rule the tabs use.
 *
 * @module components/issues/IssueSubIssues
 */
import type { Issue, IssueStatus, IssueStatusId } from "@t3tools/contracts";
import { PlusIcon } from "lucide-react";

import type { IssueChildRollup } from "~/state/issues";
import { Button } from "../ui/button";
import { IssueProgressRing } from "./IssueGlyphs";
import { IssueStatusGlyphFor } from "./IssueSelectors";

export function IssueSubIssues({
  subIssues,
  rollup,
  statusById,
  onOpenIssue,
  onAdd,
}: {
  /** The rollup's `childIds` already resolved to rows, in the rollup's order. */
  subIssues: ReadonlyArray<Issue>;
  rollup: IssueChildRollup;
  statusById: ReadonlyMap<IssueStatusId, IssueStatus>;
  onOpenIssue: (issue: Issue) => void;
  onAdd: () => void;
}) {
  return (
    <section className="flex flex-col gap-1.5 border-t border-border/50 pt-3">
      <div className="flex items-center gap-2">
        <h3 className="text-xs font-medium text-muted-foreground">Sub-issues</h3>
        {rollup.total === 0 ? null : (
          <span className="flex items-center gap-1 text-[11px] tabular-nums text-muted-foreground">
            <IssueProgressRing done={rollup.done} total={rollup.total} />
            {rollup.done}/{rollup.total}
          </span>
        )}
        <Button
          className="ms-auto text-muted-foreground"
          onClick={onAdd}
          size="icon-xs"
          variant="ghost"
        >
          <PlusIcon />
          <span className="sr-only">Add sub-issue</span>
        </Button>
      </div>

      {subIssues.length === 0 ? (
        <button
          className="rounded-md px-1.5 py-1 text-start text-[13px] text-muted-foreground outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring"
          onClick={onAdd}
          type="button"
        >
          Add a sub-issue…
        </button>
      ) : (
        <ul className="flex flex-col">
          {subIssues.map((child) => (
            <li key={child.id}>
              <button
                className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-start text-[13px] outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => onOpenIssue(child)}
                type="button"
              >
                <IssueStatusGlyphFor issue={child} statusById={statusById} />
                <span className="w-14 shrink-0 truncate font-mono text-[11px] text-muted-foreground">
                  {child.key}
                </span>
                <span className="min-w-0 flex-1 truncate">{child.title}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
