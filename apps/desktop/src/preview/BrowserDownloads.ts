// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off -- Electron download callbacks are synchronous: they name files, stamp times, and throttle progress inline.
import {
  type DesktopBrowserDownload,
  DesktopBrowserDownloadSchema,
  resolveBrowserAgentAccess,
} from "@spiritdevs/contracts";
import { fromLenientJson } from "@spiritdevs/shared/schemaJson";
import { app, shell, type DownloadItem } from "electron";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as NodeFS from "node:fs";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as BrowserSession from "./BrowserSession.ts";

/** Chrome keeps far more; this is enough to find a recent file without a slow list. */
const MAX_DOWNLOADS = 500;
/** Progress updates arrive many times a second; the list repaints at most this often. */
const PROGRESS_EMIT_INTERVAL_MS = 250;

const DownloadsJson = fromLenientJson(Schema.Array(DesktopBrowserDownloadSchema));
const decodeDownloads = Schema.decodeUnknownOption(DownloadsJson);
const encodeDownloads = Schema.encodeEffect(DownloadsJson);

export class BrowserDownloadNotFoundError extends Schema.TaggedErrorClass<BrowserDownloadNotFoundError>()(
  "BrowserDownloadNotFoundError",
  { id: Schema.String },
) {
  override get message(): string {
    return `Download ${this.id} is no longer in the download list.`;
  }
}

export class BrowserDownloadOpenError extends Schema.TaggedErrorClass<BrowserDownloadOpenError>()(
  "BrowserDownloadOpenError",
  { id: Schema.String, reason: Schema.String },
) {
  override get message(): string {
    return `Could not open download ${this.id}: ${this.reason}`;
  }
}

export type BrowserDownloadsError = BrowserDownloadNotFoundError | BrowserDownloadOpenError;

/**
 * A save path that does not overwrite an existing file: `report.pdf`, then
 * `report (1).pdf`, `report (2).pdf`, … like Chrome.
 */
export const uniqueDownloadPath = (
  directory: string,
  filename: string,
  exists: (path: string) => boolean,
  join: (...parts: ReadonlyArray<string>) => string,
): string => {
  const safeName = filename.replace(/[/\\]/g, "_").trim() || "download";
  const dot = safeName.lastIndexOf(".");
  const stem = dot > 0 ? safeName.slice(0, dot) : safeName;
  const extension = dot > 0 ? safeName.slice(dot) : "";
  for (let attempt = 0; attempt < 10_000; attempt += 1) {
    const candidate = join(
      directory,
      attempt === 0 ? safeName : `${stem} (${attempt})${extension}`,
    );
    if (!exists(candidate)) return candidate;
  }
  return join(directory, `${stem} (${Date.now()})${extension}`);
};

const originOf = (url: string | undefined): string | null => {
  if (!url || !URL.canParse(url)) return null;
  const origin = new URL(url).origin;
  return origin === "null" ? null : origin;
};

export class BrowserDownloads extends Context.Service<
  BrowserDownloads,
  {
    readonly list: () => Effect.Effect<ReadonlyArray<DesktopBrowserDownload>>;
    readonly open: (id: string) => Effect.Effect<void, BrowserDownloadsError>;
    readonly showInFolder: (id: string) => Effect.Effect<void, BrowserDownloadsError>;
    readonly pause: (id: string) => Effect.Effect<void, BrowserDownloadsError>;
    readonly resume: (id: string) => Effect.Effect<void, BrowserDownloadsError>;
    readonly cancel: (id: string) => Effect.Effect<void, BrowserDownloadsError>;
    /** Drops an entry from the list, cancelling it first if it is still running. */
    readonly remove: (id: string) => Effect.Effect<void>;
    /** Drops every finished entry. Running downloads stay. */
    readonly clear: () => Effect.Effect<void>;
    readonly defaultDirectory: () => string;
    /** Opens the folder new downloads are saved to. */
    readonly openFolder: () => Effect.Effect<void>;
    readonly subscribe: (
      listener: (downloads: ReadonlyArray<DesktopBrowserDownload>) => void,
    ) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("@spiritdevs/desktop/preview/BrowserDownloads") {}

export const make = Effect.gen(function* BrowserDownloadsMake() {
  const browserSession = yield* BrowserSession.BrowserSession;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const context = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(context);
  const historyPath = path.join(environment.stateDir, "browser-downloads.json");

  const stored = yield* fileSystem.readFileString(historyPath).pipe(
    Effect.map((raw) => Option.getOrElse(decodeDownloads(raw), () => [])),
    Effect.orElseSucceed((): ReadonlyArray<DesktopBrowserDownload> => []),
  );
  // Newest first. A download still running when Pathway quit can't resume.
  let records: ReadonlyArray<DesktopBrowserDownload> = stored.map((record) =>
    record.state === "progressing" || record.state === "paused"
      ? { ...record, state: "interrupted" as const, endedAt: record.endedAt ?? record.startedAt }
      : record,
  );
  const items = new Map<string, DownloadItem>();
  const listeners = new Set<(downloads: ReadonlyArray<DesktopBrowserDownload>) => void>();
  let sequence = 0;
  let progressTimer: ReturnType<typeof setTimeout> | undefined;

  const persist = () =>
    encodeDownloads(records).pipe(
      Effect.flatMap((encoded) =>
        fileSystem
          .makeDirectory(environment.stateDir, { recursive: true })
          .pipe(Effect.andThen(fileSystem.writeFileString(historyPath, encoded))),
      ),
      Effect.catchCause((cause) => Effect.logWarning("Could not save browser downloads.", cause)),
    );

  const withExists = (record: DesktopBrowserDownload): DesktopBrowserDownload =>
    record.state === "completed" && record.path !== ""
      ? { ...record, exists: NodeFS.existsSync(record.path) }
      : record;

  const emit = () => {
    if (listeners.size === 0) return;
    const snapshot = records.map(withExists);
    for (const listener of listeners) listener(snapshot);
  };
  const emitProgress = () => {
    if (progressTimer !== undefined) return;
    progressTimer = setTimeout(() => {
      progressTimer = undefined;
      emit();
    }, PROGRESS_EMIT_INTERVAL_MS);
  };
  /** Records a change; `durable` changes also reach disk. */
  const change = (
    id: string,
    patch: Partial<DesktopBrowserDownload>,
    options: { readonly durable: boolean },
  ) => {
    records = records.map((record) => (record.id === id ? { ...record, ...patch } : record));
    if (options.durable) {
      emit();
      runFork(persist());
    } else {
      emitProgress();
    }
  };
  const add = (record: DesktopBrowserDownload) => {
    records = [record, ...records].slice(0, MAX_DOWNLOADS);
    emit();
    runFork(persist());
  };

  const willDownload = (
    event: Electron.Event,
    item: DownloadItem,
    contents: Electron.WebContents | undefined,
  ) => {
    const settings = browserSession.settings();
    sequence += 1;
    const id = `${Date.now().toString(36)}-${sequence}`;
    const startedAt = new Date().toISOString();
    const initiator = contents && browserSession.isAgentActive(contents.id) ? "agent" : "user";
    const base: DesktopBrowserDownload = {
      id,
      url: item.getURL(),
      filename: item.getFilename(),
      path: "",
      mimeType: item.getMimeType(),
      totalBytes: item.getTotalBytes(),
      receivedBytes: 0,
      state: "progressing",
      startedAt,
      endedAt: null,
      exists: false,
      initiator,
    };
    if (initiator === "agent") {
      const origin = originOf(contents?.getURL()) ?? originOf(item.getURL());
      const access = resolveBrowserAgentAccess(settings.browserAgentPermissions, origin);
      if (!settings.browserAgentControlEnabled || access.download === "block") {
        event.preventDefault();
        add({ ...base, state: "blocked", endedAt: startedAt });
        return;
      }
    }
    const directory = settings.browserDownloadDirectory || app.getPath("downloads");
    if (settings.browserAskWhereToSave) {
      item.setSaveDialogOptions({ defaultPath: path.join(directory, item.getFilename()) });
    } else {
      item.setSavePath(
        uniqueDownloadPath(directory, item.getFilename(), NodeFS.existsSync, path.join),
      );
    }
    items.set(id, item);
    add({ ...base, path: item.getSavePath() });
    item.on("updated", (_event, state) => {
      change(
        id,
        {
          path: item.getSavePath(),
          totalBytes: item.getTotalBytes(),
          receivedBytes: item.getReceivedBytes(),
          state:
            state === "interrupted" ? "interrupted" : item.isPaused() ? "paused" : "progressing",
        },
        { durable: false },
      );
    });
    item.once("done", (_event, state) => {
      items.delete(id);
      change(
        id,
        {
          path: item.getSavePath(),
          totalBytes: item.getTotalBytes(),
          receivedBytes: item.getReceivedBytes(),
          state,
          endedAt: new Date().toISOString(),
        },
        { durable: true },
      );
    });
  };

  yield* browserSession.onSession((previewSession) => {
    previewSession.on("will-download", willDownload);
  });

  const requireRecord = (id: string) => {
    const record = records.find((entry) => entry.id === id);
    return record ? Effect.succeed(record) : Effect.fail(new BrowserDownloadNotFoundError({ id }));
  };
  const withItem = (id: string, act: (item: DownloadItem) => void) =>
    Effect.gen(function* () {
      yield* requireRecord(id);
      const item = items.get(id);
      if (!item) return;
      act(item);
      // Cancelling finishes through the item's `done` event instead.
      if (item.getState() === "progressing") {
        change(id, { state: item.isPaused() ? "paused" : "progressing" }, { durable: false });
      }
    });

  return BrowserDownloads.of({
    list: () => Effect.sync(() => records.map(withExists)),
    open: Effect.fn("BrowserDownloads.open")(function* (id) {
      const record = yield* requireRecord(id);
      const failure = yield* Effect.promise(() => shell.openPath(record.path));
      if (failure !== "") return yield* new BrowserDownloadOpenError({ id, reason: failure });
    }),
    showInFolder: Effect.fn("BrowserDownloads.showInFolder")(function* (id) {
      const record = yield* requireRecord(id);
      if (record.path === "" || !NodeFS.existsSync(record.path)) {
        return yield* new BrowserDownloadOpenError({
          id,
          reason: "The file was moved or deleted.",
        });
      }
      shell.showItemInFolder(record.path);
    }),
    pause: (id) => withItem(id, (item) => item.pause()),
    resume: (id) =>
      withItem(id, (item) => {
        if (item.canResume()) item.resume();
      }),
    cancel: (id) => withItem(id, (item) => item.cancel()),
    remove: (id) =>
      Effect.sync(() => {
        const item = items.get(id);
        if (item) {
          items.delete(id);
          item.cancel();
        }
        records = records.filter((record) => record.id !== id);
        emit();
      }).pipe(Effect.andThen(persist())),
    clear: () =>
      Effect.sync(() => {
        records = records.filter((record) => items.has(record.id));
        emit();
      }).pipe(Effect.andThen(persist())),
    defaultDirectory: () => app.getPath("downloads"),
    openFolder: () =>
      Effect.promise(() =>
        shell.openPath(
          browserSession.settings().browserDownloadDirectory || app.getPath("downloads"),
        ),
      ).pipe(Effect.asVoid),
    subscribe: (listener) =>
      Effect.acquireRelease(
        Effect.sync(() => listeners.add(listener)),
        () => Effect.sync(() => listeners.delete(listener)),
      ).pipe(Effect.asVoid),
  });
}).pipe(Effect.withSpan("BrowserDownloads.make"));

export const layer = Layer.effect(BrowserDownloads, make);
