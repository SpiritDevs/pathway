// @effect-diagnostics nodeBuiltinImport:off -- EventEmitter models native window events in this boundary test.
import * as NodeEvents from "node:events";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Electron from "electron";
import { beforeEach, expect, vi } from "vite-plus/test";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as DesktopDictation from "./DesktopDictation.ts";

const native = vi.hoisted(() => ({
  destroyTray: vi.fn(),
  setContextMenu: vi.fn(),
}));
vi.mock("electron", () => ({
  app: { isReady: () => true, removeListener: vi.fn() },
  powerMonitor: { removeListener: vi.fn() },
  ipcMain: { removeListener: vi.fn() },
  nativeImage: { createEmpty: () => ({}) },
  Menu: { buildFromTemplate: (items: unknown) => items },
  Tray: class {
    destroy = native.destroyTray;
    setContextMenu = native.setContextMenu;
    setToolTip() {}
    on() {}
  },
}));
vi.mock("../window/DesktopWindow.ts", async () => {
  const Context = await import("effect/Context");
  return { DesktopWindow: Context.Service("test/DesktopWindow") };
});

class TestWindow extends NodeEvents.EventEmitter {
  id = 1;
  destroyed = false;
  visible = true;
  webContents = Object.assign(new NodeEvents.EventEmitter(), { send: vi.fn() });
  hide = vi.fn(() => {
    this.visible = false;
  });
  show = vi.fn(() => {
    this.visible = true;
  });
  focus = vi.fn();
  isDestroyed() {
    return this.destroyed;
  }
  isVisible() {
    return this.visible;
  }
}

const environmentLayer = DesktopEnvironment.layer({
  dirname: "/repo/apps/desktop/dist-electron",
  homeDirectory: "/Users/alice",
  platform: "win32",
  processArch: "x64",
  appVersion: "1.2.3",
  appPath: "/repo",
  isPackaged: false,
  resourcesPath: "/repo/resources",
  runningUnderArm64Translation: false,
}).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({}))));

function checkLifecycle(
  check: (input: { window: TestWindow; disable: () => void; signOut: () => void }) => void,
) {
  return Effect.gen(function* () {
    const service = yield* DesktopDictation.DesktopDictation;
    vi.spyOn(service.controller, "dispose").mockResolvedValue();
    let state = service.controller.getState();
    state = {
      ...state,
      authenticated: true,
      accountId: "test-account",
      preferences: { ...state.preferences, enabled: true, showIdleBar: false },
      phase: "idle",
    };
    vi.spyOn(service.controller, "getState").mockImplementation(() => state);
    vi.spyOn(service.controller, "isBackgroundEnabled", "get").mockImplementation(
      () => state.authenticated && state.preferences.enabled,
    );
    const window = new TestWindow();
    service.bindMain(window as unknown as Electron.BrowserWindow);
    service.controller.modelChanged();
    check({
      window,
      disable: () => {
        state = {
          ...state,
          phase: "disabled",
          preferences: { ...state.preferences, enabled: false },
        };
        service.controller.modelChanged();
      },
      signOut: () => {
        state = { ...state, phase: "disabled", authenticated: false, accountId: null };
        service.controller.modelChanged();
      },
    });
  }).pipe(
    Effect.provide(
      DesktopDictation.layer.pipe(
        Layer.provide(environmentLayer),
        Layer.provide(
          Layer.succeed(DesktopWindow.DesktopWindow, {} as DesktopWindow.DesktopWindow["Service"]),
        ),
      ),
    ),
    Effect.scoped,
  );
}

beforeEach(() => vi.clearAllMocks());
describe("dictation background window lifecycle", () => {
  it.effect("reveals a window retained by dictation when dictation is disabled", () =>
    checkLifecycle(({ window, disable }) => {
      const preventDefault = vi.fn();
      window.emit("close", { preventDefault });
      expect(preventDefault).toHaveBeenCalledOnce();
      expect(window.visible).toBe(false);
      disable();
      expect(window.visible).toBe(true);
      expect(window.focus).toHaveBeenCalledOnce();
      expect(native.destroyTray).toHaveBeenCalledOnce();
      const nextClose = vi.fn();
      window.emit("close", { preventDefault: nextClose });
      expect(nextClose).not.toHaveBeenCalled();
    }),
  );
  it.effect("reveals a retained window on sign-out and removes the tray", () =>
    checkLifecycle(({ window, signOut }) => {
      window.emit("close", { preventDefault: vi.fn() });
      signOut();
      expect(window.visible).toBe(true);
      expect(native.destroyTray).toHaveBeenCalledOnce();
    }),
  );
  it.effect("does not focus a window that dictation did not hide", () =>
    checkLifecycle(({ window, disable }) => {
      disable();
      expect(window.show).not.toHaveBeenCalled();
      expect(window.focus).not.toHaveBeenCalled();
      expect(native.destroyTray).toHaveBeenCalledOnce();
    }),
  );
  it.effect("does not reveal a destroyed retained window", () =>
    checkLifecycle(({ window, disable }) => {
      window.emit("close", { preventDefault: vi.fn() });
      window.destroyed = true;
      disable();
      expect(window.show).not.toHaveBeenCalled();
      expect(native.destroyTray).toHaveBeenCalledOnce();
    }),
  );
});
