import type {
  BrowserExtensionSetting,
  ClientSettings,
  DesktopBrowserExtension,
  DesktopBrowserExtensionManifest,
} from "@spiritdevs/contracts";
import type { Session } from "electron";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import * as BrowserSession from "./BrowserSession.ts";

export class BrowserExtensionManifestError extends Schema.TaggedErrorClass<BrowserExtensionManifestError>()(
  "BrowserExtensionManifestError",
  { path: Schema.String, reason: Schema.String },
) {
  override get message(): string {
    return `${this.path} is not an unpacked Chrome extension: ${this.reason}`;
  }
}

const decodeManifest = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      name: Schema.String,
      version: Schema.String,
      description: Schema.optional(Schema.String),
      default_locale: Schema.optional(Schema.String),
    }),
  ),
);
const decodeMessages = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Record(Schema.String, Schema.Struct({ message: Schema.optional(Schema.String) })),
  ),
);

interface LoadState {
  readonly id: string | null;
  readonly error: string | null;
}

/** Resolves a `__MSG_key__` manifest string from the extension's default locale. */
const localize = (
  value: unknown,
  messages: Readonly<Record<string, { readonly message?: unknown }>>,
): string => {
  if (typeof value !== "string") return "";
  const match = /^__MSG_(.+)__$/.exec(value);
  if (!match) return value;
  const key = match[1]!.toLowerCase();
  const entry = Object.entries(messages).find(([name]) => name.toLowerCase() === key)?.[1];
  return typeof entry?.message === "string" ? entry.message : value;
};

export class BrowserExtensions extends Context.Service<
  BrowserExtensions,
  {
    /** Loads enabled extensions and unloads the rest, in every preview session. */
    readonly configure: (settings: ClientSettings) => Effect.Effect<void>;
    readonly list: () => Effect.Effect<ReadonlyArray<DesktopBrowserExtension>>;
    readonly inspect: (
      path: string,
    ) => Effect.Effect<DesktopBrowserExtensionManifest, BrowserExtensionManifestError>;
    readonly subscribe: (listener: () => void) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("@spiritdevs/desktop/preview/BrowserExtensions") {}

export const make = Effect.gen(function* BrowserExtensionsMake() {
  const browserSession = yield* BrowserSession.BrowserSession;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sessions = new Set<Session>();
  const loadStates = new Map<string, LoadState>();
  const listeners = new Set<() => void>();
  let desired: ReadonlyArray<BrowserExtensionSetting> = [];

  const emit = () => {
    for (const listener of listeners) listener();
  };

  /** Brings one session's loaded extensions in line with the settings. */
  const reconcile = async (previewSession: Session) => {
    const enabled = new Set(desired.filter((entry) => entry.enabled).map((entry) => entry.path));
    for (const extension of previewSession.extensions.getAllExtensions()) {
      if (!enabled.has(extension.path)) previewSession.extensions.removeExtension(extension.id);
    }
    const loaded = new Set(previewSession.extensions.getAllExtensions().map((entry) => entry.path));
    await Promise.all(
      [...enabled]
        .filter((extensionPath) => !loaded.has(extensionPath))
        .map(async (extensionPath) => {
          try {
            const extension = await previewSession.extensions.loadExtension(extensionPath, {
              allowFileAccess: false,
            });
            loadStates.set(extensionPath, { id: extension.id, error: null });
          } catch (cause) {
            loadStates.set(extensionPath, {
              id: null,
              error: cause instanceof Error ? cause.message : String(cause),
            });
          }
        }),
    );
    emit();
  };

  const reconcileAll = Effect.promise(() => Promise.all([...sessions].map(reconcile))).pipe(
    Effect.asVoid,
  );

  yield* browserSession.onSession((previewSession) => {
    sessions.add(previewSession);
    void reconcile(previewSession);
  });

  const inspect = Effect.fn("BrowserExtensions.inspect")(function* (extensionPath: string) {
    const manifest = yield* fileSystem
      .readFileString(path.join(extensionPath, "manifest.json"))
      .pipe(
        Effect.flatMap(decodeManifest),
        Effect.mapError(
          () =>
            new BrowserExtensionManifestError({
              path: extensionPath,
              reason: "manifest.json is missing, or has no name or version.",
            }),
        ),
      );
    const messages =
      manifest.default_locale === undefined
        ? {}
        : yield* fileSystem
            .readFileString(
              path.join(extensionPath, "_locales", manifest.default_locale, "messages.json"),
            )
            .pipe(
              Effect.flatMap(decodeMessages),
              Effect.orElseSucceed(() => ({})),
            );
    return {
      name: localize(manifest.name, messages),
      version: manifest.version,
      description: localize(manifest.description, messages),
    };
  });

  return BrowserExtensions.of({
    configure: Effect.fn("BrowserExtensions.configure")(function* (settings: ClientSettings) {
      desired = settings.browserExtensions;
      for (const extensionPath of loadStates.keys()) {
        if (!desired.some((entry) => entry.path === extensionPath))
          loadStates.delete(extensionPath);
      }
      yield* reconcileAll;
    }),
    list: Effect.fn("BrowserExtensions.list")(function* () {
      return yield* Effect.forEach(desired, (entry) =>
        inspect(entry.path).pipe(
          Effect.map((manifest) => ({ manifest, error: null as string | null })),
          Effect.catch((error) =>
            Effect.succeed({
              manifest: { name: path.basename(entry.path), version: "", description: "" },
              error: error.reason as string | null,
            }),
          ),
          Effect.map(({ manifest, error }): DesktopBrowserExtension => {
            const state = loadStates.get(entry.path);
            return {
              id: state?.id ?? null,
              ...manifest,
              path: entry.path,
              enabled: entry.enabled,
              loaded: entry.enabled && state?.id != null && state.error === null,
              error: error ?? state?.error ?? null,
            };
          }),
        ),
      );
    }),
    inspect,
    subscribe: (listener) =>
      Effect.acquireRelease(
        Effect.sync(() => listeners.add(listener)),
        () => Effect.sync(() => listeners.delete(listener)),
      ).pipe(Effect.asVoid),
  });
}).pipe(Effect.withSpan("BrowserExtensions.make"));

export const layer = Layer.effect(BrowserExtensions, make);
