import type { VcsStatusResult } from "@spiritdevs/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  attachedPrStatusIndicator,
  prStatusIndicator,
  resolveThreadPr,
  resolveThreadPrBadge,
  settledPrHoverColorClass,
} from "./ThreadStatusIndicators";

function status(overrides: Partial<VcsStatusResult> = {}): VcsStatusResult {
  return {
    isRepo: true,
    hasPrimaryRemote: true,
    isDefaultRef: false,
    refName: "feature/current",
    hasWorkingTreeChanges: false,
    workingTree: { files: [], insertions: 0, deletions: 0 },
    hasUpstream: true,
    aheadCount: 0,
    behindCount: 0,
    pr: {
      number: 42,
      title: "PR branch",
      url: "https://github.com/coreybain/pathway/pull/42",
      baseRef: "main",
      headRef: "feature/current",
      state: "open",
    },
    ...overrides,
  };
}

describe("resolveThreadPr", () => {
  it("keeps local-checkout PR indicators scoped to the stored thread branch", () => {
    expect(
      resolveThreadPr({
        threadBranch: "feature/other",
        gitStatus: status(),
      }),
    ).toBeNull();
  });

  it("hides PR indicators when a dedicated worktree has switched away from the thread branch", () => {
    expect(
      resolveThreadPr({
        threadBranch: "stack/base",
        gitStatus: status(),
      }),
    ).toBeNull();
  });

  it("hides PR indicators when thread branch metadata is missing", () => {
    expect(
      resolveThreadPr({
        threadBranch: null,
        gitStatus: status(),
      }),
    ).toBeNull();
  });

  it("shows the PR when the live checkout matches the stored thread branch", () => {
    const gitStatus = status();

    expect(
      resolveThreadPr({
        threadBranch: "feature/current",
        gitStatus,
      }),
    ).toBe(gitStatus.pr);
  });
});

describe("prStatusIndicator", () => {
  it("formats PR tooltips with number, uppercase status, and title", () => {
    expect(prStatusIndicator(status().pr, undefined)).toMatchObject({
      tooltip: "PR #42 - Open: PR branch",
      tooltipLead: "PR #42 - Open",
      tooltipTitle: "PR branch",
    });
  });

  it("uses red for closed pull requests", () => {
    const closedPr = status().pr;
    if (!closedPr) throw new Error("Expected pull request fixture");

    expect(prStatusIndicator({ ...closedPr, state: "closed" }, undefined)?.colorClass).toContain(
      "text-red-600",
    );
  });
});

describe("attachedPrStatusIndicator", () => {
  it("formats a manually attached pull request without inventing repository state", () => {
    expect(
      attachedPrStatusIndicator({
        number: 5153,
        url: "https://github.com/coreybain/pathway/pull/5153",
      }),
    ).toMatchObject({
      label: "PR attached",
      tooltip: "PR #5153 - Attached: Attached to thread",
      url: "https://github.com/coreybain/pathway/pull/5153",
    });
  });

  it("uses merge-request terminology for GitLab attachments", () => {
    expect(
      attachedPrStatusIndicator({
        number: 47,
        url: "https://gitlab.com/acme/repo/-/merge_requests/47",
      })?.label,
    ).toBe("MR attached");
  });
});

describe("resolveThreadPrBadge", () => {
  it("prefers an explicit attachment over a different branch-derived pull request", () => {
    const branchPullRequest = status().pr;
    expect(
      resolveThreadPrBadge({
        branchPullRequest,
        attachedPullRequest: {
          number: 5153,
          url: "https://github.com/coreybain/pathway/pull/5153",
        },
        provider: undefined,
      }),
    ).toMatchObject({
      pullRequest: { number: 5153 },
      status: { label: "PR attached" },
    });
  });

  it("retains live repository state when the explicit attachment matches the branch PR", () => {
    const branchPullRequest = status().pr;
    if (!branchPullRequest) throw new Error("Expected pull request fixture");

    expect(
      resolveThreadPrBadge({
        branchPullRequest,
        attachedPullRequest: branchPullRequest,
        provider: undefined,
      })?.status.label,
    ).toBe("PR open");
  });
});

describe("settledPrHoverColorClass", () => {
  it.each([
    ["open", "text-emerald-600"],
    ["merged", "text-violet-600"],
    ["closed", "text-red-600"],
  ] as const)("restores the %s pull request color on row hover", (state, colorClass) => {
    expect(settledPrHoverColorClass(state)).toContain(`group-hover/v2-row:${colorClass}`);
  });
});
