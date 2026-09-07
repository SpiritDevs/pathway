import type { AlertDeliveryAction } from "@spiritdevs/client-runtime/thread-alerts";
import type {
  AlertDeliverySettings,
  DesktopThreadAlertInput,
  ThreadAlertSupport,
  ThreadAlertTarget,
} from "@spiritdevs/contracts/threadAlerts";
import { previewAlertSound } from "./audio";

const notifications = new Map<string, Notification>();
const nativeNotificationIds = new Set<string>();
const MAX_VISIBLE_NOTIFICATIONS = 200;
let desktopBlocked = false;

export async function getAlertNotificationSupport(): Promise<ThreadAlertSupport> {
  if (window.desktopBridge?.threadAlerts) {
    if (desktopBlocked) return "blocked";
    try {
      return await window.desktopBridge.threadAlerts.getSupport();
    } catch {
      return "unsupported";
    }
  }
  if (typeof Notification === "undefined") return "unsupported";
  return Notification.permission === "granted" ? "available" : "blocked";
}

/** Only the Settings enable action calls this function. */
export async function requestAlertNotificationPermission(): Promise<ThreadAlertSupport> {
  desktopBlocked = false;
  if (window.desktopBridge?.threadAlerts) return getAlertNotificationSupport();
  if (typeof Notification === "undefined") return "unsupported";
  const permission = await Notification.requestPermission();
  return permission === "granted" ? "available" : "blocked";
}

export async function openAlertNotificationSettings(): Promise<boolean> {
  const opened = await (window.desktopBridge?.threadAlerts?.openSettings() ?? false);
  if (opened) desktopBlocked = false;
  return opened;
}

export async function showThreadAlert(
  input: DesktopThreadAlertInput,
  onNavigate: (target: ThreadAlertTarget) => void,
  isActive: () => boolean = () => true,
): Promise<void> {
  if ((await getAlertNotificationSupport()) !== "available" || !isActive()) return;
  if (window.desktopBridge?.threadAlerts) {
    try {
      await window.desktopBridge.threadAlerts.show(input);
      if (!isActive()) {
        await window.desktopBridge.threadAlerts.close(input.id);
        return;
      }
      nativeNotificationIds.add(input.id);
      if (nativeNotificationIds.size > MAX_VISIBLE_NOTIFICATIONS) {
        const oldest = nativeNotificationIds.values().next().value;
        if (oldest) {
          nativeNotificationIds.delete(oldest);
          void window.desktopBridge.threadAlerts.close(oldest).catch(() => {});
        }
      }
    } catch (error) {
      desktopBlocked = true;
      throw error;
    }
    return;
  }
  const notification = new Notification(input.title, {
    body: input.body,
    tag: input.id,
    silent: true,
  });
  const previous = notifications.get(input.id);
  previous?.close();
  notifications.set(input.id, notification);
  if (notifications.size > MAX_VISIBLE_NOTIFICATIONS) {
    const oldest = notifications.keys().next().value;
    if (oldest) {
      notifications.get(oldest)?.close();
      notifications.delete(oldest);
    }
  }
  notification.addEventListener("click", () => {
    window.focus();
    onNavigate(input.target);
    notification.close();
  });
  notification.addEventListener("close", () => {
    if (notifications.get(input.id) === notification) notifications.delete(input.id);
  });
}

const EVENT_LABELS: Record<string, string> = {
  "finished-unsettled": "Run completed",
  "pending-approval": "Permission needed",
  "awaiting-input": "Input needed",
  failed: "Run failed",
};

export function alertNotificationInput(action: AlertDeliveryAction): DesktopThreadAlertInput {
  if (action.type === "summary") {
    return {
      id: action.id,
      title: "Pathway thread alerts",
      body: `${action.eventCount} unread ${action.eventCount === 1 ? "event" : "events"} across ${action.threadCount} ${action.threadCount === 1 ? "thread" : "threads"}.`,
      target: null,
    };
  }
  return {
    id: action.id,
    title: action.event.threadTitle || "Pathway thread",
    body: `${EVENT_LABELS[action.event.kind] ?? "Attention needed"}${action.event.projectName ? ` · ${action.event.projectName}` : ""}${action.count > 1 ? ` · ${action.count} events` : ""}`,
    target: {
      environmentId: action.event.environmentId,
      threadId: action.event.threadId,
      eventId: action.event.eventId,
    },
  };
}

export async function deliverThreadAlert(
  userId: string,
  settings: AlertDeliverySettings,
  action: AlertDeliveryAction,
  onNavigate: (target: ThreadAlertTarget) => void,
  isActive: () => boolean = () => true,
): Promise<void> {
  if (!isActive()) return;
  // Neither channel can prevent the other from delivering.
  await Promise.allSettled([
    settings.osNotificationsEnabled
      ? showThreadAlert(alertNotificationInput(action), onNavigate, isActive)
      : Promise.resolve(),
    settings.soundEnabled && (action.type === "summary" || action.sound)
      ? previewAlertSound(userId, settings)
      : Promise.resolve(),
  ]);
}

export async function testThreadAlert(
  userId: string,
  settings: AlertDeliverySettings,
): Promise<void> {
  const results = await Promise.allSettled([
    settings.osNotificationsEnabled
      ? showThreadAlert(
          {
            id: "thread-alert:test",
            title: "Pathway test alert",
            body: "Thread alerts are ready on this device.",
            target: null,
          },
          () => {},
        )
      : Promise.resolve(),
    settings.soundEnabled ? previewAlertSound(userId, settings) : Promise.resolve(),
  ]);
  const failed = results.find((result) => result.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
}

/** Removes this account's outstanding notifications when the signed-in runtime ends. */
export function clearThreadAlerts(): void {
  for (const notification of notifications.values()) notification.close();
  notifications.clear();
  const native = window.desktopBridge?.threadAlerts;
  if (native) for (const id of nativeNotificationIds) void native.close(id).catch(() => {});
  nativeNotificationIds.clear();
  desktopBlocked = false;
}
