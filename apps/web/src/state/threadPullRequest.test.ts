import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EnvironmentId, ProjectId } from "@spiritdevs/contracts";
import { Atom, AtomRegistry, AsyncResult } from "effect/unstable/reactivity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  attachedPullRequestQueryTarget,
  aggregateThreadPullRequestState,
  attachedPullRequestsAtom,
  currentThreadChangeRequestState,
  threadChangeRequestSource,
  useAttachedPullRequest,
  liveAttachedPullRequestDetail,
  sameAttachedPullRequest,
} from "./threadPullRequest";

const mocks = vi.hoisted(() => ({ detail: vi.fn(), environment: vi.fn(), query: vi.fn() }));
vi.mock("./environments", () => ({ useEnvironment: mocks.environment }));
vi.mock("./query", () => ({ useEnvironmentQuery: mocks.query }));
beforeEach(() => {
  vi.clearAllMocks();
  mocks.environment.mockReturnValue(null);
  mocks.query.mockReturnValue({ data: null, error: null, isPending: false });
});
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

describe("attachment lifecycle cache", () => {
  const original = { ...thread, branch: "main", worktreePath: null };
  const cached = { source: threadChangeRequestSource(original), state: "merged" as const };

  it("invalidates merged state in the parent even when the settled row is unmounted", () => {
    expect(currentThreadChangeRequestState(original, cached)).toBe("merged");
    for (const changed of [
      { ...original, attachedPullRequest: null },
      {
        ...original,
        attachedPullRequest: {
          number: 111,
          url: original.attachedPullRequest.url.replace("110", "111"),
        },
      },
      { ...original, projectId: ProjectId.make("other") },
      { ...original, branch: "other" },
      { ...original, worktreePath: "/another-checkout" },
    ]) {
      expect(currentThreadChangeRequestState(changed, cached)).toBeNull();
    }
  });
});

function QueryObserver({ target, poll = false }: { target: typeof thread; poll?: boolean }) {
  useAttachedPullRequest(target, { poll });
  return null;
}

describe("attachment query subscriptions", () => {
  it.each([
    null,
    { descriptor: {} },
    { descriptor: { capabilities: {} } },
    { descriptor: { capabilities: { pullRequests: false } } },
  ])("does not probe environments without advertised pull request support: %j", (environment) => {
    mocks.environment.mockReturnValue(environment);
    renderToStaticMarkup(createElement(QueryObserver, { target: thread, poll: true }));
    expect(mocks.detail).not.toHaveBeenCalled();
    expect(mocks.query).toHaveBeenCalledWith(null);
  });

  it("only periodically refreshes the focused PR while 50 sidebar attachments stay mounted", async () => {
    vi.useFakeTimers();
    mocks.environment.mockReturnValue({ descriptor: { capabilities: { pullRequests: true } } });
    const reads = vi.fn();
    const source = Atom.family((number: number) =>
      Atom.make(() => {
        reads(number);
        return AsyncResult.success({ ...thread.attachedPullRequest, number });
      }).pipe(Atom.setIdleTTL("5 minutes")),
    );
    mocks.detail.mockImplementation((target) => source(target.input.number));
    const registry = AtomRegistry.make();
    const unsubscribes: (() => void)[] = [];
    const observe = (poll: boolean, number: number) => {
      renderToStaticMarkup(
        createElement(QueryObserver, {
          target: {
            ...thread,
            attachedPullRequest: {
              number,
              url: `https://github.com/spiritdevs/pathway/pull/${number}`,
            },
          },
          poll,
        }),
      );
      const atom = mocks.query.mock.lastCall![0];
      unsubscribes.push(registry.subscribe(atom, () => {}));
      registry.get(atom);
    };
    try {
      for (let number = 201; number <= 250; number++) observe(false, number);
      observe(true, 201);
      expect(reads).toHaveBeenCalledTimes(50);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(reads).toHaveBeenCalledTimes(52);
      expect(reads.mock.calls.slice(50)).toEqual([[201], [201]]);
      unsubscribes.pop()!();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(reads).toHaveBeenCalledTimes(52);
    } finally {
      unsubscribes.forEach((unsubscribe) => unsubscribe());
      registry.dispose();
    }
  });
});

describe("multiple PR settlement", () => {
  it.each([
    [["merged", "open"], "open"],
    [["merged", "closed"], "closed"],
    [["merged", null], null],
    [["merged", "merged"], "merged"],
    [[], null],
  ] as const)("aggregates %j as %s", (states, expected) => {
    expect(aggregateThreadPullRequestState(states)).toBe(expected);
  });

  it("invalidates settlement when any link is added, removed or unlinked", () => {
    const original = {
      ...thread,
      branch: "main",
      worktreePath: null,
      attachedPullRequests: [thread.attachedPullRequest],
    };
    const cached = { source: threadChangeRequestSource(original), state: "merged" as const };
    expect(
      currentThreadChangeRequestState({ ...original, attachedPullRequests: [] }, cached),
    ).toBeNull();
    expect(
      currentThreadChangeRequestState(
        {
          ...original,
          attachedPullRequests: [
            ...original.attachedPullRequests,
            { number: 111, url: thread.attachedPullRequest.url.replace("110", "111") },
          ],
        },
        cached,
      ),
    ).toBeNull();
    expect(
      currentThreadChangeRequestState(
        { ...original, detachedPullRequestUrls: [thread.attachedPullRequest.url] },
        cached,
      ),
    ).toBeNull();
  });
});

it("observes every linked PR through the shared cache and waits for the last merge", () => {
  let secondState: "open" | "merged" = "open";
  const source = Atom.family((number: number) =>
    Atom.make(() =>
      AsyncResult.success({
        number,
        url: `https://github.com/SpiritDevs/pathway/pull/${number}`,
        state: number === 110 ? "merged" : secondState,
      }),
    ),
  );
  mocks.detail.mockImplementation((target) => source(target.input.number));
  const atom = attachedPullRequestsAtom(
    JSON.stringify({
      thread: {
        ...thread,
        attachedPullRequests: [
          thread.attachedPullRequest,
          { number: 111, url: thread.attachedPullRequest.url.replace("110", "111") },
        ],
      },
      poll: false,
      supported: true,
    }),
  );
  const registry = AtomRegistry.make();
  try {
    const unsubscribe = registry.subscribe(atom, () => {});
    expect(registry.get(atom).map((entry) => entry.data?.number)).toEqual([110, 111]);
    expect(
      aggregateThreadPullRequestState(registry.get(atom).map((entry) => entry.data?.state ?? null)),
    ).toBe("open");
    secondState = "merged";
    registry.refresh(source(111));
    expect(
      aggregateThreadPullRequestState(registry.get(atom).map((entry) => entry.data?.state ?? null)),
    ).toBe("merged");
    unsubscribe();
  } finally {
    registry.dispose();
  }
});
