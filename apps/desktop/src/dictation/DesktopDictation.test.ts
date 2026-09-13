// @effect-diagnostics nodeBuiltinImport:off -- EventEmitter models native window events in this boundary test.
import * as NodeEvents from "node:events";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Electron from "electron";
import { beforeEach, expect, vi } from "vite-plus/test";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as DesktopDictation from "./DesktopDictation.ts";
import type { DictationState } from "@spiritdevs/contracts/dictation";
import { DICTATION_HIDE } from "./channels.ts";

const native = vi.hoisted(() => ({
  destroyTray: vi.fn(),
  setContextMenu: vi.fn(),
  createOverlay: vi.fn(),
}));
vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    app: Object.assign(new EventEmitter(), { isReady: () => true }),
    powerMonitor: new EventEmitter(),
    ipcMain: new EventEmitter(),
    nativeImage: { createEmpty: () => ({}) },
    Menu: { buildFromTemplate: (items: unknown) => items },
    screen: {
      getCursorScreenPoint: () => ({ x: 100, y: 100 }),
      getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
    },
    BrowserWindow: function (options: Electron.BrowserWindowConstructorOptions) {
      return native.createOverlay(options);
    },
    Tray: class {
      destroy = native.destroyTray;
      setContextMenu = native.setContextMenu;
      setToolTip() {}
      on() {}
    },
  };
});
vi.mock("../window/DesktopWindow.ts", async () => {
  const Context = await import("effect/Context");
  return { DesktopWindow: Context.Service("test/DesktopWindow") };
});

class TestWindow extends NodeEvents.EventEmitter {
  id = 1;
  destroyed = false;
  visible = true;
  webContents = Object.assign(new NodeEvents.EventEmitter(), {
    id: 10,
    send: vi.fn(),
    setWindowOpenHandler: vi.fn(),
  });
  hide = vi.fn(() => {
    this.visible = false;
  });
  show = vi.fn(() => {
    this.visible = true;
  });
  focus = vi.fn();
  showInactive = vi.fn(() => {
    this.visible = true;
  });
  destroy = vi.fn(() => {
    this.destroyed = true;
  });
  loadURL = vi.fn(async () => {});
  setVisibleOnAllWorkspaces = vi.fn();
  setAlwaysOnTop = vi.fn();
  setBounds = vi.fn();
  getBounds = () => ({ x: 0, y: 0, width: 112, height: 48 });
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
  check: (input: {
    window: TestWindow;
    disable: () => void;
    signOut: () => void;
    update: (changes: Partial<DictationState>) => void;
    getState: () => DictationState;
  }) => void | Promise<void>,
) {
  return Effect.gen(function* () {
    const service = yield* DesktopDictation.DesktopDictation;
    vi.spyOn(service.controller, "dispose").mockResolvedValue();
    vi.spyOn(service.controller, "initialize").mockResolvedValue();
    yield* service.initialize;
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
    yield* Effect.promise(async () =>
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
        update: (changes) => {
          state = { ...state, ...changes };
          service.controller.modelChanged();
        },
        getState: () => state,
      }),
    );
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
  it.effect("keeps the main window open when dictation initializes", () =>
    checkLifecycle(({ window }) => {
      expect(window.visible).toBe(true);
      expect(window.hide).not.toHaveBeenCalled();
    }),
  );
  it.effect("hides only the idle overlay and restores it on the next recording", () =>
    checkLifecycle(async ({ window, getState, update }) => {
      const overlay = new TestWindow();
      overlay.webContents.id = 20;
      native.createOverlay.mockReturnValue(overlay);
      update({ preferences: { ...getState().preferences, showIdleBar: true } });
      await overlay.loadURL.mock.results[0]!.value;
      expect(overlay.setVisibleOnAllWorkspaces).toHaveBeenCalledWith(true, {
        visibleOnFullScreen: true,
        skipTransformProcessType: true,
      });
      expect(overlay.visible).toBe(true);
      Electron.ipcMain.emit(DICTATION_HIDE, { sender: overlay.webContents });
      expect(overlay.visible).toBe(false);
      expect(getState().preferences.enabled).toBe(true);
      expect(getState().preferences.showIdleBar).toBe(true);
      expect(window.hide).not.toHaveBeenCalled();
      update({ dictionaryConnected: true });
      expect(overlay.visible).toBe(false);
      const menu = native.setContextMenu.mock
        .lastCall?.[0] as Electron.MenuItemConstructorOptions[];
      const show = menu.find((item) => item.label === "Show dictation bar");
      expect(show?.enabled).toBe(true);
      show?.click?.({} as Electron.MenuItem, undefined, {} as Electron.KeyboardEvent);
      expect(overlay.visible).toBe(true);
      Electron.ipcMain.emit(DICTATION_HIDE, { sender: overlay.webContents });
      expect(overlay.visible).toBe(false);
      update({ phase: "starting" });
      expect(overlay.visible).toBe(true);
      Electron.ipcMain.emit(DICTATION_HIDE, { sender: overlay.webContents });
      expect(overlay.visible).toBe(true);
      update({ phase: "idle" });
      expect(overlay.visible).toBe(true);
      Electron.ipcMain.emit(DICTATION_HIDE, { sender: window.webContents });
      expect(overlay.visible).toBe(true);
    }),
  );
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
