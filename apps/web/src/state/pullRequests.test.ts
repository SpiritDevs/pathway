import type { EnvironmentId, ProjectId, PullRequestListResult } from "@spiritdevs/contracts";
import { describe, expect, it } from "vite-plus/test";

import { combinePullRequestListResults } from "./pullRequests";

const env = (value: string) => value as EnvironmentId;
const project = (value: string) => value as ProjectId;

function result(overrides: Partial<PullRequestListResult> = {}): PullRequestListResult {
  return {
    viewers: { "github.com": "corey" },
    providers: [
      {
        host: "github.com",
        kind: "github",
        searchesOnHost: true,
        projectCount: 1,
        configured: true,
        detail: null,
      },
    ],
    entries: [
      {
        provider: "github",
        host: "github.com",
        projectId: project("project-1"),
        projectTitle: "Pathway",
        repository: "spiritdevs/pathway",
        number: 34,
        title: "Keep source-control markers after their turns",
        url: "https://github.com/spiritdevs/pathway/pull/34",
        author: { login: "corey", name: null, avatarUrl: null },
        headBranch: "fix/markers",
        baseBranch: "main",
        state: "open",
        isDraft: false,
        mergeability: "mergeable",
        additions: 0,
        deletions: 0,
        createdAt: "2026-08-20T00:00:00.000Z",
        updatedAt: "2026-08-21T00:00:00.000Z",
        viewerReviewRequested: false,
        labels: [],
      },
    ],
    errors: [],
    truncated: true,
    nextCursors: { "github.com spiritdevs/pathway": "next" },
    ...overrides,
  };
}

describe("multi-environment pull request lists", () => {
  it("deduplicates one hosted PR while retaining the preferred environment source", () => {
    const primary = env("primary");
    const remote = env("remote");
    const combined = combinePullRequestListResults([
      { target: { environmentId: primary }, data: result() },
      {
        target: { environmentId: remote },
        data: result({ viewers: { "github.com": "remote-user" } }),
      },
    ]);

    expect(combined.entries).toHaveLength(1);
    expect(combined.entries[0]?.environmentId).toBe(primary);
    expect(combined.entries[0]?.viewerLogin).toBe("corey");
  });

  it("namespaces continuation cursors so each environment receives only its own", () => {
    const combined = combinePullRequestListResults([
      { target: { environmentId: env("primary") }, data: result() },
      { target: { environmentId: env("remote") }, data: result() },
    ]);

    expect(Object.keys(combined.nextCursors)).toEqual([
      "primary\u0000github.com spiritdevs/pathway",
      "remote\u0000github.com spiritdevs/pathway",
    ]);
  });
});
