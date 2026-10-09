import {
  DesktopBrowserClearDataInputSchema,
  DesktopBrowserDownloadIdSchema,
  DesktopBrowserDownloadSchema,
  DesktopBrowserExtensionManifestSchema,
  DesktopBrowserExtensionSchema,
  DesktopBrowserImportBrowserId,
  DesktopBrowserImportInputSchema,
  DesktopBrowserImportProfileSchema,
  DesktopBrowserImportResultSchema,
  DesktopBrowserPermissionResponseSchema,
} from "@spiritdevs/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as BrowserDownloads from "../../preview/BrowserDownloads.ts";
import * as BrowserExtensions from "../../preview/BrowserExtensions.ts";
import * as BrowserImport from "../../preview/BrowserImport.ts";
import * as BrowserSession from "../../preview/BrowserSession.ts";
import * as DesktopClientSettings from "../../settings/DesktopClientSettings.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

/**
 * Applies the saved browser settings and forwards browser events to every
 * window. Runs once at startup, before any preview page loads.
 */
export const installBrowserSettings = Effect.fn("desktop.ipc.browser.install")(function* () {
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const clientSettings = yield* DesktopClientSettings.DesktopClientSettings;
  const browserSession = yield* BrowserSession.BrowserSession;
  const downloads = yield* BrowserDownloads.BrowserDownloads;
  const extensions = yield* BrowserExtensions.BrowserExtensions;
  const saved = yield* clientSettings.get;
  if (saved._tag === "Some") {
    yield* browserSession.configure(saved.value);
    yield* extensions.configure(saved.value);
  }
  // Listeners are plain callbacks, so each send has to be run, not just built.
  const runFork = Effect.runForkWith(yield* Effect.context<never>());
  const broadcast = (channel: string, ...args: ReadonlyArray<unknown>) => {
    runFork(electronWindow.sendAll(channel, ...args));
  };
  yield* browserSession.subscribePermissionEvents((event) =>
    broadcast(IpcChannels.BROWSER_PERMISSION_EVENT_CHANNEL, event),
  );
  yield* downloads.subscribe((list) =>
    broadcast(IpcChannels.BROWSER_DOWNLOADS_CHANGED_CHANNEL, list),
  );
  yield* extensions.subscribe(() => broadcast(IpcChannels.BROWSER_EXTENSIONS_CHANGED_CHANNEL));
});

export const clearBrowsingData = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.BROWSER_CLEAR_DATA_CHANNEL,
  payload: DesktopBrowserClearDataInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.browser.clearBrowsingData")(function* (input) {
    const browserSession = yield* BrowserSession.BrowserSession;
    const downloads = yield* BrowserDownloads.BrowserDownloads;
    yield* browserSession.clearBrowsingData(input);
    if (input.downloads) yield* downloads.clear();
  }),
});

export const listDownloads = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.BROWSER_DOWNLOADS_LIST_CHANNEL,
  payload: Schema.Void,
  result: Schema.Array(DesktopBrowserDownloadSchema),
  handler: Effect.fn("desktop.ipc.browser.listDownloads")(function* () {
    const downloads = yield* BrowserDownloads.BrowserDownloads;
    return yield* downloads.list();
  }),
});

const downloadMethod = (
  channel: string,
  name: string,
  invoke: (
    downloads: BrowserDownloads.BrowserDownloads["Service"],
    id: string,
  ) => Effect.Effect<void, BrowserDownloads.BrowserDownloadsError>,
) =>
  DesktopIpc.makeIpcMethod({
    channel,
    payload: DesktopBrowserDownloadIdSchema,
    result: Schema.Void,
    handler: Effect.fn(name)(function* ({ id }) {
      const downloads = yield* BrowserDownloads.BrowserDownloads;
      yield* invoke(downloads, id);
    }),
  });

export const openDownload = downloadMethod(
  IpcChannels.BROWSER_DOWNLOADS_OPEN_CHANNEL,
  "desktop.ipc.browser.openDownload",
  (downloads, id) => downloads.open(id),
);
export const showDownload = downloadMethod(
  IpcChannels.BROWSER_DOWNLOADS_SHOW_CHANNEL,
  "desktop.ipc.browser.showDownload",
  (downloads, id) => downloads.showInFolder(id),
);
export const pauseDownload = downloadMethod(
  IpcChannels.BROWSER_DOWNLOADS_PAUSE_CHANNEL,
  "desktop.ipc.browser.pauseDownload",
  (downloads, id) => downloads.pause(id),
);
export const resumeDownload = downloadMethod(
  IpcChannels.BROWSER_DOWNLOADS_RESUME_CHANNEL,
  "desktop.ipc.browser.resumeDownload",
  (downloads, id) => downloads.resume(id),
);
export const cancelDownload = downloadMethod(
  IpcChannels.BROWSER_DOWNLOADS_CANCEL_CHANNEL,
  "desktop.ipc.browser.cancelDownload",
  (downloads, id) => downloads.cancel(id),
);
export const removeDownload = downloadMethod(
  IpcChannels.BROWSER_DOWNLOADS_REMOVE_CHANNEL,
  "desktop.ipc.browser.removeDownload",
  (downloads, id) => downloads.remove(id),
);

export const clearDownloads = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.BROWSER_DOWNLOADS_CLEAR_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.browser.clearDownloads")(function* () {
    const downloads = yield* BrowserDownloads.BrowserDownloads;
    yield* downloads.clear();
  }),
});

export const defaultDownloadDirectory = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.BROWSER_DOWNLOADS_DEFAULT_DIRECTORY_CHANNEL,
  payload: Schema.Void,
  result: Schema.String,
  handler: Effect.fn("desktop.ipc.browser.defaultDownloadDirectory")(function* () {
    const downloads = yield* BrowserDownloads.BrowserDownloads;
    return downloads.defaultDirectory();
  }),
});

export const openDownloadsFolder = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.BROWSER_DOWNLOADS_OPEN_FOLDER_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.browser.openDownloadsFolder")(function* () {
    const downloads = yield* BrowserDownloads.BrowserDownloads;
    yield* downloads.openFolder();
  }),
});

export const listExtensions = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.BROWSER_EXTENSIONS_LIST_CHANNEL,
  payload: Schema.Void,
  result: Schema.Array(DesktopBrowserExtensionSchema),
  handler: Effect.fn("desktop.ipc.browser.listExtensions")(function* () {
    const extensions = yield* BrowserExtensions.BrowserExtensions;
    return yield* extensions.list();
  }),
});

export const inspectExtension = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.BROWSER_EXTENSIONS_INSPECT_CHANNEL,
  payload: Schema.Struct({ path: Schema.String }),
  result: DesktopBrowserExtensionManifestSchema,
  handler: Effect.fn("desktop.ipc.browser.inspectExtension")(function* ({ path }) {
    const extensions = yield* BrowserExtensions.BrowserExtensions;
    return yield* extensions.inspect(path);
  }),
});

export const respondPermission = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.BROWSER_PERMISSION_RESPOND_CHANNEL,
  payload: DesktopBrowserPermissionResponseSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.browser.respondPermission")(function* ({ requestId, allow }) {
    const browserSession = yield* BrowserSession.BrowserSession;
    yield* browserSession.respondPermission(requestId, allow);
  }),
});

export const listImportProfiles = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.BROWSER_IMPORT_LIST_PROFILES_CHANNEL,
  payload: Schema.Void,
  result: Schema.Array(DesktopBrowserImportProfileSchema),
  handler: Effect.fn("desktop.ipc.browser.listImportProfiles")(function* () {
    const browserImport = yield* BrowserImport.BrowserImport;
    return yield* browserImport.listProfiles();
  }),
});

export const isImportBrowserRunning = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.BROWSER_IMPORT_IS_RUNNING_CHANNEL,
  payload: Schema.Struct({ browserId: DesktopBrowserImportBrowserId }),
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.browser.isImportBrowserRunning")(function* ({ browserId }) {
    const browserImport = yield* BrowserImport.BrowserImport;
    return yield* browserImport.isBrowserRunning(browserId);
  }),
});

export const runImport = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.BROWSER_IMPORT_RUN_CHANNEL,
  payload: DesktopBrowserImportInputSchema,
  result: DesktopBrowserImportResultSchema,
  handler: Effect.fn("desktop.ipc.browser.runImport")(function* (input) {
    const browserImport = yield* BrowserImport.BrowserImport;
    const browserSession = yield* BrowserSession.BrowserSession;
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const result = yield* browserImport.importProfile(input.profile, input, {
      extensionsDirectory: environment.path.join(environment.stateDir, "browser-extensions"),
    });
    // Each environment's browser keeps its own cookie jar; sign the user in to all of them.
    const sessions = yield* Effect.forEach(input.environmentIds, (environmentId) =>
      browserSession.getSession(environmentId),
    );
    const imported = yield* Effect.forEach(
      result.cookies,
      (cookie) =>
        Effect.promise(() =>
          Promise.allSettled(sessions.map((previewSession) => previewSession.cookies.set(cookie))),
        ).pipe(Effect.map((settled) => settled.some((entry) => entry.status === "fulfilled"))),
      { concurrency: 16 },
    );
    return {
      passwords: result.passwords,
      cookies: imported.filter(Boolean).length,
      history: result.history,
      extensions: result.extensions,
      skipped: result.skipped,
    };
  }),
});

export const methods: ReadonlyArray<
  DesktopIpc.DesktopIpcMethod<
    unknown,
    | BrowserDownloads.BrowserDownloads
    | BrowserExtensions.BrowserExtensions
    | BrowserImport.BrowserImport
    | BrowserSession.BrowserSession
    | DesktopEnvironment.DesktopEnvironment
  >
> = [
  clearBrowsingData,
  listDownloads,
  openDownload,
  showDownload,
  pauseDownload,
  resumeDownload,
  cancelDownload,
  removeDownload,
  clearDownloads,
  defaultDownloadDirectory,
  openDownloadsFolder,
  listExtensions,
  inspectExtension,
  respondPermission,
  listImportProfiles,
  isImportBrowserRunning,
  runImport,
];
