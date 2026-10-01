import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import type * as Electron from "electron";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronMenu from "../electron/ElectronMenu.ts";
import * as DesktopApplicationMenu from "./DesktopApplicationMenu.ts";
import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as PreviewManager from "../preview/Manager.ts";
import * as DesktopUpdates from "../updates/DesktopUpdates.ts";
import * as DesktopWindow from "./DesktopWindow.ts";

const environmentInput = {
  dirname: "/repo/apps/desktop/dist-electron",
  homeDirectory: "/Users/alice",
  platform: "linux",
  processArch: "arm64",
  appVersion: "1.2.3",
  appPath: "/repo",
  isPackaged: false,
  resourcesPath: "/repo/resources",
  runningUnderArm64Translation: false,
} satisfies DesktopEnvironment.MakeDesktopEnvironmentInput;

const electronAppLayer = Layer.succeed(ElectronApp.ElectronApp, {
  metadata: Effect.die("unexpected metadata read"),
  name: Effect.succeed("Pathway"),
  whenReady: Effect.void,
  quit: Effect.void,
  exit: () => Effect.void,
  relaunch: () => Effect.void,
  setPath: () => Effect.void,
  setName: () => Effect.void,
  setAboutPanelOptions: () => Effect.void,
  setAppUserModelId: () => Effect.void,
  getAppMetrics: Effect.succeed([]),
  isDefaultProtocolClient: () => Effect.succeed(false),
  setAsDefaultProtocolClient: () => Effect.succeed(true),
  setDesktopName: () => Effect.void,
  appendCommandLineSwitch: () => Effect.void,
  onBeforeQuitForUpdate: () => Effect.void,
  removeCommandLineSwitch: () => Effect.void,
  on: () => Effect.void,
} satisfies ElectronApp.ElectronApp["Service"]);

const electronDialogLayer = Layer.succeed(ElectronDialog.ElectronDialog, {
  pickFolder: () => Effect.succeed(Option.none()),
  pickFiles: () => Effect.succeed([]),
  showMessageBox: () => Effect.succeed({ response: 0, checkboxChecked: false }),
  showErrorBox: () => Effect.void,
} satisfies ElectronDialog.ElectronDialog["Service"]);

const desktopUpdatesLayer = Layer.succeed(DesktopUpdates.DesktopUpdates, {
  getState: Effect.die("unexpected getState"),
  isActionActive: Effect.succeed(false),
  isInstallActive: Effect.succeed(false),
  subscribe: Effect.die("unexpected subscribe"),
  emitState: Effect.void,
  disabledReason: Effect.succeed(Option.none()),
  configure: Effect.void,
  setChannel: () => Effect.die("unexpected setChannel"),
  check: () => Effect.die("unexpected check"),
  download: Effect.die("unexpected download"),
  install: Effect.die("unexpected install"),
  installPrepared: () => Effect.die("unexpected installPrepared"),
} satisfies DesktopUpdates.DesktopUpdates["Service"]);

const makeDesktopWindowLayer = (selectedActions: Array<string>) =>
  Layer.succeed(DesktopWindow.DesktopWindow, {
    createMain: Effect.die("unexpected createMain"),
    ensureMain: Effect.succeed({
      isDestroyed: () => false,
      webContents: {
        reload: () => {
          selectedActions.push("reload-app");
        },
      },
    } as Electron.BrowserWindow),
    revealOrCreateMain: Effect.die("unexpected revealOrCreateMain"),
    activate: Effect.void,
    createMainIfBackendReady: Effect.void,
    showConnectingSplash: () => Effect.void,
    handleRendererReady: () => Effect.void,
    handleBackendReady: () => Effect.void,
    handleBackendNotReady: Effect.void,
    flushWindowState: Effect.void,
    prepareCaptureReveal: Effect.void,
    cancelPreparedCaptureReveal: Effect.void,
    dispatchSnapShotEvent: () => Effect.void,
    dispatchMenuAction: (action) =>
      Effect.sync(() => {
        selectedActions.push(action);
      }),
    zoomMain: (direction) =>
      Effect.sync(() => {
        selectedActions.push(`zoom-${direction}`);
      }),
    syncAppearance: Effect.void,
    openChild: () => Effect.die("unexpected torn-out window"),
    closeChild: () => Effect.void,
    closeAllChildren: Effect.sync(() => {
      selectedActions.push("close-all-windows");
    }),
    listChildren: Effect.succeed([]),
  } satisfies DesktopWindow.DesktopWindow["Service"]);

const makeElectronMenuLayer = (
  applicationMenuTemplate: Deferred.Deferred<readonly Electron.MenuItemConstructorOptions[]>,
) =>
  Layer.succeed(ElectronMenu.ElectronMenu, {
    setApplicationMenu: (template) =>
      Deferred.succeed(applicationMenuTemplate, template).pipe(Effect.asVoid),
    popupTemplate: () => Effect.void,
    showContextMenu: () => Effect.succeed(Option.none()),
  } satisfies ElectronMenu.ElectronMenu["Service"]);

const configureMenu = (
  selectedActions: Array<string>,
  applicationMenuTemplate: Deferred.Deferred<readonly Electron.MenuItemConstructorOptions[]>,
  options: { readonly devServerUrl?: string; readonly browserFocused?: boolean } = {},
) =>
  Effect.gen(function* () {
    const menu = yield* DesktopApplicationMenu.DesktopApplicationMenu;
    yield* menu.configure;
  }).pipe(
    Effect.provide(
      DesktopApplicationMenu.layer.pipe(
        Layer.provideMerge(makeElectronMenuLayer(applicationMenuTemplate)),
        Layer.provideMerge(makeDesktopWindowLayer(selectedActions)),
        Layer.provideMerge(
          Layer.mock(PreviewManager.PreviewManager)({
            isBrowserPartition: () => false,
            isBrowserContentFocused: () => options.browserFocused ?? false,
          }),
        ),
        Layer.provideMerge(desktopUpdatesLayer),
        Layer.provideMerge(electronDialogLayer),
        Layer.provideMerge(electronAppLayer),
        Layer.provideMerge(
          DesktopEnvironment.layer(environmentInput).pipe(
            Layer.provide(
              Layer.mergeAll(
                NodeServices.layer,
                DesktopConfig.layerTest({
                  VITE_DEV_SERVER_URL: options.devServerUrl,
                }),
              ),
            ),
          ),
        ),
      ),
    ),
  );

describe("DesktopApplicationMenu", () => {
  it.effect("installs the native menu and routes Settings through DesktopWindow", () =>
    Effect.gen(function* () {
      const selectedActions: Array<string> = [];
      const applicationMenuTemplate =
        yield* Deferred.make<readonly Electron.MenuItemConstructorOptions[]>();

      yield* configureMenu(selectedActions, applicationMenuTemplate);

      const template = yield* Deferred.await(applicationMenuTemplate);
      const fileMenu = template.find((item) => item.label === "File");
      assert.isDefined(fileMenu);
      if (!Array.isArray(fileMenu.submenu)) {
        throw new Error("Expected File menu submenu to be an array.");
      }
      const settingsItem = fileMenu.submenu.find((item) => item.label === "Settings...");
      assert.isDefined(settingsItem);
      const settingsClick = settingsItem.click;
      if (typeof settingsClick !== "function") {
        throw new Error("Expected Settings menu item to have a click handler.");
      }

      settingsClick({} as Electron.MenuItem, {} as Electron.BrowserWindow, {} as KeyboardEvent);
      assert.deepEqual(selectedActions, ["open-settings"]);
    }),
  );

  // Zoom must route through DesktopWindow.zoomMain instead of the Electron
  // zoom roles: the roles zoom whichever webContents has focus, which breaks
  // app zoom while an embedded preview WebContentsView holds focus.
  it.effect("routes View menu zoom to the main window instead of zoom roles", () =>
    Effect.gen(function* () {
      const selectedActions: Array<string> = [];
      const applicationMenuTemplate =
        yield* Deferred.make<readonly Electron.MenuItemConstructorOptions[]>();

      yield* configureMenu(selectedActions, applicationMenuTemplate);

      const template = yield* Deferred.await(applicationMenuTemplate);
      const viewMenu = template.find((item) => item.label === "View");
      assert.isDefined(viewMenu);
      if (!Array.isArray(viewMenu.submenu)) {
        throw new Error("Expected View menu submenu to be an array.");
      }

      assert.isUndefined(
        viewMenu.submenu.find((item) => item.role?.toLowerCase().includes("zoom")),
      );

      const zoomIn = viewMenu.submenu.find((item) => item.label === "Zoom In");
      assert.isDefined(zoomIn);
      assert.equal(zoomIn.accelerator, "CmdOrCtrl+=");
      if (typeof zoomIn.click !== "function") {
        throw new Error("Expected Zoom In menu item to have a click handler.");
      }

      zoomIn.click({} as Electron.MenuItem, {} as Electron.BrowserWindow, {} as KeyboardEvent);
      assert.deepEqual(selectedActions, ["zoom-in"]);
    }),
  );

  it.effect("leaves app shortcuts to a focused browser tab but keeps menu clicks working", () =>
    Effect.gen(function* () {
      const selectedActions: Array<string> = [];
      const applicationMenuTemplate =
        yield* Deferred.make<readonly Electron.MenuItemConstructorOptions[]>();

      yield* configureMenu(selectedActions, applicationMenuTemplate, { browserFocused: true });

      const template = yield* Deferred.await(applicationMenuTemplate);
      const item = (menuLabel: string, label: string) => {
        const menu = template.find(
          (entry) => entry.label === menuLabel || entry.role === menuLabel,
        );
        if (!Array.isArray(menu?.submenu)) throw new Error("Expected a submenu array.");
        const found = menu.submenu.find((entry) => entry.label === label);
        if (typeof found?.click !== "function") throw new Error(`Expected "${label}" to click.`);
        return found.click;
      };
      const shortcut = { triggeredByAccelerator: true } as Electron.KeyboardEvent;
      const mouse = { triggeredByAccelerator: false } as Electron.KeyboardEvent;
      let closed = 0;
      const window = { close: () => closed++ } as unknown as Electron.BrowserWindow;

      item("File", "Settings...")({} as Electron.MenuItem, window, shortcut);
      item("View", "Zoom In")({} as Electron.MenuItem, window, shortcut);
      item("windowMenu", "Close Window")({} as Electron.MenuItem, window, shortcut);
      assert.deepEqual(selectedActions, []);
      assert.equal(closed, 0);

      item("File", "Settings...")({} as Electron.MenuItem, window, mouse);
      item("windowMenu", "Close Window")({} as Electron.MenuItem, window, mouse);
      assert.deepEqual(selectedActions, ["open-settings"]);
      assert.equal(closed, 1);
    }),
  );

  it.effect("offers pane and window items that route through DesktopWindow", () =>
    Effect.gen(function* () {
      const selectedActions: Array<string> = [];
      const applicationMenuTemplate =
        yield* Deferred.make<readonly Electron.MenuItemConstructorOptions[]>();

      yield* configureMenu(selectedActions, applicationMenuTemplate);

      const template = yield* Deferred.await(applicationMenuTemplate);
      const click = (menu: Electron.MenuItemConstructorOptions | undefined, label: string) => {
        if (!Array.isArray(menu?.submenu)) throw new Error("Expected a submenu array.");
        const item = menu.submenu.find((entry) => entry.label === label);
        if (typeof item?.click !== "function") throw new Error(`Expected "${label}" to click.`);
        item.click({} as Electron.MenuItem, {} as Electron.BrowserWindow, {} as KeyboardEvent);
      };
      const viewMenu = template.find((item) => item.label === "View");
      click(viewMenu, "Split Panel");
      click(viewMenu, "Close Panel");
      click(viewMenu, "Close All Panels");
      click(
        template.find((item) => item.role === "windowMenu"),
        "Close All Pathway Windows",
      );

      assert.deepEqual(selectedActions, [
        "pane-split",
        "pane-close",
        "pane-close-all",
        "close-all-windows",
      ]);
    }),
  );

  it.effect("does not register native app reload accelerators", () =>
    Effect.gen(function* () {
      const selectedActions: Array<string> = [];
      const applicationMenuTemplate =
        yield* Deferred.make<readonly Electron.MenuItemConstructorOptions[]>();

      yield* configureMenu(selectedActions, applicationMenuTemplate);

      const template = yield* Deferred.await(applicationMenuTemplate);
      const viewMenu = template.find((item) => item.label === "View");
      assert.isDefined(viewMenu);
      if (!Array.isArray(viewMenu.submenu)) {
        throw new Error("Expected View menu submenu to be an array.");
      }

      assert.isUndefined(
        viewMenu.submenu.find((item) => item.role === "reload" || item.role === "forceReload"),
      );

      const fileMenu = template.find((item) => item.label === "File");
      assert.isDefined(fileMenu);
      if (!Array.isArray(fileMenu.submenu)) {
        throw new Error("Expected File menu submenu to be an array.");
      }
      assert.isUndefined(fileMenu.submenu.find((item) => item.label === "Reload App"));
    }),
  );

  it.effect("offers a click-only app reload in development", () =>
    Effect.gen(function* () {
      const selectedActions: Array<string> = [];
      const applicationMenuTemplate =
        yield* Deferred.make<readonly Electron.MenuItemConstructorOptions[]>();

      yield* configureMenu(selectedActions, applicationMenuTemplate, {
        devServerUrl: "http://127.0.0.1:5733",
      });

      const template = yield* Deferred.await(applicationMenuTemplate);
      const fileMenu = template.find((item) => item.label === "File");
      assert.isDefined(fileMenu);
      if (!Array.isArray(fileMenu.submenu)) {
        throw new Error("Expected File menu submenu to be an array.");
      }

      const reloadItem = fileMenu.submenu.find((item) => item.label === "Reload App");
      assert.isDefined(reloadItem);
      assert.isUndefined(reloadItem.accelerator);
      if (typeof reloadItem.click !== "function") {
        throw new Error("Expected Reload App menu item to have a click handler.");
      }

      reloadItem.click({} as Electron.MenuItem, {} as Electron.BrowserWindow, {} as KeyboardEvent);

      assert.deepEqual(selectedActions, ["reload-app"]);
    }),
  );
});
