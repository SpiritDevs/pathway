/**
 * The relations section of the detail sheet.
 *
 * One stored row per pair, read from whichever end this sheet is on: "blocked by" is a `blocks`
 * row arriving inbound, which is why adding one swaps the two ids rather than picking a fourth
 * kind. Blocked-by leads the groups because it is what a triage pass is looking for.
 *
 * @module components/issues/IssueRelationsSection
 */
import type {
  Issue,
  IssueId,
  IssueRelationCreateInput,
  IssueRelationId,
  IssueStatus,
  IssueStatusId,
} from "@t3tools/contracts";
import { PlusIcon, XIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { cn } from "~/lib/utils";
import type { IssueRelationDisplay } from "~/state/issues";
import { Button } from "../ui/button";
import {
  Menu,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "../ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { IssueSearchList, IssueStatusGlyphFor } from "./IssueSelectors";
import {
  DEFAULT_ISSUE_RELATION_CHOICE,
  ISSUE_RELATION_CHOICES,
  groupIssueRelationDisplays,
  issueRelationChoice,
  issueRelationCreateInput,
  searchIssues,
  type IssueRelationChoiceValue,
} from "./issueDetail.logic";

const TRIGGER_CLASS =
  "flex h-6 items-center gap-1 rounded-md border border-input px-1.5 text-[11px] text-muted-foreground outline-none hover:bg-accent/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring";

function AddRelationPopover({
  issue,
  issuesById,
  linkedIds,
  statusById,
  onCreate,
}: {
  issue: Issue;
  issuesById: ReadonlyMap<IssueId, Issue>;
  /** Everything already linked, so the picker cannot offer a duplicate the server would refuse. */
  linkedIds: ReadonlySet<IssueId>;
  statusById: ReadonlyMap<IssueStatusId, IssueStatus>;
  onCreate: (input: IssueRelationCreateInput) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [choiceValue, setChoiceValue] = useState<IssueRelationChoiceValue>(
    DEFAULT_ISSUE_RELATION_CHOICE.value,
  );
  const choice = issueRelationChoice(choiceValue);
  const exclude = useMemo(() => new Set([...linkedIds, issue.id]), [issue.id, linkedIds]);
  const results = useMemo(
    () => searchIssues(issuesById.values(), { query, exclude }),
    [exclude, issuesById, query],
  );

  return (
    <Popover
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
      open={open}
    >
      <PopoverTrigger
        render={
          <button className={TRIGGER_CLASS} type="button">
            <PlusIcon className="size-3" />
            Add relation
          </button>
        }
      />
      <PopoverPopup align="start" className="w-72 p-1.5">
        <Menu>
          <MenuTrigger
            render={
              <button className={cn(TRIGGER_CLASS, "mb-1.5 w-full justify-between")} type="button">
                {choice.label}
              </button>
            }
          />
          <MenuPopup align="start" className="min-w-44" side="bottom">
            <MenuGroupLabel>Relation</MenuGroupLabel>
            <MenuRadioGroup
              onValueChange={(next) => setChoiceValue(next as IssueRelationChoiceValue)}
              value={choiceValue}
            >
              {ISSUE_RELATION_CHOICES.map((option) => (
                <MenuRadioItem key={option.value} value={option.value}>
                  {option.label}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuPopup>
        </Menu>
        <IssueSearchList
          emptyHint="No other issue matches."
          onPick={(picked) => {
            const input = issueRelationCreateInput({
              issueId: issue.id,
              otherIssueId: picked.id,
              choice,
            });
            setOpen(false);
            setQuery("");
            if (input !== null) onCreate(input);
          }}
          onQueryChange={setQuery}
          placeholder="Search by key or title…"
          query={query}
          renderStatusGlyph={(candidate) => (
            <IssueStatusGlyphFor issue={candidate} statusById={statusById} />
          )}
          results={results}
        />
      </PopoverPopup>
    </Popover>
  );
}

export function IssueRelationsSection({
  issue,
  displays,
  issuesById,
  statusById,
  onOpenIssue,
  onCreate,
  onDelete,
}: {
  issue: Issue;
  displays: ReadonlyArray<IssueRelationDisplay>;
  issuesById: ReadonlyMap<IssueId, Issue>;
  statusById: ReadonlyMap<IssueStatusId, IssueStatus>;
  onOpenIssue: (issue: Issue) => void;
  onCreate: (input: IssueRelationCreateInput) => void;
  onDelete: (relationId: IssueRelationId) => void;
}) {
  const groups = useMemo(() => groupIssueRelationDisplays(displays), [displays]);
  const linkedIds = useMemo(() => new Set(displays.map((display) => display.issueId)), [displays]);

  return (
    <section className="flex flex-col gap-1.5 border-t border-border/50 pt-3">
      <div className="flex items-center gap-2">
        <h3 className="text-xs font-medium text-muted-foreground">Relations</h3>
        <div className="ms-auto">
          <AddRelationPopover
            issue={issue}
            issuesById={issuesById}
            linkedIds={linkedIds}
            onCreate={onCreate}
            statusById={statusById}
          />
        </div>
      </div>

      {groups.length === 0 ? (
        <p className="px-1.5 text-[13px] text-muted-foreground">Nothing linked yet.</p>
      ) : (
        groups.map((group) => (
          <div className="flex flex-col" key={group.label}>
            <p className="px-1.5 pt-1 text-[11px] font-medium text-muted-foreground/80">
              {group.label}
            </p>
            {group.displays.map((display) => {
              const other = issuesById.get(display.issueId);
              return (
                <div
                  className="group/relation flex items-center gap-2 rounded-md px-1.5 py-1 text-[13px] hover:bg-accent/30"
                  key={display.relationId}
                >
                  {other === undefined ? (
                    <span className="min-w-0 flex-1 truncate text-muted-foreground">
                      An issue this client has not loaded
                    </span>
                  ) : (
                    <button
                      className="flex min-w-0 flex-1 items-center gap-2 text-start outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={() => onOpenIssue(other)}
                      type="button"
                    >
                      <IssueStatusGlyphFor issue={other} statusById={statusById} />
                      <span className="w-14 shrink-0 truncate font-mono text-[11px] text-muted-foreground">
                        {other.key}
                      </span>
                      <span className="min-w-0 flex-1 truncate">{other.title}</span>
                    </button>
                  )}
                  <Button
                    aria-label="Unlink"
                    className="text-muted-foreground opacity-0 group-hover/relation:opacity-100 focus-visible:opacity-100"
                    onClick={() => onDelete(display.relationId)}
                    size="icon-xs"
                    variant="ghost"
                  >
                    <XIcon />
                  </Button>
                </div>
              );
            })}
          </div>
        ))
      )}
    </section>
  );
}
