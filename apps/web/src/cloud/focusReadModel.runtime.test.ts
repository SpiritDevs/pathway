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
import { appAtomRegistry, resetAppAtomRegistryForTests } from "../rpc/atomRegistry";
import { threadAlertNotificationsReadyAtom } from "../threadAlerts/state";
import {
  FOCUS_FUNCTION_REFERENCES,
  focusNotificationsAtom,
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
});

describe("Focus notification subscription readiness", () => {
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
  const model = { focuses: [], assignments: [] };
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
