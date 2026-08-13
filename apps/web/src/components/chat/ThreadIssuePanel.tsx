import { useNavigate } from "@tanstack/react-router";
import type { Issue, IssueStatus, ThreadId } from "@t3tools/contracts";
import { CalendarIcon } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import { useIssue, useIssueLinksForThread, useIssueStatuses } from "~/state/issues";
import { IssueDetailSheet } from "../issues/IssueDetailSheet";
import { IssuePriorityIcon, IssueStatusDot } from "../issues/IssueGlyphs";
import { ISSUE_PRIORITY_LABELS } from "../issues/issuesList.logic";

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

/** The issue that created this thread. Manually attached issues intentionally do not appear here. */
export function ThreadIssuePanel(props: {
  readonly threadId: ThreadId;
  readonly enabled: boolean;
}) {
  const { links } = useIssueLinksForThread(props.threadId, props.enabled);
  const statuses = useIssueStatuses();
  const navigate = useNavigate();
  const [openIssueKey, setOpenIssueKey] = useState<string | null>(null);
  const startWorkLink = links.find((link) => link.origin === "start-work") ?? null;
  const issue = useIssue(startWorkLink?.issueId ?? null);
  const status =
    issue === null ? null : (statuses.find((candidate) => candidate.id === issue.statusId) ?? null);
  const meta = useMemo(() => (issue === null ? [] : issueMeta(issue, status)), [issue, status]);

  if (issue === null) return null;

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
            Issue
          </h3>
        </div>
        <div className="px-2 pb-2.5">
          <button
            type="button"
            className="flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-black/[0.055] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:hover:bg-white/[0.075]"
            aria-label={`View issue ${issue.key}`}
            onClick={() => setOpenIssueKey(issue.key)}
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
