import { AtomRegistry } from "effect/unstable/reactivity";
import { EnvironmentId, ThreadId } from "@spiritdevs/contracts";
import {
  AttentionEventId,
  FocusNotificationId,
  type FocusNotification,
} from "@spiritdevs/contracts/focus";
import { FocusId, FocusProjectKey, type FocusReadModel } from "@spiritdevs/contracts/focus";
import { describe, expect, it, vi } from "vite-plus/test";

import { appAtomRegistry } from "../rpc/atomRegistry";

import {
  ALL_FOCUS_ID,
  focusReadModelStorageKey,
  readCachedFocusReadModel,
  focusMutationsAtom,
  focusNotificationsAtom,
  markThreadNotificationsRead,
  readThreadHasUnreadNotification,
  threadHasUnreadNotificationAtom,
  type FocusMutations,
  activeFocusIdStorageKey,
  persistActiveFocusSelection,
  readActiveFocusId,
  writeActiveFocusId,
  type ActiveFocusStorage,
} from "./focusReadModel";

const WORK = FocusId.make("focus-work");
const PROJECT = FocusProjectKey.make("environment-a:project-a");
const READ_MODEL: FocusReadModel = {
  focuses: [
    {
      id: WORK,
      name: "Work",
      iconName: "Briefcase",
      accentColor: "#3366ff",
      orderKey: "n",
      createdAt: 1,
      updatedAt: 1,
    },
  ],
  assignments: [{ focusId: WORK, projectKey: PROJECT, createdAt: 1, updatedAt: 1 }],
  viewPreferences: [],
};

function memoryStorage(initial: Readonly<Record<string, string>> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    storage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
    } satisfies ActiveFocusStorage,
    values,
  };
}

describe("active Focus persistence", () => {
  it("scopes the local selection by signed-in account", () => {
    const { storage } = memoryStorage({
      [activeFocusIdStorageKey("account-a")]: WORK,
      [activeFocusIdStorageKey("account-b")]: ALL_FOCUS_ID,
    });
    const visibleProjectKeys = new Set([PROJECT]);

    expect(
      readActiveFocusId({ scope: "account-a", readModel: READ_MODEL, visibleProjectKeys, storage }),
    ).toBe(WORK);
    expect(
      readActiveFocusId({ scope: "account-b", readModel: READ_MODEL, visibleProjectKeys, storage }),
    ).toBe(ALL_FOCUS_ID);
  });

  it("keeps a persisted selection while Convex is loading, then falls back when it is invalid", () => {
    const { storage } = memoryStorage({ [activeFocusIdStorageKey("account-a")]: WORK });

    expect(
      readActiveFocusId({
        scope: "account-a",
        readModel: null,
        visibleProjectKeys: new Set(),
        storage,
      }),
    ).toBe(WORK);
    expect(
      readActiveFocusId({
        scope: "account-a",
        readModel: READ_MODEL,
        visibleProjectKeys: new Set(),
        storage,
      }),
    ).toBe(ALL_FOCUS_ID);
  });

  it("does not switch to All while company projects are still loading", () => {
    const { storage } = memoryStorage({ [activeFocusIdStorageKey("account-a")]: WORK });
    expect(
      readActiveFocusId({
        scope: "account-a",
        readModel: READ_MODEL,
        visibleProjectKeys: new Set(),
        projectsReady: false,
        storage,
      }),
    ).toBe(WORK);
    expect(
      readActiveFocusId({
        scope: "account-a",
        readModel: READ_MODEL,
        visibleProjectKeys: new Set(),
        projectsReady: true,
        storage,
      }),
    ).toBe(ALL_FOCUS_ID);
  });

  it("preserves a requested Focus while its projects are hidden", () => {
    const { storage, values } = memoryStorage();
    const overrides = persistActiveFocusSelection({
      scope: "account-a",
      requestedId: WORK,
      overrides: new Map(),
      storage,
    });

    expect(overrides.get("account-a")).toBe(WORK);
    expect(values.get(activeFocusIdStorageKey("account-a"))).toBe(WORK);
    expect(
      readActiveFocusId({
        scope: "account-a",
        readModel: READ_MODEL,
        visibleProjectKeys: new Set(),
        storage,
      }),
    ).toBe(ALL_FOCUS_ID);
    expect(
      readActiveFocusId({
        scope: "account-a",
        readModel: READ_MODEL,
        visibleProjectKeys: new Set([PROJECT]),
        storage,
      }),
    ).toBe(WORK);
  });

  it("writes All explicitly and tolerates unavailable storage", () => {
    const { storage, values } = memoryStorage();
    expect(writeActiveFocusId({ scope: "account-a", activeFocusId: ALL_FOCUS_ID, storage })).toBe(
      ALL_FOCUS_ID,
    );
    expect(values.get(activeFocusIdStorageKey("account-a"))).toBe(ALL_FOCUS_ID);
    expect(
      readActiveFocusId({
        scope: "account-a",
        readModel: READ_MODEL,
        visibleProjectKeys: new Set([PROJECT]),
        storage: {
          getItem: () => {
            throw new Error("blocked");
          },
          setItem: () => undefined,
        },
      }),
    ).toBe(ALL_FOCUS_ID);
  });
});

describe("thread notification dots", () => {
  it("tracks unread events by environment and clears only after every thread event is read", () => {
    const registry = AtomRegistry.make();
    const notification: FocusNotification = {
      id: FocusNotificationId.make("finished"),
      eventId: AttentionEventId.make("finished"),
      environmentId: EnvironmentId.make("env"),
      threadId: ThreadId.make("thread"),
      projectKey: FocusProjectKey.make("env:project"),
      eventKind: "finished-unsettled",
      createdAt: 1,
      isRead: false,
      alertEligibleAtCreation: true,
    };
    const second = {
      ...notification,
      id: FocusNotificationId.make("second"),
      eventId: AttentionEventId.make("second"),
    };
    const dot = threadHasUnreadNotificationAtom("env:thread");
    const otherEnvironmentDot = threadHasUnreadNotificationAtom("other:thread");
    const unmount = registry.mount(dot);
    try {
      registry.set(focusNotificationsAtom, [notification, second]);
      expect(registry.get(dot)).toBe(true);
      expect(registry.get(otherEnvironmentDot)).toBe(false);
      registry.set(focusNotificationsAtom, [{ ...notification, isRead: true }, second]);
      expect(registry.get(dot)).toBe(true);
      registry.set(focusNotificationsAtom, [
        { ...notification, isRead: true },
        { ...second, isRead: true },
      ]);
      expect(registry.get(dot)).toBe(false);
      registry.set(focusNotificationsAtom, [notification]);
      expect(registry.get(dot)).toBe(true);
    } finally {
      unmount();
      registry.dispose();
    }
  });

  it("clears a settled thread's dot at once, even when Cloud fails to record the read", async () => {
    const notification: FocusNotification = {
      id: FocusNotificationId.make("settle-unread"),
      eventId: AttentionEventId.make("settle-unread"),
      environmentId: EnvironmentId.make("env"),
      threadId: ThreadId.make("settled-thread"),
      projectKey: FocusProjectKey.make("env:project"),
      eventKind: "finished-unsettled",
      createdAt: 1,
      isRead: false,
      alertEligibleAtCreation: true,
    };
    const markNotificationRead = vi.fn(() => Promise.reject(new Error("Cloud unavailable")));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    appAtomRegistry.set(focusNotificationsAtom, [notification]);
    appAtomRegistry.set(focusMutationsAtom, {
      markNotificationRead,
    } as Partial<FocusMutations> as FocusMutations);
    try {
      expect(readThreadHasUnreadNotification("env:settled-thread")).toBe(true);
      markThreadNotificationsRead("env:settled-thread");
      expect(markNotificationRead).toHaveBeenCalledWith("settle-unread");
      expect(readThreadHasUnreadNotification("env:settled-thread")).toBe(false);
      await vi.waitFor(() => expect(warn).toHaveBeenCalled());
      expect(readThreadHasUnreadNotification("env:settled-thread")).toBe(false);
    } finally {
      appAtomRegistry.set(focusNotificationsAtom, []);
      appAtomRegistry.set(focusMutationsAtom, null);
      warn.mockRestore();
    }
  });
});

describe("cached Focus read model", () => {
  it("restores a complete model only for its account and deployment", () => {
    const { storage } = memoryStorage({
      [focusReadModelStorageKey("a", "https://a.convex.cloud")]: JSON.stringify(READ_MODEL),
    });
    expect(readCachedFocusReadModel("a", "https://a.convex.cloud", storage)).toEqual(READ_MODEL);
    expect(readCachedFocusReadModel("b", "https://a.convex.cloud", storage)).toBeNull();
    expect(readCachedFocusReadModel("a", "https://b.convex.cloud", storage)).toBeNull();
  });
  it("keeps the cold gate when storage is absent or invalid", () => {
    const key = focusReadModelStorageKey("a", "https://a.convex.cloud");
    for (const raw of ["{bad", JSON.stringify({ focuses: [] })]) {
      expect(
        readCachedFocusReadModel(
          "a",
          "https://a.convex.cloud",
          memoryStorage({ [key]: raw }).storage,
        ),
      ).toBeNull();
    }
    expect(readCachedFocusReadModel("a", "https://a.convex.cloud", null)).toBeNull();
    expect(
      readCachedFocusReadModel("a", "https://a.convex.cloud", {
        getItem: () => {
          throw new Error("blocked");
        },
        setItem: () => undefined,
      }),
    ).toBeNull();
  });
});
