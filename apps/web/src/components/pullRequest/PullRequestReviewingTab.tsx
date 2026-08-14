import { scopeThreadRef } from "@spiritdevs/client-runtime/environment";
import type {
  EnvironmentId,
  PullRequestRef,
  PullRequestReviewThread,
  ThreadId,
} from "@spiritdevs/contracts";
import { CodeIcon, MessageSquareIcon } from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useRef } from "react";

import { DiffWorkerPoolProvider } from "~/components/DiffWorkerPoolProvider";
import { useThreadProjection, useThreadShell } from "~/state/entities";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import {
  agentReviewCommentMarkerId,
  agentReviewSummary,
  parseAgentReviewFindings,
  reviewCommentBodyWithMarker,
} from "./pullRequestAgentReview.logic";
import {
  pullRequestReviewKey,
  usePendingReviewComments,
  usePullRequestReviewStore,
} from "./pullRequestReviewStore";

// ChatView imports the pull-request panel for thread-side PR tabs. Loading it synchronously from
// this panel would make that dependency circular; the review tab is already an on-demand surface.
const ReviewChatView = lazy(() => import("../ChatView"));

function publishedMarkerIds(threads: ReadonlyArray<PullRequestReviewThread>): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const comment of threads.flatMap((thread) => thread.comments)) {
    for (const match of comment.body.matchAll(/<!-- (pathway-agent-review:[^\s>]+) -->/gu)) {
      if (match[1]) ids.add(match[1]);
    }
  }
  return ids;
}

export function PullRequestReviewingTab({
  environmentId,
  threadId,
  reference,
  reviewThreads,
  publishComments,
  canPublishComments,
  codeAvailable,
  activityState,
  onOpenCode,
  onPublished,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly reference: PullRequestRef;
  readonly reviewThreads: ReadonlyArray<PullRequestReviewThread>;
  readonly publishComments: boolean;
  readonly canPublishComments: boolean;
  readonly codeAvailable: boolean;
  readonly activityState: "pending" | "ready" | "unavailable";
  readonly onOpenCode: () => void;
  readonly onPublished: () => void;
}) {
  const threadRef = useMemo(
    () => scopeThreadRef(environmentId, threadId),
    [environmentId, threadId],
  );
  const shell = useThreadShell(threadRef);
  const projection = useThreadProjection(threadRef);
  const processedMessageIds = useRef(new Set<string>());
  const reviewKey = pullRequestReviewKey(reference);
  const pendingComments = usePendingReviewComments(reference);
  const submitReview = useAtomCommand(pullRequestEnvironment.submitReview, {
    reportFailure: false,
  });

  useEffect(() => {
    processedMessageIds.current = new Set();
  }, [threadId]);

  useEffect(() => {
    if (projection === null) return;
    // A restored publishing review must first see the host activity that can prove which marker
    // ids are already there. Otherwise opening the tab after a reload would post them twice.
    if (publishComments && canPublishComments && activityState === "pending") return;
    const alreadyPublished = publishedMarkerIds(reviewThreads);
    for (const message of projection.projection.messages) {
      if (
        message.role !== "assistant" ||
        message.streaming ||
        processedMessageIds.current.has(message.id)
      ) {
        continue;
      }
      const findings = parseAgentReviewFindings(message.text);
      if (findings.length === 0) {
        processedMessageIds.current.add(message.id);
        continue;
      }
      const marked = findings.map((finding) => ({
        finding,
        markerId: agentReviewCommentMarkerId({
          threadId,
          messageId: message.id,
          findingIndex: finding.index,
        }),
      }));
      const newFindings = marked.filter(({ markerId }) => !alreadyPublished.has(markerId));
      processedMessageIds.current.add(message.id);
      if (newFindings.length === 0) continue;

      const stage = (announce = true) => {
        const store = usePullRequestReviewStore.getState();
        for (const { finding, markerId } of newFindings) {
          store.addComment(reviewKey, {
            id: markerId,
            path: finding.path,
            ...(finding.oldPath === undefined ? {} : { oldPath: finding.oldPath }),
            line: finding.line,
            side: finding.side,
            body: finding.body,
          });
        }
        const summary = agentReviewSummary(message.text);
        if (summary.length > 0 && (store.summaries[reviewKey] ?? "").trim().length === 0) {
          store.setSummary(reviewKey, summary);
        }
        if (announce) {
          toastManager.add({
            type: "success",
            title: `${newFindings.length} agent ${newFindings.length === 1 ? "finding" : "findings"} ready in Code`,
          });
        }
      };

      if (!publishComments || !canPublishComments || activityState === "unavailable") {
        stage();
        continue;
      }

      void (async () => {
        const result = await submitReview({
          environmentId,
          input: {
            ...reference,
            verdict: "comment",
            body: agentReviewSummary(message.text),
            comments: newFindings.map(({ finding, markerId }) => ({
              path: finding.path,
              ...(finding.oldPath === undefined ? {} : { oldPath: finding.oldPath }),
              line: finding.line,
              side: finding.side,
              body: reviewCommentBodyWithMarker(finding.body, markerId),
            })),
          },
        });
        if (result._tag === "Failure") {
          stage(false);
          toastManager.add({
            type: "error",
            title: "The agent review could not be published",
            description: "Its findings are still available as drafts in Code.",
          });
          return;
        }
        toastManager.add({
          type: "success",
          title: "Agent review published",
          description: `${newFindings.length} inline ${newFindings.length === 1 ? "comment" : "comments"} posted.`,
        });
        onPublished();
      })();
    }
  }, [
    activityState,
    canPublishComments,
    environmentId,
    onPublished,
    projection,
    publishComments,
    reference,
    reviewKey,
    reviewThreads,
    submitReview,
    threadId,
  ]);

  if (shell === null) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
        <Spinner className="size-4" />
        Opening the review conversation…
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border/60 bg-muted/15 px-4 py-2 text-xs text-muted-foreground">
        <MessageSquareIcon className="size-3.5" />
        <span className="min-w-0 flex-1 truncate">
          {!codeAvailable && !publishComments
            ? "Findings stay in this conversation because this host has no inline diff support."
            : publishComments
              ? "Actionable findings are published as inline review comments."
              : pendingComments.length === 0
                ? "Agent findings will appear as draft comments in Code."
                : `${pendingComments.length} draft ${pendingComments.length === 1 ? "comment is" : "comments are"} ready in Code.`}
        </span>
        {codeAvailable ? (
          <Button size="xs" variant="ghost" onClick={onOpenCode}>
            <CodeIcon className="size-3" />
            Code
          </Button>
        ) : null}
      </div>
      <div className="min-h-0 flex-1">
        <DiffWorkerPoolProvider>
          <Suspense
            fallback={
              <div className="flex h-full items-center justify-center">
                <Spinner className="size-4" />
              </div>
            }
          >
            <ReviewChatView
              environmentId={environmentId}
              panelOwnerThreadRef={threadRef}
              presentation="panel"
              reserveTitleBarControlInset={false}
              routeKind="server"
              threadId={threadId}
            />
          </Suspense>
        </DiffWorkerPoolProvider>
      </div>
    </div>
  );
}
