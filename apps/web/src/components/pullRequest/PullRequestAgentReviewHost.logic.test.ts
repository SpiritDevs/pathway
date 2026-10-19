import type { EnvironmentThreadShell } from "@spiritdevs/client-runtime/state/models";
import { EnvironmentId, ProjectId, RunId, ThreadId } from "@spiritdevs/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  pullRequestReviewCanFinish,
  pullRequestReviewCompletionKey,
  readCompletedPullRequestReviewKeys,
  reconcilePullRequestReviewPublisherTargets,
  type PullRequestReviewPublisherTarget,
  writeCompletedPullRequestReviewKeys,
} from "./PullRequestAgentReviewHost.logic";

function thread(input: {
  readonly id: string;
  readonly title: string;
  readonly runtimeStatus?: "running" | "settled";
  readonly deletedAt?: string | null;
  readonly createdAt?: string;
  readonly runId?: string | null;
  readonly updatedAt?: string;
}): EnvironmentThreadShell {
  return {
    environmentId: EnvironmentId.make("environment-1"),
    id: ThreadId.make(input.id),
    projectId: ProjectId.make("project-1"),
    title: input.title,
    deletedAt: input.deletedAt ?? null,
    latestRun:
      input.runId === null
        ? null
        : {
            runId: RunId.make(input.runId ?? `${input.id}-run`),
          },
    createdAt: input.createdAt ?? "2026-08-27T00:00:00.000Z",
    updatedAt: input.updatedAt ?? "2026-08-27T00:00:00.000Z",
    runtime: { status: input.runtimeStatus ?? "running" },
  } as unknown as EnvironmentThreadShell;
}

describe("pull request review publisher targets", () => {
  it("persists completed review keys and treats malformed storage as empty", () => {
    let stored: string | null = null;
    const storage = {
      getItem: () => stored,
      setItem: (_key: string, value: string) => {
        stored = value;
      },
    };

    writeCompletedPullRequestReviewKeys(storage, new Set(["review-1", "review-2"]));
    expect(readCompletedPullRequestReviewKeys(storage)).toEqual(new Set(["review-1", "review-2"]));

    stored = "not json";
    expect(readCompletedPullRequestReviewKeys(storage)).toEqual(new Set());
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

  it("recovers every settled publishing review through one bounded slot", () => {
    const older = thread({
      id: "older-publisher",
      title: "PR review · coreybaines/pathway#40 · publish",
      runtimeStatus: "settled",
      createdAt: "2026-08-26T00:00:00.000Z",
    });
    const latest = thread({
      id: "latest-publisher",
      title: "PR review · coreybaines/pathway#40 · publish",
      runtimeStatus: "settled",
      createdAt: "2026-08-27T00:00:00.000Z",
    });
    const draft = thread({
      id: "latest-draft",
      title: "PR review · coreybaines/pathway#40",
      runtimeStatus: "settled",
    });

    expect(reconcilePullRequestReviewPublisherTargets([older, latest, draft], [])).toEqual([
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

    expect(
      reconcilePullRequestReviewPublisherTargets(
        [older, latest, draft],
        [],
        new Set(["environment-1\u0000latest-publisher\u0000latest-publisher-run"]),
      ),
    ).toEqual([
      {
        environmentId: "environment-1",
        threadId: "older-publisher",
        reference: {
          projectId: "project-1",
          repository: "coreybaines/pathway",
          number: 40,
        },
      },
    ]);
  });

  it("bounds settled recovery globally rather than mounting one publisher per pull request", () => {
    expect(
      reconcilePullRequestReviewPublisherTargets(
        [
          thread({
            id: "older-pr",
            title: "PR review · coreybaines/pathway#40 · publish",
            runtimeStatus: "settled",
            createdAt: "2026-08-26T00:00:00.000Z",
          }),
          thread({
            id: "newer-pr",
            title: "PR review · coreybaines/pathway#41 · publish",
            runtimeStatus: "settled",
            createdAt: "2026-08-27T00:00:00.000Z",
          }),
        ],
        [],
      ),
    ).toEqual([
      {
        environmentId: "environment-1",
        threadId: "newer-pr",
        reference: {
          projectId: "project-1",
          repository: "coreybaines/pathway",
          number: 41,
        },
      },
    ]);
  });

  it("does not recover another settled review while a retained review owns the recovery slot", () => {
    const retainedThread = thread({
      id: "retained-review",
      title: "PR review · coreybaines/pathway#40 · publish",
      runtimeStatus: "settled",
      createdAt: "2026-08-26T00:00:00.000Z",
    });
    const waitingThread = thread({
      id: "waiting-review",
      title: "PR review · coreybaines/pathway#41 · publish",
      runtimeStatus: "settled",
      createdAt: "2026-08-27T00:00:00.000Z",
    });
    const retained: PullRequestReviewPublisherTarget[] = [
      {
        environmentId: EnvironmentId.make("environment-1"),
        threadId: ThreadId.make("retained-review"),
        reference: {
          projectId: ProjectId.make("project-1"),
          repository: "coreybaines/pathway",
          number: 40,
        },
      },
    ];

    expect(
      reconcilePullRequestReviewPublisherTargets([retainedThread, waitingThread], retained),
    ).toEqual(retained);
  });

  it("skips a settled review with no run without blocking recoverable reviews", () => {
    const retained: PullRequestReviewPublisherTarget[] = [
      {
        environmentId: EnvironmentId.make("environment-1"),
        threadId: ThreadId.make("newer-no-run"),
        reference: {
          projectId: ProjectId.make("project-1"),
          repository: "coreybaines/pathway",
          number: 40,
        },
      },
    ];

    expect(
      reconcilePullRequestReviewPublisherTargets(
        [
          thread({
            id: "newer-no-run",
            title: "PR review · coreybaines/pathway#40 · publish",
            runtimeStatus: "settled",
            runId: null,
            createdAt: "2026-08-27T00:00:00.000Z",
          }),
          thread({
            id: "older-with-run",
            title: "PR review · coreybaines/pathway#41 · publish",
            runtimeStatus: "settled",
            createdAt: "2026-08-26T00:00:00.000Z",
          }),
        ],
        retained,
      ),
    ).toEqual([
      {
        environmentId: "environment-1",
        threadId: "older-with-run",
        reference: {
          projectId: "project-1",
          repository: "coreybaines/pathway",
          number: 41,
        },
      },
    ]);
  });

  it("releases a completed run but observes a later run completed by another client", () => {
    const settled = thread({
      id: "thread-1",
      title: "PR review · coreybaines/pathway#42 · publish",
      runtimeStatus: "settled",
      runId: "run-1",
    });
    const target = {
      environmentId: EnvironmentId.make("environment-1"),
      threadId: ThreadId.make("thread-1"),
    };
    const key = pullRequestReviewCompletionKey(target, RunId.make("run-1"));

    expect(reconcilePullRequestReviewPublisherTargets([settled], [], new Set([key]))).toEqual([]);
    expect(
      reconcilePullRequestReviewPublisherTargets(
        [
          {
            ...settled,
            latestRun: { runId: RunId.make("run-2") },
          } as unknown as EnvironmentThreadShell,
        ],
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
