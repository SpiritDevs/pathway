import { EnvironmentId, ThreadId } from "@spiritdevs/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const runtime = vi.hoisted(() => {
  const effects: { effect: () => void | (() => void); deps: readonly unknown[] }[] = [];
  class Client {
    static instances: Client[] = [];
    readonly subscriptions: {
      reference: unknown;
      receive: (value: unknown) => void;
      fail: (error: Error) => void;
      unsubscribe: ReturnType<typeof vi.fn>;
    }[] = [];
    readonly setAuth = vi.fn();
    readonly mutation = vi.fn().mockResolvedValue(null);
    readonly close = vi.fn().mockResolvedValue(undefined);
    readonly connectionState = () => ({ isWebSocketConnected: true });
    readonly subscribeToConnectionState = () => vi.fn();
    constructor() {
      Client.instances.push(this);
    }
    onUpdate(
      reference: unknown,
      _args: unknown,
      receive: (value: unknown) => void,
      fail: (error: Error) => void,
    ) {
      const unsubscribe = vi.fn();
      this.subscriptions.push({ reference, receive, fail, unsubscribe });
      return unsubscribe;
    }
  }
  return { effects, Client };
});

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useEffect: (effect: () => void | (() => void), deps: readonly unknown[]) => {
    runtime.effects.push({ effect, deps });
  },
}));
vi.mock("convex/browser", () => ({ ConvexClient: runtime.Client }));

import { focusReadModelAtom } from "@spiritdevs/client-runtime/state/focuses";
import { sidebarThreadSection } from "../state/sidebarThreadLifecycle";
import { makeThreadFixture } from "../test-fixtures";
import { appAtomRegistry, resetAppAtomRegistryForTests } from "../rpc/atomRegistry";
import { threadAlertNotificationsReadyAtom } from "../threadAlerts/state";
import { cloudSyncResetMarkerKey } from "./syncReset";
import {
  FOCUS_FUNCTION_REFERENCES,
  focusReadModelStorageKey,
  focusMutationsAtom,
  focusNotificationsAtom,
  markThreadNotificationsRead,
  unreadNotificationsStorageKey,
  unreadNotificationThreadKeysAtom,
  useFocusReadModelRuntime,
} from "./focusReadModel";

const cleanups = new Set<() => void>();
function mount(accountScope: string) {
  const mounted: { deps: readonly unknown[]; cleanup: (() => void) | void }[] = [];
  const render = (scope: string) => {
    useFocusReadModelRuntime({
      enabled: true,
      accountScope: scope,
      convexUrl: "https://example.convex.cloud",
      fetchToken: async () => "token",
    });
    runtime.effects.splice(0).forEach(({ effect, deps }, index) => {
      const previous = mounted[index];
      if (previous && deps.every((dep, i) => Object.is(dep, previous.deps[i]))) return;
      previous?.cleanup?.();
      mounted[index] = { deps, cleanup: effect() };
    });
    return runtime.Client.instances.at(-1)!;
  };
  const client = render(accountScope);
  const stop = () => {
    if (cleanups.delete(stop)) mounted.forEach(({ cleanup }) => cleanup?.());
  };
  cleanups.add(stop);
  const notifications = client.subscriptions.find(
    (row) => row.reference === FOCUS_FUNCTION_REFERENCES.notifications,
  );
  if (notifications === undefined) throw new Error("Expected a notification subscription.");
  return { client, notifications, stop, render };
}

function notification(eventId: string) {
  return {
    id: eventId,
    eventId,
    environmentId: "environment-a",
    threadId: "thread-a",
    projectKey: "environment-a:project-a",
    eventKind: "finished-unsettled",
    createdAt: 1,
    alertEligibleAtCreation: true,
    isRead: false,
  };
}

beforeEach(() => {
  resetAppAtomRegistryForTests();
  runtime.Client.instances.length = 0;
  runtime.effects.length = 0;
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  for (const cleanup of cleanups) cleanup();
  resetAppAtomRegistryForTests();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Focus notification subscription readiness", () => {
  it("sends only synced view settings even when the editor passes its full local view", async () => {
    const { client } = mount("account-a");
    const mutations = appAtomRegistry.get(focusMutationsAtom)!;
    const view = {
      focusId: "all",
      sortOrder: "project" as const,
      collapsiblePinned: true,
      pinnedCollapsed: true,
    };
    await mutations.setViewPreference(view);
    expect(client.mutation).toHaveBeenLastCalledWith(FOCUS_FUNCTION_REFERENCES.setViewPreference, {
      focusId: "all",
      sortOrder: "project",
      collapsiblePinned: true,
    });
    await mutations.setViewPreference({ focusId: "all", collapsiblePinned: false });
    expect(client.mutation).toHaveBeenLastCalledWith(FOCUS_FUNCTION_REFERENCES.setViewPreference, {
      focusId: "all",
      collapsiblePinned: false,
    });
  });

  it("pauses alert delivery on a subscription error or invalid result and resumes on valid data", () => {
    const { notifications } = mount("account-a");
    expect(appAtomRegistry.get(threadAlertNotificationsReadyAtom)).toBe(false);
    notifications.receive([notification("event-a")]);
    expect(appAtomRegistry.get(threadAlertNotificationsReadyAtom)).toBe(true);
    expect(appAtomRegistry.get(focusNotificationsAtom).map((row) => row.eventId)).toEqual([
      "event-a",
    ]);

    notifications.fail(new Error("Connection interrupted"));
    expect(appAtomRegistry.get(threadAlertNotificationsReadyAtom)).toBe(false);
    notifications.receive([]);
    expect(appAtomRegistry.get(threadAlertNotificationsReadyAtom)).toBe(true);
    notifications.receive([{ eventId: "invalid-event" }]);
    expect(appAtomRegistry.get(threadAlertNotificationsReadyAtom)).toBe(false);
    expect(appAtomRegistry.get(focusNotificationsAtom)).toEqual([]);
    notifications.receive([notification("event-b")]);
    expect(appAtomRegistry.get(threadAlertNotificationsReadyAtom)).toBe(true);
    expect(appAtomRegistry.get(focusNotificationsAtom).map((row) => row.eventId)).toEqual([
      "event-b",
    ]);
  });

  it("ignores callbacks from a cleaned-up account before and after the next account becomes ready", () => {
    const previous = mount("account-a");
    previous.notifications.receive([notification("old-event")]);
    previous.stop();
    expect(previous.client.close).toHaveBeenCalledOnce();
    expect(previous.notifications.unsubscribe).toHaveBeenCalledOnce();
    expect(appAtomRegistry.get(focusNotificationsAtom)).toEqual([]);
    expect(appAtomRegistry.get(threadAlertNotificationsReadyAtom)).toBe(false);

    const current = mount("account-b");
    previous.notifications.receive([notification("late-old-event")]);
    expect(appAtomRegistry.get(focusNotificationsAtom)).toEqual([]);
    expect(appAtomRegistry.get(threadAlertNotificationsReadyAtom)).toBe(false);

    current.notifications.receive([notification("current-event")]);
    previous.notifications.receive([notification("another-old-event")]);
    previous.notifications.fail(new Error("Old connection closed"));
    previous.notifications.receive([{ invalid: true }]);
    expect(appAtomRegistry.get(focusNotificationsAtom).map((row) => row.eventId)).toEqual([
      "current-event",
    ]);
    expect(appAtomRegistry.get(threadAlertNotificationsReadyAtom)).toBe(true);
  });
});

describe("Focus definitions across subscription restarts", () => {
  const model = { focuses: [], assignments: [], viewPreferences: [] };
  const definitions = (client: InstanceType<typeof runtime.Client>) =>
    client.subscriptions.find((row) => row.reference === FOCUS_FUNCTION_REFERENCES.readModel)!;
  it("retains a complete same-account view while a replacement subscription loads", () => {
    const current = mount("account-a");
    definitions(current.client).receive(model);
    const previousValue = appAtomRegistry.get(focusReadModelAtom);
    expect(previousValue).toEqual(model);
    const replacement = current.render("account-a");
    expect(replacement).not.toBe(current.client);
    expect(current.client.close).toHaveBeenCalledOnce();
    expect(appAtomRegistry.get(focusReadModelAtom)).toBe(previousValue);
    definitions(replacement).fail(new Error("temporarily offline"));
    expect(appAtomRegistry.get(focusReadModelAtom)).toBe(previousValue);
    definitions(current.client).receive({ invalid: true });
    expect(appAtomRegistry.get(focusReadModelAtom)).toBe(previousValue);
    current.stop();
    expect(appAtomRegistry.get(focusReadModelAtom)).toBeNull();
  });
  it("clears the previous account before accepting another account's definitions", () => {
    const current = mount("account-a");
    definitions(current.client).receive(model);
    const replacement = current.render("account-b");
    expect(appAtomRegistry.get(focusReadModelAtom)).toBeNull();
    definitions(current.client).receive(model);
    expect(appAtomRegistry.get(focusReadModelAtom)).toBeNull();
    definitions(replacement).receive(model);
    expect(appAtomRegistry.get(focusReadModelAtom)).toEqual(model);
  });
});

it("paints scoped cached Focus definitions before the subscription answers and replaces them live", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
  vi.stubGlobal("window", { localStorage: storage });
  const cached = { focuses: [], assignments: [], viewPreferences: [] };
  values.set(
    focusReadModelStorageKey("account-a", "https://example.convex.cloud"),
    JSON.stringify(cached),
  );
  const { client, render } = mount("account-a");
  expect(appAtomRegistry.get(focusReadModelAtom)).toEqual(cached);
  const live = {
    ...cached,
    viewPreferences: [
      { focusId: "all", sortOrder: "updated", collapsiblePinned: false, updatedAt: 2 },
    ],
  };
  client.subscriptions
    .find((row) => row.reference === FOCUS_FUNCTION_REFERENCES.readModel)!
    .receive(live);
  expect(appAtomRegistry.get(focusReadModelAtom)).toEqual(live);
  expect(
    JSON.parse(
      storage.getItem(focusReadModelStorageKey("account-a", "https://example.convex.cloud"))!,
    ),
  ).toEqual(live);
  render("account-b");
  expect(appAtomRegistry.get(focusReadModelAtom)).toBeNull();
});

it("keeps the cold Focus gate after sign-out marked this account for a reset", () => {
  const values = new Map([
    [
      focusReadModelStorageKey("account-a", "https://example.convex.cloud"),
      JSON.stringify({ focuses: [], assignments: [], viewPreferences: [] }),
    ],
    [cloudSyncResetMarkerKey("account-a"), "pending"],
  ]);
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
  });
  mount("account-a");
  expect(appAtomRegistry.get(focusReadModelAtom)).toBeNull();
});

describe("cached unread placement", () => {
  const url = "https://example.convex.cloud";
  const threadKey = "environment-a:thread-a";
  function stubStorage(entries: Record<string, string> = {}) {
    const values = new Map(Object.entries(entries));
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
      },
    });
    return values;
  }
  const cache = (unread: readonly string[], locallyRead: readonly string[] = []) =>
    JSON.stringify({
      unread: unread.map((eventId) => ({
        eventId,
        environmentId: "environment-a",
        threadId: "thread-a",
      })),
      locallyRead,
    });
  // An explicitly settled thread sits in Active only while it has unread news.
  const section = () =>
    sidebarThreadSection(
      makeThreadFixture({
        environmentId: EnvironmentId.make("environment-a"),
        id: ThreadId.make("thread-a"),
        settledOverride: "settled",
      }),
      {
        now: "2026-09-12T12:00:00.000Z",
        autoSettleAfterDays: null,
        queued: false,
        unread: appAtomRegistry.get(unreadNotificationThreadKeysAtom).has(threadKey),
        supportsSettlement: true,
        supportsSnooze: true,
        projectCwd: null,
        changeRequests: new Map(),
      },
    ).section;

  it("places a cached unread thread where the unchanged live list will, without alerting", () => {
    stubStorage({ [unreadNotificationsStorageKey("account-a", url)]: cache(["event-a"]) });
    const { notifications } = mount("account-a");
    const cachedSection = section();
    expect(cachedSection).toBe("active");
    // Cached events never reach the alert pipeline.
    expect(appAtomRegistry.get(focusNotificationsAtom)).toEqual([]);
    expect(appAtomRegistry.get(threadAlertNotificationsReadyAtom)).toBe(false);
    notifications.receive([notification("event-a")]);
    expect(section()).toBe(cachedSection);
  });

  it("silently applies a read recorded on another device", () => {
    const values = stubStorage({
      [unreadNotificationsStorageKey("account-a", url)]: cache(["event-a"]),
    });
    const { notifications } = mount("account-a");
    expect(section()).toBe("active");
    notifications.receive([{ ...notification("event-a"), isRead: true }]);
    expect(section()).toBe("settled");
    expect(JSON.parse(values.get(unreadNotificationsStorageKey("account-a", url))!)).toEqual({
      unread: [],
      locallyRead: [],
    });
  });

  it("keeps a thread read across a reload while Cloud has not recorded the read", () => {
    const values = stubStorage();
    const first = mount("account-a");
    first.notifications.receive([notification("event-a")]);
    expect(section()).toBe("active");
    markThreadNotificationsRead(threadKey);
    expect(section()).toBe("settled");
    first.stop();

    const second = mount("account-a");
    expect(section()).toBe("settled");
    second.notifications.receive([notification("event-a")]);
    expect(section()).toBe("settled");
    // The reload sends the read Cloud missed once more.
    expect(second.client.mutation).toHaveBeenCalledWith(FOCUS_FUNCTION_REFERENCES.markRead, {
      eventId: "event-a",
    });
    // Once Cloud records it, the local acknowledgement is no longer stored.
    second.notifications.receive([{ ...notification("event-a"), isRead: true }]);
    expect(JSON.parse(values.get(unreadNotificationsStorageKey("account-a", url))!)).toEqual({
      unread: [],
      locallyRead: [],
    });
  });

  it("settles a cached unread thread by hand before Cloud answers", () => {
    stubStorage({ [unreadNotificationsStorageKey("account-a", url)]: cache(["event-a"]) });
    const { client } = mount("account-a");
    markThreadNotificationsRead(threadKey);
    expect(section()).toBe("settled");
    expect(client.mutation).toHaveBeenCalledWith(FOCUS_FUNCTION_REFERENCES.markRead, {
      eventId: "event-a",
    });
  });

  it("restores nothing for another account, another deployment, or after sign-out", () => {
    stubStorage({
      [unreadNotificationsStorageKey("account-a", url)]: cache(["event-a"]),
      [unreadNotificationsStorageKey("account-b", "https://other.convex.cloud")]: cache([
        "event-b",
      ]),
      [cloudSyncResetMarkerKey("account-c")]: "pending",
      [unreadNotificationsStorageKey("account-c", url)]: cache(["event-c"]),
    });
    const current = mount("account-a");
    expect(section()).toBe("active");
    current.render("account-b");
    expect(section()).toBe("settled");
    current.render("account-c");
    expect(section()).toBe("settled");
  });
});
