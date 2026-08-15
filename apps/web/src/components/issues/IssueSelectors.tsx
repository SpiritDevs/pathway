/**
 * The stage-2 pickers: milestone, cycle, and one searchable issue list that both the parent picker
 * and the relation picker are built from.
 *
 * All three are `Popover`s rather than `Menu`s, for the reason the label editor already is: each
 * hosts a text field — a search box or an inline create row — and a menu treats the first keystroke
 * as typeahead and closes on the second.
 *
 * @module components/issues/IssueSelectors
 */
import type {
  Issue,
  IssueCycle,
  IssueCycleId,
  IssueDate,
  IssueId,
  IssueMilestone,
  IssueMilestoneId,
  IssueStatus,
  IssueStatusId,
} from "@spiritdevs/contracts";
import { CalendarRangeIcon, CheckIcon, FlagIcon, GitBranchIcon, PlusIcon } from "lucide-react";
import { useMemo, useState, type ReactElement, type ReactNode } from "react";

import { issueCyclesByStatus, todayIssueDate, type IssueCyclesByStatus } from "~/state/issues";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { IssueStatusDot } from "./IssueGlyphs";
import { IssuePropertyGuard } from "./IssuePropertyMenus";
import {
  buildIssueTreeIndex,
  isCompleteIssueDate,
  issueMilestoneCreateName,
  issueParentCandidates,
} from "./issueDetail.logic";
import { formatIssueDateRange } from "./issuesList.logic";

const OPTION_CLASS =
  "flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-start text-[13px] outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring";

const SECTION_LABEL_CLASS = "px-1.5 pt-1.5 pb-0.5 text-[11px] font-medium text-muted-foreground/80";

function OptionRow({
  children,
  selected,
  onSelect,
}: {
  children: ReactNode;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button className={OPTION_CLASS} onClick={onSelect} type="button">
      <span className="flex min-w-0 flex-1 items-center gap-2">{children}</span>
      {selected ? <CheckIcon className="size-3.5 shrink-0 text-primary" /> : null}
    </button>
  );
}

/**
 * Filtered to the issue's project, because a milestone belongs to one: the server refuses a
 * milestone from a project the issue is not in, so a rootless issue gets the hint rather than a
 * list it cannot pick from.
 */
export function IssueMilestonePicker({
  milestones,
  value,
  hasProject,
  onSelect,
  onCreate,
  trigger,
}: {
  /** Already narrowed to the issue's project by the caller. */
  milestones: ReadonlyArray<IssueMilestone>;
  value: IssueMilestoneId | null;
  hasProject: boolean;
  onSelect: (milestoneId: IssueMilestoneId | null) => void;
  /**
   * Absent hides the create row. Answers with the new milestone so the picker can apply it — the
   * only reason to type a milestone into an issue is to put the issue in it.
   */
  onCreate?:
    | ((input: {
        readonly name: string;
        readonly targetDate: IssueDate | null;
      }) => Promise<IssueMilestoneId | null>)
    | undefined;
  trigger: ReactElement;
}) {
  const [open, setOpen] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [draftDate, setDraftDate] = useState("");
  const [creating, setCreating] = useState(false);

  const createName = issueMilestoneCreateName(draftName, milestones);

  const reset = () => {
    setDraftName("");
    setDraftDate("");
  };

  const submit = () => {
    if (createName === null || creating || onCreate === undefined) return;
    setCreating(true);
    void (async () => {
      const created = await onCreate({
        name: createName,
        targetDate: isCompleteIssueDate(draftDate) ? (draftDate.trim() as IssueDate) : null,
      });
      setCreating(false);
      if (created === null) return;
      reset();
      onSelect(created);
      setOpen(false);
    })();
  };

  return (
    <IssuePropertyGuard>
      <Popover
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) reset();
        }}
        open={open}
      >
        <PopoverTrigger render={trigger} />
        <PopoverPopup align="start" className="w-64 p-1.5">
          {!hasProject ? (
            <p className="px-1.5 py-1 text-xs text-muted-foreground">
              Milestones belong to a project. Give this issue one first.
            </p>
          ) : (
            <>
              <div className="max-h-56 overflow-y-auto">
                <OptionRow
                  onSelect={() => {
                    onSelect(null);
                    setOpen(false);
                  }}
                  selected={value === null}
                >
                  <span className="text-muted-foreground">No milestone</span>
                </OptionRow>
                {milestones.map((milestone) => (
                  <OptionRow
                    key={milestone.id}
                    onSelect={() => {
                      onSelect(milestone.id);
                      setOpen(false);
                    }}
                    selected={value === milestone.id}
                  >
                    <FlagIcon className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="truncate">{milestone.name}</span>
                    {milestone.targetDate === null ? null : (
                      <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                        {milestone.targetDate.slice(5)}
                      </span>
                    )}
                  </OptionRow>
                ))}
              </div>

              {onCreate === undefined ? null : (
                <div className="mt-1.5 flex items-center gap-1.5 border-t border-border/60 pt-1.5">
                  <Input
                    aria-label="New milestone name"
                    className="min-w-0 flex-1"
                    disabled={creating}
                    onChange={(event) => setDraftName(event.currentTarget.value)}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter") return;
                      event.preventDefault();
                      submit();
                    }}
                    placeholder="New milestone…"
                    size="sm"
                    value={draftName}
                  />
                  <input
                    aria-label="Target date for the new milestone"
                    className="h-7 w-24 shrink-0 rounded-md border border-input bg-transparent px-1.5 text-[11px] tabular-nums outline-none [color-scheme:light] focus-visible:ring-2 focus-visible:ring-ring dark:[color-scheme:dark]"
                    disabled={creating}
                    onChange={(event) => setDraftDate(event.currentTarget.value)}
                    type="date"
                    value={draftDate}
                  />
                  <Button
                    aria-label="Create milestone"
                    disabled={createName === null || creating}
                    onClick={submit}
                    size="icon-xs"
                    variant="outline"
                  >
                    <PlusIcon />
                  </Button>
                </div>
              )}
              {draftName.trim().length > 0 && createName === null ? (
                <p className="px-1 pt-1 text-[11px] text-muted-foreground">
                  This project already has a milestone with that name.
                </p>
              ) : null}
            </>
          )}
        </PopoverPopup>
      </Popover>
    </IssuePropertyGuard>
  );
}

function CycleOptionLabel({ cycle, today }: { cycle: IssueCycle; today: IssueDate }) {
  return (
    <>
      <CalendarRangeIcon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate">{cycle.name}</span>
      <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
        {formatIssueDateRange(cycle.startDate, cycle.endDate, today)}
      </span>
    </>
  );
}

/**
 * Active and upcoming first; ended cycles stay behind a disclosure, because the list only grows and
 * nothing anybody is planning is in it.
 */
export function IssueCyclePicker({
  cycles,
  value,
  onSelect,
  trigger,
}: {
  cycles: ReadonlyArray<IssueCycle>;
  value: IssueCycleId | null;
  onSelect: (cycleId: IssueCycleId | null) => void;
  trigger: ReactElement;
}) {
  const [open, setOpen] = useState(false);
  const [showEnded, setShowEnded] = useState(false);
  const today = useMemo(() => todayIssueDate(), []);
  const byStatus: IssueCyclesByStatus = useMemo(
    () => issueCyclesByStatus(cycles, today),
    [cycles, today],
  );

  const pick = (cycleId: IssueCycleId | null) => {
    onSelect(cycleId);
    setOpen(false);
  };

  const section = (label: string, list: ReadonlyArray<IssueCycle>) =>
    list.length === 0 ? null : (
      <>
        <p className={SECTION_LABEL_CLASS}>{label}</p>
        {list.map((cycle) => (
          <OptionRow key={cycle.id} onSelect={() => pick(cycle.id)} selected={value === cycle.id}>
            <CycleOptionLabel cycle={cycle} today={today} />
          </OptionRow>
        ))}
      </>
    );

  return (
    <IssuePropertyGuard>
      <Popover
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setShowEnded(false);
        }}
        open={open}
      >
        <PopoverTrigger render={trigger} />
        <PopoverPopup align="start" className="w-64 p-1.5">
          <div className="max-h-64 overflow-y-auto">
            <OptionRow onSelect={() => pick(null)} selected={value === null}>
              <span className="text-muted-foreground">No cycle</span>
            </OptionRow>
            {cycles.length === 0 ? (
              <p className="px-1.5 py-1 text-xs text-muted-foreground">
                No cycles yet. Create one from the Cycles heading in the sidebar.
              </p>
            ) : null}
            {section("Active", byStatus.active)}
            {section("Upcoming", byStatus.upcoming)}
            {byStatus.ended.length === 0 ? null : showEnded ? (
              section("Ended", byStatus.ended)
            ) : (
              <button
                className="mt-1 w-full rounded-md px-1.5 py-1 text-start text-[11px] text-muted-foreground outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => setShowEnded(true)}
                type="button"
              >
                Show {byStatus.ended.length} ended
              </button>
            )}
          </div>
        </PopoverPopup>
      </Popover>
    </IssuePropertyGuard>
  );
}

/**
 * The searchable issue list both the parent picker and the relation picker render. Keeps its own
 * query so the caller only handles the choice.
 */
export function IssueSearchList({
  results,
  query,
  onQueryChange,
  onPick,
  renderStatusGlyph,
  placeholder,
  emptyHint,
}: {
  results: ReadonlyArray<Issue>;
  query: string;
  onQueryChange: (query: string) => void;
  onPick: (issue: Issue) => void;
  renderStatusGlyph: (issue: Issue) => ReactNode;
  placeholder: string;
  emptyHint: string;
}) {
  return (
    <>
      <Input
        aria-label={placeholder}
        autoFocus
        className="mb-1"
        onChange={(event) => onQueryChange(event.currentTarget.value)}
        placeholder={placeholder}
        size="sm"
        value={query}
      />
      <div className="max-h-56 overflow-y-auto">
        {results.length === 0 ? (
          <p className="px-1.5 py-1 text-xs text-muted-foreground">{emptyHint}</p>
        ) : (
          results.map((issue) => (
            <button
              className={OPTION_CLASS}
              key={issue.id}
              onClick={() => onPick(issue)}
              type="button"
            >
              {renderStatusGlyph(issue)}
              <span className="w-14 shrink-0 truncate font-mono text-[11px] text-muted-foreground">
                {issue.key}
              </span>
              <span className="min-w-0 flex-1 truncate">{issue.title}</span>
            </button>
          ))
        )}
      </div>
    </>
  );
}

/**
 * "Sub-issue of". Offers only the parents the server would accept — not itself, not one of its own
 * descendants, and nothing that would push the subtree past the depth cap — so a choice here never
 * comes back as a refusal.
 */
export function IssueParentPicker({
  issue,
  issues,
  renderStatusGlyph,
  onSelect,
  trigger,
}: {
  issue: Issue;
  /**
   * The whole tracker, as the store holds it: the depth rule needs the tree, not a candidate list,
   * and a map is what keeps the memo below stable — an iterator is single-use and a fresh one on
   * every render would rebuild the tree on every keystroke elsewhere on the sheet.
   */
  issues: ReadonlyMap<IssueId, Issue>;
  renderStatusGlyph: (issue: Issue) => ReactNode;
  onSelect: (parentId: IssueId | null) => void;
  trigger: ReactElement;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const tree = useMemo(() => buildIssueTreeIndex(issues.values()), [issues]);
  const results = useMemo(
    () => issueParentCandidates(tree, { issueId: issue.id, query }),
    [issue.id, query, tree],
  );

  return (
    <IssuePropertyGuard>
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
            emptyHint="No issue here can be this one's parent."
            onPick={(picked) => {
              onSelect(picked.id);
              setOpen(false);
            }}
            onQueryChange={setQuery}
            placeholder="Search by key or title…"
            query={query}
            results={results}
            renderStatusGlyph={renderStatusGlyph}
          />
          {issue.parentId === null ? null : (
            <button
              className="mt-1.5 flex w-full items-center gap-2 border-t border-border/60 px-1.5 pt-1.5 text-start text-[13px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => {
                onSelect(null);
                setOpen(false);
              }}
              type="button"
            >
              <GitBranchIcon className="size-3.5 shrink-0" />
              Remove parent
            </button>
          )}
        </PopoverPopup>
      </Popover>
    </IssuePropertyGuard>
  );
}

/**
 * The glyph column of a row that names another issue — a search result, a sub-issue, a relation.
 * A status the client has not seen renders as the dashed placeholder the list row uses.
 */
export function IssueStatusGlyphFor({
  issue,
  statusById,
}: {
  issue: Issue;
  statusById: ReadonlyMap<IssueStatusId, IssueStatus>;
}) {
  const status = statusById.get(issue.statusId);
  return status === undefined ? (
    <span className="size-3.5 shrink-0 rounded-full border border-dashed border-border" />
  ) : (
    <IssueStatusDot status={status} />
  );
}
