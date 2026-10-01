import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type * as Electron from "electron";

import { makeComponentLogger } from "../app/DesktopObservability.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronMenu from "../electron/ElectronMenu.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as PreviewManager from "../preview/Manager.ts";
import * as DesktopUpdates from "../updates/DesktopUpdates.ts";
import * as DesktopWindow from "./DesktopWindow.ts";

export class DesktopApplicationMenuActionError extends Schema.TaggedErrorClass<DesktopApplicationMenuActionError>()(
  "DesktopApplicationMenuActionError",
  {
    action: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Desktop menu action "${this.action}" failed.`;
  }
}

export class DesktopApplicationMenu extends Context.Service<
  DesktopApplicationMenu,
  {
    readonly configure: Effect.Effect<void>;
  }
>()("@spiritdevs/desktop/window/DesktopApplicationMenu") {}

type DesktopApplicationMenuRuntimeServices =
  | DesktopUpdates.DesktopUpdates
  | DesktopWindow.DesktopWindow
  | ElectronDialog.ElectronDialog;

const { logInfo: logUpdaterInfo } = makeComponentLogger("desktop-updater");

const { logError: logMenuError } = makeComponentLogger("desktop-menu");

const dispatchMenuAction = Effect.fn("desktop.menu.dispatchMenuAction")(function* (
  action: string,
): Effect.fn.Return<void, DesktopWindow.DesktopWindowError, DesktopWindow.DesktopWindow> {
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  yield* desktopWindow.dispatchMenuAction(action);
});

const closeAllChildWindows = Effect.fn("desktop.menu.closeAllChildWindows")(function* () {
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  yield* desktopWindow.closeAllChildren;
});

const zoomMainWindow = Effect.fn("desktop.menu.zoomMainWindow")(function* (
  direction: DesktopWindow.MainWindowZoomDirection,
): Effect.fn.Return<void, never, DesktopWindow.DesktopWindow> {
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  yield* desktopWindow.zoomMain(direction);
});

const reloadMainWindow = Effect.fn("desktop.menu.reloadMainWindow")(function* () {
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  const window = yield* desktopWindow.ensureMain;
  if (!window.isDestroyed()) {
    window.webContents.reload();
  }
});

const checkForUpdatesFromMenu = Effect.gen(function* () {
  const updates = yield* DesktopUpdates.DesktopUpdates;
  const electronDialog = yield* ElectronDialog.ElectronDialog;
  const result = yield* updates.check("menu");
  const updateState = result.state;

  if (updateState.status === "up-to-date") {
    yield* electronDialog.showMessageBox({
      type: "info",
      title: "You're up to date!",
      message: `Pathway ${updateState.currentVersion} is currently the newest version available.`,
      buttons: ["OK"],
    });
  } else if (updateState.status === "error") {
    yield* electronDialog.showMessageBox({
      type: "warning",
      title: "Update check failed",
      message: "Could not check for updates.",
      detail: updateState.message ?? "An unknown error occurred. Please try again later.",
      buttons: ["OK"],
    });
  }
}).pipe(Effect.withSpan("desktop.menu.checkForUpdates"));

const handleCheckForUpdatesMenuClick = Effect.gen(function* () {
  const updates = yield* DesktopUpdates.DesktopUpdates;
  const electronDialog = yield* ElectronDialog.ElectronDialog;
  const disabledReason = yield* updates.disabledReason;
  if (Option.isSome(disabledReason)) {
    yield* updates.check("menu");
    yield* logUpdaterInfo("manual update check requested, but updates are disabled", {
      disabledReason: disabledReason.value,
    });
    yield* electronDialog.showMessageBox({
      type: "info",
      title: "Updates unavailable",
      message: "Automatic updates are not available right now.",
      detail: disabledReason.value,
      buttons: ["OK"],
    });
    return;
  }

  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  yield* desktopWindow.ensureMain;
  yield* checkForUpdatesFromMenu;
}).pipe(Effect.withSpan("desktop.menu.handleCheckForUpdatesClick"));

export const make = Effect.gen(function* () {
  const electronApp = yield* ElectronApp.ElectronApp;
  const electronMenu = yield* ElectronMenu.ElectronMenu;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const previewManager = yield* PreviewManager.PreviewManager;
  const appName = yield* electronApp.name;
  const context = yield* Effect.context<DesktopApplicationMenuRuntimeServices>();
  const runPromise = Effect.runPromiseWith(context);

  const runMenuEffect = <E>(
    action: string,
    effect: Effect.Effect<void, E, DesktopApplicationMenuRuntimeServices>,
  ) => {
    void runPromise(
      effect.pipe(
        Effect.annotateLogs({ action }),
        Effect.withSpan("desktop.menu.action"),
        Effect.catchCause((cause) => {
          const error = new DesktopApplicationMenuActionError({ action, cause });
          return logMenuError(error.message, { error });
        }),
      ),
    );
  };

  // A focused browser tab owns the keyboard like a real browser: its unhandled
  // chords reach this menu, so Pathway's own shortcuts stand down for it.
  // Clicking the item still works.
  const appShortcut =
    (run: (window: Electron.BaseWindow | undefined) => void) =>
    (
      _item: Electron.MenuItem,
      window: Electron.BaseWindow | undefined,
      event: Electron.KeyboardEvent,
    ) => {
      if (event.triggeredByAccelerator && previewManager.isBrowserContentFocused()) return;
      run(window);
    };

  const configure = Effect.gen(function* () {
    const checkForUpdatesClick = () => {
      runMenuEffect("check-for-updates", handleCheckForUpdatesMenuClick);
    };
    const settingsClick = appShortcut(() => {
      runMenuEffect("open-settings", dispatchMenuAction("open-settings"));
    });
    const closeWindowItem: Electron.MenuItemConstructorOptions = {
      label: "Close Window",
      accelerator: "CmdOrCtrl+W",
      click: appShortcut((window) => window?.close()),
    };
    // Panes live in the main window, so DesktopWindow routes these there even
    // when a torn-out window has focus.
    const paneClick = (action: "pane-split" | "pane-close" | "pane-close-all") => () => {
      runMenuEffect(action, dispatchMenuAction(action));
    };
    const closeAllWindowsClick = () => {
      runMenuEffect("close-all-windows", closeAllChildWindows());
    };
    const reloadClick = () => {
      runMenuEffect("reload-app", reloadMainWindow());
    };
    const zoomClick = (direction: DesktopWindow.MainWindowZoomDirection) =>
      appShortcut(() => {
        runMenuEffect(`zoom-${direction}`, zoomMainWindow(direction));
      });
    const template: Electron.MenuItemConstructorOptions[] = [];

    if (environment.platform === "darwin") {
      template.push({
        label: appName,
        submenu: [
          { role: "about" },
          {
            label: "Check for Updates...",
            click: checkForUpdatesClick,
          },
          { type: "separator" },
          {
            label: "Settings...",
            accelerator: "CmdOrCtrl+,",
            click: settingsClick,
          },
          { type: "separator" },
          { role: "services" },
          { type: "separator" },
          { role: "hide" },
          { role: "hideOthers" },
          { role: "unhide" },
          { type: "separator" },
          { role: "quit" },
        ],
      });
    }

    template.push(
      {
        label: "File",
        submenu: [
          ...(environment.platform === "darwin"
            ? []
            : [
                {
                  label: "Settings...",
                  accelerator: "CmdOrCtrl+,",
                  click: settingsClick,
                },
                { type: "separator" as const },
              ]),
          ...(environment.isDevelopment
            ? [
                {
                  label: "Reload App",
                  click: reloadClick,
                },
                { type: "separator" as const },
              ]
            : []),
          environment.platform === "darwin" ? closeWindowItem : { role: "quit" },
        ],
      },
      { role: "editMenu" },
      {
        label: "View",
        submenu: [
          { role: "toggleDevTools" },
          { type: "separator" },
          /*
            Not the zoom roles: those act on the focused webContents, so with
            an embedded preview WebContentsView focused they zoom the guest
            page and the app UI appears stuck. These always zoom the main
            window (see DesktopWindow.zoomMain).
          */
          { label: "Actual Size", accelerator: "CmdOrCtrl+0", click: zoomClick("reset") },
          { label: "Zoom In", accelerator: "CmdOrCtrl+=", click: zoomClick("in") },
          {
            label: "Zoom In",
            accelerator: "CmdOrCtrl+Plus",
            visible: false,
            click: zoomClick("in"),
          },
          { label: "Zoom Out", accelerator: "CmdOrCtrl+-", click: zoomClick("out") },
          { type: "separator" },
          { role: "togglefullscreen" },
          { type: "separator" },
          { label: "Split Panel", click: paneClick("pane-split") },
          { label: "Close Panel", click: paneClick("pane-close") },
          { label: "Close All Panels", click: paneClick("pane-close-all") },
        ],
      },
      {
        role: "windowMenu",
        // Electron's default Window menu, plus closing every torn-out window.
        submenu: [
          { role: "minimize" },
          ...(environment.platform === "darwin" ? [{ role: "zoom" as const }] : [closeWindowItem]),
          { type: "separator" },
          { label: "Close All Pathway Windows", click: closeAllWindowsClick },
          ...(environment.platform === "darwin"
            ? [{ type: "separator" as const }, { role: "front" as const }]
            : []),
        ],
      },
      {
        role: "help",
        submenu: [
          {
            label: "Check for Updates...",
            click: checkForUpdatesClick,
          },
        ],
      },
    );

    yield* electronMenu.setApplicationMenu(template);
  }).pipe(Effect.withSpan("desktop.menu.configure"));

  return DesktopApplicationMenu.of({
    configure,
  });
});

export const layer = Layer.effect(DesktopApplicationMenu, make);
