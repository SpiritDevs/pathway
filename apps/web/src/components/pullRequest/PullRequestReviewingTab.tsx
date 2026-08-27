import { scopeThreadRef } from "@spiritdevs/client-runtime/environment";
import type { EnvironmentId, PullRequestRef, ThreadId } from "@spiritdevs/contracts";
import { CodeIcon, MessageSquareIcon } from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useRef } from "react";

import { DiffWorkerPoolProvider } from "~/components/DiffWorkerPoolProvider";
import { useThreadProjection, useThreadShell } from "~/state/entities";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { markedAgentReviewFindings } from "./pullRequestAgentReview.logic";
import { stageAgentReviewFindings, usePendingReviewComments } from "./pullRequestReviewStore";

// ChatView imports the pull-request panel for thread-side PR tabs. Loading it synchronously from
// this panel would make that dependency circular; the review tab is already an on-demand surface.
const ReviewChatView = lazy(() => import("../ChatView"));

export function PullRequestReviewingTab({
  environmentId,
  threadId,
  reference,
  publishComments,
  codeAvailable,
  onOpenCode,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly reference: PullRequestRef;
  readonly publishComments: boolean;
  readonly codeAvailable: boolean;
  readonly onOpenCode: () => void;
}) {
  const threadRef = useMemo(
    () => scopeThreadRef(environmentId, threadId),
    [environmentId, threadId],
  );
  const shell = useThreadShell(threadRef);
  const projection = useThreadProjection(threadRef);
  const processedMessageIds = useRef(new Set<string>());
  const pendingComments = usePendingReviewComments(reference);

  useEffect(() => {
    processedMessageIds.current = new Set();
  }, [threadId]);

  useEffect(() => {
    if (projection === null || publishComments) return;
    for (const message of projection.projection.messages) {
      if (
        message.role !== "assistant" ||
        message.streaming ||
        processedMessageIds.current.has(message.id)
      ) {
        continue;
      }
      const marked = markedAgentReviewFindings({
        text: message.text,
        threadId,
        messageId: message.id,
      });
      if (marked.length === 0) {
        processedMessageIds.current.add(message.id);
        continue;
      }
      processedMessageIds.current.add(message.id);

      stageAgentReviewFindings({ reference, messageText: message.text, findings: marked });
      toastManager.add({
        type: "success",
        title: `${marked.length} agent ${marked.length === 1 ? "finding" : "findings"} ready in Code`,
      });
    }
  }, [projection, publishComments, reference, threadId]);

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
      <div className="flex min-h-0 flex-1 overflow-hidden">
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
