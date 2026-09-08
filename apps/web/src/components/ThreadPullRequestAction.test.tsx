import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { makeThreadFixture } from "../test-fixtures";
import { ThreadPullRequestAction } from "./ThreadPullRequestAction";

const mocks = vi.hoisted(() => ({ query: vi.fn(), open: vi.fn() }));
vi.mock("../state/threadPullRequest", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/threadPullRequest")>()),
  useAttachedPullRequest: mocks.query,
}));
vi.mock("../lib/openPullRequestLink", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/openPullRequestLink")>()),
  useOpenPrLink: () => mocks.open,
}));

const attachment = { number: 110, url: "https://github.com/SpiritDevs/pathway/pull/110" };
const thread = { ...makeThreadFixture({ branch: "main" }), attachedPullRequest: attachment };
const detail = {
  ...attachment,
  title: "Location selection",
  state: "merged",
  baseBranch: "main",
  headBranch: "feature",
  provider: "github",
  isDraft: false,
  checks: [],
};

beforeEach(() => mocks.query.mockReturnValue({ data: detail, error: null, isPending: false }));

describe("ThreadPullRequestAction", () => {
  it.each([true, false])(
    "shows the attached PR and its merged state in panel mode %s",
    (isPanel) => {
      const html = renderToStaticMarkup(
        <ThreadPullRequestAction thread={thread} isPanel={isPanel} />,
      );
      expect(html).toContain("PR #110");
      expect(html).toContain("Merged");
      expect(html).toContain("text-violet-600");
    },
  );

  it("shows a lookup failure without presenting the attachment as a successful PR", () => {
    mocks.query.mockReturnValue({ data: null, error: "Permission denied", isPending: false });
    const html = renderToStaticMarkup(<ThreadPullRequestAction thread={thread} isPanel />);
    expect(html).toContain("Status unavailable");
    expect(html).toContain("Permission denied");
    expect(html).toContain("text-amber-600");
  });

  it("removes the row when the PR is detached", () => {
    expect(
      renderToStaticMarkup(
        <ThreadPullRequestAction thread={{ ...thread, attachedPullRequest: null }} isPanel />,
      ),
    ).toBe("");
  });
});
