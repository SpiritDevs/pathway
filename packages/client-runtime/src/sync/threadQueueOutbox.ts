/** Device-durable pending sends. Blob bytes and intent commit together before submission. */
export interface ThreadQueueOutboxRecord<Submission = unknown> {
  readonly key: string;
  readonly accountId: string;
  readonly companyId: string;
  readonly environmentId: string;
  readonly threadId: string;
  readonly commandId: string;
  readonly threadTitle?: string;
  readonly localProjectId?: string | null;
  readonly submission: Submission;
  readonly attachments: ReadonlyArray<{
    readonly metadata: {
      readonly id: string;
      readonly type: string;
      readonly name: string;
      readonly mimeType: string;
      readonly sizeBytes: number;
    };
    readonly blob: Blob;
    readonly storageId?: string;
  }>;
  readonly createdAt: number;
  readonly error?: string;
  readonly revision?: number;
  readonly submissionStarted?: boolean;
  readonly canceled?: boolean;
}

let database: Promise<IDBDatabase> | undefined;
function openDatabase(): Promise<IDBDatabase> {
  return (database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open("pathway-thread-queue-v1", 1);
    request.addEventListener("upgradeneeded", () =>
      request.result.createObjectStore("outbox", { keyPath: "key" }),
    );
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => {
      database = undefined;
      reject(request.error);
    });
  }));
}

export async function saveQueuedIntent(record: ThreadQueueOutboxRecord): Promise<void> {
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("outbox", "readwrite");
    tx.objectStore("outbox").put(record);
    tx.addEventListener("complete", () => resolve());
    tx.addEventListener("error", () => reject(tx.error));
    tx.addEventListener("abort", () =>
      reject(tx.error ?? new Error("Could not save this message on this device.")),
    );
  });
}

export async function removeQueuedIntent(key: string): Promise<void> {
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("outbox", "readwrite");
    tx.objectStore("outbox").delete(key);
    tx.addEventListener("complete", () => resolve());
    tx.addEventListener("error", () => reject(tx.error));
    tx.addEventListener("abort", () => reject(tx.error));
  });
}

export async function readQueuedIntents(
  accountId: string,
): Promise<ReadonlyArray<ThreadQueueOutboxRecord>> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction("outbox").objectStore("outbox").getAll();
    request.addEventListener("success", () =>
      resolve(
        (request.result as ThreadQueueOutboxRecord[])
          .filter((row) => row.accountId === accountId)
          .sort((a, b) => a.createdAt - b.createdAt),
      ),
    );
    request.addEventListener("error", () => reject(request.error));
  });
}

/** A read/write transaction serializes edits and the submission fence across browser tabs. */
export async function changeQueuedIntent(
  key: string,
  change: (current: ThreadQueueOutboxRecord) => ThreadQueueOutboxRecord | null,
): Promise<ThreadQueueOutboxRecord | null> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("outbox", "readwrite");
    const store = tx.objectStore("outbox");
    const request = store.get(key);
    let updated: ThreadQueueOutboxRecord | null = null;
    request.addEventListener("success", () => {
      if (!request.result) return;
      try {
        updated = change(request.result as ThreadQueueOutboxRecord);
        if (updated !== null) store.put(updated);
      } catch (cause) {
        tx.abort();
        reject(cause);
      }
    });
    tx.addEventListener("complete", () => resolve(updated));
    tx.addEventListener("error", () => reject(tx.error));
    tx.addEventListener("abort", () => reject(tx.error ?? new Error("Queue update was canceled.")));
  });
}

/** Once a request may reach cloud, only cloud can safely edit or cancel its stable identity. */
export function claimQueuedIntent(key: string, revision: number) {
  return changeQueuedIntent(key, (current) =>
    (current.revision ?? 1) !== revision || current.canceled
      ? null
      : { ...current, submissionStarted: true },
  );
}

export function editLocalQueuedIntent(
  key: string,
  revision: number,
  change: (current: ThreadQueueOutboxRecord) => ThreadQueueOutboxRecord,
) {
  return changeQueuedIntent(key, (current) => {
    if ((current.revision ?? 1) !== revision)
      throw new Error("This queued message changed in another window. Review it and try again.");
    if (current.submissionStarted)
      throw new Error(
        "Cloud submission has started. Reconnect to confirm whether it can still be changed.",
      );
    return { ...change(current), revision: revision + 1 };
  });
}

export async function cancelLocalQueuedThread(key: string, revision: number): Promise<void> {
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("outbox", "readwrite");
    const store = tx.objectStore("outbox");
    const request = store.getAll();
    request.addEventListener("success", () => {
      try {
        const rows = request.result as ThreadQueueOutboxRecord[];
        const launch = rows.find((row) => row.key === key);
        if (!launch || (launch.revision ?? 1) !== revision)
          throw new Error("This queued thread changed in another window. Review it and try again.");
        const threadRows = rows.filter(
          (row) =>
            row.accountId === launch.accountId &&
            row.companyId === launch.companyId &&
            row.threadId === launch.threadId,
        );
        if (threadRows.some((row) => row.submissionStarted))
          throw new Error(
            "Cloud submission has started. Reconnect to confirm whether it can still be canceled.",
          );
        for (const row of threadRows)
          store.put({ ...row, canceled: true, revision: (row.revision ?? 1) + 1 });
      } catch (cause) {
        tx.abort();
        reject(cause);
      }
    });
    tx.addEventListener("complete", () => resolve());
    tx.addEventListener("error", () => reject(tx.error));
    tx.addEventListener("abort", () => reject(tx.error ?? new Error("Queue cancellation failed.")));
  });
}

/** Retrying one message never replaces an existing intent or clears its submission fence. */
export async function createQueuedIntent(record: ThreadQueueOutboxRecord): Promise<void> {
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("outbox", "readwrite");
    const store = tx.objectStore("outbox");
    const request = store.get(record.key);
    request.addEventListener("success", () => {
      if (!request.result) store.add(record);
    });
    tx.addEventListener("complete", () => resolve());
    tx.addEventListener("error", () => reject(tx.error));
    tx.addEventListener("abort", () =>
      reject(tx.error ?? new Error("Could not save the queued message.")),
    );
  });
}
