import { EnvironmentId, ProjectId } from "@spiritdevs/contracts";
import { Atom, AtomRegistry, AsyncResult } from "effect/unstable/reactivity";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  attachedPullRequestQueryTarget,
  liveAttachedPullRequestDetail,
  sameAttachedPullRequest,
} from "./threadPullRequest";

const mocks = vi.hoisted(() => ({ detail: vi.fn() }));
vi.mock("./pullRequests", () => ({ pullRequestEnvironment: { detail: mocks.detail } }));

const thread = {
  environmentId: EnvironmentId.make("remote-environment"),
  projectId: ProjectId.make("project"),
  attachedPullRequest: { number: 110, url: "https://github.com/SpiritDevs/pathway/pull/110" },
};

afterEach(() => vi.useRealTimers());

describe("attached pull request lookup", () => {
  it("uses the thread's environment and the attached repository and number without a branch", () => {
    expect(attachedPullRequestQueryTarget(thread)).toEqual({
      environmentId: thread.environmentId,
      input: { projectId: thread.projectId, repository: "spiritdevs/pathway", number: 110 },
    });
  });

  it("does not query after detaching or when there is no project", () => {
    expect(attachedPullRequestQueryTarget({ ...thread, attachedPullRequest: null })).toBeNull();
    expect(attachedPullRequestQueryTarget({ ...thread, projectId: null })).toBeNull();
    expect(attachedPullRequestQueryTarget(null)).toBeNull();
  });

  it("compares repository, host and number while allowing URL fragments and casing", () => {
    const attachment = thread.attachedPullRequest;
    expect(
      sameAttachedPullRequest(attachment, {
        ...attachment,
        url: attachment.url.toLowerCase() + "#discussion",
      }),
    ).toBe(true);
    expect(
      sameAttachedPullRequest(attachment, {
        ...attachment,
        url: attachment.url.replace("github.com", "github.example.com"),
      }),
    ).toBe(false);
    expect(
      sameAttachedPullRequest(attachment, {
        ...attachment,
        url: attachment.url.replace("pathway", "other"),
      }),
    ).toBe(false);
    expect(
      sameAttachedPullRequest(attachment, {
        number: 111,
        url: attachment.url.replace("110", "111"),
      }),
    ).toBe(false);
  });

  it("shares refreshes across consumers and stops polling after the last observer leaves", async () => {
    vi.useFakeTimers();
    let state = "open";
    const read = vi.fn(() => AsyncResult.success({ ...thread.attachedPullRequest, state }));
    const source = Atom.make(read).pipe(Atom.setIdleTTL("5 minutes"));
    mocks.detail.mockReturnValue(source);
    const target = attachedPullRequestQueryTarget(thread)!;
    const atom = liveAttachedPullRequestDetail(target);
    expect(liveAttachedPullRequestDetail({ ...target, input: { ...target.input } })).toBe(atom);
    const registry = AtomRegistry.make();
    try {
      const unsubscribeSidebar = registry.subscribe(atom, () => {});
      const unsubscribePanel = registry.subscribe(atom, () => {});
      expect(registry.get(atom)).toMatchObject({ value: { state: "open" } });
      expect(read).toHaveBeenCalledTimes(1);
      state = "merged";
      await vi.advanceTimersByTimeAsync(30_000);
      expect(read).toHaveBeenCalledTimes(2);
      expect(registry.get(atom)).toMatchObject({ value: { state: "merged" } });
      unsubscribeSidebar();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(read).toHaveBeenCalledTimes(3);
      unsubscribePanel();
      await vi.advanceTimersByTimeAsync(90_000);
      expect(read).toHaveBeenCalledTimes(3);
    } finally {
      registry.dispose();
    }
  });
});
