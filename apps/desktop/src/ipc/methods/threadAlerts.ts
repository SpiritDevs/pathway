import { Notification, shell } from "electron";
import { HostProcessPlatform } from "@spiritdevs/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  DesktopThreadAlertInput,
  ThreadAlertTarget,
  type ThreadAlertSupport,
} from "@spiritdevs/contracts/threadAlerts";
import * as DesktopWindow from "../../window/DesktopWindow.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import * as Channels from "../channels.ts";

class ThreadAlertDeliveryError extends Schema.TaggedErrorClass<ThreadAlertDeliveryError>()(
  "ThreadAlertDeliveryError",
  { cause: Schema.Defect() },
) {
  override get message() {
    return "Could not show the OS notification.";
  }
}

const active = new Map<string, Notification>();
const pendingClicks: ThreadAlertTarget[] = [];
let deliveryBlocked = false;

export const getThreadAlertSupport = DesktopIpc.makeIpcMethod({
  channel: Channels.THREAD_ALERT_SUPPORT_CHANNEL,
  payload: Schema.Void,
  result: Schema.Literals(["available", "blocked", "unsupported"]),
  handler: () =>
    Effect.sync(
      (): ThreadAlertSupport =>
        !Notification.isSupported() ? "unsupported" : deliveryBlocked ? "blocked" : "available",
    ),
});

export const showThreadAlert = DesktopIpc.makeIpcMethod({
  channel: Channels.THREAD_ALERT_SHOW_CHANNEL,
  payload: DesktopThreadAlertInput,
  result: Schema.Void,
  handler: Effect.fn("desktop.threadAlerts.show")(function* (input) {
    const windows = yield* DesktopWindow.DesktopWindow;
    const context = yield* Effect.context<DesktopWindow.DesktopWindow>();
    const runPromise = Effect.runPromiseWith(context);
    yield* Effect.try({
      try: () => {
        if (!Notification.isSupported()) throw new Error("OS notifications are unsupported.");
        active.get(input.id)?.close();
        const notification = new Notification({
          title: input.title,
          body: input.body,
          silent: true,
        });
        active.set(input.id, notification);
        const forget = () => {
          if (active.get(input.id) === notification) active.delete(input.id);
        };
        notification.on("failed", () => {
          if (active.get(input.id) === notification) deliveryBlocked = true;
          forget();
        });
        notification.on("show", () => {
          if (active.get(input.id) === notification) deliveryBlocked = false;
        });
        notification.on("close", forget);
        notification.on("click", () => {
          pendingClicks.push(input.target);
          if (pendingClicks.length > 20) pendingClicks.shift();
          void runPromise(windows.revealOrCreateMain)
            .then((window) => {
              const send = () => {
                if (!window.isDestroyed())
                  window.webContents.send(Channels.THREAD_ALERT_CLICK_CHANNEL);
              };
              if (window.webContents.isLoadingMainFrame())
                window.webContents.once("did-finish-load", send);
              else send();
            })
            .catch((error: unknown) => {
              void runPromise(
                Effect.logWarning("Could not open the notification's window.", error),
              );
            });
        });
        notification.show();
        // Keep native objects alive while their OS notifications can be selected, with a bounded cap.
        if (active.size > 200) {
          const first = active.keys().next().value;
          if (first !== undefined) {
            active.get(first)?.close();
            active.delete(first);
          }
        }
      },
      catch: (cause) => {
        deliveryBlocked = true;
        active.delete(input.id);
        return new ThreadAlertDeliveryError({ cause });
      },
    });
  }),
});

export const closeThreadAlert = DesktopIpc.makeIpcMethod({
  channel: Channels.THREAD_ALERT_CLOSE_CHANNEL,
  payload: Schema.String,
  result: Schema.Void,
  handler: (id) =>
    Effect.sync(() => {
      active.get(id)?.close();
      active.delete(id);
    }),
});
export const consumeThreadAlertClicks = DesktopIpc.makeIpcMethod({
  channel: Channels.THREAD_ALERT_CONSUME_CLICKS_CHANNEL,
  payload: Schema.Void,
  result: Schema.Array(ThreadAlertTarget),
  handler: () => Effect.sync(() => pendingClicks.splice(0)),
});
export const playThreadAlertSystemSound = DesktopIpc.makeIpcMethod({
  channel: Channels.THREAD_ALERT_SYSTEM_SOUND_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: () => Effect.sync(() => shell.beep()),
});
export const openThreadAlertSettings = DesktopIpc.makeIpcMethod({
  channel: Channels.THREAD_ALERT_OPEN_SETTINGS_CHANNEL,
  payload: Schema.Void,
  result: Schema.Boolean,
  handler: Effect.fn("desktop.threadAlerts.openSettings")(function* () {
    const platform = yield* HostProcessPlatform;
    return yield* Effect.promise(async () => {
      const url =
        platform === "darwin"
          ? "x-apple.systempreferences:com.apple.Notifications-Settings.extension"
          : platform === "win32"
            ? "ms-settings:notifications"
            : null;
      if (url === null) return false;
      try {
        await shell.openExternal(url);
        deliveryBlocked = false;
        return true;
      } catch {
        return false;
      }
    });
  }),
});
