import { advanceAlertDelivery, type AlertDeliveryState } from "./index.ts";

const DATABASE = "pathway-thread-alerts-v1";
let database: Promise<IDBDatabase> | undefined;

function openDatabase(): Promise<IDBDatabase> {
  return (database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("delivery");
      request.result.createObjectStore("sounds");
      request.result.createObjectStore("presence");
    };
    request.onsuccess = () => {
      request.result.addEventListener("versionchange", () => {
        request.result.close();
        database = undefined;
      });
      resolve(request.result);
    };
    request.addEventListener("error", () => {
      database = undefined;
      reject(request.error);
    });
  }));
}

interface Presence {
  readonly account: string;
  readonly threadKey: string | null;
  readonly expiresAt: number;
}
interface DeliveryRecord {
  readonly state: AlertDeliveryState | null;
  readonly lease: { readonly owner: string; readonly expiresAt: number };
}

/** An IndexedDB write transaction fences stale leaders and claims events before side effects. */
export async function claimAlertDelivery(
  userId: string,
  owner: string,
  input: Omit<Parameters<typeof advanceAlertDelivery>[0], "state" | "installationId" | "focused">,
) {
  const db = await openDatabase();
  return new Promise<ReturnType<typeof advanceAlertDelivery> | null>((resolve, reject) => {
    const transaction = db.transaction(["delivery", "presence"], "readwrite");
    const store = transaction.objectStore("delivery");
    const stateRequest = store.get(userId);
    const presenceRequest = transaction.objectStore("presence").getAll();
    let result: ReturnType<typeof advanceAlertDelivery> | null = null;
    let requestsCompleted = 0;
    const decide = () => {
      requestsCompleted += 1;
      if (requestsCompleted !== 2) return;
      const record = stateRequest.result as DeliveryRecord | undefined;
      if (record && record.lease.owner !== owner && record.lease.expiresAt > input.now) return;
      const presence = presenceRequest.result as Presence[];
      result = advanceAlertDelivery({
        ...input,
        state: record?.state ?? null,
        installationId: owner,
        focused: (event) =>
          presence.some(
            (tab) =>
              tab.account === userId &&
              tab.expiresAt > input.now &&
              tab.threadKey === JSON.stringify([event.environmentId, event.threadId]),
          ),
      });
      store.put(
        {
          state: result.state,
          lease: { owner, expiresAt: input.now + 15_000 },
        } satisfies DeliveryRecord,
        userId,
      );
    };
    stateRequest.onsuccess = decide;
    presenceRequest.onsuccess = decide;
    transaction.oncomplete = () => resolve(result);
    transaction.addEventListener("error", () => reject(transaction.error));
    transaction.addEventListener("abort", () =>
      reject(transaction.error ?? new Error("Alert storage transaction aborted")),
    );
  });
}

export async function releaseAlertLease(userId: string, owner: string): Promise<void> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("delivery", "readwrite");
    const store = tx.objectStore("delivery");
    const request = store.get(userId);
    request.onsuccess = () => {
      const record = request.result as DeliveryRecord | undefined;
      if (record?.lease.owner === owner)
        store.put({ ...record, lease: { owner, expiresAt: 0 } }, userId);
    };
    tx.oncomplete = () => resolve();
    tx.addEventListener("error", () => reject(tx.error));
  });
}

export async function updateAlertPresence(
  userId: string,
  tabId: string,
  threadKey: string | null,
  now: number,
): Promise<void> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("presence", "readwrite");
    const store = tx.objectStore("presence");
    const request = store.openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      if ((cursor.value as Presence).expiresAt < now) cursor.delete();
      cursor.continue();
    };
    store.put({ account: userId, threadKey, expiresAt: now + 25_000 } satisfies Presence, tabId);
    tx.oncomplete = () => resolve();
    tx.addEventListener("error", () => reject(tx.error));
  });
}

export async function saveAlertSound(id: string, file: Blob): Promise<void> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("sounds", "readwrite");
    tx.objectStore("sounds").put(file, id);
    tx.oncomplete = () => resolve();
    tx.addEventListener("error", () => reject(tx.error));
  });
}

export async function readAlertSound(id: string): Promise<Blob | undefined> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction("sounds").objectStore("sounds").get(id);
    request.onsuccess = () => resolve(request.result as Blob | undefined);
    request.addEventListener("error", () => reject(request.error));
  });
}

export async function deleteAlertSound(id: string): Promise<void> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("sounds", "readwrite");
    tx.objectStore("sounds").delete(id);
    tx.oncomplete = () => resolve();
    tx.addEventListener("error", () => reject(tx.error));
  });
}
