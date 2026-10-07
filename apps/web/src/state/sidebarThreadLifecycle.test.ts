import { scopeThreadRef, scopedThreadKey } from "@spiritdevs/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@spiritdevs/contracts";
import { AtomRegistry } from "effect/unstable/reactivity";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { makeThreadFixture } from "../test-fixtures";
import { threadChangeRequestSource, type ThreadChangeRequestState } from "./threadPullRequest";
import {
  sidebarThreadChangeRequestsAtom,
  sidebarThreadSection,
  updateSidebarChangeRequest,
} from "./sidebarThreadLifecycle";

const now = "2026-09-12T12:00:00.000Z";
const thread = makeThreadFixture({
  branch: "work",
  worktreePath: "/work",
  latestUserMessageAt: "2026-09-12T10:00:00.000Z",
});
const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
const merged = { source: threadChangeRequestSource(thread), state: "merged" as const };
const options = {
  now,
  autoSettleAfterDays: null,
  queued: false,
  supportsSettlement: true,
  supportsSnooze: true,
  projectCwd: "/project",
  changeRequests: new Map<string, ThreadChangeRequestState>(),
};
const classify = (
  value = thread,
  overrides: Partial<Parameters<typeof sidebarThreadSection>[1]> = {},
) => sidebarThreadSection(value, { ...options, ...overrides });
afterEach(() => vi.useRealTimers());

describe("sidebar lifecycle loading", () => {
  it("holds unresolved PR history in loading until the background check answers", () => {
    expect(classify()).toBe("loading");
    expect(classify(thread, { changeRequests: new Map([[key, merged]]) })).toBe("settled");
    expect(classify(thread, { changeRequests: new Map([[key, { ...merged, state: null }]]) })).toBe(
      "active",
    );
    expect(
      classify(thread, { changeRequests: new Map([[key, { ...merged, state: "open" }]]) }),
    ).toBe("active");
  });

  it("distinguishes unknown capabilities from an older server without support", () => {
    expect(sidebarThreadSection(thread, { ...options, supportsSettlement: undefined })).toBe(
      "loading",
    );
    expect(classify(thread, { supportsSettlement: false })).toBe("active");
    const settled = { ...thread, settledOverride: "settled" as const };
    expect(sidebarThreadSection(settled, { ...options, supportsSettlement: undefined })).toBe(
      "loading",
    );
    expect(classify(settled)).toBe("settled");
    expect(classify(settled, { supportsSettlement: false })).toBe("active");
  });

  it("does not wait for a PR when work, explicit overrides or a pin determine the section", () => {
    expect(classify({ ...thread, settledOverride: "active" })).toBe("active");
    expect(classify({ ...thread, settledOverride: "settled" })).toBe("settled");
    expect(classify({ ...thread, pinnedAt: now })).toBe("pinned");
    expect(classify(thread, { queued: true })).toBe("active");
    expect(classify({ ...thread, branch: null, worktreePath: null })).toBe("active");
    expect(classify({ ...thread, latestUserMessageAt: now })).toBe("active");
  });

  it("keeps unread threads in place until they are read, then settles them as usual", () => {
    const changeRequests = new Map([[key, merged]]);
    const settled = { ...thread, settledOverride: "settled" as const };
    expect(classify(thread, { changeRequests, unread: true })).toBe("active");
    expect(classify(settled, { unread: true })).toBe("active");
    expect(classify({ ...settled, pinnedAt: now }, { unread: true })).toBe("pinned");
    expect(classify(thread, { changeRequests, unread: false })).toBe("settled");
    expect(classify(settled, { unread: false })).toBe("settled");
  });

  it("honors snoozing and restores the pin exactly at wake", () => {
    const snoozed = { ...thread, pinnedAt: now, snoozedUntil: "2026-09-12T13:00:00.000Z" };
    expect(classify(snoozed)).toBe("snoozed");
    expect(sidebarThreadSection(snoozed, { ...options, supportsSnooze: undefined })).toBe(
      "loading",
    );
    expect(classify(snoozed, { now: snoozed.snoozedUntil })).toBe("pinned");
  });

  it("reclassifies changed PR sources and keeps environments separate", () => {
    const changeRequests = new Map([[key, merged]]);
    expect(classify({ ...thread, branch: "new-work" }, { changeRequests })).toBe("loading");
    expect(
      classify({ ...thread, environmentId: EnvironmentId.make("other") }, { changeRequests }),
    ).toBe("loading");
    expect(classify({ ...thread, worktreePath: "/another" }, { changeRequests })).toBe("loading");
  });

  it("does not auto-settle an old branch before discovering its open PR", () => {
    const old = {
      ...thread,
      createdAt: "2026-08-01T00:00:00.000Z",
      latestUserMessageAt: "2026-08-01T00:00:00.000Z",
    };
    expect(classify(old, { autoSettleAfterDays: 1 })).toBe("loading");
    expect(
      classify(old, {
        autoSettleAfterDays: 1,
        changeRequests: new Map([[key, { ...merged, state: "open" }]]),
      }),
    ).toBe("active");
  });

  it("keeps 106 merged threads settled through a sidebar unmount and remount", async () => {
    vi.useFakeTimers();
    const registry = AtomRegistry.make();
    const atom = sidebarThreadChangeRequestsAtom("account-a/company-a");
    const history = Array.from({ length: 106 }, (_, index) => ({
      ...thread,
      id: ThreadId.make(`history-${index}`),
    }));
    try {
      const unmount = registry.subscribe(atom, () => {});
      const states = new Map(
        history.map((item) => [
          scopedThreadKey(scopeThreadRef(item.environmentId, item.id)),
          merged,
        ]),
      );
      registry.set(atom, states);
      unmount();
      await vi.advanceTimersByTimeAsync(60_000);
      const remount = registry.subscribe(atom, () => {});
      expect(
        history.map((item) => classify(item, { changeRequests: new Map(registry.get(atom)) })),
      ).toEqual(Array(106).fill("settled"));
      expect(registry.get(sidebarThreadChangeRequestsAtom("account-b/company-a")).size).toBe(0);
      expect(registry.get(sidebarThreadChangeRequestsAtom("account-a/company-b")).size).toBe(0);
      remount();
      await vi.advanceTimersByTimeAsync(31 * 60_000);
      expect(registry.get(atom).size).toBe(0);
    } finally {
      registry.dispose();
    }
  });

  it("retains known classification on refresh errors but accepts real reverse transitions", () => {
    const states = new Map([[key, merged]]);
    expect(updateSidebarChangeRequest(states, key, { ...merged, state: null }, true)).toBe(states);
    const reopened = updateSidebarChangeRequest(states, key, { ...merged, state: "open" });
    expect(sidebarThreadSection(thread, { ...options, changeRequests: reopened })).toBe("active");
    expect(
      updateSidebarChangeRequest(new Map(), key, { ...merged, state: null }, true).get(key)?.state,
    ).toBeNull();
  });
});

it("keeps uncached remote threads navigable while offline and reclassifies after reconnect", () => {
  expect(classify(thread, { unavailable: true })).toBe("active");
  expect(classify(thread, { unavailable: true, supportsSettlement: undefined })).toBe("active");
  expect(classify(thread, { unavailable: true, changeRequests: new Map([[key, merged]]) })).toBe(
    "settled",
  );
  expect(classify(thread, { unavailable: false })).toBe("loading");
  expect(
    classify(thread, {
      unavailable: false,
      changeRequests: new Map([[key, { ...merged, state: "open" }]]),
    }),
  ).toBe("active");
});

it("retains freshness across cache reads and errors, and advances it on successful revalidation", () => {
  vi.spyOn(Date, "now").mockReturnValue(1000);
  try {
    const states = updateSidebarChangeRequest(new Map(), key, merged);
    expect(states.get(key)?.checkedAt).toBe(1000);
    vi.mocked(Date.now).mockReturnValue(2000);
    expect(updateSidebarChangeRequest(states, key, merged)).toBe(states);
    expect(updateSidebarChangeRequest(states, key, { ...merged, checkedAt: 2000 }, true)).toBe(
      states,
    );
    const refreshed = updateSidebarChangeRequest(states, key, { ...merged, checkedAt: 2000 });
    expect(refreshed.get(key)?.checkedAt).toBe(2000);
    expect(classify(thread, { changeRequests: refreshed })).toBe("settled");
  } finally {
    vi.restoreAllMocks();
  }
});

it("retains badge inputs across navigation and refresh errors, and updates checks without changing classification", () => {
  const presentation: NonNullable<ThreadChangeRequestState["presentation"]> = {
    branchPullRequest: {
      number: 123,
      title: "Cached PR",
      url: "https://github.com/example/repo/pull/123",
      baseRef: "main",
      headRef: "work",
      state: "open",
    },
    attachedDetails: [],
    provider: undefined,
  };
  const cached = { ...merged, state: "open" as const, presentation };
  const states = updateSidebarChangeRequest(new Map(), key, cached);
  expect(updateSidebarChangeRequest(states, key, cached)).toBe(states);
  expect(
    updateSidebarChangeRequest(states, key, { ...cached, presentation: { ...presentation } }),
  ).toBe(states);
  expect(
    updateSidebarChangeRequest(
      states,
      key,
      { ...cached, presentation: { ...presentation, branchPullRequest: null } },
      true,
    ),
  ).toBe(states);
  const changed = updateSidebarChangeRequest(states, key, {
    ...cached,
    presentation: {
      ...presentation,
      branchPullRequest: { ...presentation.branchPullRequest!, title: "Updated PR" },
    },
  });
  expect(changed.get(key)?.presentation?.branchPullRequest?.title).toBe("Updated PR");
  const registry = AtomRegistry.make();
  const atom = sidebarThreadChangeRequestsAtom("badges/account-a/company-a");
  try {
    const unmount = registry.subscribe(atom, () => {});
    registry.set(atom, changed);
    unmount();
    const remount = registry.subscribe(atom, () => {});
    expect(registry.get(atom).get(key)?.presentation).toBe(changed.get(key)?.presentation);
    expect(registry.get(sidebarThreadChangeRequestsAtom("badges/account-b/company-a")).size).toBe(
      0,
    );
    remount();
  } finally {
    registry.dispose();
  }
});
