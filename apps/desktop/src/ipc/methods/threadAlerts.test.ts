import type * as Electron from "electron";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { afterEach, beforeEach, describe, expect, vi } from "vite-plus/test";
import { it } from "@effect/vitest";

const native = vi.hoisted(() => {
  class FakeNotification {
    static supported = true;
    static throwOnShow = false;
    static instances: FakeNotification[] = [];
    readonly handlers = new Map<string, (() => void)[]>();
    readonly close = vi.fn();
    readonly show = vi.fn(() => {
      if (FakeNotification.throwOnShow) throw new Error("Native failure");
      this.emit("show");
    });
    readonly options: { title: string; body: string; silent: boolean };
    constructor(options: { title: string; body: string; silent: boolean }) {
      this.options = options;
      FakeNotification.instances.push(this);
    }
    static isSupported() {
      return FakeNotification.supported;
    }
    on(name: string, callback: () => void) {
      this.handlers.set(name, [...(this.handlers.get(name) ?? []), callback]);
      return this;
    }
    emit(name: string) {
      for (const callback of this.handlers.get(name) ?? []) callback();
    }
  }
  return { FakeNotification, beep: vi.fn(), openExternal: vi.fn().mockResolvedValue(undefined) };
});
vi.mock("electron", () => ({
  Notification: native.FakeNotification,
  shell: { beep: native.beep, openExternal: native.openExternal },
}));

import * as DesktopWindow from "../../window/DesktopWindow.ts";
import * as Channels from "../channels.ts";
import {
  closeThreadAlert,
  consumeThreadAlertClicks,
  getThreadAlertSupport,
  playThreadAlertSystemSound,
  showThreadAlert,
} from "./threadAlerts.ts";

const input = (id: string) => ({
  id,
  title: "Thread",
  body: "Completed · Project",
  target: { environmentId: "environment", threadId: "thread", eventId: id },
});
const runShow = (id: string, window?: Electron.BrowserWindow) =>
  showThreadAlert.handler(input(id)).pipe(
    Effect.provide(
      Layer.mock(DesktopWindow.DesktopWindow)({
        revealOrCreateMain:
          window === undefined ? Effect.die("Unexpected window access") : Effect.succeed(window),
      }),
    ),
  );

beforeEach(() => {
  native.FakeNotification.supported = true;
  native.FakeNotification.throwOnShow = false;
  native.FakeNotification.instances.length = 0;
  native.beep.mockClear();
});
afterEach(() => {
  for (const notification of native.FakeNotification.instances) notification.emit("close");
});

describe("desktop thread alerts", () => {
  it.effect(
    "replaces a coalesced native notification silently and ignores its stale close event",
    () =>
      Effect.gen(function* () {
        yield* runShow("coalesced");
        const first = native.FakeNotification.instances[0]!;
        yield* runShow("coalesced");
        const second = native.FakeNotification.instances[1]!;
        expect(first.close).toHaveBeenCalledOnce();
        expect(second.options).toMatchObject({ silent: true });
        first.emit("close");
        first.emit("failed");
        expect(yield* getThreadAlertSupport.handler(undefined)).toBe("available");
        yield* closeThreadAlert.handler("coalesced");
        expect(second.close).toHaveBeenCalledOnce();
        expect(native.beep).not.toHaveBeenCalled();
      }),
  );

  it.effect("reports unsupported and both asynchronous and synchronous delivery failure", () =>
    Effect.gen(function* () {
      native.FakeNotification.supported = false;
      expect(yield* getThreadAlertSupport.handler(undefined)).toBe("unsupported");
      native.FakeNotification.supported = true;
      yield* runShow("async-failure");
      native.FakeNotification.instances[0]!.emit("failed");
      expect(yield* getThreadAlertSupport.handler(undefined)).toBe("blocked");
      yield* runShow("recovered");
      expect(yield* getThreadAlertSupport.handler(undefined)).toBe("available");
      native.FakeNotification.throwOnShow = true;
      const failure = yield* Effect.exit(runShow("sync-failure"));
      expect(failure._tag).toBe("Failure");
      expect(String(failure)).toContain("Could not show the OS notification.");
      expect(yield* getThreadAlertSupport.handler(undefined)).toBe("blocked");
    }),
  );

  it.effect("queues an exact event click until a newly created main window finishes loading", () =>
    Effect.gen(function* () {
      const registered = Promise.withResolvers<() => void>();
      const send = vi.fn();
      const window = {
        isDestroyed: () => false,
        webContents: {
          send,
          isLoadingMainFrame: () => true,
          once: (event: string, callback: () => void) => {
            expect(event).toBe("did-finish-load");
            registered.resolve(callback);
          },
        },
      } as unknown as Electron.BrowserWindow;
      yield* runShow("loading", window);
      native.FakeNotification.instances[0]!.emit("click");
      const finishLoad = yield* Effect.promise(() => registered.promise);
      expect(send).not.toHaveBeenCalled();
      finishLoad();
      expect(send).toHaveBeenCalledWith(Channels.THREAD_ALERT_CLICK_CHANNEL);
      expect(yield* consumeThreadAlertClicks.handler(undefined)).toEqual([input("loading").target]);
      expect(yield* consumeThreadAlertClicks.handler(undefined)).toEqual([]);
    }),
  );

  it.effect("bounds retained native notification objects and keeps system sound separate", () =>
    Effect.gen(function* () {
      for (let index = 0; index < 201; index++) yield* runShow(`bounded-${index}`);
      expect(native.FakeNotification.instances[0]!.close).toHaveBeenCalledOnce();
      expect(native.FakeNotification.instances[200]!.close).not.toHaveBeenCalled();
      expect(native.beep).not.toHaveBeenCalled();
      yield* playThreadAlertSystemSound.handler(undefined);
      expect(native.beep).toHaveBeenCalledOnce();
    }),
  );
});
