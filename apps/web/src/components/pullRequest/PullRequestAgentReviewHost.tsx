import { scopeThreadRef } from "@spiritdevs/client-runtime/environment";
import { threadRuntimeIsActive } from "@spiritdevs/client-runtime/state/models";
import { deriveLatestThreadRun } from "@spiritdevs/client-runtime/state/thread-execution";
import { pullRequestAgentReviewMarkerIds } from "@spiritdevs/shared/pullRequestReview";
import { useCallback, useEffect, useRef, useState } from "react";

import { useThreadProjection, useThreadShell, useThreadShells } from "~/state/entities";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { toastManager } from "../ui/toast";
import {
  reconcilePullRequestReviewPublisherTargets,
  pullRequestReviewCanFinish,
  pullRequestReviewProcessingDisposition,
  pullRequestReviewPublisherTargetKey,
  type PullRequestReviewPublisherTarget,
} from "./PullRequestAgentReviewHost.logic";
import {
  agentReviewSummary,
  markedAgentReviewFindings,
  reviewCommentBodyWithMarker,
} from "./pullRequestAgentReview.logic";
import { stageAgentReviewFindings } from "./pullRequestReviewStore";

function PullRequestAgentReviewPublisher({
  target,
  onFinished,
}: {
  readonly target: PullRequestReviewPublisherTarget;
  readonly onFinished: (target: PullRequestReviewPublisherTarget) => void;
}) {
  const threadRef = scopeThreadRef(target.environmentId, target.threadId);
  const shell = useThreadShell(threadRef);
  const projection = useThreadProjection(threadRef);
  const {
    data: activity,
    error: activityError,
    refresh: refreshActivity,
  } = useEnvironmentQuery(
    pullRequestEnvironment.activity({
      environmentId: target.environmentId,
      input: target.reference,
    }),
  );
  const submitReview = useAtomCommand(pullRequestEnvironment.submitReview, {
    reportFailure: false,
  });
  const processedMessageIds = useRef(new Set<string>());
  const publishing = useRef(false);
  const [processingVersion, setProcessingVersion] = useState(0);

  useEffect(() => {
    if (projection === null || publishing.current) return;
    const active = shell !== null && threadRuntimeIsActive(shell.runtime);
    const latestRun = deriveLatestThreadRun(projection.projection);
    const finishIfComplete = () => {
      if (
        pullRequestReviewCanFinish({
          active,
          processedMessageIds: processedMessageIds.current,
          latestRun,
        })
      ) {
        onFinished(target);
      }
    };
    const messages = projection.projection.messages.filter(
      (message) =>
        message.role === "assistant" &&
        !message.streaming &&
        !processedMessageIds.current.has(message.id),
    );
    if (messages.length === 0) {
      finishIfComplete();
      return;
    }
    const disposition = pullRequestReviewProcessingDisposition({
      activityAvailable: activity !== null,
      activityError,
    });
    if (disposition === "wait") return;

    const alreadyPublished = new Set(
      activity?.reviewThreads.flatMap((thread) =>
        thread.comments.flatMap((comment) => [...pullRequestAgentReviewMarkerIds(comment.body)]),
      ) ?? [],
    );
    const prepared = messages.map((message) => {
      const marked = markedAgentReviewFindings({
        text: message.text,
        threadId: target.threadId,
        messageId: message.id,
      });
      processedMessageIds.current.add(message.id);
      return {
        message,
        findings: marked.filter(({ markerId }) => !alreadyPublished.has(markerId)),
      };
    });
    const findingCount = prepared.reduce((count, entry) => count + entry.findings.length, 0);

    if (disposition === "stage") {
      for (const { message, findings } of prepared) {
        if (findings.length > 0) {
          stageAgentReviewFindings({
            reference: target.reference,
            messageText: message.text,
            findings,
          });
        }
      }
      if (findingCount > 0) {
        toastManager.add({
          type: "error",
          title: "The agent review could not be published",
          description: "Its findings are still available as drafts in Code.",
        });
      }
      finishIfComplete();
      return;
    }

    if (findingCount === 0) {
      finishIfComplete();
      return;
    }

    publishing.current = true;
    void (async () => {
      let reviewSynced = false;
      let stagedCount = 0;
      for (const { message, findings } of prepared) {
        if (findings.length === 0) continue;
        const result = await submitReview({
          environmentId: target.environmentId,
          input: {
            ...target.reference,
            verdict: "comment",
            body: agentReviewSummary(message.text),
            comments: findings.map(({ finding, markerId }) => ({
              path: finding.path,
              ...(finding.oldPath === undefined ? {} : { oldPath: finding.oldPath }),
              line: finding.line,
              side: finding.side,
              body: reviewCommentBodyWithMarker(finding.body, markerId),
            })),
          },
        });
        if (result._tag === "Failure") {
          stageAgentReviewFindings({
            reference: target.reference,
            messageText: message.text,
            findings,
          });
          stagedCount += findings.length;
        } else {
          reviewSynced = true;
        }
      }
      publishing.current = false;
      setProcessingVersion((version) => version + 1);
      if (stagedCount > 0) {
        toastManager.add({
          type: "error",
          title: "The agent review could not be published",
          description: "Its findings are still available as drafts in Code.",
        });
      }
      if (reviewSynced && stagedCount === 0) {
        toastManager.add({
          type: "success",
          title: "Agent review synced",
          description: "Inline findings are available on the pull request.",
        });
        refreshActivity();
      }
    })();
  }, [
    activity,
    activityError,
    onFinished,
    processingVersion,
    projection,
    refreshActivity,
    shell,
    submitReview,
    target,
  ]);

  return null;
}

/** Keeps pull-request publishing alive independently of whichever route or tab is visible. */
export function PullRequestAgentReviewHost() {
  const threads = useThreadShells();
  const [targets, setTargets] = useState<ReadonlyArray<PullRequestReviewPublisherTarget>>([]);
  const [completedThreadKeys, setCompletedThreadKeys] = useState<ReadonlySet<string>>(new Set());

  const finishTarget = useCallback((target: PullRequestReviewPublisherTarget) => {
    const key = pullRequestReviewPublisherTargetKey(target);
    setCompletedThreadKeys((current) => new Set(current).add(key));
    setTargets((current) =>
      current.filter((candidate) => pullRequestReviewPublisherTargetKey(candidate) !== key),
    );
  }, []);

  useEffect(() => {
    const activeThreadKeys = new Set(
      threads
        .filter((thread) => threadRuntimeIsActive(thread.runtime))
        .map((thread) => `${thread.environmentId}\u0000${thread.id}`),
    );
    setCompletedThreadKeys((current) => {
      if (![...current].some((key) => activeThreadKeys.has(key))) return current;
      return new Set([...current].filter((key) => !activeThreadKeys.has(key)));
    });
  }, [threads]);

  useEffect(() => {
    setTargets((current) =>
      reconcilePullRequestReviewPublisherTargets(threads, current, completedThreadKeys),
    );
  }, [completedThreadKeys, threads]);

  return targets.map((target) => (
    <PullRequestAgentReviewPublisher
      key={`${target.environmentId}:${target.threadId}`}
      onFinished={finishTarget}
      target={target}
    />
  ));
}
