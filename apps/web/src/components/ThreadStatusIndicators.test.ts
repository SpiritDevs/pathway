import type { PullRequestCheckStatus, VcsStatusResult } from "@spiritdevs/contracts";
import { effectiveSettled } from "@spiritdevs/client-runtime/state/thread-settled";
import { makeThreadFixture } from "../test-fixtures";
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
  const attached = { number: 110, url: "https://github.com/SpiritDevs/pathway/pull/110" };
  const detail = {
    ...attached,
    title: "Keep location selection available",
    state: "open" as const,
    headBranch: "fix/location-auto-dropdown",
    baseBranch: "main",
    provider: "github" as const,
    isDraft: false,
    checks: [],
  };

  it("shows live status for an attached PR while the thread is on main", () => {
    const branchPullRequest = resolveThreadPr({ threadBranch: "main", gitStatus: status() });
    expect(
      resolveThreadPrBadge({
        branchPullRequest,
        attachedPullRequest: attached,
        attachedDetail: detail,
        provider: undefined,
      }),
    ).toMatchObject({
      changeRequestState: "open",
      status: { label: "PR open", colorClass: "text-emerald-600 dark:text-emerald-300/90" },
    });
  });

  it.each([
    ["pending", "PR checks pending", "text-amber-600"],
    ["failure", "PR checks failing", "text-red-600"],
    ["cancelled", "PR checks failing", "text-red-600"],
    ["success", "PR open", "text-emerald-600"],
  ] satisfies Array<[PullRequestCheckStatus, string, string]>)(
    "shows %s checks on the attached PR",
    (checkStatus, label, color) => {
      const badge = resolveThreadPrBadge({
        branchPullRequest: status().pr,
        attachedPullRequest: attached,
        attachedDetail: {
          ...detail,
          checks: [{ name: "CI", status: checkStatus, description: null, url: null }],
        },
        provider: undefined,
      });
      expect(badge?.status.label).toBe(label);
      expect(badge?.status.colorClass).toContain(color);
      expect(badge?.changeRequestState).toBe("open");
    },
  );

  it("feeds attached merge state into settlement while preserving the active-work blocker", () => {
    const badge = resolveThreadPrBadge({
      branchPullRequest: null,
      attachedPullRequest: attached,
      attachedDetail: { ...detail, state: "merged" },
      provider: undefined,
    });
    expect(badge?.status.colorClass).toContain("text-violet-600");
    const thread = makeThreadFixture({ branch: "main" });
    const options = {
      now: "2026-09-08T10:00:00Z",
      autoSettleAfterDays: null,
      changeRequestState: badge?.changeRequestState ?? null,
    };
    expect(effectiveSettled(thread, options)).toBe(true);
    expect(effectiveSettled({ ...thread, hasPendingApprovals: true }, options)).toBe(false);
    expect(effectiveSettled({ ...thread, settledOverride: "active" }, options)).toBe(false);
  });

  it("does not mistake an attachment replacement or detached PR for a merged thread", () => {
    const merged = { ...detail, state: "merged" as const };
    expect(
      resolveThreadPrBadge({
        branchPullRequest: null,
        attachedPullRequest: { ...attached, number: 111, url: attached.url.replace("110", "111") },
        attachedDetail: merged,
        provider: undefined,
      })?.changeRequestState,
    ).toBeNull();
    expect(
      resolveThreadPrBadge({
        branchPullRequest: null,
        attachedPullRequest: null,
        attachedDetail: merged,
        provider: undefined,
      }),
    ).toBeNull();
  });

  it("surfaces lookup failures and retains a last known state during refresh failures", () => {
    const input = {
      branchPullRequest: null,
      attachedPullRequest: attached,
      provider: undefined,
      attachedError: "GitHub is unavailable",
    };
    expect(resolveThreadPrBadge(input)).toMatchObject({
      changeRequestState: null,
      status: { label: "PR status unavailable", tooltip: "GitHub is unavailable" },
    });
    expect(resolveThreadPrBadge({ ...input, attachedDetail: detail })).toMatchObject({
      changeRequestState: "open",
      status: { tooltipTitle: expect.stringContaining("Status refresh failed") },
    });
  });

  it("uses the attached provider's terminology", () => {
    const attachment = {
      number: 110,
      url: "https://gitlab.com/SpiritDevs/pathway/-/merge_requests/110",
    };
    expect(
      resolveThreadPrBadge({
        branchPullRequest: null,
        attachedPullRequest: attachment,
        attachedDetail: { ...detail, ...attachment, provider: "gitlab" },
        provider: undefined,
      })?.status.label,
    ).toBe("MR open");
  });

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
      changeRequestState: null,
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
      }),
    ).toMatchObject({ status: { label: "PR open" }, changeRequestState: "open" });
  });

  it("reports lifecycle state for an automatically detected branch PR", () => {
    const branchPullRequest = status().pr;

    expect(
      resolveThreadPrBadge({
        branchPullRequest,
        attachedPullRequest: null,
        provider: undefined,
      })?.changeRequestState,
    ).toBe("open");
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

it("keeps GitLab terminology when attachment lookup fails", () => {
  const badge = resolveThreadPrBadge({
    attachedPullRequest: { number: 47, url: "https://gitlab.com/group/repo/-/merge_requests/47" },
    attachedError: "Permission denied",
    branchPullRequest: null,
    provider: undefined,
  });
  expect(badge?.status.label).toBe("MR status unavailable");
});
