/**
 * The investigation panel — see `docs/internals/decisions/0006-issue-tracker.md`.
 *
 * The Investigation tab inside the issue detail sheet. An enrichment run is not a thread: it has
 * no turns, it cannot be replied to, and it belongs to the issue it was fired from. Putting it
 * anywhere the threads view can reach would make it look like one.
 *
 * The transcript is a live log, republished whole every 250ms by the server, so the scroller
 * follows the tail only while the reader is already at it — the check is latched on the reader's
 * own scroll rather than recomputed from a `scrollHeight` that every append changes.
 *
 * @module components/issues/IssueEnrichmentPanel
 */
import type {
  Issue,
  IssueEnrichmentRun,
  IssueEnrichmentRunId,
  IssueLabel,
  IssueLabelId,
  IssuePriority,
} from "@spiritdevs/contracts";
import {
  ArrowDownIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  CircleAlertIcon,
  FileIcon,
  PlusIcon,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { IssueLabelDot, IssuePriorityIcon } from "./IssueGlyphs";
import {
  ISSUE_ENRICHMENT_STATE_LABELS,
  hasIssueEnrichmentSuggestions,
  issueEnrichmentRunPresentation,
  latestIssueEnrichmentRun,
  resolveIssueSuggestedDescription,
  resolveIssueSuggestedLabels,
  resolveIssueSuggestedTitle,
  shouldFollowIssueTranscript,
  type IssueEnrichmentTone,
  type IssueSuggestedRewrite,
} from "./issueEnrichment.logic";
import { ISSUE_PRIORITY_LABELS } from "./issuesList.logic";

/** How often the duration on a live run is redrawn. Seconds are the smallest unit it prints. */
const DURATION_TICK_MS = 1000;

const TONE_CLASS: Readonly<Record<IssueEnrichmentTone, string>> = {
  pending: "border-border/60 text-muted-foreground",
  active: "border-primary/40 bg-primary/10 text-primary",
  done: "border-border/60 text-muted-foreground",
  failed: "border-destructive/40 bg-destructive/10 text-destructive-foreground",
};

function RunStateBadge({ run, nowMs }: { run: IssueEnrichmentRun; nowMs: number }) {
  const presentation = issueEnrichmentRunPresentation(run, nowMs);
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-px text-[11px]",
        TONE_CLASS[presentation.tone],
      )}
    >
      {presentation.isActive ? (
        <span
          aria-hidden
          className="size-1.5 shrink-0 animate-pulse rounded-full bg-current motion-reduce:animate-none"
        />
      ) : null}
      {presentation.label}
    </span>
  );
}

/**
 * The log. A plain scroller rather than `ScrollArea`: this one needs its own `onScroll` and its
 * own `scrollTop` write on every batch, and reaching through a styled wrapper for both is more
 * moving parts than the border it would save.
 */
function TranscriptScroller({ transcript }: { transcript: string }) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const [following, setFollowing] = useState(true);

  // Layout effect: the write lands in the same frame the new text paints in, so a followed
  // transcript never shows a scrollbar jump.
  useLayoutEffect(() => {
    if (!following) return;
    const scroller = scrollerRef.current;
    if (scroller === null) return;
    scroller.scrollTop = scroller.scrollHeight;
  }, [following, transcript]);

  return (
    <div className="relative min-h-0">
      <div
        className="max-h-72 min-h-24 overflow-y-auto rounded-md border border-border/60 bg-muted/24 p-2"
        onScroll={(event) => {
          const scroller = event.currentTarget;
          setFollowing(
            shouldFollowIssueTranscript({
              scrollTop: scroller.scrollTop,
              scrollHeight: scroller.scrollHeight,
              clientHeight: scroller.clientHeight,
            }),
          );
        }}
        ref={scrollerRef}
      >
        <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-foreground/80">
          {transcript.length === 0 ? "Waiting for the first output…" : transcript}
        </pre>
      </div>
      {following ? null : (
        <Button
          className="absolute bottom-2 end-2 shadow-sm"
          onClick={() => setFollowing(true)}
          size="xs"
          variant="outline"
        >
          <ArrowDownIcon />
          Follow
        </Button>
      )}
    </div>
  );
}

/**
 * The one control a rewrite card carries. Three states, and only one of them is a press: a tick
 * for a suggestion the issue already reads, and a greyed Apply carrying its reason for one the
 * field is not open to — the same greyed-with-a-title treatment a deleted label chip gets. Saying
 * "Applied" for that second case is the thing this is careful not to do.
 */
function RewriteApplyButton({
  blockedReason,
  className,
  onApply,
  rewrite,
}: {
  blockedReason: string;
  className?: string;
  onApply: (text: string) => void;
  rewrite: IssueSuggestedRewrite;
}) {
  const applied = rewrite.state === "applied";
  return (
    <Button
      className={cn("shrink-0", className)}
      disabled={rewrite.state !== "applicable"}
      onClick={() => onApply(rewrite.text)}
      size="xs"
      title={rewrite.state === "blocked" ? blockedReason : undefined}
      variant="outline"
    >
      {applied ? <CheckIcon /> : <PlusIcon />}
      {applied ? "Applied" : "Apply"}
    </Button>
  );
}

function Suggestions({
  issue,
  labels,
  run,
  onApplyDescription,
  onApplyLabel,
  onApplyPriority,
  onApplyTitle,
}: {
  issue: Issue;
  labels: ReadonlyArray<IssueLabel>;
  run: IssueEnrichmentRun;
  onApplyDescription: (description: string) => void;
  onApplyLabel: (labelId: IssueLabelId) => void;
  onApplyPriority: (priority: IssuePriority) => void;
  onApplyTitle: (title: string) => void;
}) {
  const result = run.result;
  if (result === null) return null;
  // The row stands while anything it names is still outstanding, and the ones already taken stay
  // on it with a tick: half a suggestion set applied should still read as a set.
  if (!hasIssueEnrichmentSuggestions(result, issue, labels)) return null;
  const suggestedLabels = resolveIssueSuggestedLabels(
    result.suggestedLabels,
    labels,
    issue.labelIds,
  );
  const priority = result.suggestedPriority;
  const priorityApplied = priority !== null && priority === issue.priority;
  // Generic system titles and empty descriptions are applied by the server. Any title still
  // pressable here needs confirmation; a description can remain blocked if the user filled it
  // while the investigation was running.
  const suggestedTitle = resolveIssueSuggestedTitle(result, issue);
  const suggestedDescription = resolveIssueSuggestedDescription(result, issue);

  return (
    <section className="flex flex-col gap-1.5">
      <h4 className="text-[11px] font-medium text-muted-foreground">Suggestions</h4>
      {suggestedTitle === null ? null : (
        <div className="flex items-start gap-2 rounded-md border border-border/60 bg-muted/24 p-2">
          <div className="min-w-0 flex-1">
            <h5 className="text-[11px] font-medium text-muted-foreground">Title</h5>
            <p className="mt-0.5 break-words text-[13px] text-foreground">{suggestedTitle.text}</p>
          </div>
          <RewriteApplyButton
            blockedReason="Review this title before replacing the current one."
            onApply={onApplyTitle}
            rewrite={suggestedTitle}
          />
        </div>
      )}
      {suggestedDescription === null ? null : (
        <div className="flex flex-col gap-1 rounded-md border border-border/60 bg-muted/24 p-2">
          <div className="flex items-center gap-2">
            <h5 className="text-[11px] font-medium text-muted-foreground">Description</h5>
            <RewriteApplyButton
              blockedReason="This issue already has a description. Applying would overwrite it."
              className="ms-auto"
              onApply={onApplyDescription}
              rewrite={suggestedDescription}
            />
          </div>
          {/* Markdown, up to 8000 characters of it: clamped and scrolled rather than let loose
              down the panel, the same way the transcript is. */}
          <div className="max-h-56 overflow-y-auto">
            <ChatMarkdown
              className="text-[13px]"
              cwd={undefined}
              text={suggestedDescription.text}
            />
          </div>
        </div>
      )}
      {priority === null && suggestedLabels.length === 0 ? null : (
        <div className="flex flex-wrap items-center gap-1.5">
          {priority === null ? null : (
            <button
              className={cn(
                "flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[11px] outline-none focus-visible:ring-2 focus-visible:ring-ring",
                priorityApplied
                  ? "border-border/60 text-muted-foreground"
                  : "border-border hover:bg-accent/60",
              )}
              disabled={priorityApplied}
              onClick={() => onApplyPriority(priority)}
              type="button"
            >
              <IssuePriorityIcon priority={priority} />
              {ISSUE_PRIORITY_LABELS[priority]}
              {priorityApplied ? (
                <CheckIcon className="size-3 text-primary" />
              ) : (
                <PlusIcon className="size-3" />
              )}
            </button>
          )}
          {suggestedLabels.map((suggestion) => {
            const label = suggestion.label;
            // A name with no row behind it is shown, greyed: the tracker filtered the run's
            // vocabulary before storing it, so this only happens when the label was since deleted.
            const disabled = label === null || suggestion.applied;
            return (
              <button
                className={cn(
                  "flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[11px] outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  disabled
                    ? "border-border/60 text-muted-foreground"
                    : "border-border hover:bg-accent/60",
                )}
                disabled={disabled}
                key={suggestion.name}
                onClick={() => {
                  if (label !== null) onApplyLabel(label.id);
                }}
                title={label === null ? "That label no longer exists." : undefined}
                type="button"
              >
                {label === null ? null : <IssueLabelDot className="size-1.5" color={label.color} />}
                {suggestion.name}
                {suggestion.applied ? (
                  <CheckIcon className="size-3 text-primary" />
                ) : label === null ? null : (
                  <PlusIcon className="size-3" />
                )}
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}

function RunResult({
  issue,
  issuesByKey,
  labels,
  run,
  onApplyDescription,
  onApplyLabel,
  onApplyPriority,
  onApplyTitle,
  onOpenIssueKey,
}: {
  issue: Issue;
  issuesByKey: ReadonlyMap<string, Issue>;
  labels: ReadonlyArray<IssueLabel>;
  run: IssueEnrichmentRun;
  onApplyDescription: (description: string) => void;
  onApplyLabel: (labelId: IssueLabelId) => void;
  onApplyPriority: (priority: IssuePriority) => void;
  onApplyTitle: (title: string) => void;
  onOpenIssueKey: (issueKey: string) => void;
}) {
  const result = run.result;
  if (result === null) return null;

  return (
    <div className="flex flex-col gap-3">
      {result.summary.trim().length === 0 ? null : (
        <section className="flex flex-col gap-1">
          <h4 className="text-[11px] font-medium text-muted-foreground">Summary</h4>
          <ChatMarkdown className="text-[13px]" cwd={undefined} text={result.summary} />
        </section>
      )}

      {result.likelyFiles.length === 0 ? null : (
        <section className="flex flex-col gap-1">
          <h4 className="text-[11px] font-medium text-muted-foreground">Likely files</h4>
          <ul className="flex flex-col gap-1">
            {result.likelyFiles.map((file) => (
              <li className="flex items-start gap-1.5 text-[12px]" key={file.path}>
                <FileIcon className="mt-0.5 size-3 shrink-0 text-muted-foreground" />
                <span className="min-w-0">
                  <span className="break-all font-mono text-[11px] text-foreground">
                    {file.path}
                  </span>
                  {file.reason.trim().length === 0 ? null : (
                    <span className="text-muted-foreground"> — {file.reason}</span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {result.relatedIssueKeys.length === 0 ? null : (
        <section className="flex flex-col gap-1">
          <h4 className="text-[11px] font-medium text-muted-foreground">Related issues</h4>
          <div className="flex flex-wrap gap-1.5">
            {result.relatedIssueKeys.map((key) => {
              const related = issuesByKey.get(key) ?? null;
              return (
                <button
                  className="flex max-w-full items-center gap-1 rounded-full border border-border/60 px-1.5 py-0.5 text-[11px] outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 disabled:hover:bg-transparent"
                  disabled={related === null}
                  key={key}
                  onClick={() => onOpenIssueKey(key)}
                  title={related === null ? "No issue here carries that key." : related.title}
                  type="button"
                >
                  <span className="font-mono">{key}</span>
                  {related === null ? null : (
                    <span className="max-w-40 truncate text-muted-foreground">{related.title}</span>
                  )}
                </button>
              );
            })}
          </div>
        </section>
      )}

      <Suggestions
        issue={issue}
        labels={labels}
        onApplyDescription={onApplyDescription}
        onApplyLabel={onApplyLabel}
        onApplyPriority={onApplyPriority}
        onApplyTitle={onApplyTitle}
        run={run}
      />
    </div>
  );
}

export interface IssueEnrichmentPanelProps {
  readonly issue: Issue;
  readonly labels: ReadonlyArray<IssueLabel>;
  /** Every issue in the tracker, keyed by key, for the related-issue chips. */
  readonly issuesByKey: ReadonlyMap<string, Issue>;
  /** Newest first, from `useIssueEnrichmentRuns`. */
  readonly runs: ReadonlyArray<IssueEnrichmentRun>;
  readonly isPending: boolean;
  readonly error: string | null;
  readonly onCancel: (runId: IssueEnrichmentRunId) => void;
  readonly onApplyLabel: (labelId: IssueLabelId) => void;
  readonly onApplyPriority: (priority: IssuePriority) => void;
  /** A title left outstanding by server-side automatic application. */
  readonly onApplyTitle: (title: string) => void;
  /** Only reachable while the issue's description is still empty. */
  readonly onApplyDescription: (description: string) => void;
  readonly onOpenIssueKey: (issueKey: string) => void;
}

export function IssueEnrichmentPanel({
  issue,
  labels,
  issuesByKey,
  runs,
  isPending,
  error,
  onCancel,
  onApplyLabel,
  onApplyPriority,
  onApplyTitle,
  onApplyDescription,
  onOpenIssueKey,
}: IssueEnrichmentPanelProps) {
  // Null follows the newest run, which is what a panel opened mid-investigation should show. A
  // press on a history row pins that one until the reader presses another.
  const [pinnedRunId, setPinnedRunId] = useState<IssueEnrichmentRunId | null>(null);
  const [expandedTranscriptRunId, setExpandedTranscriptRunId] =
    useState<IssueEnrichmentRunId | null>(null);
  const selected = runs.find((run) => run.id === pinnedRunId) ?? latestIssueEnrichmentRun(runs);
  const presentation =
    selected === null ? null : issueEnrichmentRunPresentation(selected, Date.now());
  const isActive = presentation?.isActive ?? false;
  const transcriptExpanded = selected !== null && expandedTranscriptRunId === selected.id;

  // Only while something is running: a finished run's duration is a fixed subtraction, and a
  // timer left running behind a closed panel is the kind of thing this codebase audits for.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!isActive) return;
    const timer = window.setInterval(() => setNowMs(Date.now()), DURATION_TICK_MS);
    return () => window.clearInterval(timer);
  }, [isActive]);

  const durationLabel =
    selected === null ? null : issueEnrichmentRunPresentation(selected, nowMs).durationLabel;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 py-3">
        {selected === null ? (
          <p className="text-[13px] text-muted-foreground">
            {isPending
              ? "Loading investigations…"
              : (error ??
                "No investigation has been run on this issue yet. Press Investigate to start one.")}
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <RunStateBadge nowMs={nowMs} run={selected} />
              <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">
                {selected.modelSelection.model}
              </span>
              {durationLabel === null ? null : (
                <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                  {durationLabel}
                </span>
              )}
              <span className="shrink-0 text-[11px] text-muted-foreground/70">
                {formatRelativeTimeLabel(selected.createdAt)}
              </span>
              {presentation?.isActive ? (
                <Button
                  className="ms-auto"
                  onClick={() => onCancel(selected.id)}
                  size="xs"
                  variant="outline"
                >
                  Cancel
                </Button>
              ) : selected.state === "done" ? (
                <Button
                  aria-controls={`issue-investigation-transcript-${selected.id}`}
                  aria-expanded={transcriptExpanded}
                  className="ms-auto"
                  onClick={() =>
                    setExpandedTranscriptRunId((current) =>
                      current === selected.id ? null : selected.id,
                    )
                  }
                  size="xs"
                  variant="ghost"
                >
                  {transcriptExpanded ? <ChevronUpIcon /> : <ChevronDownIcon />}
                  {transcriptExpanded ? "Hide output" : "Show output"}
                </Button>
              ) : null}
            </div>

            {selected.state === "queued" && selected.transcript.length === 0 ? (
              <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
                <Spinner className="size-3.5" />
                Waiting for a slot. One investigation runs at a time.
              </p>
            ) : selected.state !== "done" || transcriptExpanded ? (
              <div id={`issue-investigation-transcript-${selected.id}`}>
                <TranscriptScroller transcript={selected.transcript} />
              </div>
            ) : (
              <div hidden id={`issue-investigation-transcript-${selected.id}`} />
            )}

            {selected.state === "failed" && selected.error !== null ? (
              <p className="flex items-start gap-1.5 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-[12px] text-destructive-foreground">
                <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
                <span className="min-w-0 break-words">{selected.error}</span>
              </p>
            ) : null}

            {selected.state === "done" ? (
              <RunResult
                issue={issue}
                issuesByKey={issuesByKey}
                labels={labels}
                onApplyDescription={onApplyDescription}
                onApplyLabel={onApplyLabel}
                onApplyPriority={onApplyPriority}
                onApplyTitle={onApplyTitle}
                onOpenIssueKey={onOpenIssueKey}
                run={selected}
              />
            ) : null}

            {runs.length < 2 ? null : (
              <section className="flex flex-col gap-1 border-t border-border/50 pt-2">
                <h4 className="text-[11px] font-medium text-muted-foreground">Past runs</h4>
                <ul className="flex flex-col">
                  {runs.map((run) => (
                    <li key={run.id}>
                      <button
                        aria-current={run.id === selected.id}
                        className={cn(
                          "flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-start text-[11px] outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring",
                          run.id === selected.id && "bg-accent/60",
                        )}
                        onClick={() => setPinnedRunId(run.id)}
                        type="button"
                      >
                        <span className="w-20 shrink-0 text-muted-foreground">
                          {ISSUE_ENRICHMENT_STATE_LABELS[run.state]}
                        </span>
                        <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground/80">
                          {run.modelSelection.model}
                        </span>
                        <span className="shrink-0 text-muted-foreground/70">
                          {formatRelativeTimeLabel(run.createdAt)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
