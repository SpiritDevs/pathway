// @effect-diagnostics nodeBuiltinImport:off -- Electron windows and native executable paths are desktop boundaries.
import * as NodePath from "node:path";
import * as NodeFS from "node:fs";
import * as Electron from "electron";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { DictationController } from "./DictationController.ts";
import { DictationModels } from "./DictationModels.ts";
import { DictationInference } from "./DictationInference.ts";
import { DictationStorage } from "./DictationStorage.ts";
import { NativeDictationHost } from "./NativeDictationHost.ts";
import { createDictationWidgetHtml } from "./widgetHtml.ts";
import * as channels from "./channels.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import type { DictationState } from "@spiritdevs/contracts/dictation";
import { showMacPermissionSetup } from "../snapShot/MacPermissionSetup.ts";

export class DesktopDictationError extends Schema.TaggedErrorClass<DesktopDictationError>()(
  "DesktopDictationError",
  { message: Schema.String },
) {}
export const dictationEffect = <A>(operation: () => Promise<A>) =>
  Effect.tryPromise({
    try: operation,
    catch: (error) =>
      new DesktopDictationError({
        message: error instanceof Error ? error.message : "Dictation failed.",
      }),
  });

export class DesktopDictation extends Context.Service<
  DesktopDictation,
  {
    controller: DictationController;
    initialize: Effect.Effect<void, DesktopDictationError>;
    bindMain: (window: Electron.BrowserWindow) => void;
    isOverlay: (senderId: number) => boolean;
  }
>()("@spiritdevs/desktop/dictation/DesktopDictation") {}

const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  const context = yield* Effect.context<DesktopWindow.DesktopWindow>();
  const run = Effect.runPromiseWith(context);
  const nativeRoot = environment.isPackaged
    ? NodePath.join(environment.resourcesPath, "dictation")
    : NodePath.join(environment.rootDir, "native/dictation/build");
  const binary = NodePath.join(
    nativeRoot,
    "host",
    `pathway-dictation-host${environment.platform === "win32" ? ".exe" : ""}`,
  );
  const directory = NodePath.join(environment.stateDir, "dictation");
  let overlay: Electron.BrowserWindow | undefined;
  let owner: Electron.BrowserWindow | undefined;
  let tray: Electron.Tray | undefined;
  let quitting = false;
  let widgetLoading = false;
  let display: Electron.Display | undefined;
  let controller: DictationController | undefined;
  const boundOwners = new Set<number>();

  const open = (page: "models" | "history" | "dictionary" | "settings") => {
    void run(desktopWindow.revealOrCreateMain)
      .then((window) => {
        bindMain(window);
        window.webContents.send(channels.DICTATION_NAVIGATE, page);
      })
      .catch(() => {});
  };
  const menu = () =>
    Electron.Menu.buildFromTemplate([
      {
        label: "Open Pathway",
        click: () => {
          void run(desktopWindow.revealOrCreateMain);
        },
      },
      {
        label: "Record dictation",
        enabled: Boolean(controller?.isBackgroundEnabled && !controller?.isBusy),
        click: () => {
          void controller?.execute({ type: "start", mode: "locked" }).catch(() => {});
        },
      },
      { label: "Dictation settings", click: () => open("settings") },
      { label: "Dictation history", click: () => open("history") },
      { type: "separator" },
      {
        label: "Enable dictation",
        type: "checkbox",
        checked: controller?.getState().preferences.enabled ?? false,
        enabled: controller?.getState().authenticated ?? false,
        click: (item) => {
          const preferences = controller?.getState().preferences;
          if (preferences)
            void controller
              ?.execute({
                type: "preferences",
                preferences: { ...preferences, enabled: item.checked },
              })
              .catch(() => open("models"));
        },
      },
      { type: "separator" },
      { label: "Quit Pathway", click: () => Electron.app.quit() },
    ]);
  const position = (width: number, height: number) => {
    if (!overlay || overlay.isDestroyed()) return;
    const area = (
      display ?? Electron.screen.getDisplayNearestPoint(Electron.screen.getCursorScreenPoint())
    ).workArea;
    const safeWidth = Math.min(area.width, Math.max(80, Math.round(width)));
    const safeHeight = Math.min(area.height, Math.max(24, Math.round(height)));
    overlay.setBounds({
      x: Math.round(area.x + (area.width - safeWidth) / 2),
      y: area.y + area.height - safeHeight - 18,
      width: safeWidth,
      height: safeHeight,
    });
  };
  const createOverlay = async () => {
    if (overlay || widgetLoading || quitting) return;
    widgetLoading = true;
    const panel = new Electron.BrowserWindow({
      width: 620,
      height: 330,
      frame: false,
      transparent: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      focusable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      show: false,
      hasShadow: false,
      ...(environment.platform === "darwin" ? { type: "panel" as const } : {}),
      webPreferences: {
        preload: NodePath.join(environment.dirname, "dictation-preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    overlay = panel;
    panel.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    panel.setAlwaysOnTop(true, "floating");
    panel.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    panel.webContents.on("will-navigate", (event) => event.preventDefault());
    panel.on("closed", () => {
      if (overlay === panel) overlay = undefined;
    });
    try {
      await panel.loadURL(
        `data:text/html;charset=utf-8,${encodeURIComponent(createDictationWidgetHtml())}`,
      );
    } finally {
      widgetLoading = false;
      if (controller && !panel.isDestroyed()) present(controller.getState());
    }
  };
  const present = (state: DictationState) => {
    if (!Electron.app.isReady() || quitting) return;
    if ((!state.authenticated || state.phase === "disabled") && overlay && !overlay.isDestroyed()) {
      overlay.destroy();
      overlay = undefined;
      display = undefined;
    }
    const visible =
      state.authenticated &&
      state.phase !== "disabled" &&
      (state.phase !== "idle" || state.preferences.showIdleBar) &&
      state.mode !== "test";
    if (visible && !overlay) void createOverlay().catch(() => {});
    if (overlay && !overlay.isDestroyed()) {
      if (state.phase === "starting" || !display)
        display = Electron.screen.getDisplayNearestPoint(Electron.screen.getCursorScreenPoint());
      overlay.webContents.send(channels.DICTATION_STATE, state);
      if (visible && !widgetLoading) {
        position(overlay.getBounds().width, overlay.getBounds().height);
        overlay.showInactive();
      } else if (!visible) overlay.hide();
    }
    if (owner && !owner.isDestroyed()) owner.webContents.send(channels.DICTATION_STATE, state);
    if (state.authenticated && state.preferences.enabled && !tray) {
      const iconPath = environment
        .resolveResourcePathCandidates("icon.png")
        .find(NodeFS.existsSync);
      const icon = iconPath
        ? Electron.nativeImage.createFromPath(iconPath).resize({ width: 18, height: 18 })
        : Electron.nativeImage.createEmpty();
      tray = new Electron.Tray(icon);
      tray.setToolTip("Pathway Dictation");
      tray.on("double-click", () => {
        void run(desktopWindow.revealOrCreateMain);
      });
    }
    tray?.setContextMenu(menu());
  };
  const bindMain = (window: Electron.BrowserWindow) => {
    owner = window;
    if (boundOwners.has(window.id)) return;
    boundOwners.add(window.id);
    window.on("close", (event) => {
      if (!quitting && controller?.isBackgroundEnabled) {
        event.preventDefault();
        window.hide();
      }
    });
    const revoke = () => {
      void controller?.execute({ type: "account", accountId: null }).catch(() => {});
    };
    window.webContents.on("render-process-gone", revoke);
    window.webContents.on("destroyed", revoke);
    window.webContents.on("did-start-navigation", (_event, _url, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace) revoke();
    });
  };

  const models = new DictationModels({
    directory: NodePath.join(directory, "models"),
    onChange: () => controller?.modelChanged(),
    isModelInUse: () => controller?.isBusy ?? false,
  });
  const inference = new DictationInference({
    engineDirectory: NodePath.join(nativeRoot, "engines"),
    modelDirectory: NodePath.join(directory, "models"),
    onLoadedChange: (id, loaded) => models.setLoaded(id, loaded),
  });
  const host = new NativeDictationHost({
    binaryPath: binary,
    onEvent: (event) => {
      if (!controller) return;
      if (event.type === "shortcut-down" || event.type === "shortcut-up")
        controller.shortcutEvent(event.type === "shortcut-down" ? "down" : "up", event.timestampMs);
      else if (event.type === "cancel") {
        void controller.cancel();
      } else if (event.type === "level") controller.meter(event.id, event.durationMs, event.level);
      else if (event.type === "microphone-disconnected") {
        void controller.microphoneDisconnected(event.id, event.durationMs);
      } else if (event.type === "error") {
        void controller.nativeFailed(event.message);
      }
    },
  });
  controller = new DictationController({
    platform: environment.platform,
    arch: environment.runtimeInfo.hostArch,
    nativeAvailable:
      NodeFS.existsSync(binary) &&
      ["speech", "cleanup"].every((kind) =>
        NodeFS.existsSync(
          NodePath.join(
            nativeRoot,
            "engines",
            `pathway-${kind}-engine${environment.platform === "win32" ? ".exe" : ""}`,
          ),
        ),
      ),
    temporaryDirectory: NodePath.join(directory, "temporary"),
    storage: new DictationStorage(directory),
    models,
    inference,
    native: {
      permissions: async (request, permission) => {
        if (environment.platform !== "darwin" || !request)
          return host.request({
            type: "permissions",
            request,
            ...(permission ? { permission } : {}),
          });
        if (permission !== "accessibility") {
          const current = await host.request({
            type: "permissions",
            request: true,
            permission: "microphone",
          });
          if (current.microphone === "unknown")
            throw new Error(
              "macOS did not show a microphone permission prompt. Restart Pathway and try again.",
            );
          if (current.microphone === "denied")
            await Electron.shell.openExternal(
              "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
            );
          if (permission === "microphone") return current;
        }
        const window = owner;
        if (!window || window.isDestroyed())
          throw new Error("Open Pathway to set up Accessibility access.");
        await showMacPermissionSetup(window, "allow-accessibility");
        return host.request({ type: "permissions", request: false });
      },
      microphones: () => host.request({ type: "enumerate" }),
      configure: async (shortcut, enabled) => {
        await host.request({ type: "configureShortcut", shortcut, enabled });
      },
      start: async (id, audioPath, deviceId) => {
        await host.request({ type: "startCapture", id, path: audioPath, deviceId });
      },
      stop: (id) => host.request({ type: "stopCapture", id }),
      cancel: async (id) => {
        await host.request({ type: "cancelCapture", id });
      },
      insert: (text) => host.request({ type: "insert", text }),
      close: () => host.close(),
    },
    onState: present,
    onMeter: (meter) => {
      if (overlay && !overlay.isDestroyed())
        overlay.webContents.send(channels.DICTATION_METER, {
          durationMs: meter.durationMs,
          level: meter.level,
        });
      if (meter.mode === "test" && owner && !owner.isDestroyed())
        owner.webContents.send(channels.DICTATION_METER, {
          durationMs: meter.durationMs,
          level: meter.level,
        });
    },
    copy: (text) => Electron.clipboard.writeText(text),
    open,
  });
  const ownedController = controller;
  const beforeQuit = () => {
    quitting = true;
  };
  const suspend = () => {
    void ownedController.cancel().then(() => inference.unload());
  };
  const resize = (event: Electron.IpcMainEvent, value: unknown) => {
    if (
      event.sender.id !== overlay?.webContents.id ||
      typeof value !== "object" ||
      value === null ||
      !("width" in value) ||
      !("height" in value) ||
      typeof value.width !== "number" ||
      typeof value.height !== "number" ||
      !Number.isFinite(value.width) ||
      !Number.isFinite(value.height)
    )
      return;
    position(value.width, value.height);
  };
  const initialize = dictationEffect(async () => {
    Electron.app.prependListener("before-quit", beforeQuit);
    Electron.powerMonitor.on("suspend", suspend);
    Electron.powerMonitor.on("lock-screen", suspend);
    Electron.ipcMain.on(channels.DICTATION_RESIZE, resize);
    // Hashing previously downloaded weights must not delay opening the main window.
    void ownedController
      .initialize()
      .catch((error) =>
        ownedController.nativeFailed(
          error instanceof Error ? error.message : "Dictation setup could not load.",
        ),
      );
  });
  yield* Effect.addFinalizer(() =>
    Effect.promise(async () => {
      quitting = true;
      Electron.app.removeListener("before-quit", beforeQuit);
      Electron.powerMonitor.removeListener("suspend", suspend);
      Electron.powerMonitor.removeListener("lock-screen", suspend);
      Electron.ipcMain.removeListener(channels.DICTATION_RESIZE, resize);
      overlay?.destroy();
      tray?.destroy();
      await ownedController.dispose();
    }),
  );
  return DesktopDictation.of({
    controller: ownedController,
    initialize,
    bindMain,
    isOverlay: (id) => overlay?.webContents.id === id,
  });
});

export const layer = Layer.effect(DesktopDictation, make);
