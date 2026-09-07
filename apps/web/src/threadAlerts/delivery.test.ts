import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { DEFAULT_ALERT_DELIVERY_SETTINGS } from "@spiritdevs/contracts/threadAlerts";
import { previewAlertSound } from "./audio";
import {
  alertNotificationInput,
  clearThreadAlerts,
  openAlertNotificationSettings,
  showThreadAlert,
  deliverThreadAlert,
  getAlertNotificationSupport,
  requestAlertNotificationPermission,
  testThreadAlert,
} from "./delivery";

vi.mock("./audio", () => ({ previewAlertSound: vi.fn().mockResolvedValue(undefined) }));

class FakeNotification extends EventTarget {
  static permission = "granted";
  static requestPermission = vi.fn().mockResolvedValue("granted");
  static instances: FakeNotification[] = [];
  onclick: (() => void) | null = null;
  onclose: (() => void) | null = null;
  close = vi.fn();
  constructor(
    readonly title: string,
    readonly options: NotificationOptions,
  ) {
    super();
    FakeNotification.instances.push(this);
  }
}
const action = {
  type: "event" as const,
  id: "event-notification",
  count: 1,
  sound: true,
  event: {
    eventId: "event",
    environmentId: "env",
    threadId: "thread",
    kind: "pending-approval" as const,
    createdAt: 1,
    threadTitle: "Fix search",
    projectName: "Pathway",
  },
};

beforeEach(() => {
  vi.stubGlobal("window", { focus: vi.fn() });
  clearThreadAlerts();
  vi.clearAllMocks();
  FakeNotification.permission = "granted";
  FakeNotification.instances = [];
  vi.stubGlobal("Notification", FakeNotification);
  vi.stubGlobal("window", { focus: vi.fn() });
});
afterEach(() => vi.unstubAllGlobals());

describe("thread alert channels", () => {
  it("requires its device toggle even when calendar notifications already have permission", async () => {
    await deliverThreadAlert("account", DEFAULT_ALERT_DELIVERY_SETTINGS, action, vi.fn());
    expect(FakeNotification.instances).toHaveLength(0);
    expect(previewAlertSound).toHaveBeenCalledOnce();
    expect(FakeNotification.requestPermission).not.toHaveBeenCalled();
  });
  it("posts silently and routes the exact event on click", async () => {
    const navigate = vi.fn();
    await deliverThreadAlert(
      "account",
      { ...DEFAULT_ALERT_DELIVERY_SETTINGS, osNotificationsEnabled: true },
      action,
      navigate,
    );
    expect(FakeNotification.instances[0]?.options).toEqual({
      tag: "event-notification",
      body: "Permission needed · Pathway",
      silent: true,
    });
    FakeNotification.instances[0]?.dispatchEvent(new Event("click"));
    expect(navigate).toHaveBeenCalledWith({
      environmentId: "env",
      threadId: "thread",
      eventId: "event",
    });
    expect(window.focus).toHaveBeenCalledOnce();
    expect(previewAlertSound).toHaveBeenCalledOnce();
  });
  it("updates coalesced notifications without another sound", async () => {
    await deliverThreadAlert(
      "account",
      { ...DEFAULT_ALERT_DELIVERY_SETTINGS, osNotificationsEnabled: true },
      { ...action, count: 3, sound: false },
      vi.fn(),
    );
    expect(FakeNotification.instances[0]?.options.body).toBe(
      "Permission needed · Pathway · 3 events",
    );
    expect(previewAlertSound).not.toHaveBeenCalled();
  });
  it("revoked OS permission does not prevent sound and requests nothing automatically", async () => {
    FakeNotification.permission = "denied";
    await deliverThreadAlert(
      "account",
      { ...DEFAULT_ALERT_DELIVERY_SETTINGS, osNotificationsEnabled: true },
      action,
      vi.fn(),
    );
    expect(await getAlertNotificationSupport()).toBe("blocked");
    expect(FakeNotification.instances).toHaveLength(0);
    expect(previewAlertSound).toHaveBeenCalledOnce();
    expect(FakeNotification.requestPermission).not.toHaveBeenCalled();
  });
  it("only the explicit enable action requests permission", async () => {
    await requestAlertNotificationPermission();
    expect(FakeNotification.requestPermission).toHaveBeenCalledOnce();
  });
  it("a failed sound does not prevent the OS notification", async () => {
    vi.mocked(previewAlertSound).mockRejectedValueOnce(new Error("Audio blocked"));
    await deliverThreadAlert(
      "account",
      { ...DEFAULT_ALERT_DELIVERY_SETTINGS, osNotificationsEnabled: true },
      action,
      vi.fn(),
    );
    expect(FakeNotification.instances).toHaveLength(1);
  });
  it("summaries contain counts only and target the tray", () => {
    expect(
      alertNotificationInput("account", {
        type: "summary",
        id: "summary",
        eventCount: 4,
        threadCount: 2,
      }),
    ).toEqual({
      userId: "account",
      id: "summary",
      title: "Pathway thread alerts",
      body: "4 unread events across 2 threads.",
      target: null,
    });
  });
  it("the explicit test bypasses quiet hours without creating a tray record", async () => {
    await testThreadAlert("account", {
      ...DEFAULT_ALERT_DELIVERY_SETTINGS,
      quietHours: { enabled: true, weekdays: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "00:00" },
      osNotificationsEnabled: true,
    });
    expect(FakeNotification.instances[0]?.title).toBe("Pathway test alert");
    expect(previewAlertSound).toHaveBeenCalledOnce();
  });
});

describe("notification lifetime", () => {
  it("caps retained browser notifications even if the browser never emits close", async () => {
    for (let index = 0; index < 201; index += 1) {
      await showThreadAlert(
        {
          userId: "account",
          id: `bounded:${index}`,
          title: "Thread",
          body: "Run completed",
          target: null,
        },
        vi.fn(),
      );
    }
    expect(FakeNotification.instances[0]?.close).toHaveBeenCalledOnce();
    expect(FakeNotification.instances[200]?.close).not.toHaveBeenCalled();
    clearThreadAlerts();
    expect(FakeNotification.instances[200]?.close).toHaveBeenCalledOnce();
  });
  it("does not post a notification if account teardown happens during its permission check", async () => {
    let active = true;
    const posting = showThreadAlert(
      { userId: "account", id: "departing", title: "Thread", body: "Run completed", target: null },
      vi.fn(),
      () => active,
    );
    active = false;
    await posting;
    expect(FakeNotification.instances).toHaveLength(0);
  });
  it("recovers native delivery after opening system settings", async () => {
    const bridge = {
      getSupport: vi.fn().mockResolvedValue("available"),
      show: vi.fn().mockRejectedValueOnce(new Error("Permission revoked")),
      openSettings: vi.fn().mockResolvedValue(true),
      close: vi.fn().mockResolvedValue(undefined),
    };
    vi.stubGlobal("window", { desktopBridge: { threadAlerts: bridge } });
    await expect(
      showThreadAlert(
        { userId: "account", id: "native", title: "Thread", body: "Run completed", target: null },
        vi.fn(),
      ),
    ).rejects.toThrow("Permission revoked");
    expect(await getAlertNotificationSupport()).toBe("blocked");
    expect(await openAlertNotificationSettings()).toBe(true);
    expect(await getAlertNotificationSupport()).toBe("available");
  });
});
