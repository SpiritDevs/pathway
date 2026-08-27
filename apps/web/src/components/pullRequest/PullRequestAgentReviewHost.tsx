import { scopeThreadRef } from "@spiritdevs/client-runtime/environment";
import type { PullRequestReviewThread } from "@spiritdevs/contracts";
import { useEffect, useRef, useState } from "react";

import { useThreadProjection, useThreadShells } from "~/state/entities";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { toastManager } from "../ui/toast";
import {
  reconcilePullRequestReviewPublisherTargets,
  type PullRequestReviewPublisherTarget,
} from "./PullRequestAgentReviewHost.logic";
import {
  agentReviewCommentMarkerId,
  agentReviewSummary,
  parseAgentReviewFindings,
  reviewCommentBodyWithMarker,
} from "./pullRequestAgentReview.logic";
import { pullRequestReviewKey, usePullRequestReviewStore } from "./pullRequestReviewStore";

function publishedMarkerIds(threads: ReadonlyArray<PullRequestReviewThread>): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const comment of threads.flatMap((thread) => thread.comments)) {
    for (const match of comment.body.matchAll(/<!-- (pathway-agent-review:[^\s>]+) -->/gu)) {
      if (match[1]) ids.add(match[1]);
    }
  }
  return ids;
}

function PullRequestAgentReviewPublisher({
  target,
}: {
  readonly target: PullRequestReviewPublisherTarget;
}) {
  const projection = useThreadProjection(scopeThreadRef(target.environmentId, target.threadId));
  const { data: activity, refresh: refreshActivity } = useEnvironmentQuery(
    pullRequestEnvironment.activity({
      environmentId: target.environmentId,
      input: target.reference,
    }),
  );
  const submitReview = useAtomCommand(pullRequestEnvironment.submitReview, {
    reportFailure: false,
  });
  const processedMessageIds = useRef(new Set<string>());

  useEffect(() => {
    if (projection === null || activity === null) return;
    const alreadyPublished = publishedMarkerIds(activity.reviewThreads);
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
          threadId: target.threadId,
          messageId: message.id,
          findingIndex: finding.index,
        }),
      }));
      const newFindings = marked.filter(({ markerId }) => !alreadyPublished.has(markerId));
      processedMessageIds.current.add(message.id);
      if (newFindings.length === 0) continue;

      void (async () => {
        const result = await submitReview({
          environmentId: target.environmentId,
          input: {
            ...target.reference,
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
          const store = usePullRequestReviewStore.getState();
          const reviewKey = pullRequestReviewKey(target.reference);
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
        refreshActivity();
      })();
    }
  }, [activity, projection, refreshActivity, submitReview, target]);

  return null;
}

/** Keeps pull-request publishing alive independently of whichever route or tab is visible. */
export function PullRequestAgentReviewHost() {
  const threads = useThreadShells();
  const [targets, setTargets] = useState<ReadonlyArray<PullRequestReviewPublisherTarget>>([]);

  useEffect(() => {
    setTargets((current) => reconcilePullRequestReviewPublisherTargets(threads, current));
  }, [threads]);

  return targets.map((target) => (
    <PullRequestAgentReviewPublisher
      key={`${target.environmentId}:${target.threadId}`}
      target={target}
    />
  ));
}
