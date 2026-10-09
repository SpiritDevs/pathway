// @effect-diagnostics nodeBuiltinImport:off -- Tests create and inspect isolated filesystem fixtures.
import { createCipheriv, createHash, pbkdf2Sync } from "node:crypto";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  BrowserImportProfileNotFoundError,
  BrowserImportUnsupportedPlatformError,
  make,
  type BrowserImportSelection,
  type ChromiumBrowserProfile,
} from "./BrowserImport.ts";

const platformLayer = Layer.merge(NodeFileSystem.layer, NodePath.layer);
const keychainPassword = "fixture-keychain-password";
const key = pbkdf2Sync(keychainPassword, "saltysalt", 1003, 16, "sha1");
const profile: ChromiumBrowserProfile = {
  browserId: "chrome",
  browserName: "Google Chrome",
  profileDirectory: "Default",
  profileName: "Personal",
};
const all: BrowserImportSelection = {
  passwords: true,
  cookies: true,
  history: true,
  extensions: true,
};
const none: BrowserImportSelection = {
  passwords: false,
  cookies: false,
  history: false,
  extensions: false,
};
const extensionId = "a".repeat(32);
const themeId = "b".repeat(32);
const componentId = "c".repeat(32);
const externalComponentId = "d".repeat(32);
const unresolvedId = "e".repeat(32);
const chromeTime = (iso: string) => BigInt(Date.parse(iso)) * 1000n + 11_644_473_600_000_000n;
const encrypted = (plaintext: string | Buffer) => {
  const cipher = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
  return Buffer.concat([Buffer.from("v10"), cipher.update(plaintext), cipher.final()]);
};
const encryptedCookie = (host: string, value: string) =>
  encrypted(Buffer.concat([createHash("sha256").update(host).digest(), Buffer.from(value)]));

describe("BrowserImport", () => {
  let directory: string;
  let root: string;
  let source: string;
  let temporaryDirectory: string;
  let extensionsDirectory: string;
  let lookup: ReturnType<typeof vi.fn<(service: string, account: string) => Promise<string>>>;
  const writeJson = async (filename: string, value: unknown) => {
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await fs.writeFile(filename, JSON.stringify(value));
  };
  const createImporter = (overrides: Parameters<typeof make>[0] = {}) =>
    Effect.runPromise(
      make({
        platform: "darwin",
        userDataRoots: { chrome: root },
        readSafeStorageKey: lookup,
        temporaryDirectory,
        ...overrides,
      }).pipe(Effect.provide(platformLayer)),
    );
  const importSelection = async (selection = all) => {
    const importer = await createImporter();
    return Effect.runPromise(importer.importProfile(profile, selection, { extensionsDirectory }));
  };
  const writeExtension = async (id: string, version: string, manifest: object) => {
    const versionDirectory = path.join(source, "Extensions", id, version);
    await writeJson(path.join(versionDirectory, "manifest.json"), {
      manifest_version: 3,
      version: version.split("_")[0],
      ...manifest,
    });
    await fs.writeFile(path.join(versionDirectory, "script.js"), `// ${version}`);
    return versionDirectory;
  };

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(tmpdir(), "pathway-browser-import-test-"));
    root = path.join(directory, "Chrome");
    source = path.join(root, "Default");
    temporaryDirectory = path.join(directory, "temporary");
    extensionsDirectory = path.join(directory, "imported-extensions");
    lookup = vi.fn(async () => keychainPassword);
    await fs.mkdir(path.join(source, "Network"), { recursive: true });
    await fs.mkdir(temporaryDirectory);
    await fs.mkdir(path.join(root, "Profile 1"));
    await fs.writeFile(path.join(root, "Not a directory"), "file");
    await writeJson(path.join(root, "Local State"), {
      profile: {
        info_cache: {
          Default: { name: "Personal" },
          "Profile 1": {},
          Missing: { name: "Deleted" },
          "Not a directory": { name: "File" },
          "../temporary": { name: "Outside root" },
        },
      },
    });
    const passwords = new DatabaseSync(path.join(source, "Login Data"));
    try {
      passwords.exec(
        "CREATE TABLE logins (origin_url TEXT, username_value TEXT, password_value BLOB, blacklisted_by_user INTEGER)",
      );
      const insert = passwords.prepare("INSERT INTO logins VALUES (?, ?, ?, ?)");
      insert.run("https://example.com/login?next=home", "alice", encrypted("pāssword"), 0);
      insert.run("http://example.net:8080/signin", "bob", encrypted("second"), 0);
      insert.run("https://blocked.example", "blocked", encrypted("never"), 1);
      insert.run("https://empty.example", "empty", encrypted(""), 0);
      insert.run("android://example", "mobile", encrypted("never"), 0);
      insert.run("https://broken.example", "broken", Buffer.from("v10invalid"), 0);
      insert.run("https://future.example", "future", Buffer.from("v20unsupported"), 0);
    } finally {
      passwords.close();
    }
    const cookies = new DatabaseSync(path.join(source, "Network", "Cookies"));
    try {
      cookies.exec(
        "CREATE TABLE meta (key TEXT, value TEXT); INSERT INTO meta VALUES ('version', '24'); CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, path TEXT, expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER, samesite INTEGER)",
      );
      const insert = cookies.prepare("INSERT INTO cookies VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
      insert.run(
        ".example.com",
        "domain",
        "",
        encryptedCookie(".example.com", "cookie-secret"),
        "/account",
        chromeTime("2099-01-01T00:00:00.000Z"),
        1,
        1,
        1,
      );
      insert.run(
        "session.example",
        "session",
        "",
        encryptedCookie("session.example", "session-secret"),
        "/",
        0,
        0,
        0,
        -1,
      );
      insert.run(
        "expired.example",
        "expired",
        "",
        encryptedCookie("expired.example", "old"),
        "/",
        chromeTime("2000-01-01T00:00:00.000Z"),
        1,
        0,
        2,
      );
      insert.run("bad.example", "broken", "", Buffer.from("v10broken"), "/", 0, 1, 0, 0);
      insert.run(
        "wrong.example",
        "wrong-host",
        "",
        encryptedCookie("different.example", "mismatch"),
        "/",
        0,
        1,
        0,
        0,
      );
      insert.run("short.example", "short-hash", "", encrypted("short"), "/", 0, 1, 0, 0);
      insert.run("plain.example", "plain", "plain-value", Buffer.alloc(0), "/", 0, 1, 0, 2);
      insert.run("empty.example", "empty", "", Buffer.alloc(0), "/", 0, 1, 0, 0);
    } finally {
      cookies.close();
    }
    const history = new DatabaseSync(path.join(source, "History"));
    try {
      history.exec(
        "CREATE TABLE urls (url TEXT, title TEXT, visit_count INTEGER, last_visit_time INTEGER, hidden INTEGER)",
      );
      const insert = history.prepare("INSERT INTO urls VALUES (?, ?, ?, ?, ?)");
      insert.run(
        "https://older.example/path",
        "Older",
        3,
        chromeTime("2026-01-01T00:00:00.000Z"),
        0,
      );
      insert.run("http://newer.example/", "Newer", 7, chromeTime("2026-03-01T12:34:56.789Z"), 0);
      insert.run("https://hidden.example/", "Hidden", 1, chromeTime("2026-04-01T00:00:00.000Z"), 1);
      insert.run("chrome://settings", "Settings", 2, chromeTime("2026-05-01T00:00:00.000Z"), 0);
      insert.run("file:///private/file", "File", 1, chromeTime("2026-05-01T00:00:00.000Z"), 0);
      insert.run("https://", "Invalid", 1, chromeTime("2026-05-01T00:00:00.000Z"), 0);
    } finally {
      history.close();
    }
    await writeExtension(extensionId, "1.9_0", { name: "Old version" });
    const latest = await writeExtension(extensionId, "1.10_0", {
      name: "__MSG_extensionName__",
      default_locale: "en",
    });
    await writeJson(path.join(latest, "_locales", "en", "messages.json"), {
      extensionname: { message: "Fixture extension" },
    });
    await writeExtension(themeId, "1.0_0", { name: "Theme", theme: {} });
    await writeExtension(componentId, "1.0_0", { name: "Component" });
    await writeExtension(externalComponentId, "1.0_0", { name: "External component" });
    await writeExtension(unresolvedId, "1.0_0", { name: "__MSG_missing__", default_locale: "en" });
    await writeJson(path.join(source, "Preferences"), {
      extensions: {
        settings: {
          [componentId]: { location: 5 },
        },
      },
    });
    await writeJson(path.join(source, "Secure Preferences"), {
      extensions: { settings: { [externalComponentId]: { location: 10 } } },
    });
  });
  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  it("lists existing profile directories and detects dangling SingletonLock symlinks", async () => {
    const importer = await createImporter();
    expect(await Effect.runPromise(importer.listProfiles())).toEqual([
      profile,
      { ...profile, profileDirectory: "Profile 1", profileName: "Profile 1" },
    ]);
    expect(await Effect.runPromise(importer.isBrowserRunning("chrome"))).toBe(false);
    await fs.symlink("fixture-host-12345", path.join(root, "SingletonLock"));
    expect(await Effect.runPromise(importer.isBrowserRunning("chrome"))).toBe(true);
    expect(await Effect.runPromise(importer.isBrowserRunning("edge"))).toBe(false);
    expect(lookup).not.toHaveBeenCalled();
  });
  it("ignores malformed Local State and missing browser roots", async () => {
    await fs.writeFile(path.join(root, "Local State"), "not JSON");
    const importer = await createImporter({
      userDataRoots: { chrome: root, edge: path.join(directory, "missing") },
    });
    expect(await Effect.runPromise(importer.listProfiles())).toEqual([]);
  });
  it.each([
    ["chrome", "Google Chrome", "Chrome"],
    ["chrome-beta", "Google Chrome Beta", "Chrome"],
    ["chrome-canary", "Google Chrome Canary", "Chrome"],
    ["chromium", "Chromium", "Chromium"],
    ["brave", "Brave", "Brave"],
    ["edge", "Microsoft Edge", "Microsoft Edge"],
    ["arc", "Arc", "Arc"],
    ["vivaldi", "Vivaldi", "Vivaldi"],
    ["opera", "Opera", "Opera"],
  ] as const)(
    "lists %s and uses its Safe Storage service/account",
    async (browserId, browserName, account) => {
      const importer = await createImporter({ userDataRoots: { [browserId]: root } });
      const profiles = await Effect.runPromise(importer.listProfiles());
      expect(profiles[0]).toEqual({ ...profile, browserId, browserName });
      const result = await Effect.runPromise(
        importer.importProfile(
          { ...profile, browserId, browserName },
          { ...none, passwords: true },
          { extensionsDirectory },
        ),
      );
      expect(result.passwords).toHaveLength(2);
      expect(lookup).toHaveBeenCalledExactlyOnceWith(`${account} Safe Storage`, account);
    },
  );
  it("decrypts passwords and v24 cookies and omits expired/invalid values", async () => {
    const result = await importSelection({ ...none, passwords: true, cookies: true });
    expect(result.passwords).toEqual([
      { origin: "https://example.com", username: "alice", password: "pāssword" },
      { origin: "http://example.net:8080", username: "bob", password: "second" },
    ]);
    expect(result.cookies).toEqual([
      {
        url: "https://example.com/account",
        name: "domain",
        value: "cookie-secret",
        domain: ".example.com",
        path: "/account",
        secure: true,
        httpOnly: true,
        expirationDate: Date.parse("2099-01-01T00:00:00.000Z") / 1000,
        sameSite: "lax",
      },
      {
        url: "http://session.example/",
        name: "session",
        value: "session-secret",
        path: "/",
        secure: false,
        httpOnly: false,
        sameSite: "unspecified",
      },
      {
        url: "https://plain.example/",
        name: "plain",
        value: "plain-value",
        path: "/",
        secure: true,
        httpOnly: false,
        sameSite: "strict",
      },
      {
        url: "https://empty.example/",
        name: "empty",
        value: "",
        path: "/",
        secure: true,
        httpOnly: false,
        sameSite: "no_restriction",
      },
    ]);
    expect(result.skipped).toEqual([]);
    expect(lookup).toHaveBeenCalledExactlyOnceWith("Chrome Safe Storage", "Chrome");
    expect(await fs.readdir(temporaryDirectory)).toEqual([]);
  });
  it("falls back to legacy Cookies and decrypts pre-v24 values without a host hash", async () => {
    await fs.rename(path.join(source, "Network", "Cookies"), path.join(source, "Cookies"));
    const database = new DatabaseSync(path.join(source, "Cookies"));
    try {
      database.exec("UPDATE meta SET value = '23'; DELETE FROM cookies");
      database
        .prepare("INSERT INTO cookies VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run("legacy.example", "legacy", "", encrypted("legacy-secret"), "/", 0, 1, 1, 1);
    } finally {
      database.close();
    }
    const result = await importSelection({ ...none, cookies: true });
    expect(result.cookies).toEqual([
      {
        url: "https://legacy.example/",
        name: "legacy",
        value: "legacy-secret",
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "lax",
      },
    ]);
  });
  it("maps history timestamps and counts, orders newest first and excludes hidden/non-http entries", async () => {
    const result = await importSelection({ ...none, history: true });
    expect(result.history).toEqual([
      {
        url: "http://newer.example/",
        title: "Newer",
        visits: 7,
        lastVisitedAt: "2026-03-01T12:34:56.789Z",
      },
      {
        url: "https://older.example/path",
        title: "Older",
        visits: 3,
        lastVisitedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    expect(lookup).not.toHaveBeenCalled();
  });
  it("caps history at 5000 entries", async () => {
    const database = new DatabaseSync(path.join(source, "History"));
    try {
      database.exec("DELETE FROM urls; BEGIN");
      const insert = database.prepare("INSERT INTO urls VALUES (?, 'Title', 1, ?, 0)");
      for (let i = 0; i < 5005; i++)
        insert.run(
          `https://example.com/${i}`,
          chromeTime("2026-01-01T00:00:00.000Z") + BigInt(i) * 1_000_000n,
        );
      database.exec("COMMIT");
    } finally {
      database.close();
    }
    const result = await importSelection({ ...none, history: true });
    expect(result.history).toHaveLength(5000);
    expect(result.history[0]?.url).toBe("https://example.com/5004");
    expect(result.history.at(-1)?.url).toBe("https://example.com/5");
  });
  it("copies the highest extension version, resolves names, replaces existing copies and skips themes/components", async () => {
    const target = path.join(extensionsDirectory, extensionId);
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(path.join(target, "obsolete.js"), "obsolete");
    const result = await importSelection({ ...none, extensions: true });
    expect(result.extensions).toEqual([
      { id: extensionId, name: "Fixture extension", path: target },
      { id: unresolvedId, name: unresolvedId, path: path.join(extensionsDirectory, unresolvedId) },
    ]);
    expect(await fs.readFile(path.join(target, "script.js"), "utf8")).toBe("// 1.10_0");
    expect(await fs.readdir(target)).not.toContain("obsolete.js");
    expect(await fs.readdir(extensionsDirectory)).toEqual([extensionId, unresolvedId]);
    expect(
      await fs.readFile(path.join(source, "Extensions", extensionId, "1.9_0", "script.js"), "utf8"),
    ).toBe("// 1.9_0");
    expect(lookup).not.toHaveBeenCalled();
  });
  it("continues importing other extensions after a malformed manifest", async () => {
    await fs.writeFile(
      path.join(source, "Extensions", extensionId, "1.10_0", "manifest.json"),
      "broken",
    );
    const result = await importSelection({ ...none, extensions: true });
    expect(result.extensions.map((extension) => extension.id)).toEqual([unresolvedId]);
    expect(result.skipped).toEqual([
      { kind: "extensions", reason: expect.stringContaining(extensionId) },
    ]);
  });
  it("reports Keychain denial and still imports history/extensions without exposing the cause", async () => {
    lookup.mockRejectedValue(new Error("private-keychain-error-do-not-expose"));
    const result = await importSelection();
    expect(result.passwords).toEqual([]);
    expect(result.cookies).toEqual([]);
    expect(result.history).toHaveLength(2);
    expect(result.extensions).toHaveLength(2);
    expect(result.skipped).toEqual([
      { kind: "passwords", reason: "Safe Storage access was denied or unavailable in Keychain." },
      { kind: "cookies", reason: "Safe Storage access was denied or unavailable in Keychain." },
    ]);
    expect(JSON.stringify(result)).not.toContain("private-keychain-error-do-not-expose");
    expect(await fs.readdir(temporaryDirectory)).toEqual([]);
  });
  it("does not access Keychain or databases when nothing is selected", async () => {
    expect(await importSelection(none)).toEqual({
      passwords: [],
      cookies: [],
      history: [],
      extensions: [],
      skipped: [],
    });
    expect(lookup).not.toHaveBeenCalled();
    expect(await fs.readdir(temporaryDirectory)).toEqual([]);
  });
  it("reports only the selected protected kind when Keychain is denied", async () => {
    lookup.mockRejectedValue(new Error("denied"));
    expect(
      (await importSelection({ ...none, cookies: true })).skipped.map((entry) => entry.kind),
    ).toEqual(["cookies"]);
  });
  it("cleans up copies after read/copy failures and continues with readable kinds", async () => {
    await fs.writeFile(path.join(source, "Login Data"), "not sqlite");
    await fs.rm(path.join(source, "Network", "Cookies"));
    const result = await importSelection();
    expect(result.skipped).toEqual([
      { kind: "passwords", reason: "Could not read browser passwords." },
      { kind: "cookies", reason: "Could not read browser cookies." },
    ]);
    expect(result.history).toHaveLength(2);
    expect(result.extensions).toHaveLength(2);
    expect(await fs.readdir(temporaryDirectory)).toEqual([]);
  });
  it("reads committed WAL data from a copy, copies journal siblings and preserves the live database", async () => {
    const database = new DatabaseSync(path.join(source, "History"));
    try {
      database.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0");
      database
        .prepare("INSERT INTO urls VALUES (?, ?, ?, ?, 0)")
        .run("https://wal.example/", "WAL entry", 1, chromeTime("2026-06-01T00:00:00.000Z"));
      await fs.writeFile(path.join(source, "Login Data-journal"), Buffer.alloc(512));
      const copies: Array<{ from: string; to: string }> = [];
      const importer = await Effect.runPromise(
        Effect.gen(function* () {
          const realFs = yield* FileSystem.FileSystem;
          return yield* make({
            platform: "darwin",
            userDataRoots: { chrome: root },
            readSafeStorageKey: lookup,
            temporaryDirectory,
          }).pipe(
            Effect.provideService(FileSystem.FileSystem, {
              ...realFs,
              copyFile: (from, to) => {
                copies.push({ from, to });
                return realFs.copyFile(from, to);
              },
            }),
          );
        }).pipe(Effect.provide(platformLayer)),
      );
      const before = await fs.readFile(path.join(source, "History"));
      const walBefore = await fs.readFile(path.join(source, "History-wal"));
      const result = await Effect.runPromise(
        importer.importProfile(
          profile,
          { ...none, passwords: true, history: true },
          { extensionsDirectory },
        ),
      );
      expect(result.history[0]?.url).toBe("https://wal.example/");
      expect(result.passwords).toHaveLength(2);
      expect(result.skipped).toEqual([]);
      expect(copies.map((copy) => path.basename(copy.from))).toContain("History-wal");
      expect(copies.map((copy) => path.basename(copy.from))).toContain("Login Data-journal");
      expect(copies.every((copy) => copy.to.startsWith(`${temporaryDirectory}${path.sep}`))).toBe(
        true,
      );
      expect(await fs.readFile(path.join(source, "History"))).toEqual(before);
      expect(await fs.readFile(path.join(source, "History-wal"))).toEqual(walBefore);
      expect(await fs.readdir(temporaryDirectory)).toEqual([]);
    } finally {
      database.close();
    }
  });
  it("removes temporary copies when an import is interrupted", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const realFs = yield* FileSystem.FileSystem;
        const copying = yield* Deferred.make<void>();
        const importer = yield* make({
          platform: "darwin",
          userDataRoots: { chrome: root },
          readSafeStorageKey: lookup,
          temporaryDirectory,
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...realFs,
            copyFile: (from, to) =>
              realFs
                .copyFile(from, to)
                .pipe(
                  Effect.andThen(Deferred.succeed(copying, undefined)),
                  Effect.andThen(Effect.never),
                ),
          }),
        );
        const fiber = yield* importer
          .importProfile(profile, { ...none, history: true }, { extensionsDirectory })
          .pipe(Effect.forkChild);
        yield* Deferred.await(copying);
        yield* Fiber.interrupt(fiber);
      }).pipe(Effect.provide(platformLayer)),
    );
    expect(await fs.readdir(temporaryDirectory)).toEqual([]);
  });
  it("fails with typed errors for missing profiles and unsupported platforms", async () => {
    const importer = await createImporter();
    expect(
      await Effect.runPromise(
        importer
          .importProfile({ ...profile, profileDirectory: "Missing" }, all, { extensionsDirectory })
          .pipe(Effect.flip),
      ),
    ).toBeInstanceOf(BrowserImportProfileNotFoundError);
    expect(
      await Effect.runPromise(
        importer
          .importProfile({ ...profile, profileDirectory: "../temporary" }, all, {
            extensionsDirectory,
          })
          .pipe(Effect.flip),
      ),
    ).toBeInstanceOf(BrowserImportProfileNotFoundError);
    const unsupported = await createImporter({ platform: "linux" });
    expect(await Effect.runPromise(unsupported.listProfiles())).toEqual([]);
    expect(await Effect.runPromise(unsupported.isBrowserRunning("chrome"))).toBe(false);
    expect(
      await Effect.runPromise(
        unsupported.importProfile(profile, all, { extensionsDirectory }).pipe(Effect.flip),
      ),
    ).toBeInstanceOf(BrowserImportUnsupportedPlatformError);
    expect(lookup).not.toHaveBeenCalled();
  });
});
