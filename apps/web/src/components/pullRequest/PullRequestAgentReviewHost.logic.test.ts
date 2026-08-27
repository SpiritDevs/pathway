import type { EnvironmentThreadShell } from "@spiritdevs/client-runtime/state/models";
import { EnvironmentId, ProjectId, ThreadId } from "@spiritdevs/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  pullRequestReviewCanFinish,
  reconcilePullRequestReviewPublisherTargets,
  pullRequestReviewProcessingDisposition,
  type PullRequestReviewPublisherTarget,
} from "./PullRequestAgentReviewHost.logic";

function thread(input: {
  readonly id: string;
  readonly title: string;
  readonly runtimeStatus?: "running" | "settled";
  readonly deletedAt?: string | null;
  readonly updatedAt?: string;
}): EnvironmentThreadShell {
  return {
    environmentId: EnvironmentId.make("environment-1"),
    id: ThreadId.make(input.id),
    projectId: ProjectId.make("project-1"),
    title: input.title,
    deletedAt: input.deletedAt ?? null,
    updatedAt: input.updatedAt ?? "2026-08-27T00:00:00.000Z",
    runtime: { status: input.runtimeStatus ?? "running" },
  } as unknown as EnvironmentThreadShell;
}

describe("pull request review publisher targets", () => {
  it("waits for publishing activity but stages findings when that read fails", () => {
    expect(
      pullRequestReviewProcessingDisposition({
        activityAvailable: false,
        activityError: null,
      }),
    ).toBe("wait");
    expect(
      pullRequestReviewProcessingDisposition({
        activityAvailable: false,
        activityError: "Host unavailable",
      }),
    ).toBe("stage");
  });

  it("releases a settled review that completed without an assistant message", () => {
    expect(
      pullRequestReviewCanFinish({
        active: false,
        processedMessageIds: new Set(),
        latestRun: { assistantMessageId: null },
      }),
    ).toBe(true);
    expect(
      pullRequestReviewCanFinish({
        active: false,
        processedMessageIds: new Set(),
        latestRun: null,
      }),
    ).toBe(false);
    expect(
      pullRequestReviewCanFinish({
        active: true,
        processedMessageIds: new Set(["message-1"]),
        latestRun: { assistantMessageId: null },
      }),
    ).toBe(false);
    expect(
      pullRequestReviewCanFinish({
        active: false,
        processedMessageIds: new Set(["older-message"]),
        latestRun: { assistantMessageId: "latest-message" },
      }),
    ).toBe(false);
    expect(
      pullRequestReviewCanFinish({
        active: false,
        processedMessageIds: new Set(["latest-message"]),
        latestRun: { assistantMessageId: "latest-message" },
      }),
    ).toBe(true);
  });

  it("observes active publishing reviews and retains them after they settle", () => {
    const active = thread({
      id: "thread-1",
      title: "PR review · coreybaines/pathway#42 · publish",
    });

    const observed = reconcilePullRequestReviewPublisherTargets([active], []);
    expect(observed).toEqual([
      {
        environmentId: "environment-1",
        threadId: "thread-1",
        reference: {
          projectId: "project-1",
          repository: "coreybaines/pathway",
          number: 42,
        },
      },
    ]);

    expect(
      reconcilePullRequestReviewPublisherTargets(
        [{ ...active, runtime: { status: "settled" } } as unknown as EnvironmentThreadShell],
        observed,
      ),
    ).toEqual(observed);
  });

  it("restores only the latest settled publishing review for each pull request", () => {
    expect(
      reconcilePullRequestReviewPublisherTargets(
        [
          thread({
            id: "older-publisher",
            title: "PR review · coreybaines/pathway#40 · publish",
            runtimeStatus: "settled",
            updatedAt: "2026-08-26T00:00:00.000Z",
          }),
          thread({
            id: "latest-publisher",
            title: "PR review · coreybaines/pathway#40 · publish",
            runtimeStatus: "settled",
            updatedAt: "2026-08-27T00:00:00.000Z",
          }),
          thread({
            id: "latest-draft",
            title: "PR review · coreybaines/pathway#40",
            runtimeStatus: "settled",
          }),
        ],
        [],
      ),
    ).toEqual([
      {
        environmentId: "environment-1",
        threadId: "latest-publisher",
        reference: {
          projectId: "project-1",
          repository: "coreybaines/pathway",
          number: 40,
        },
      },
    ]);
  });

  it("releases a completed settled review but observes it again if its runtime restarts", () => {
    const settled = thread({
      id: "thread-1",
      title: "PR review · coreybaines/pathway#42 · publish",
      runtimeStatus: "settled",
    });
    const key = "environment-1\u0000thread-1";

    expect(reconcilePullRequestReviewPublisherTargets([settled], [], new Set([key]))).toEqual([]);
    expect(
      reconcilePullRequestReviewPublisherTargets(
        [{ ...settled, runtime: { status: "running" } } as unknown as EnvironmentThreadShell],
        [],
        new Set([key]),
      ),
    ).toHaveLength(1);
  });

  it("stops retaining a review when its thread is deleted", () => {
    const retained: PullRequestReviewPublisherTarget[] = [
      {
        environmentId: EnvironmentId.make("environment-1"),
        threadId: ThreadId.make("thread-1"),
        reference: {
          projectId: ProjectId.make("project-1"),
          repository: "coreybaines/pathway",
          number: 42,
        },
      },
    ];

    expect(
      reconcilePullRequestReviewPublisherTargets(
        [
          thread({
            id: "thread-1",
            title: "PR review · coreybaines/pathway#42 · publish",
            deletedAt: "2026-08-27T00:00:00.000Z",
          }),
        ],
        retained,
      ),
    ).toEqual([]);
    expect(reconcilePullRequestReviewPublisherTargets([], retained)).toEqual([]);
  });
});
