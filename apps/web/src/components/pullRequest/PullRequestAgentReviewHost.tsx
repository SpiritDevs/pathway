import { scopeThreadRef } from "@spiritdevs/client-runtime/environment";
import { threadRuntimeIsActive } from "@spiritdevs/client-runtime/state/models";
import { deriveLatestThreadRun } from "@spiritdevs/client-runtime/state/thread-execution";
import type { RunId } from "@spiritdevs/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useThreadProjection, useThreadShell, useThreadShells } from "~/state/entities";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { useAtomCommand } from "~/state/use-atom-command";
import { toastManager } from "../ui/toast";
import {
  addCompletedPullRequestReviewKey,
  readCompletedPullRequestReviewKeys,
  reconcilePullRequestReviewPublisherTargets,
  pullRequestReviewCanFinish,
  pullRequestReviewCompletionKey,
  pullRequestReviewPublisherTargetKey,
  type PullRequestReviewPublisherTarget,
  writeCompletedPullRequestReviewKeys,
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
  readonly onFinished: (
    target: PullRequestReviewPublisherTarget,
    runId: RunId,
    completion: "durable" | "session",
  ) => void;
}) {
  const threadRef = scopeThreadRef(target.environmentId, target.threadId);
  const shell = useThreadShell(threadRef);
  const projection = useThreadProjection(threadRef);
  const submitReview = useAtomCommand(pullRequestEnvironment.submitReview, {
    reportFailure: false,
  });
  const processedMessageIds = useRef(new Set<string>());
  const requiresRetry = useRef(false);
  const publishing = useRef(false);
  const [processingVersion, setProcessingVersion] = useState(0);

  useEffect(() => {
    if (projection === null || publishing.current) return;
    const active = shell !== null && threadRuntimeIsActive(shell.runtime);
    const latestRun = deriveLatestThreadRun(projection.projection);
    const finishIfComplete = () => {
      if (
        latestRun !== null &&
        pullRequestReviewCanFinish({
          active,
          processedMessageIds: processedMessageIds.current,
          latestRun,
        })
      ) {
        onFinished(target, latestRun.runId, requiresRetry.current ? "session" : "durable");
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
    const prepared = messages.map((message) => {
      const marked = markedAgentReviewFindings({
        text: message.text,
        threadId: target.threadId,
        messageId: message.id,
      });
      processedMessageIds.current.add(message.id);
      return {
        message,
        findings: marked,
      };
    });
    const findingCount = prepared.reduce((count, entry) => count + entry.findings.length, 0);

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
          requiresRetry.current = true;
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
      }
    })();
  }, [onFinished, processingVersion, projection, shell, submitReview, target]);

  return null;
}

function completionStorage(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

/** Keeps pull-request publishing alive independently of whichever route or tab is visible. */
export function PullRequestAgentReviewHost() {
  const threads = useThreadShells();
  const [targets, setTargets] = useState<ReadonlyArray<PullRequestReviewPublisherTarget>>([]);
  const [sessionCompletedThreadKeys, setSessionCompletedThreadKeys] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [durableCompletedThreadKeys, setDurableCompletedThreadKeys] = useState<ReadonlySet<string>>(
    () => readCompletedPullRequestReviewKeys(completionStorage()),
  );
  const completedThreadKeys = useMemo(
    () => new Set([...sessionCompletedThreadKeys, ...durableCompletedThreadKeys]),
    [durableCompletedThreadKeys, sessionCompletedThreadKeys],
  );

  const finishTarget = useCallback(
    (target: PullRequestReviewPublisherTarget, runId: RunId, completion: "durable" | "session") => {
      const targetKey = pullRequestReviewPublisherTargetKey(target);
      const completionKey = pullRequestReviewCompletionKey(target, runId);
      setSessionCompletedThreadKeys((current) =>
        addCompletedPullRequestReviewKey(current, completionKey),
      );
      if (completion === "durable") {
        setDurableCompletedThreadKeys((current) =>
          addCompletedPullRequestReviewKey(current, completionKey),
        );
      }
      setTargets((current) =>
        current.filter((candidate) => pullRequestReviewPublisherTargetKey(candidate) !== targetKey),
      );
    },
    [],
  );

  useEffect(() => {
    writeCompletedPullRequestReviewKeys(completionStorage(), durableCompletedThreadKeys);
  }, [durableCompletedThreadKeys]);

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
