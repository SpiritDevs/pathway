import type { EnvironmentId, PullRequestDetail } from "@spiritdevs/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { usePullRequestFindings } from "./usePullRequestFindings";

const { loadActivity, startHandoff, notify, buildTask, setPending } = vi.hoisted(() => ({
  loadActivity: vi.fn(),
  startHandoff: vi.fn(),
  notify: vi.fn(),
  buildTask: vi.fn(() => ({ prompt: "Fix the loaded findings" })),
  setPending: vi.fn(),
}));
vi.mock("react", () => ({
  useRef: (value: unknown) => ({ current: value }),
  useState: (value: unknown) => [value, setPending],
}));
vi.mock("~/state/pullRequests", () => ({ pullRequestEnvironment: { activity: vi.fn() } }));
vi.mock("~/state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => loadActivity }));
vi.mock("../ui/toast", () => ({ toastManager: { add: notify } }));
vi.mock("./pullRequestDetail.logic", () => ({ buildFixFindingsHandoff: buildTask }));
vi.mock("@spiritdevs/client-runtime/state/runtime", () => ({
  squashAtomCommandFailure: () => new Error("Activity unavailable"),
}));

const detail = {
  projectId: "project-1",
  repository: "example/project",
  number: 42,
  title: "Fix editor",
  url: "https://github.com/example/project/pull/42",
  headBranch: "fix-editor",
  baseBranch: "main",
  checks: [],
  comments: [],
  reviewThreads: [],
  commentsTruncated: false,
} as unknown as PullRequestDetail;
const activity = {
  comments: [{ body: "Please fix this" }],
  reviewThreads: [{ id: "thread-1" }],
  commentsTruncated: true,
};
const setup = () =>
  usePullRequestFindings({
    environmentId: "remote-environment" as EnvironmentId,
    detail,
    startHandoff,
  });

beforeEach(() => {
  vi.clearAllMocks();
  loadActivity.mockReset();
  startHandoff.mockResolvedValue(undefined);
});

describe("pull request findings loading", () => {
  it("does not load activity when mounted", () => {
    setup();
    expect(loadActivity).not.toHaveBeenCalled();
    expect(startHandoff).not.toHaveBeenCalled();
  });

  it("waits for activity in the selected environment and ignores duplicate requests", async () => {
    let finish!: (result: unknown) => void;
    loadActivity.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const { start } = setup();
    const pending = start();
    await start();
    expect(loadActivity).toHaveBeenCalledExactlyOnceWith({
      environmentId: "remote-environment",
      input: { projectId: "project-1", repository: "example/project", number: 42 },
    });
    expect(startHandoff).not.toHaveBeenCalled();
    finish({ _tag: "Success", value: activity });
    await pending;
    expect(buildTask).toHaveBeenCalledWith(expect.objectContaining(activity));
    expect(startHandoff).toHaveBeenCalledExactlyOnceWith("findings", {
      prompt: "Fix the loaded findings",
    });
    expect(setPending.mock.calls).toEqual([[true], [false]]);
  });

  it.each(["failure", "rejection"])(
    "does not start an empty handoff after %s and allows retry",
    async (failure) => {
      if (failure === "failure") loadActivity.mockResolvedValueOnce({ _tag: "Failure" });
      else loadActivity.mockRejectedValueOnce(new Error("Disconnected"));
      const { start } = setup();
      await start();
      expect(startHandoff).not.toHaveBeenCalled();
      expect(notify).toHaveBeenCalledWith(expect.objectContaining({ type: "error" }));
      loadActivity.mockResolvedValueOnce({ _tag: "Success", value: activity });
      await start();
      expect(startHandoff).toHaveBeenCalledTimes(1);
    },
  );
});
