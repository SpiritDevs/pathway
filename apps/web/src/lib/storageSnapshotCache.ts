import { StorageSnapshot, type EnvironmentId } from "@spiritdevs/contracts";
import * as Schema from "effect/Schema";

const DATABASE = "pathway:storage-snapshots";
const STORE = "snapshots";
const decodeSnapshot = Schema.decodeUnknownSync(StorageSnapshot);

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.addEventListener("upgradeneeded", () => request.result.createObjectStore(STORE), {
      once: true,
    });
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error), { once: true });
    request.addEventListener(
      "blocked",
      () => reject(new Error("Storage snapshot cache is unavailable.")),
      { once: true },
    );
  });
}

/** Cached measurements are account scoped and only used for offline presentation. */
export async function readStorageSnapshots(
  accountId: string,
  environmentIds: ReadonlyArray<EnvironmentId>,
): Promise<ReadonlyMap<EnvironmentId, StorageSnapshot>> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(STORE, "readonly");
    const values = await Promise.all(
      environmentIds.map(
        (environmentId) =>
          new Promise<readonly [EnvironmentId, StorageSnapshot | null]>((resolve) => {
            const request = transaction
              .objectStore(STORE)
              .get(JSON.stringify([accountId, environmentId]));
            request.addEventListener(
              "success",
              () => {
                try {
                  resolve([
                    environmentId,
                    request.result === undefined ? null : decodeSnapshot(request.result),
                  ]);
                } catch {
                  resolve([environmentId, null]);
                }
              },
              { once: true },
            );
            request.addEventListener("error", () => resolve([environmentId, null]), { once: true });
          }),
      ),
    );
    return new Map(values.flatMap(([id, snapshot]) => (snapshot ? [[id, snapshot] as const] : [])));
  } finally {
    database.close();
  }
}

export async function writeStorageSnapshot(
  accountId: string,
  environmentId: EnvironmentId,
  snapshot: StorageSnapshot,
): Promise<void> {
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE, "readwrite");
      transaction.objectStore(STORE).put(snapshot, JSON.stringify([accountId, environmentId]));
      transaction.addEventListener("complete", () => resolve(), { once: true });
      transaction.addEventListener("error", () => reject(transaction.error), { once: true });
      transaction.addEventListener("abort", () => reject(transaction.error), { once: true });
    });
  } finally {
    database.close();
  }
}
