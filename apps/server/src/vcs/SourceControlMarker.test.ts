import type { GitRunStackedActionResult } from "@spiritdevs/contracts";
import { describe, expect, it } from "@effect/vitest";

import { sourceControlMarkerFromGitResult } from "./SourceControlMarker.ts";

function result(overrides: Partial<GitRunStackedActionResult> = {}): GitRunStackedActionResult {
  return {
    action: "commit_push",
    branch: { status: "skipped_not_requested" },
    commit: { status: "created", commitSha: "abc123", subject: "Fix it" },
    push: { status: "pushed", branch: "feature" },
    pr: { status: "skipped_not_requested" },
    toast: { title: "Done", description: "Done", cta: { kind: "none" } },
    ...overrides,
  };
}

describe("sourceControlMarkerFromGitResult", () => {
  it("records a pushed commit", () => {
    expect(sourceControlMarkerFromGitResult(result())).toEqual({
      committed: true,
      commitSha: "abc123",
      pullRequest: null,
    });
  });

  it("attaches a newly-created pull request", () => {
    expect(
      sourceControlMarkerFromGitResult(
        result({
          action: "commit_push_pr",
          pr: {
            status: "created",
            number: 47,
            url: "https://github.com/SpiritDevs/pathway/pull/47",
          },
        }),
      ),
    ).toEqual({
      committed: true,
      commitSha: "abc123",
      pullRequest: { number: 47, url: "https://github.com/SpiritDevs/pathway/pull/47" },
    });
  });

  it("records a newly-created pull request even when no push step was needed", () => {
    expect(
      sourceControlMarkerFromGitResult(
        result({
          push: { status: "skipped_not_requested" },
          pr: {
            status: "created",
            number: 47,
            url: "https://github.com/SpiritDevs/pathway/pull/47",
          },
        }),
      ),
    ).toEqual({
      committed: true,
      commitSha: "abc123",
      pullRequest: { number: 47, url: "https://github.com/SpiritDevs/pathway/pull/47" },
    });
  });

  it("omits the sha when the push carried no new commit", () => {
    expect(
      sourceControlMarkerFromGitResult(result({ commit: { status: "skipped_no_changes" } })),
    ).toEqual({ committed: false, pullRequest: null });
  });

  it("does not record skipped pushes or existing pull requests", () => {
    expect(
      sourceControlMarkerFromGitResult(result({ push: { status: "skipped_not_requested" } })),
    ).toBeNull();
    expect(
      sourceControlMarkerFromGitResult(
        result({
          pr: {
            status: "opened_existing",
            number: 47,
            url: "https://github.com/SpiritDevs/pathway/pull/47",
          },
        }),
      ),
    ).toEqual({ committed: true, commitSha: "abc123", pullRequest: null });
  });
});
