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
    error?: string;
    mergeability?: PullRequestDetail["mergeability"];
  } = {},
) {
  return renderToStaticMarkup(
    <ThreadDetailsPrRow
      environmentId={EnvironmentId.make("test")}
      project={{ id: ProjectId.make("project") } as EnvironmentProject}
      pr={pr}
      status={prStatusIndicator(pr, undefined)!}
      label="PR #149"
      openAriaLabel="Open PR"
      onOpen={() => {}}
      detailQuery={{
        data: { ...detail, mergeability: options.mergeability ?? detail.mergeability },
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
