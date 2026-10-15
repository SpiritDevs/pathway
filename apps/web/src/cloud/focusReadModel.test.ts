import { AtomRegistry } from "effect/unstable/reactivity";
import { managedRelaySessionAtom } from "@spiritdevs/client-runtime/relay";
import {
  CONVERSATIONS_FOCUS_ID,
  focusReadModelAtom,
  type ActiveFocusId,
} from "@spiritdevs/client-runtime/state/focuses";
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
  activeFocusIdAtom,
  focusSeenAtAtom,
  type FocusView,
  focusSeenAtStorageKey,
  markFocusSeen,
  readFocusSeenAt,
  unseenFocusIds,
  unseenFocusIdsAtom,
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

describe("unseen Focus dots", () => {
  const PERSONAL = FocusId.make("focus-personal");
  const PERSONAL_PROJECT = FocusProjectKey.make("environment-a:project-b");
  const focuses = [
    READ_MODEL.focuses[0]!,
    { ...READ_MODEL.focuses[0]!, id: PERSONAL, name: "Personal", orderKey: "t" },
  ];
  const assignments = [
    ...READ_MODEL.assignments,
    { focusId: PERSONAL, projectKey: PERSONAL_PROJECT, createdAt: 1, updatedAt: 1 },
  ];
  function notification(
    id: string,
    projectKey: string,
    createdAt: number,
    overrides: Partial<FocusNotification> = {},
  ): FocusNotification {
    return {
      id: FocusNotificationId.make(id),
      eventId: AttentionEventId.make(id),
      environmentId: EnvironmentId.make("environment-a"),
      threadId: ThreadId.make(`thread-${id}`),
      projectKey: FocusProjectKey.make(projectKey),
      eventKind: "finished-unsettled",
      createdAt,
      alertEligibleAtCreation: true,
      ...overrides,
    };
  }
  const base = {
    locallyRead: new Set<string>(),
    focuses,
    assignments,
    seenAt: {},
    knownFocuses: null,
  };

  it("marks the Focus holding a new notification, never the open Focus or All", () => {
    const notifications = [
      notification("work", PROJECT, 10),
      notification("unassigned", "environment-a:project-z", 10),
      notification("chat", "environment-a:conversations", 10),
    ];
    expect(unseenFocusIds({ ...base, notifications, activeFocusId: ALL_FOCUS_ID })).toEqual(
      new Set([WORK, CONVERSATIONS_FOCUS_ID]),
    );
    expect(unseenFocusIds({ ...base, notifications, activeFocusId: WORK })).toEqual(
      new Set([CONVERSATIONS_FOCUS_ID]),
    );
  });

  it("ignores notifications already read or acknowledged locally", () => {
    const notifications = [
      notification("read", PROJECT, 10, { isRead: true }),
      notification("local", PERSONAL_PROJECT, 10),
    ];
    expect(
      unseenFocusIds({
        ...base,
        notifications,
        locallyRead: new Set(["local"]),
        activeFocusId: ALL_FOCUS_ID,
      }).size,
    ).toBe(0);
  });

  it("keeps the dot for unread notifications only seen in the tray", () => {
    expect(
      unseenFocusIds({
        ...base,
        notifications: [notification("tray", PROJECT, 10, { isSeen: true })],
        activeFocusId: ALL_FOCUS_ID,
      }),
    ).toEqual(new Set([WORK]));
  });

  it("clears once the Focus is seen and returns when something newer arrives", () => {
    const first = [notification("first", PROJECT, 10), notification("other", PERSONAL_PROJECT, 12)];
    const seenAt = markFocusSeen({ ...base, notifications: first, focusId: WORK });
    expect(seenAt).toEqual({ [WORK]: 10 });
    expect(markFocusSeen({ ...base, seenAt, notifications: first, focusId: WORK })).toBe(seenAt);
    expect(
      unseenFocusIds({ ...base, seenAt, notifications: first, activeFocusId: ALL_FOCUS_ID }),
    ).toEqual(new Set([PERSONAL]));
    expect(
      unseenFocusIds({
        ...base,
        seenAt,
        notifications: [...first, notification("second", PROJECT, 11)],
        activeFocusId: ALL_FOCUS_ID,
      }),
    ).toEqual(new Set([WORK, PERSONAL]));
  });

  it("reads seen marks per account and tolerates bad storage", () => {
    const { storage } = memoryStorage({
      [focusSeenAtStorageKey("account-a")]: JSON.stringify({ [WORK]: 10 }),
      [focusSeenAtStorageKey("account-b")]: "{bad",
    });
    expect(readFocusSeenAt("account-a", storage)).toEqual({ [WORK]: 10 });
    expect(readFocusSeenAt("account-b", storage)).toEqual({});
    expect(readFocusSeenAt("account-c", null)).toEqual({});
  });

  it("drops marks for deleted Focuses once the Focus list is loaded", () => {
    const seenAt = { [WORK]: 10, "focus-deleted": 5, [CONVERSATIONS_FOCUS_ID]: 3 };
    expect(markFocusSeen({ ...base, seenAt, notifications: [], focusId: WORK })).toBe(seenAt);
    expect(
      markFocusSeen({ ...base, seenAt, notifications: [], focusId: WORK, knownFocuses: focuses }),
    ).toEqual({ [WORK]: 10, [CONVERSATIONS_FOCUS_ID]: 3 });
  });

  it("holds a Focus's mark while the view hides an unread notification newer than it", () => {
    const OTHER_PROJECT = FocusProjectKey.make("environment-a:project-c");
    const workAssignments = [
      ...assignments,
      { focusId: WORK, projectKey: OTHER_PROJECT, createdAt: 1, updatedAt: 1 },
    ];
    const inView = (candidate: FocusNotification) => candidate.projectKey === PROJECT;
    const input = { ...base, assignments: workAssignments, focusId: WORK, inView };
    const hidden = notification("other-company", OTHER_PROJECT, 10);
    const shown = notification("shown", PROJECT, 12);
    expect(markFocusSeen({ ...input, notifications: [hidden, shown] })).toBe(base.seenAt);
    // Read or already-covered hidden notifications cannot light a dot, so they do not hold it.
    expect(
      markFocusSeen({ ...input, notifications: [{ ...hidden, isRead: true }, shown] }),
    ).toEqual({ [WORK]: 12 });
    expect(
      markFocusSeen({ ...input, seenAt: { [WORK]: 10 }, notifications: [hidden, shown] }),
    ).toEqual({ [WORK]: 12 });
  });

  describe("acknowledging a Focus view", () => {
    function view(
      focusId: ActiveFocusId,
      notifications: ReadonlyArray<FocusNotification>,
      overrides: Partial<FocusView> = {},
    ): FocusView {
      return {
        focusId,
        notifications,
        shown: true,
        narrowed: false,
        inView: () => true,
        ...overrides,
      };
    }

    function setup() {
      const { storage, values } = memoryStorage();
      vi.stubGlobal("window", { localStorage: storage });
      const registry = AtomRegistry.make();
      const unmount = registry.mount(unseenFocusIdsAtom);
      registry.set(managedRelaySessionAtom, {
        accountId: "account-a",
        readClerkToken: () => {
          throw new Error("unused");
        },
      });
      registry.set(focusReadModelAtom, { ...READ_MODEL, focuses, assignments });
      return {
        registry,
        values,
        dispose: () => {
          unmount();
          registry.dispose();
          vi.unstubAllGlobals();
        },
      };
    }

    it("clears a Focus's dot once its view shows the notification, and remembers it", () => {
      const { registry, values, dispose } = setup();
      try {
        const shown = [notification("work", PROJECT, 10)];
        registry.set(focusNotificationsAtom, shown);
        expect(registry.get(unseenFocusIdsAtom)).toEqual(new Set([WORK]));

        registry.set(activeFocusIdAtom, WORK);
        registry.set(focusSeenAtAtom, view(WORK, shown));
        registry.set(activeFocusIdAtom, PERSONAL);
        expect(registry.get(unseenFocusIdsAtom).size).toBe(0);
        expect(JSON.parse(values.get(focusSeenAtStorageKey("account-a"))!)).toEqual({
          [WORK]: 10,
        });

        registry.set(focusNotificationsAtom, [...shown, notification("later", PROJECT, 12)]);
        expect(registry.get(unseenFocusIdsAtom)).toEqual(new Set([WORK]));
      } finally {
        dispose();
      }
    });

    it("does not acknowledge a Focus selected while its view is hidden", () => {
      const { registry, dispose } = setup();
      try {
        // Work is selected but the thread sidebar is hidden (Settings), so nothing renders it.
        registry.set(activeFocusIdAtom, WORK);
        registry.set(focusNotificationsAtom, [notification("work", PROJECT, 10)]);
        registry.set(activeFocusIdAtom, PERSONAL);
        expect(registry.get(unseenFocusIdsAtom)).toEqual(new Set([WORK]));
      } finally {
        dispose();
      }
    });

    it("does not acknowledge a notification that arrived after the view last rendered", () => {
      const { registry, dispose } = setup();
      try {
        const shown = [notification("work", PROJECT, 10)];
        registry.set(focusNotificationsAtom, shown);
        registry.set(activeFocusIdAtom, WORK);
        registry.set(focusSeenAtAtom, view(WORK, shown));
        registry.set(focusNotificationsAtom, [...shown, notification("unrendered", PROJECT, 11)]);
        registry.set(activeFocusIdAtom, PERSONAL);
        expect(registry.get(unseenFocusIdsAtom)).toEqual(new Set([WORK]));
      } finally {
        dispose();
      }
    });

    it("does not acknowledge a notification that arrived while the page was hidden", () => {
      const { registry, dispose } = setup();
      try {
        const shown = [notification("work", PROJECT, 10)];
        registry.set(focusNotificationsAtom, shown);
        registry.set(activeFocusIdAtom, WORK);
        registry.set(focusSeenAtAtom, view(WORK, shown));
        // A background tab or minimized window re-renders the view without anyone seeing it.
        const background = [...shown, notification("background", PROJECT, 11)];
        registry.set(focusNotificationsAtom, background);
        registry.set(focusSeenAtAtom, view(WORK, background, { shown: false }));
        registry.set(activeFocusIdAtom, PERSONAL);
        expect(registry.get(unseenFocusIdsAtom)).toEqual(new Set([WORK]));
      } finally {
        dispose();
      }
    });

    it("does not acknowledge while search or the project picker narrows the view", () => {
      const { registry, dispose } = setup();
      try {
        const notifications = [notification("work", PROJECT, 10)];
        registry.set(focusNotificationsAtom, notifications);
        registry.set(activeFocusIdAtom, WORK);
        registry.set(focusSeenAtAtom, view(WORK, notifications, { narrowed: true }));
        registry.set(activeFocusIdAtom, PERSONAL);
        expect(registry.get(unseenFocusIdsAtom)).toEqual(new Set([WORK]));
      } finally {
        dispose();
      }
    });

    it("does not acknowledge a notification the company scope hides", () => {
      const { registry, dispose } = setup();
      try {
        // Work spans two projects; the active company only shows PROJECT.
        const OTHER_PROJECT = FocusProjectKey.make("environment-a:project-c");
        registry.set(focusReadModelAtom, {
          ...READ_MODEL,
          focuses,
          assignments: [
            ...assignments,
            { focusId: WORK, projectKey: OTHER_PROJECT, createdAt: 1, updatedAt: 1 },
          ],
        });
        const notifications = [
          notification("elsewhere", OTHER_PROJECT, 10),
          notification("here", PROJECT, 12),
        ];
        registry.set(focusNotificationsAtom, notifications);
        registry.set(activeFocusIdAtom, WORK);
        registry.set(
          focusSeenAtAtom,
          view(WORK, notifications, { inView: (candidate) => candidate.projectKey === PROJECT }),
        );
        registry.set(activeFocusIdAtom, PERSONAL);
        expect(registry.get(unseenFocusIdsAtom)).toEqual(new Set([WORK]));
      } finally {
        dispose();
      }
    });
  });
});
