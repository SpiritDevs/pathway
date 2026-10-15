import { scopeThreadRef, scopedThreadKey } from "@spiritdevs/client-runtime/environment";
import { setManagedRelaySession } from "@spiritdevs/client-runtime/relay";
import { EnvironmentId, ThreadId } from "@spiritdevs/contracts";
import { AtomRegistry } from "effect/unstable/reactivity";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { clearCloudSyncReset, markCloudSyncReset, type SyncResetStorage } from "../cloud/syncReset";
import { makeThreadFixture } from "../test-fixtures";
import { threadChangeRequestSource, type ThreadChangeRequestState } from "./threadPullRequest";
import {
  clearSidebarChangeRequests,
  readSidebarChangeRequests,
  sidebarChangeRequestsStorageKey,
  sidebarThreadChangeRequestsAtom,
  sidebarThreadSection,
  updateSidebarChangeRequest,
  writeSidebarChangeRequests,
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
) => sidebarThreadSection(value, { ...options, ...overrides }).section;
const provisional = (
  value = thread,
  overrides: Partial<Parameters<typeof sidebarThreadSection>[1]> = {},
) => sidebarThreadSection(value, { ...options, ...overrides }).provisional;
afterEach(() => vi.useRealTimers());

describe("sidebar lifecycle placement", () => {
  it("renders unresolved PR history provisionally until the background check answers", () => {
    expect(classify()).toBe("active");
    expect(provisional()).toBe(true);
    expect(classify(thread, { changeRequests: new Map([[key, merged]]) })).toBe("settled");
    expect(provisional(thread, { changeRequests: new Map([[key, merged]]) })).toBe(false);
    expect(classify(thread, { changeRequests: new Map([[key, { ...merged, state: null }]]) })).toBe(
      "active",
    );
    expect(
      classify(thread, { changeRequests: new Map([[key, { ...merged, state: "open" }]]) }),
    ).toBe("active");
  });

  it("never hides a head while PR status or capabilities are unknown", () => {
    const attached = {
      ...thread,
      branch: null,
      attachedPullRequests: [{ number: 7, url: "https://github.com/example/repo/pull/7" }],
    };
    const quiet = { latestUserMessageAt: "2026-09-01T00:00:00.000Z" };
    const heads = [
      thread,
      attached,
      { ...thread, ...quiet },
      { ...attached, ...quiet },
      { ...thread, settledOverride: "settled" as const },
      { ...thread, snoozedUntil: "2026-09-12T13:00:00.000Z" },
      { ...thread, branch: "new-work" },
    ];
    for (const supportsSettlement of [true, undefined]) {
      for (const supportsSnooze of [true, undefined]) {
        for (const head of heads) {
          expect(["active", "pinned", "snoozed", "settled"]).toContain(
            classify(head, { autoSettleAfterDays: 3, supportsSettlement, supportsSnooze }),
          );
        }
      }
    }
  });

  it("keeps unresolved attached PRs Active and places unclassified branches by age", () => {
    const attached = {
      ...thread,
      branch: null,
      attachedPullRequests: [{ number: 7, url: "https://github.com/example/repo/pull/7" }],
    };
    const old = { latestUserMessageAt: "2026-09-01T00:00:00.000Z" };
    const quietAttached = { ...attached, ...old };
    // Offline or not yet checked, a quiet thread with an attached PR must not hide in Settled.
    expect(classify(quietAttached, { autoSettleAfterDays: 3 })).toBe("active");
    expect(provisional(quietAttached, { autoSettleAfterDays: 3 })).toBe(true);
    expect(classify({ ...quietAttached, branch: "work" }, { autoSettleAfterDays: 3 })).toBe(
      "active",
    );
    // Known settlement or an explicit override still decides.
    const attachedKey = scopedThreadKey(scopeThreadRef(attached.environmentId, attached.id));
    const attachedMerged = new Map([
      [attachedKey, { source: threadChangeRequestSource(quietAttached), state: "merged" as const }],
    ]);
    expect(
      classify(quietAttached, { autoSettleAfterDays: 3, changeRequests: attachedMerged }),
    ).toBe("settled");
    expect(
      classify(
        { ...quietAttached, settledOverride: "settled" as const },
        { autoSettleAfterDays: 3 },
      ),
    ).toBe("settled");
    // Running work stays protected even when a merged answer is known.
    expect(
      classify(
        { ...quietAttached, hasPendingApprovals: true },
        { autoSettleAfterDays: 3, changeRequests: attachedMerged },
      ),
    ).toBe("active");
    expect(
      classify(
        {
          ...quietAttached,
          pendingBackgroundTasks: [{ taskId: "bg-1", description: "sleep 20" }],
        },
        { autoSettleAfterDays: 3 },
      ),
    ).toBe("active");
    // A branch with no attachment falls back to the age rule.
    expect(classify({ ...thread, ...old }, { autoSettleAfterDays: 3 })).toBe("settled");
    expect(provisional({ ...thread, ...old }, { autoSettleAfterDays: 3 })).toBe(true);
    expect(classify({ ...thread, ...old }, { autoSettleAfterDays: null })).toBe("active");
  });

  it("treats loading capabilities as supported and an older server as unsupported", () => {
    expect(classify(thread, { supportsSettlement: undefined })).toBe("active");
    expect(classify(thread, { supportsSettlement: false })).toBe("active");
    expect(provisional(thread, { supportsSettlement: false })).toBe(false);
    const settled = { ...thread, settledOverride: "settled" as const };
    expect(classify(settled, { supportsSettlement: undefined })).toBe("settled");
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
    expect(classify(snoozed, { supportsSnooze: undefined })).toBe("snoozed");
    expect(classify(snoozed, { supportsSnooze: false })).toBe("pinned");
    expect(classify(snoozed, { now: snoozed.snoozedUntil })).toBe("pinned");
  });

  it("reclassifies changed PR sources and keeps environments separate", () => {
    const changeRequests = new Map([[key, merged]]);
    expect(provisional({ ...thread, branch: "new-work" }, { changeRequests })).toBe(true);
    expect(
      provisional({ ...thread, environmentId: EnvironmentId.make("other") }, { changeRequests }),
    ).toBe(true);
    expect(provisional({ ...thread, worktreePath: "/another" }, { changeRequests })).toBe(true);
    expect(classify({ ...thread, branch: "new-work" }, { changeRequests })).toBe("active");
  });

  it("returns an old branch to Active once its open PR is discovered", () => {
    const old = {
      ...thread,
      createdAt: "2026-08-01T00:00:00.000Z",
      latestUserMessageAt: "2026-08-01T00:00:00.000Z",
    };
    expect(classify(old, { autoSettleAfterDays: 1 })).toBe("settled");
    expect(provisional(old, { autoSettleAfterDays: 1 })).toBe(true);
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
    expect(classify(thread, { changeRequests: reopened })).toBe("active");
    expect(
      updateSidebarChangeRequest(new Map(), key, { ...merged, state: null }, true).get(key)?.state,
    ).toBeNull();
  });
});

function memoryStorage() {
  const store = new Map<string, string>();
  return {
    store,
    storage: {
      get length() {
        return store.size;
      },
      key: (index: number) => [...store.keys()][index] ?? null,
      getItem: (item: string) => store.get(item) ?? null,
      setItem: (item: string, value: string) => void store.set(item, value),
      removeItem: (item: string) => void store.delete(item),
    } satisfies SyncResetStorage,
  };
}

it("persists classification without badge inputs in the account's sync namespace", () => {
  const scope = JSON.stringify(["account-a", "company-a"]);
  const { store, storage } = memoryStorage();
  expect(sidebarChangeRequestsStorageKey(scope)).toBe(
    "pathway:cloud-sync/account-a/sidebar-change-requests/company-a",
  );
  expect(sidebarChangeRequestsStorageKey(JSON.stringify([null, "company-a"]))).toBeNull();
  writeSidebarChangeRequests(
    scope,
    new Map([
      [
        key,
        {
          ...merged,
          checkedAt: 1000,
          presentation: { branchPullRequest: null, attachedDetails: [], provider: undefined },
        },
      ],
    ]),
    storage,
  );
  const restored = readSidebarChangeRequests(scope, storage);
  expect(restored.get(key)).toEqual({ ...merged, checkedAt: 1000 });
  expect(classify(thread, { changeRequests: restored })).toBe("settled");
  expect(readSidebarChangeRequests(JSON.stringify(["account-b", "company-a"]), storage).size).toBe(
    0,
  );
  store.set("pathway:cloud-sync/account-a/sidebar-change-requests/company-a", "{corrupt");
  expect(readSidebarChangeRequests(scope, storage).size).toBe(0);
});

it("keeps only the most recently written companies per account", () => {
  const { store, storage } = memoryStorage();
  const scopeFor = (company: string) => JSON.stringify(["account-a", company]);
  const states = new Map([[key, merged]]);
  for (const company of ["c1", "c2", "c3", "c4"])
    writeSidebarChangeRequests(scopeFor(company), states, storage);
  writeSidebarChangeRequests(scopeFor("c1"), states, storage);
  writeSidebarChangeRequests(scopeFor("c5"), states, storage);
  expect(readSidebarChangeRequests(scopeFor("c2"), storage).size).toBe(0);
  for (const company of ["c1", "c3", "c4", "c5"])
    expect(readSidebarChangeRequests(scopeFor(company), storage).size).toBe(1);
  writeSidebarChangeRequests(JSON.stringify(["account-b", "c1"]), states, storage);
  clearSidebarChangeRequests("account-a", storage);
  expect([...store.keys()].filter((item) => item.includes("/account-a/"))).toEqual([]);
  expect(readSidebarChangeRequests(JSON.stringify(["account-b", "c1"]), storage).size).toBe(1);
});

it("evicts and signs out every company another tab stored, even one the index lost", () => {
  const { store, storage } = memoryStorage();
  const scopeFor = (company: string) => JSON.stringify(["account-a", company]);
  const states = new Map([[key, merged]]);
  const companies = () =>
    [...store.keys()].filter((item) => item.includes("/account-a/sidebar-change-requests/"));
  writeSidebarChangeRequests(scopeFor("c1"), states, storage);
  // Tab B writes c2 between tab A's index read and A's index write, so A's index drops c2.
  let otherTab = () => writeSidebarChangeRequests(scopeFor("c2"), states, storage);
  const tabA: SyncResetStorage = {
    ...storage,
    get length() {
      return storage.length;
    },
    getItem: (item) => {
      const value = storage.getItem(item);
      otherTab();
      otherTab = () => undefined;
      return value;
    },
  };
  writeSidebarChangeRequests(scopeFor("c3"), states, tabA);
  expect(store.get("pathway:cloud-sync/account-a/sidebar-change-requests-recent")).toBe(
    JSON.stringify(["c3", "c1"]),
  );
  expect(companies()).toHaveLength(3);
  const signedOut = new Map(store);
  // Best effort across tabs: the next writes evict back down to the most recent four.
  for (const company of ["c4", "c5", "c6"])
    writeSidebarChangeRequests(scopeFor(company), states, storage);
  expect(companies()).toHaveLength(4);
  expect(readSidebarChangeRequests(scopeFor("c6"), storage).size).toBe(1);
  // Sign-out sweeps the unindexed cache too.
  store.clear();
  for (const [item, value] of signedOut) store.set(item, value);
  clearSidebarChangeRequests("account-a", storage);
  expect([...store.keys()]).toEqual([]);
});

it("reads nothing while a sign-out reset is pending", () => {
  const scope = JSON.stringify(["account-a", "company-a"]);
  const { storage } = memoryStorage();
  writeSidebarChangeRequests(scope, new Map([[key, merged]]), storage);
  markCloudSyncReset("account-a", storage);
  expect(readSidebarChangeRequests(scope, storage).size).toBe(0);
  // The sync runtime clears the marker once its reset sweep succeeds.
  clearCloudSyncReset("account-a", storage);
  expect(readSidebarChangeRequests(scope, storage).size).toBe(1);
});

it("warns once when storage rejects a write and retries on the next one", () => {
  const scope = JSON.stringify(["account-a", "company-a"]);
  const { storage } = memoryStorage();
  let full = true;
  const quotaStorage = {
    ...storage,
    setItem: (item: string, value: string) => {
      if (full) throw new DOMException("full", "QuotaExceededError");
      storage.setItem(item, value);
    },
  };
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    writeSidebarChangeRequests(scope, new Map([[key, merged]]), quotaStorage);
    writeSidebarChangeRequests(scope, new Map([[key, merged]]), quotaStorage);
    expect(warn).toHaveBeenCalledOnce();
    full = false;
    writeSidebarChangeRequests(scope, new Map([[key, merged]]), quotaStorage);
    expect(readSidebarChangeRequests(scope, storage).get(key)?.state).toBe("merged");
  } finally {
    warn.mockRestore();
  }
});

it("drops queued writes on sign-out and never persists a signed-out account's scope", async () => {
  vi.useFakeTimers();
  const { store, storage } = memoryStorage();
  vi.stubGlobal("window", { localStorage: storage });
  const registry = AtomRegistry.make();
  const scope = JSON.stringify(["account-a", "sign-out-company"]);
  const atom = sidebarThreadChangeRequestsAtom(scope);
  const stop = registry.subscribe(atom, () => {});
  try {
    // A check landing while signed out stays in memory.
    registry.set(atom, new Map([[key, merged]]));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(registry.get(atom).get(key)).toEqual(merged);
    expect(store.size).toBe(0);
    setManagedRelaySession(registry, { accountId: "account-a", readClerkToken: async () => null });
    // Sign-out inside the write delay cancels the queued write.
    registry.set(atom, new Map([[key, { ...merged, state: "open" }]]));
    clearSidebarChangeRequests("account-a");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(store.size).toBe(0);
    registry.set(atom, new Map([[key, merged]]));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(readSidebarChangeRequests(scope).get(key)).toEqual(merged);
    clearSidebarChangeRequests("account-a");
    expect(store.size).toBe(0);
  } finally {
    stop();
    registry.dispose();
    vi.unstubAllGlobals();
  }
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
