import "fake-indexeddb/auto";
import { describe, expect, it } from "vite-plus/test";
import { readQueuedIntents, removeQueuedIntent, saveQueuedIntent } from "./threadQueueOutbox.ts";

describe("durable thread outbox", () => {
  it("persists prompt and file bytes together and scopes recovery to the signed-in account", async () => {
    const record = {
      key: "account-a:company:message",
      accountId: "account-a",
      companyId: "company",
      environmentId: "offline",
      threadId: "thread",
      commandId: "message",
      submission: { text: "Run when reconnected" },
      attachments: [
        {
          metadata: {
            id: "attachment",
            type: "file",
            name: "notes.txt",
            mimeType: "text/plain",
            sizeBytes: 5,
          },
          blob: new Blob(["notes"]),
        },
      ],
      createdAt: 1,
    };
    await saveQueuedIntent(record);
    expect(await readQueuedIntents("account-b")).toEqual([]);
    const [restored] = await readQueuedIntents("account-a");
    expect(restored?.submission).toEqual({ text: "Run when reconnected" });
    expect(await restored?.attachments[0]?.blob.text()).toBe("notes");
    await removeQueuedIntent(record.key);
    expect(await readQueuedIntents("account-a")).toEqual([]);
  });
  it("retries with the same identity replace one stored intent without duplicating it", async () => {
    const record = {
      key: "account-c:company:message",
      accountId: "account-c",
      companyId: "company",
      environmentId: "offline",
      threadId: "thread",
      commandId: "message",
      submission: { text: "Original" },
      attachments: [],
      createdAt: 1,
    };
    await saveQueuedIntent(record);
    await saveQueuedIntent({ ...record, error: "Cloud unavailable" });
    expect(await readQueuedIntents("account-c")).toHaveLength(1);
    await removeQueuedIntent(record.key);
  });
});

import { claimQueuedIntent, editLocalQueuedIntent } from "./threadQueueOutbox.ts";
it("serializes edits and the submission fence across concurrent tabs", async () => {
  const row = {
    key: "fence",
    accountId: "fence-account",
    companyId: "company",
    environmentId: "offline",
    threadId: "thread",
    commandId: "message",
    submission: { text: "Original" },
    attachments: [],
    createdAt: 1,
    revision: 1,
  };
  await saveQueuedIntent(row);
  await editLocalQueuedIntent(row.key, 1, (current) => ({
    ...current,
    submission: { text: "Edited" },
  }));
  expect(await claimQueuedIntent(row.key, 1)).toBeNull();
  expect(await claimQueuedIntent(row.key, 2)).toMatchObject({
    submissionStarted: true,
    submission: { text: "Edited" },
  });
  await expect(
    editLocalQueuedIntent(row.key, 2, (current) => ({ ...current, canceled: true })),
  ).rejects.toThrow("Cloud submission has started");
  await removeQueuedIntent(row.key);
});
it("a cancellation that commits before claiming prevents submission", async () => {
  const row = {
    key: "cancel-fence",
    accountId: "fence-account",
    companyId: "company",
    environmentId: "offline",
    threadId: "thread",
    commandId: "message",
    submission: { text: "Original" },
    attachments: [],
    createdAt: 1,
    revision: 1,
  };
  await saveQueuedIntent(row);
  await editLocalQueuedIntent(row.key, 1, (current) => ({ ...current, canceled: true }));
  expect(await claimQueuedIntent(row.key, 2)).toBeNull();
  await removeQueuedIntent(row.key);
});

import { cancelLocalQueuedThread } from "./threadQueueOutbox.ts";
it("canceling an unsubmitted thread atomically cancels its local followups", async () => {
  const launch = {
    key: "cancel-thread-launch",
    accountId: "cancel-thread-account",
    companyId: "company",
    environmentId: "offline",
    threadId: "thread",
    commandId: "launch",
    submission: { text: "Original" },
    attachments: [],
    createdAt: 1,
    revision: 1,
  };
  await saveQueuedIntent(launch);
  await saveQueuedIntent({ ...launch, key: "cancel-thread-next", commandId: "next", createdAt: 2 });
  await cancelLocalQueuedThread(launch.key, 1);
  const rows = await readQueuedIntents(launch.accountId);
  expect(rows).toHaveLength(2);
  expect(rows.every((row) => row.canceled && row.revision === 2)).toBe(true);
  for (const row of rows) await removeQueuedIntent(row.key);
});

import { createQueuedIntent } from "./threadQueueOutbox.ts";
it("a duplicate local submission cannot replace content or clear an uncertain delivery fence", async () => {
  const row = {
    key: "duplicate-fence",
    accountId: "fence-account",
    companyId: "company",
    environmentId: "offline",
    threadId: "thread",
    commandId: "message",
    submission: { text: "Original" },
    attachments: [],
    createdAt: 1,
    revision: 1,
  };
  await createQueuedIntent(row);
  await claimQueuedIntent(row.key, 1);
  await createQueuedIntent({ ...row, submission: { text: "Accidental duplicate" } });
  const stored = (await readQueuedIntents(row.accountId)).find((item) => item.key === row.key);
  expect(stored).toMatchObject({ submission: { text: "Original" }, submissionStarted: true });
  await removeQueuedIntent(row.key);
});
