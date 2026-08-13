import { useNavigate } from "@tanstack/react-router";
import type { Issue, IssueStatus, IssueThreadLinkOrigin, ThreadId } from "@t3tools/contracts";
import { CalendarIcon } from "lucide-react";
import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";

import { useIssueLinksForThread, useIssueStatuses, useIssuesStore } from "~/state/issues";
import { IssueDetailSheet } from "../issues/IssueDetailSheet";
import { IssuePriorityIcon, IssueStatusDot } from "../issues/IssueGlyphs";
import { ISSUE_PRIORITY_LABELS } from "../issues/issuesList.logic";
import { resolveThreadLineageWindow, ThreadLineageRowList } from "./ThreadRelationshipsControl";

// A thread can accumulate links faster than anything else in this panel — every
// issue key an agent mentions adds one — so the section shows a window and keeps
// the rest behind Show more, like Lineage above it.
const THREAD_ISSUE_INITIAL_COUNT = 5;
/** Handed to the row list as well as to Show more, so the button cannot promise a different page. */
export const THREAD_ISSUE_PAGE_COUNT = 10;

/** Provenance first: where the work came from, then what somebody attached, then what was said. */
const ORIGIN_RANK: Record<IssueThreadLinkOrigin, number> = {
  "start-work": 0,
  manual: 1,
  mention: 2,
};

function issueMeta(issue: Issue, status: IssueStatus | null): ReadonlyArray<ReactNode> {
  const parts: Array<ReactNode> = [];
  if (status !== null) {
    parts.push(
      <span className="inline-flex min-w-0 items-center gap-1" key="status">
        <IssueStatusDot className="size-3" status={status} />
        <span className="truncate">{status.name}</span>
      </span>,
    );
  }
  if (issue.priority !== "none") {
    parts.push(
      <span className="inline-flex items-center gap-1" key="priority">
        <IssuePriorityIcon className="size-3" priority={issue.priority} />
        {ISSUE_PRIORITY_LABELS[issue.priority]}
      </span>,
    );
  }
  if (issue.dueDate !== null) {
    parts.push(
      <span className="inline-flex items-center gap-1" key="due">
        <CalendarIcon className="size-3" />
        {issue.dueDate}
      </span>,
    );
  }
  if (issue.deletedAt !== null) parts.push(<span key="deleted">Deleted</span>);
  return parts;
}

/** One linked issue. Opens the sheet over the chat rather than navigating; hook-free on purpose. */
export function ThreadIssueRow(props: {
  readonly issue: Issue;
  readonly meta: ReadonlyArray<ReactNode>;
  readonly onOpen: (issueKey: string) => void;
}) {
  const { issue, meta } = props;
  return (
    <li>
      <button
        type="button"
        className="flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-black/[0.055] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:hover:bg-white/[0.075]"
        aria-label={`View issue ${issue.key}`}
        onClick={() => props.onOpen(issue.key)}
      >
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-baseline gap-1.5">
            <span className="shrink-0 text-[11px] font-medium text-muted-foreground">
              {issue.key}
            </span>
            <span className="truncate text-[13px] font-medium text-foreground/90">
              {issue.title}
            </span>
          </div>
          {meta.length > 0 ? (
            <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
              {meta}
            </div>
          ) : null}
        </div>
      </button>
    </li>
  );
}

/**
 * Every issue this thread is linked to — the one it was started from, anything attached by hand,
 * and anything its messages mentioned — one row per issue, ordered start-work, manual, mention and
 * otherwise left in the order the links were created. A row opens the issue in a sheet over the
 * chat rather than navigating away; the sheet's own action goes to the issues page.
 *
 * A link whose issue is not in the store is dropped (the issue was purged). A soft-deleted one
 * still renders, with a Deleted chip: the thread really did reference it.
 */
export function ThreadIssuePanel(props: {
  readonly threadId: ThreadId;
  readonly enabled: boolean;
}) {
  const { links } = useIssueLinksForThread(props.threadId, props.enabled);
  const issuesById = useIssuesStore().issuesById;
  const statuses = useIssueStatuses();
  const navigate = useNavigate();
  const [openIssueKey, setOpenIssueKey] = useState<string | null>(null);

  const rows = useMemo(() => {
    // One row per issue, keeping the strongest origin it was linked under: the store dedupes links
    // already, but a row per link would double a row — and reuse a React key — the moment it did
    // not, and "linked twice" is a thing a person reads as one relationship anyway.
    const byIssueId = new Map<
      string,
      { issue: Issue; origin: IssueThreadLinkOrigin; meta: ReadonlyArray<ReactNode> }
    >();
    for (const link of links) {
      const issue = issuesById.get(link.issueId);
      if (issue === undefined) continue;
      const existing = byIssueId.get(issue.id);
      if (existing !== undefined) {
        if (ORIGIN_RANK[link.origin] < ORIGIN_RANK[existing.origin]) existing.origin = link.origin;
        continue;
      }
      const status = statuses.find((candidate) => candidate.id === issue.statusId) ?? null;
      byIssueId.set(issue.id, { issue, origin: link.origin, meta: issueMeta(issue, status) });
    }
    // Links arrive sorted by creation, and a stable sort keeps that order inside each rank.
    return [...byIssueId.values()].sort(
      (left, right) => ORIGIN_RANK[left.origin] - ORIGIN_RANK[right.origin],
    );
  }, [issuesById, links, statuses]);

  const [visibleCount, setVisibleCount] = useState(THREAD_ISSUE_INITIAL_COUNT);
  const lastThreadIdRef = useRef(props.threadId);
  if (lastThreadIdRef.current !== props.threadId) {
    lastThreadIdRef.current = props.threadId;
    setVisibleCount(THREAD_ISSUE_INITIAL_COUNT);
  }
  const showMore = useCallback(
    () => setVisibleCount((count) => count + THREAD_ISSUE_PAGE_COUNT),
    [],
  );
  const { visibleRows, hiddenCount } = resolveThreadLineageWindow(rows, visibleCount);

  if (rows.length === 0) return null;

  return (
    <>
      <section
        aria-labelledby="thread-details-issue-heading"
        className="border-t border-border/65"
        data-thread-issue-panel
      >
        <div className="px-3.5 pb-1 pt-3">
          <h3
            id="thread-details-issue-heading"
            className="text-[11px] font-medium text-muted-foreground"
          >
            Issues
          </h3>
        </div>
        <div className="px-2 pb-2.5">
          <ThreadLineageRowList
            ariaLabel="Issues linked to this thread"
            hiddenCount={hiddenCount}
            onShowMore={showMore}
            pageCount={THREAD_ISSUE_PAGE_COUNT}
          >
            {visibleRows.map(({ issue, meta }) => (
              <ThreadIssueRow key={issue.id} issue={issue} meta={meta} onOpen={setOpenIssueKey} />
            ))}
          </ThreadLineageRowList>
        </div>
      </section>

      {openIssueKey === null ? null : (
        <IssueDetailSheet
          issueKey={openIssueKey}
          onClose={() => setOpenIssueKey(null)}
          onOpenInIssues={(key) => {
            void navigate({ to: "/issues", search: { issue: key } });
          }}
          onOpenIssueKey={setOpenIssueKey}
        />
      )}
    </>
  );
}
