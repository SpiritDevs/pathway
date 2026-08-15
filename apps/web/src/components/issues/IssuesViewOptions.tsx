/**
 * The grouping and ordering selectors in the `/issues` header, beside the list/board toggle.
 *
 * One menu rather than two selects: grouping and ordering are read together and change together,
 * and the header row has one line to spend on both.
 *
 * @module components/issues/IssuesViewOptions
 */
import type { IssueViewGrouping, IssueViewMode, IssueViewSortMode } from "@spiritdevs/contracts";
import { SlidersHorizontalIcon } from "lucide-react";

import { Button } from "../ui/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import {
  ISSUE_GROUPING_LABELS,
  ISSUE_SORT_MODE_LABELS,
  ISSUE_VIEW_GROUPINGS,
  ISSUE_VIEW_SORT_MODES,
  issueSortModeHint,
} from "./issuesList.logic";

export function IssuesViewOptions({
  grouping,
  sortMode,
  viewMode,
  onGrouping,
  onSortMode,
}: {
  grouping: IssueViewGrouping;
  sortMode: IssueViewSortMode;
  /**
   * The board's columns are statuses and nothing else, so it is offered no grouping — the decision
   * record makes grouping a read concern of the list alone — and its hint is about the drag rather
   * than about the order.
   */
  viewMode: IssueViewMode;
  onGrouping: (grouping: IssueViewGrouping) => void;
  onSortMode: (sortMode: IssueViewSortMode) => void;
}) {
  const showGrouping = viewMode === "list";
  // Manual order is the stored fractional key written by dragging inside a status group.
  const hint = issueSortModeHint(sortMode, grouping, viewMode);
  const help =
    hint ??
    (sortMode === "manual"
      ? viewMode === "board"
        ? "Drag cards to reorder them or move them between statuses."
        : "Drag rows to reorder them or move them between statuses."
      : null);

  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            size="xs"
            title={
              help ??
              (showGrouping
                ? `Grouped by ${ISSUE_GROUPING_LABELS[grouping].toLowerCase()} and ordered by ${ISSUE_SORT_MODE_LABELS[sortMode].toLowerCase()}`
                : `Ordered by ${ISSUE_SORT_MODE_LABELS[sortMode].toLowerCase()}`)
            }
            variant="ghost"
          >
            <SlidersHorizontalIcon />
            {showGrouping ? (
              <>
                {ISSUE_GROUPING_LABELS[grouping]}
                <span className="text-muted-foreground">· {ISSUE_SORT_MODE_LABELS[sortMode]}</span>
              </>
            ) : (
              ISSUE_SORT_MODE_LABELS[sortMode]
            )}
          </Button>
        }
      />
      <MenuPopup align="end" className="min-w-52" side="bottom">
        {!showGrouping ? null : (
          <>
            <MenuGroup>
              <MenuGroupLabel>Grouping</MenuGroupLabel>
              <MenuRadioGroup
                onValueChange={(next) => onGrouping(next as IssueViewGrouping)}
                value={grouping}
              >
                {ISSUE_VIEW_GROUPINGS.map((option) => (
                  <MenuRadioItem key={option} value={option}>
                    {ISSUE_GROUPING_LABELS[option]}
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuGroup>
            <MenuSeparator />
          </>
        )}
        <MenuGroup>
          <MenuGroupLabel>Ordering</MenuGroupLabel>
          <MenuRadioGroup
            onValueChange={(next) => onSortMode(next as IssueViewSortMode)}
            value={sortMode}
          >
            {ISSUE_VIEW_SORT_MODES.map((option) => (
              <MenuRadioItem key={option} value={option}>
                {ISSUE_SORT_MODE_LABELS[option]}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
          {help === null ? null : (
            <p className="max-w-52 px-2 pt-1.5 text-[11px] text-muted-foreground">{help}</p>
          )}
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}
