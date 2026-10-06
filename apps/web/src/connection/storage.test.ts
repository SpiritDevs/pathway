import { ConnectionTransientError } from "@spiritdevs/client-runtime/connection";
import { ConnectionCatalogDocument } from "@spiritdevs/client-runtime/platform";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { afterEach, vi } from "vite-plus/test";

import { connectionCacheDatabaseName } from "./accountScope";
import { IDBFactory } from "fake-indexeddb";

import { adoptLegacyConnectionCache, makeCatalogBackend, makeCatalogStore } from "./storage";

const emptyCatalog = {
  schemaVersion: 1,
  targets: [],
  profiles: [],
  credentials: [],
  remoteDpopTokens: [],
} as const;
const decodeCatalog = Schema.decodeUnknownSync(Schema.fromJsonString(ConnectionCatalogDocument));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("makeCatalogStore", () => {
  it.effect("quarantines malformed catalogs and starts from an empty document", () =>
    Effect.gen(function* () {
      const writes: string[] = [];
      const quarantined: string[] = [];
      const store = yield* makeCatalogStore({
        read: Effect.succeed("{not-json"),
        write: (raw) => Effect.sync(() => writes.push(raw)),
        quarantine: (raw) => Effect.sync(() => quarantined.push(raw)),
      });

      expect(yield* store.read).toEqual(emptyCatalog);
      expect(quarantined).toEqual(["{not-json"]);
      expect(writes).toHaveLength(1);
      expect(decodeCatalog(writes[0]!)).toEqual(emptyCatalog);
    }),
  );

  it.effect("does not hide catalog read failures", () =>
    Effect.gen(function* () {
      const failure = new ConnectionTransientError({
        reason: "remote-unavailable",
        detail: "permission denied",
      });
      const store = yield* makeCatalogStore({
        read: Effect.fail(failure),
        write: () => Effect.void,
      });

      expect(yield* Effect.flip(store.read)).toBe(failure);
    }),
  );

  it.effect("removes legacy relay targets when loading a saved catalog", () =>
    Effect.gen(function* () {
      const writes: string[] = [];
      const store = yield* makeCatalogStore({
        read: Effect.succeed(
          '{"schemaVersion":1,"targets":[{"_tag":"RelayConnectionTarget","environmentId":"legacy-environment","label":"Old Pathway Connect environment"}],"profiles":[],"credentials":[],"remoteDpopTokens":[]}',
        ),
        write: (raw) => Effect.sync(() => writes.push(raw)),
      });

      expect(yield* store.read).toEqual(emptyCatalog);
      expect(writes).toHaveLength(1);
      expect(decodeCatalog(writes[0]!)).toEqual(emptyCatalog);
    }),
  );
});

describe("makeCatalogBackend", () => {
  it.effect("fails writes when desktop secure storage declines the catalog", () =>
    Effect.gen(function* () {
      const setConnectionCatalog = vi.fn().mockResolvedValue(false);
      vi.stubGlobal("window", {
        desktopBridge: {
          getConnectionCatalog: vi.fn().mockResolvedValue(null),
          setConnectionCatalog,
        },
      });
      const backend = makeCatalogBackend({} as IDBDatabase);

      const error = yield* backend.write("{}").pipe(Effect.flip);

      expect(error).toBeInstanceOf(ConnectionTransientError);
      expect(error.message).toContain("Desktop secure storage is unavailable");
      expect(setConnectionCatalog).toHaveBeenCalledWith("{}");
    }),
  );
});

it("isolates environment snapshots from other accounts and legacy unscoped storage", () => {
  expect(connectionCacheDatabaseName("account-a")).not.toBe(
    connectionCacheDatabaseName("account-b"),
  );
  expect(connectionCacheDatabaseName("account-a")).not.toBe("pathway:connection-runtime");
  expect(connectionCacheDatabaseName("a/b")).not.toBe(connectionCacheDatabaseName("a%2Fb"));
});

const openStores = (factory: IDBFactory, name: string) =>
  new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(name, 4);
    request.addEventListener("upgradeneeded", () => {
      for (const store of ["catalog", "shell", "thread", "server-config", "vcs-refs"]) {
        request.result.createObjectStore(store);
      }
    });
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
  });

const readValue = (database: IDBDatabase, store: string, key: string) =>
  new Promise<unknown>((resolve) => {
    const request = database.transaction(store).objectStore(store).get(key);
    request.addEventListener("success", () => resolve(request.result));
  });

it("moves the unscoped cache into the first account cache so saved connections survive", async () => {
  const factory = new IDBFactory();
  const legacy = await openStores(factory, "pathway:connection-runtime");
  const seed = legacy.transaction(["catalog", "thread"], "readwrite");
  seed.objectStore("catalog").put("saved-catalog", "catalog");
  seed.objectStore("thread").put("cached-thread", "env:thread-1");
  await new Promise((resolve) => seed.addEventListener("complete", resolve));
  legacy.close();

  const scoped = await openStores(factory, connectionCacheDatabaseName("account-a"));
  await adoptLegacyConnectionCache(factory, scoped);

  expect(await readValue(scoped, "catalog", "catalog")).toBe("saved-catalog");
  expect(await readValue(scoped, "thread", "env:thread-1")).toBe("cached-thread");
  const remaining = await factory.databases();
  expect(remaining.map((database) => database.name)).not.toContain("pathway:connection-runtime");
});

it("leaves nothing behind when there was no unscoped cache", async () => {
  const factory = new IDBFactory();
  const scoped = await openStores(factory, connectionCacheDatabaseName("account-a"));
  await adoptLegacyConnectionCache(factory, scoped);
  const remaining = await factory.databases();
  expect(remaining.map((database) => database.name)).toEqual([
    connectionCacheDatabaseName("account-a"),
  ]);
});
