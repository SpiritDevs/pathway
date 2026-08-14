import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  deriveActivePullRequestReviewKeys,
  pullRequestReviewActivityKey,
} from "./pullRequestReviewActivity";

const ENVIRONMENT_ID = "environment-1" as EnvironmentId;
const PROJECT_ID = "project-1" as ProjectId;

function thread(
  overrides: Partial<EnvironmentThreadShell> = {},
): Pick<EnvironmentThreadShell, "deletedAt" | "environmentId" | "projectId" | "runtime" | "title"> {
  return {
    environmentId: ENVIRONMENT_ID,
    projectId: PROJECT_ID,
    title: "PR review · coreybain/pathway#4843",
    deletedAt: null,
    runtime: {
      status: "running",
      activeRunId: null,
      providerInstanceId: "provider-1" as EnvironmentThreadShell["providerInstanceId"],
      providerName: null,
      lastError: null,
      updatedAt: "2026-08-14T00:00:00Z",
    },
    ...overrides,
  };
}

describe("active pull request reviews", () => {
  const key = pullRequestReviewActivityKey({
    projectId: PROJECT_ID,
    repository: "coreybain/pathway",
    number: 4843,
  });

  it("identifies a running review thread", () => {
    expect(deriveActivePullRequestReviewKeys([thread()], ENVIRONMENT_ID)).toEqual(new Set([key]));
  });

  it("ignores settled, deleted, unrelated, and cross-environment threads", () => {
    expect(
      deriveActivePullRequestReviewKeys(
        [
          thread({ runtime: { ...thread().runtime!, status: "completed" } }),
          thread({ deletedAt: "2026-08-14T00:00:00Z" }),
          thread({ title: "Ordinary conversation" }),
          thread({ environmentId: "environment-2" as EnvironmentId }),
        ],
        ENVIRONMENT_ID,
      ),
    ).toEqual(new Set());
  });

  it("matches repository identity case-insensitively", () => {
    const keys = deriveActivePullRequestReviewKeys(
      [thread({ title: "PR review · COREYBAIN/PATHWAY#4843 · publish" })],
      ENVIRONMENT_ID,
    );
    expect(keys.has(key)).toBe(true);
  });
});
