import type { EnvironmentThreadShell } from "@spiritdevs/client-runtime/state/models";
import { EnvironmentId, ProjectId, ThreadId } from "@spiritdevs/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  reconcilePullRequestReviewPublisherTargets,
  type PullRequestReviewPublisherTarget,
} from "./PullRequestAgentReviewHost.logic";

function thread(input: {
  readonly id: string;
  readonly title: string;
  readonly runtimeStatus?: "running" | "settled";
  readonly deletedAt?: string | null;
}): EnvironmentThreadShell {
  return {
    environmentId: EnvironmentId.make("environment-1"),
    id: ThreadId.make(input.id),
    projectId: ProjectId.make("project-1"),
    title: input.title,
    deletedAt: input.deletedAt ?? null,
    runtime: { status: input.runtimeStatus ?? "running" },
  } as unknown as EnvironmentThreadShell;
}

describe("pull request review publisher targets", () => {
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

  it("does not wake old settled reviews or draft-only reviews", () => {
    expect(
      reconcilePullRequestReviewPublisherTargets(
        [
          thread({
            id: "settled",
            title: "PR review · coreybaines/pathway#40 · publish",
            runtimeStatus: "settled",
          }),
          thread({ id: "draft", title: "PR review · coreybaines/pathway#41" }),
        ],
        [],
      ),
    ).toEqual([]);
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
  });
});
