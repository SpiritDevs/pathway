import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@spiritdevs/contracts";
import {
  AttentionEventId,
  FocusNotificationId,
  FocusProjectKey,
  type FocusNotification,
} from "@spiritdevs/contracts/focus";
import { reactHookHarness as hooks } from "../test/reactHookHarness";

const state = vi.hoisted(() => ({ effects: [] as Array<() => void | (() => void)> }));
vi.mock("react", async () => {
  const { reactHookHarness } = await import("../test/reactHookHarness");
  return {
    useRef: reactHookHarness.useRef,
    useEffect: (effect: () => void | (() => void)) => state.effects.push(effect),
  };
});
import { useReadThreadNotifications } from "./useReadThreadNotifications";

const thread = { environmentId: "env", threadId: "thread" };
function notification(id: string, overrides: Partial<FocusNotification> = {}): FocusNotification {
  return {
    id: FocusNotificationId.make(id),
    eventId: AttentionEventId.make(id),
    environmentId: EnvironmentId.make("env"),
    threadId: ThreadId.make("thread"),
    projectKey: FocusProjectKey.make("env:project"),
    eventKind: "finished-unsettled",
    createdAt: 1,
    isRead: false,
    alertEligibleAtCreation: true,
    ...overrides,
  };
}
let documentTarget: EventTarget & { visibilityState: string; hasFocus: () => boolean };
let windowTarget: EventTarget;
let cleanups: Array<() => void>;
const markRead = vi.fn<(id: string) => Promise<null>>();
function render(
  notifications: FocusNotification[],
  options: Partial<Parameters<typeof useReadThreadNotifications>[0]> = {},
) {
  for (const cleanup of cleanups) cleanup();
  cleanups = [];
  hooks.beginRender();
  state.effects = [];
  useReadThreadNotifications({ account: "account", thread, notifications, markRead, ...options });
  // The account effect only runs on mount for these same-account renders.
  if (firstRender) {
    state.effects[0]!();
    firstRender = false;
  }
  const cleanup = state.effects[1]!();
  if (cleanup) cleanups.push(cleanup);
}
let firstRender: boolean;
beforeEach(() => {
  hooks.reset();
  firstRender = true;
  cleanups = [];
  markRead.mockReset().mockResolvedValue(null);
  documentTarget = Object.assign(new EventTarget(), {
    visibilityState: "visible",
    hasFocus: () => true,
  });
  windowTarget = new EventTarget();
  vi.stubGlobal("document", documentTarget);
  vi.stubGlobal("window", windowTarget);
});
afterEach(() => {
  for (const cleanup of cleanups) cleanup();
  vi.unstubAllGlobals();
});

describe("reading thread notifications", () => {
  it("acknowledges every unread event for the visited thread and environment", () => {
    render([
      notification("finished"),
      notification("approval", { eventKind: "pending-approval" }),
      notification("read", { isRead: true }),
      notification("other-thread", { threadId: ThreadId.make("other") }),
      notification("other-environment", { environmentId: EnvironmentId.make("other") }),
    ]);
    expect(markRead.mock.calls).toEqual([["finished"], ["approval"]]);
  });
  it("keeps background events unread until the thread is visible and focused", () => {
    documentTarget.visibilityState = "hidden";
    render([notification("finished")]);
    expect(markRead).not.toHaveBeenCalled();
    documentTarget.visibilityState = "visible";
    documentTarget.hasFocus = () => false;
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    expect(markRead).not.toHaveBeenCalled();
    documentTarget.hasFocus = () => true;
    windowTarget.dispatchEvent(new Event("focus"));
    expect(markRead).toHaveBeenCalledExactlyOnceWith("finished");
  });
  it("reads new events while open without repeating pending acknowledgements", () => {
    render([notification("first")]);
    windowTarget.dispatchEvent(new Event("focus"));
    render([notification("first"), notification("second")]);
    expect(markRead.mock.calls).toEqual([["first"], ["second"]]);
  });
  it("stops acknowledging the previous thread after navigation", () => {
    render([notification("first")]);
    render([notification("second")], { thread: { ...thread, threadId: "other" } });
    windowTarget.dispatchEvent(new Event("focus"));
    expect(markRead.mock.calls).toEqual([["first"]]);
  });
  it("leaves notifications unread outside a signed-in thread view", () => {
    render([notification("first")], { account: null });
    render([notification("first")], { thread: null });
    expect(markRead).not.toHaveBeenCalled();
  });
  it("retries a failed acknowledgement when focus returns", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    markRead.mockRejectedValueOnce(new Error("Disconnected"));
    render([notification("first")]);
    await Promise.resolve();
    windowTarget.dispatchEvent(new Event("focus"));
    expect(markRead).toHaveBeenCalledTimes(2);
    warning.mockRestore();
  });
});
