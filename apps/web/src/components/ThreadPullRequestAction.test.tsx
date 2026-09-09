import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { ProjectId } from "@spiritdevs/contracts";
import { makeThreadFixture } from "../test-fixtures";
import { ThreadPullRequestAction } from "./ThreadPullRequestAction";

const mocks = vi.hoisted(() => ({ query: vi.fn(), open: vi.fn(), detach: vi.fn(), row: vi.fn() }));
vi.mock("../state/threadPullRequest", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/threadPullRequest")>()),
  useAttachedPullRequest: mocks.query,
}));
vi.mock("../lib/openPullRequestLink", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/openPullRequestLink")>()),
  useOpenPrLink: () => mocks.open,
}));
vi.mock("../state/entities", () => ({
  useProject: () => null,
  useServerConfigs: () =>
    new Map([
      [
        "environment-test",
        { environment: { capabilities: { threadPullRequestAttachments: true } } },
      ],
    ]),
}));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => mocks.detach }));
vi.mock("./chat/ThreadDetailsPrRow", () => ({
  ThreadDetailsPrRow: (props: {
    pr: { number: number };
    status: { tooltip: string };
    label: string;
  }) => {
    mocks.row(props);
    return (
      <span>
        {props.label} {props.status.tooltip}
      </span>
    );
  },
}));
const first = { number: 110, url: "https://github.com/SpiritDevs/pathway/pull/110" };
const second = { number: 111, url: "https://github.com/SpiritDevs/pathway/pull/111" };
const thread = {
  ...makeThreadFixture({ branch: "main" }),
  attachedPullRequest: second,
  attachedPullRequests: [first, second],
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.query.mockImplementation((target) => ({
    project: { id: ProjectId.make(`project-${target.attachedPullRequest.number}`) },
    data: {
      ...target.attachedPullRequest,
      title: "Feature",
      state: target.attachedPullRequest.number === 110 ? "merged" : "open",
      baseBranch: "main",
      headBranch: "feature",
      provider: "github",
      isDraft: false,
      checks: [],
    },
    error: null,
    isPending: false,
    refresh: vi.fn(),
  }));
});
describe("ThreadPullRequestAction", () => {
  it("stacks both PRs with their own states and actions", () => {
    const html = renderToStaticMarkup(<ThreadPullRequestAction thread={thread} isPanel />);
    expect(html).toContain("PR #110 - Merged");
    expect(html).toContain("PR #111 - Open");
    expect(mocks.row.mock.calls.map(([props]) => props.pr.number)).toEqual([110, 111]);
    expect(mocks.row.mock.calls.map(([props]) => props.project.id)).toEqual([
      "project-110",
      "project-111",
    ]);
  });
  it("deduplicates the branch PR and hides explicitly unlinked branch PRs", () => {
    const branch = {
      ...second,
      state: "open" as const,
      title: "Feature",
      headRef: "feature",
      baseRef: "main",
    };
    renderToStaticMarkup(
      <ThreadPullRequestAction thread={thread} isPanel branchPullRequest={branch} />,
    );
    expect(mocks.row).toHaveBeenCalledTimes(2);
    mocks.row.mockClear();
    renderToStaticMarkup(
      <ThreadPullRequestAction
        thread={{ ...thread, attachedPullRequests: [first], detachedPullRequestUrls: [second.url] }}
        isPanel
        branchPullRequest={branch}
      />,
    );
    expect(mocks.row.mock.calls.map(([props]) => props.pr.number)).toEqual([110]);
  });
  it("unlinks only the PR whose action was selected in its owning environment", () => {
    renderToStaticMarkup(<ThreadPullRequestAction thread={thread} isPanel />);
    const props = mocks.row.mock.calls[0]![0];
    expect(props.onUnlink).toBeTypeOf("function");
    props.onUnlink();
    expect(mocks.detach).toHaveBeenCalledExactlyOnceWith({
      environmentId: thread.environmentId,
      input: { threadId: thread.id, pullRequest: first },
    });
  });

  it("keeps a failed lookup visible and exposes the failure", () => {
    mocks.query.mockReturnValue({ data: null, error: "Permission denied", isPending: false });
    expect(renderToStaticMarkup(<ThreadPullRequestAction thread={thread} isPanel />)).toContain(
      "Permission denied",
    );
    expect(mocks.row).toHaveBeenCalledTimes(2);
  });
});
