import { AtomRegistry } from "effect/unstable/reactivity";
import { EnvironmentId, ThreadId } from "@spiritdevs/contracts";
import {
  AttentionEventId,
  FocusNotificationId,
  type FocusNotification,
} from "@spiritdevs/contracts/focus";
import { FocusId, FocusProjectKey, type FocusReadModel } from "@spiritdevs/contracts/focus";
import { describe, expect, it } from "vite-plus/test";

import {
  ALL_FOCUS_ID,
  focusNotificationsAtom,
  threadHasUnreadNotificationAtom,
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
});
