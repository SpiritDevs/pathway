// @effect-diagnostics-next-line nodeBuiltinImport:off -- Keychain lookup explicitly uses execFile at this macOS boundary.
import { execFile } from "node:child_process";
import { createDecipheriv, createHash, pbkdf2Sync } from "node:crypto";
import { homedir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

export interface ChromiumBrowserProfile {
  readonly browserId:
    | "chrome"
    | "chrome-beta"
    | "chrome-canary"
    | "chromium"
    | "brave"
    | "edge"
    | "arc"
    | "vivaldi"
    | "opera";
  readonly browserName: string;
  readonly profileDirectory: string;
  readonly profileName: string;
}

export interface BrowserImportSelection {
  readonly passwords: boolean;
  readonly cookies: boolean;
  readonly history: boolean;
  readonly extensions: boolean;
}

export interface ImportedPassword {
  readonly origin: string;
  readonly username: string;
  readonly password: string;
}

export interface ImportedCookie {
  readonly url: string;
  readonly name: string;
  readonly value: string;
  readonly domain?: string;
  readonly path: string;
  readonly secure: boolean;
  readonly httpOnly: boolean;
  readonly expirationDate?: number;
  readonly sameSite: "unspecified" | "no_restriction" | "lax" | "strict";
}

export interface ImportedHistoryEntry {
  readonly url: string;
  readonly title: string;
  readonly lastVisitedAt: string;
  readonly visits: number;
}

export interface ImportedExtension {
  readonly id: string;
  readonly name: string;
  readonly path: string;
}

export interface BrowserImportResult {
  readonly passwords: ReadonlyArray<ImportedPassword>;
  readonly cookies: ReadonlyArray<ImportedCookie>;
  readonly history: ReadonlyArray<ImportedHistoryEntry>;
  readonly extensions: ReadonlyArray<ImportedExtension>;
  readonly skipped: ReadonlyArray<{
    readonly kind: "passwords" | "cookies" | "history" | "extensions";
    readonly reason: string;
  }>;
}

export class BrowserImportUnsupportedPlatformError extends Schema.TaggedErrorClass<BrowserImportUnsupportedPlatformError>()(
  "BrowserImportUnsupportedPlatformError",
  { platform: Schema.String },
) {
  override get message(): string {
    return "Browser import is only supported on macOS.";
  }
}

export class BrowserImportProfileNotFoundError extends Schema.TaggedErrorClass<BrowserImportProfileNotFoundError>()(
  "BrowserImportProfileNotFoundError",
  { browserId: Schema.String, profileDirectory: Schema.String },
) {
  override get message(): string {
    return "The selected browser profile is no longer available.";
  }
}

export class BrowserImportReadError extends Schema.TaggedErrorClass<BrowserImportReadError>()(
  "BrowserImportReadError",
  {
    kind: Schema.Literals(["passwords", "cookies", "history", "extensions"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Could not read browser ${this.kind}.`;
  }
}

export class BrowserImportKeychainError extends Schema.TaggedErrorClass<BrowserImportKeychainError>()(
  "BrowserImportKeychainError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Safe Storage access was denied or unavailable in Keychain.";
  }
}

export const BrowserImportError = Schema.Union([
  BrowserImportUnsupportedPlatformError,
  BrowserImportProfileNotFoundError,
  BrowserImportReadError,
  BrowserImportKeychainError,
]);
export type BrowserImportError = typeof BrowserImportError.Type;

export class BrowserImport extends Context.Service<
  BrowserImport,
  {
    readonly listProfiles: () => Effect.Effect<ReadonlyArray<ChromiumBrowserProfile>>;
    /** A SingletonLock symlink indicates that the source browser may still be running. */
    readonly isBrowserRunning: (
      browserId: ChromiumBrowserProfile["browserId"],
    ) => Effect.Effect<boolean>;
    readonly importProfile: (
      profile: ChromiumBrowserProfile,
      selection: BrowserImportSelection,
      options: { readonly extensionsDirectory: string },
    ) => Effect.Effect<BrowserImportResult, BrowserImportError>;
  }
>()("@spiritdevs/desktop/preview/BrowserImport") {}

const browsers = {
  chrome: { name: "Google Chrome", directory: "Google/Chrome", account: "Chrome" },
  "chrome-beta": { name: "Google Chrome Beta", directory: "Google/Chrome Beta", account: "Chrome" },
  "chrome-canary": {
    name: "Google Chrome Canary",
    directory: "Google/Chrome Canary",
    account: "Chrome",
  },
  chromium: { name: "Chromium", directory: "Chromium", account: "Chromium" },
  brave: { name: "Brave", directory: "BraveSoftware/Brave-Browser", account: "Brave" },
  edge: { name: "Microsoft Edge", directory: "Microsoft Edge", account: "Microsoft Edge" },
  arc: { name: "Arc", directory: "Arc/User Data", account: "Arc" },
  vivaldi: { name: "Vivaldi", directory: "Vivaldi", account: "Vivaldi" },
  opera: { name: "Opera", directory: "com.operasoftware.Opera", account: "Opera" },
} as const;

interface BrowserImportOptions {
  /** Replaces all default roots, including browsers omitted from this map. */
  readonly userDataRoots?: Partial<Readonly<Record<ChromiumBrowserProfile["browserId"], string>>>;
  /** Returns the Keychain password, before PBKDF2 derivation. */
  readonly readSafeStorageKey?: (service: string, account: string) => Promise<string>;
  readonly platform?: NodeJS.Platform;
  readonly temporaryDirectory?: string;
}

const LocalState = Schema.fromJsonString(
  Schema.Struct({
    profile: Schema.Struct({
      info_cache: Schema.Record(
        Schema.String,
        Schema.Struct({ name: Schema.optionalKey(Schema.String) }),
      ),
    }),
  }),
);
const Manifest = Schema.fromJsonString(
  Schema.Struct({
    name: Schema.optionalKey(Schema.String),
    default_locale: Schema.optionalKey(Schema.String),
    theme: Schema.optionalKey(Schema.Unknown),
  }),
);
const Messages = Schema.fromJsonString(
  Schema.Record(Schema.String, Schema.Struct({ message: Schema.String })),
);
const Preferences = Schema.fromJsonString(
  Schema.Struct({
    extensions: Schema.optionalKey(
      Schema.Struct({
        settings: Schema.optionalKey(
          Schema.Record(
            Schema.String,
            Schema.Struct({ location: Schema.optionalKey(Schema.Number) }),
          ),
        ),
      }),
    ),
  }),
);
const decodePasswords = Schema.decodeUnknownSync(
  Schema.Array(
    Schema.Struct({
      origin_url: Schema.String,
      username_value: Schema.String,
      password_value: Schema.Uint8Array,
    }),
  ),
);
const decodeCookies = Schema.decodeUnknownSync(
  Schema.Array(
    Schema.Struct({
      host_key: Schema.String,
      name: Schema.String,
      value: Schema.String,
      encrypted_value: Schema.Uint8Array,
      path: Schema.String,
      expires_utc: Schema.Number,
      is_secure: Schema.Number,
      is_httponly: Schema.Number,
      samesite: Schema.Number,
    }),
  ),
);
const decodeHistory = Schema.decodeUnknownSync(
  Schema.Array(
    Schema.Struct({
      url: Schema.String,
      title: Schema.String,
      visit_count: Schema.Number,
      last_visit_time: Schema.Number,
    }),
  ),
);

const chromeMilliseconds = (microseconds: number) => (microseconds - 11_644_473_600_000_000) / 1000;
const chromeSeconds = (microseconds: number) => chromeMilliseconds(microseconds) / 1000;
const isDirectoryName = (name: string) =>
  name.length > 0 && name !== "." && name !== ".." && !/[\\/\0]/.test(name);
const httpUrl = (value: string) => {
  const url = URL.parse(value);
  return url?.protocol === "http:" || url?.protocol === "https:" ? url : undefined;
};

const readKeychainPassword = (service: string, account: string): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(
      "/usr/bin/security",
      ["find-generic-password", "-w", "-s", service, "-a", account],
      { encoding: "utf8" },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout.replace(/\r?\n$/, ""));
      },
    );
  });

const decrypt = (encrypted: Uint8Array, key: Buffer): Buffer | undefined => {
  if (Buffer.from(encrypted.subarray(0, 3)).toString("ascii") !== "v10") return undefined;
  try {
    const decipher = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
    return Buffer.concat([decipher.update(encrypted.subarray(3)), decipher.final()]);
  } catch {
    return undefined;
  }
};

const readPasswords = (database: DatabaseSync, key: Buffer): Array<ImportedPassword> => {
  const rows = decodePasswords(
    database
      .prepare(
        "SELECT origin_url, username_value, password_value FROM logins WHERE blacklisted_by_user = 0",
      )
      .all(),
  );
  return rows.flatMap((row) => {
    const origin = httpUrl(row.origin_url)?.origin;
    if (!origin) return [];
    const password = decrypt(row.password_value, key)?.toString("utf8");
    return password ? [{ origin, username: row.username_value, password }] : [];
  });
};

const readCookies = (database: DatabaseSync, key: Buffer, now: number): Array<ImportedCookie> => {
  const hasMeta = database
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'")
    .get();
  const version = hasMeta
    ? Number(database.prepare("SELECT value FROM meta WHERE key = 'version'").get()?.value ?? 0)
    : 0;
  const rows = decodeCookies(
    database
      .prepare(
        "SELECT host_key, name, value, encrypted_value, path, CAST(expires_utc AS REAL) AS expires_utc, is_secure, is_httponly, samesite FROM cookies",
      )
      .all(),
  );
  return rows.flatMap((row): Array<ImportedCookie> => {
    const expirationDate = row.expires_utc === 0 ? undefined : chromeSeconds(row.expires_utc);
    if (expirationDate !== undefined && expirationDate <= now) return [];
    const secure = row.is_secure !== 0;
    const url = `${secure ? "https" : "http"}://${row.host_key.replace(/^\./, "")}${row.path}`;
    if (!httpUrl(url)) return [];
    let value = row.value;
    if (!value && row.encrypted_value.length > 0) {
      let plaintext = decrypt(row.encrypted_value, key);
      if (!plaintext) return [];
      if (version >= 24) {
        const hostHash = createHash("sha256").update(row.host_key).digest();
        if (!plaintext.subarray(0, 32).equals(hostHash)) return [];
        plaintext = plaintext.subarray(32);
      }
      value = plaintext.toString("utf8");
    }
    return [
      {
        url,
        name: row.name,
        value,
        path: row.path,
        secure,
        httpOnly: row.is_httponly !== 0,
        ...(row.host_key.startsWith(".") ? { domain: row.host_key } : {}),
        ...(expirationDate === undefined ? {} : { expirationDate }),
        sameSite:
          row.samesite === 0
            ? "no_restriction"
            : row.samesite === 1
              ? "lax"
              : row.samesite === 2
                ? "strict"
                : "unspecified",
      },
    ];
  });
};

const readHistory = (database: DatabaseSync): Array<ImportedHistoryEntry> => {
  const rows = decodeHistory(
    database
      .prepare(
        "SELECT url, title, visit_count, CAST(last_visit_time AS REAL) AS last_visit_time FROM urls WHERE hidden = 0 AND (url LIKE 'http://%' OR url LIKE 'https://%') ORDER BY last_visit_time DESC LIMIT 5000",
      )
      .all(),
  );
  return rows.flatMap((row) => {
    const date = DateTime.make(chromeMilliseconds(row.last_visit_time));
    return httpUrl(row.url) && Option.isSome(date)
      ? [
          {
            url: row.url,
            title: row.title,
            lastVisitedAt: DateTime.formatIso(date.value),
            visits: row.visit_count,
          },
        ]
      : [];
  });
};

export const make = Effect.fn("BrowserImport.make")(function* (options: BrowserImportOptions = {}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = options.platform ?? process.platform;
  const lookupKey = options.readSafeStorageKey ?? readKeychainPassword;
  const rootFor = (id: ChromiumBrowserProfile["browserId"]) =>
    options.userDataRoots === undefined
      ? path.join(homedir(), "Library", "Application Support", browsers[id].directory)
      : options.userDataRoots[id];
  const isDirectory = (directory: string) =>
    fs.stat(directory).pipe(
      Effect.map((info) => info.type === "Directory"),
      Effect.orElseSucceed(() => false),
    );
  const readError = (kind: keyof BrowserImportSelection) => (cause: unknown) =>
    new BrowserImportReadError({ kind, cause });

  const listProfiles = Effect.fn("BrowserImport.listProfiles")(function* () {
    if (platform !== "darwin") return [];
    const profiles: Array<ChromiumBrowserProfile> = [];
    for (const browserId of Object.keys(browsers) as Array<ChromiumBrowserProfile["browserId"]>) {
      const root = rootFor(browserId);
      if (!root) continue;
      const state = yield* fs.readFileString(path.join(root, "Local State")).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(LocalState)),
        Effect.orElseSucceed(() => undefined),
      );
      for (const [profileDirectory, info] of Object.entries(state?.profile.info_cache ?? {})) {
        if (
          !isDirectoryName(profileDirectory) ||
          !(yield* isDirectory(path.join(root, profileDirectory)))
        )
          continue;
        profiles.push({
          browserId,
          browserName: browsers[browserId].name,
          profileDirectory,
          profileName: info.name || profileDirectory,
        });
      }
    }
    return profiles;
  });

  const isBrowserRunning = Effect.fn("BrowserImport.isBrowserRunning")(function* (
    browserId: ChromiumBrowserProfile["browserId"],
  ) {
    const root = rootFor(browserId);
    if (platform !== "darwin" || !root) return false;
    return yield* fs.readLink(path.join(root, "SingletonLock")).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
  });

  const readDatabase = Effect.fn("BrowserImport.readDatabase")(function* <A>(
    kind: "passwords" | "cookies" | "history",
    source: string,
    read: (database: DatabaseSync) => A,
  ) {
    return yield* Effect.acquireUseRelease(
      fs.makeTempDirectory({
        directory: options.temporaryDirectory,
        prefix: "pathway-browser-import-",
      }),
      Effect.fn("BrowserImport.readDatabaseCopy")(function* (temporary) {
        const copy = path.join(temporary, path.basename(source));
        yield* fs.copyFile(source, copy);
        for (const suffix of ["-wal", "-journal"]) {
          if (yield* fs.exists(`${source}${suffix}`))
            yield* fs.copyFile(`${source}${suffix}`, `${copy}${suffix}`);
        }
        return yield* Effect.try({
          try: () => {
            const database = new DatabaseSync(copy, { readOnly: true });
            try {
              return read(database);
            } finally {
              database.close();
            }
          },
          catch: readError(kind),
        });
      }),
      (temporary) => fs.remove(temporary, { recursive: true, force: true }),
    ).pipe(Effect.mapError(readError(kind)));
  });

  const readExtensions = Effect.fn("BrowserImport.readExtensions")(
    function* (
      profileDirectory: string,
      destination: string,
      skipped: Array<BrowserImportResult["skipped"][number]>,
    ) {
      const source = path.join(profileDirectory, "Extensions");
      const components = new Set<string>();
      for (const filename of ["Preferences", "Secure Preferences"]) {
        const preferences = yield* fs.readFileString(path.join(profileDirectory, filename)).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Preferences)),
          Effect.orElseSucceed(() => undefined),
        );
        // Chromium persists component ManifestLocation values in extension preferences.
        for (const [id, entry] of Object.entries(preferences?.extensions?.settings ?? {})) {
          if (entry.location === 5 || entry.location === 10) components.add(id);
        }
      }
      const extensions: Array<ImportedExtension> = [];
      for (const id of yield* fs.readDirectory(source)) {
        if (!/^[a-p]{32}$/.test(id)) continue;
        if (components.has(id)) continue;
        yield* Effect.gen(function* () {
          const versions = (yield* fs.readDirectory(path.join(source, id)))
            .filter((version) => /^\d+(?:\.\d+)*(?:_\d+)?$/.test(version))
            .sort((a, b) => b.localeCompare(a, "en", { numeric: true }));
          let versionDirectory: string | undefined;
          for (const version of versions) {
            const candidate = path.join(source, id, version);
            if (yield* isDirectory(candidate)) {
              versionDirectory = candidate;
              break;
            }
          }
          if (!versionDirectory) return;
          const manifest = yield* fs
            .readFileString(path.join(versionDirectory, "manifest.json"))
            .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Manifest)));
          if (manifest.theme !== undefined) return;
          let name = manifest.name || id;
          const messageKey = /^__MSG_(.+)__$/i.exec(name)?.[1];
          if (messageKey) {
            name = id;
            if (manifest.default_locale && isDirectoryName(manifest.default_locale)) {
              const messages = yield* fs
                .readFileString(
                  path.join(versionDirectory, "_locales", manifest.default_locale, "messages.json"),
                )
                .pipe(
                  Effect.flatMap(Schema.decodeUnknownEffect(Messages)),
                  Effect.orElseSucceed(() => undefined),
                );
              name =
                Object.entries(messages ?? {}).find(
                  ([key]) => key.toLowerCase() === messageKey.toLowerCase(),
                )?.[1].message || id;
            }
          }
          const target = path.join(destination, id);
          yield* fs.makeDirectory(destination, { recursive: true });
          yield* fs.remove(target, { recursive: true, force: true });
          yield* fs.copy(versionDirectory, target);
          extensions.push({ id, name, path: target });
        }).pipe(
          Effect.mapError(readError("extensions")),
          Effect.catch((error) =>
            Effect.sync(() => {
              skipped.push({
                kind: "extensions",
                reason: `${error.message} Extension ${id} was skipped.`,
              });
            }),
          ),
        );
      }
      return extensions;
    },
    Effect.mapError(readError("extensions")),
  );

  const importProfile = Effect.fn("BrowserImport.importProfile")(function* (
    profile: ChromiumBrowserProfile,
    selection: BrowserImportSelection,
    importOptions: { readonly extensionsDirectory: string },
  ) {
    if (platform !== "darwin")
      return yield* new BrowserImportUnsupportedPlatformError({ platform });
    const root = rootFor(profile.browserId);
    if (
      !root ||
      !isDirectoryName(profile.profileDirectory) ||
      !(yield* isDirectory(path.join(root, profile.profileDirectory)))
    ) {
      return yield* new BrowserImportProfileNotFoundError({
        browserId: profile.browserId,
        profileDirectory: profile.profileDirectory,
      });
    }
    const profileDirectory = path.join(root, profile.profileDirectory);
    const skipped: Array<BrowserImportResult["skipped"][number]> = [];
    const collect = <A>(
      kind: keyof BrowserImportSelection,
      effect: Effect.Effect<Array<A>, BrowserImportReadError>,
    ) =>
      effect.pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            skipped.push({ kind, reason: error.message });
            return [];
          }),
        ),
      );
    let key: Buffer | undefined;
    if (selection.passwords || selection.cookies) {
      const account = browsers[profile.browserId].account;
      key = yield* Effect.tryPromise({
        try: async () =>
          pbkdf2Sync(
            await lookupKey(`${account} Safe Storage`, account),
            "saltysalt",
            1003,
            16,
            "sha1",
          ),
        catch: (cause) => new BrowserImportKeychainError({ cause }),
      }).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            for (const kind of ["passwords", "cookies"] as const) {
              if (selection[kind]) skipped.push({ kind, reason: error.message });
            }
            return undefined;
          }),
        ),
      );
    }
    return yield* Effect.gen(function* () {
      const passwords =
        selection.passwords && key
          ? yield* collect(
              "passwords",
              readDatabase("passwords", path.join(profileDirectory, "Login Data"), (db) =>
                readPasswords(db, key),
              ),
            )
          : [];
      const cookies =
        selection.cookies && key
          ? yield* collect(
              "cookies",
              Effect.gen(function* () {
                const networkCookies = path.join(profileDirectory, "Network", "Cookies");
                const source = (yield* fs.exists(networkCookies))
                  ? networkCookies
                  : path.join(profileDirectory, "Cookies");
                const now = yield* DateTime.now;
                return yield* readDatabase("cookies", source, (db) =>
                  readCookies(db, key, DateTime.toEpochMillis(now) / 1000),
                );
              }).pipe(Effect.mapError(readError("cookies"))),
            )
          : [];
      const history = selection.history
        ? yield* collect(
            "history",
            readDatabase("history", path.join(profileDirectory, "History"), readHistory),
          )
        : [];
      const extensions = selection.extensions
        ? yield* collect(
            "extensions",
            readExtensions(profileDirectory, importOptions.extensionsDirectory, skipped),
          )
        : [];
      return { passwords, cookies, history, extensions, skipped } satisfies BrowserImportResult;
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          key?.fill(0);
        }),
      ),
    );
  });

  return BrowserImport.of({ listProfiles, isBrowserRunning, importProfile });
});

export const layer = Layer.effect(BrowserImport, make());
