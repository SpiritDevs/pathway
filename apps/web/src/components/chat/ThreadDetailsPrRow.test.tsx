import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId, type PullRequestDetail } from "@spiritdevs/contracts";
import type { EnvironmentProject } from "@spiritdevs/client-runtime/state/shell";
import { ThreadDetailsPrRow } from "./ThreadDetailsPrRow";
import { prStatusIndicator } from "../ThreadStatusIndicators";

vi.mock("~/state/entities", () => ({
  useServerConfigs: () =>
    new Map([["test", { environment: { capabilities: { pullRequests: true } } }]]),
}));
vi.mock("../pullRequest/usePullRequestActions", () => ({
  usePullRequestActionRunner: () => ({ actionPending: false, perform: vi.fn() }),
  usePullRequestHandoffs: () => ({ handoff: null, startHandoff: vi.fn() }),
}));

const pr = {
  number: 149,
  url: "https://github.com/example/repo/pull/149",
  title: "Fix refresh",
  state: "open" as const,
  headRef: "feature",
  baseRef: "main",
};
const detail: PullRequestDetail = {
  ...pr,
  projectId: ProjectId.make("project"),
  projectTitle: "Project",
  workspaceRoot: "/project",
  repository: "example/repo",
  provider: "github",
  body: "",
  author: { login: "maintainer", name: null, avatarUrl: null },
  isDraft: false,
  mergeability: "conflicting",
  headBranch: "feature",
  baseBranch: "main",
  additions: 1,
  deletions: 0,
  changedFiles: 1,
  createdAt: "2026-09-12T00:00:00Z",
  updatedAt: "2026-09-12T00:00:00Z",
  mergedAt: null,
  closedAt: null,
  reviewers: [],
  labels: [],
  checks: [],
  capabilities: {
    actions: ["merge"],
    mergeMethods: ["merge"],
    diff: true,
    comment: false,
    search: true,
    review: { inlineComment: false, reply: false, resolve: false, verdicts: [] },
    reviewers: { request: false, listCandidates: false },
  },
  viewerPermissions: {
    actions: ["merge"],
    comment: false,
    resolve: false,
    verdicts: [],
    requestReviewers: false,
  },
  mergeCapabilities: { merge: true, squash: false, rebase: false },
};
function render(
  options: {
    pending?: boolean;
    checks?: PullRequestDetail["checks"];
    state?: PullRequestDetail["state"];
    prState?: PullRequestDetail["state"];
    isDraft?: boolean;
    error?: string;
    mergeability?: PullRequestDetail["mergeability"];
  } = {},
) {
  const currentDetail = {
    ...detail,
    mergeability: options.mergeability ?? detail.mergeability,
    checks: options.checks ?? [],
    state: options.state ?? detail.state,
    isDraft: options.isDraft ?? false,
  };
  const currentPr = { ...pr, state: options.prState ?? currentDetail.state };
  return renderToStaticMarkup(
    <ThreadDetailsPrRow
      environmentId={EnvironmentId.make("test")}
      project={{ id: ProjectId.make("project") } as EnvironmentProject}
      pr={currentPr}
      status={prStatusIndicator(currentPr, undefined, currentDetail)!}
      label="PR #149"
      openAriaLabel="Open PR"
      onOpen={() => {}}
      detailQuery={{
        data: currentDetail,
        isPending: options.pending ?? false,
        error: options.error ?? null,
        refresh: vi.fn(),
      }}
    />,
  );
}

it("shows the conflict only when its check has succeeded", () => {
  expect(render()).toContain("Merge conflicts");
  const checking = render({ pending: true });
  expect(checking).toContain("Checking merge status…");
  expect(checking).not.toContain("Merge conflicts");
  expect(checking).not.toContain(">Resolve<");
});

it("qualifies retained conflict data after failure and offers retry", () => {
  const failed = render({ error: "Host unavailable" });
  expect(failed).toContain("Couldn’t refresh status");
  expect(failed).toContain("Retry");
  expect(failed).not.toContain("Merge conflicts");
});

it("keeps unknown mergeability checking and enables merge after recovery", () => {
  const unknown = render({ mergeability: "unknown" });
  expect(unknown).toContain("Checking merge status…");
  expect(unknown).not.toContain(">Merge<");
  const recovered = render({ mergeability: "mergeable" });
  expect(recovered).toContain(">Merge<");
  expect(recovered).not.toContain("Checking merge status…");
  expect(recovered).not.toContain("Couldn’t refresh status");
});

const failedCheck = {
  name: "Vercel – quotecloud-v2",
  status: "failure" as const,
  description: "Cannot deploy from a private GitHub organization repository on the Hobby plan",
  url: null,
};

it("uses the sidebar failure colour and visibly explains the failing check", () => {
  const html = render({ mergeability: "mergeable", checks: [failedCheck] });
  expect(html).toMatch(/<svg[^>]*class="[^"]*text-red-600/);
  expect(html).not.toContain("text-emerald");
  expect(html).toContain(">1 check failing</span>");
  expect(html).toContain(failedCheck.name);
  expect(html).toContain(failedCheck.description);
});

it("shows pending checks and preserves draft glyphs with check-aware colour", () => {
  const html = render({ isDraft: true, checks: [{ ...failedCheck, status: "pending" }] });
  expect(html).toContain("1 check pending");
  expect(html).toMatch(/<svg[^>]*class="[^"]*text-amber-600/);
  expect(html).toContain("lucide-git-pull-request-draft");
});

it("counts cancelled checks as failing consistently with the sidebar", () => {
  const html = render({
    checks: [failedCheck, { ...failedCheck, name: "Tests", status: "cancelled" }],
  });
  expect(html).toContain("2 checks failing");
  expect(html).toContain(">Tests</span>");
});

it("removes the failure notice when checks pass or the PR merges", () => {
  for (const html of [
    render({ checks: [{ ...failedCheck, status: "success" }] }),
    render({ checks: [failedCheck], state: "merged" }),
  ]) {
    expect(html).not.toContain("check failing");
    expect(html).not.toContain(failedCheck.description);
    expect(html).not.toContain("text-red-600");
  }
});

it("uses an effective merged state when cached detail is still open", () => {
  const html = render({ checks: [failedCheck], isDraft: true, prState: "merged" });
  expect(html).toContain("lucide-git-merge");
  expect(html).not.toContain("lucide-git-pull-request-draft");
  expect(html).not.toContain("check failing");
  expect(html).not.toContain(failedCheck.description);
  expect(html).not.toContain("text-red-600");
});
