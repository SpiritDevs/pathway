import { describe, expect, it } from "vite-plus/test";
import { MessageId, ThreadId } from "@spiritdevs/contracts";
import type { ThreadQueueThread } from "@spiritdevs/contracts/threadQueue";
import { buildThreadQueueSubmission } from "@spiritdevs/client-runtime/operations";
import {
  findQueuedThread,
  parseQueuedThreadSearch,
  mergeThreadQueueEntries,
  reconcileQueuedThreadReceipts,
} from "./threadQueueState";
const cloud: ThreadQueueThread = {
  threadId: "thread",
  environmentId: "environment",
  localProjectId: null,
  cloudProjectId: null,
  title: "Original title",
  launch: null,
  state: "delivered",
  error: null,
  revision: 2,
  acceptedAt: 1,
  queuedCount: 0,
  createdAt: 1,
  updatedAt: 2,
};
const pending = {
  key: "pending",
  accountId: "account",
  companyId: "company",
  threadId: "thread",
  environmentId: "environment",
  commandId: "next",
  createdAt: 3,
  attachments: [],
  submission: buildThreadQueueSubmission(
    {
      threadId: ThreadId.make("thread"),
      message: {
        messageId: MessageId.make("next"),
        role: "user",
        text: "A follow-up while offline",
        attachments: [],
      },
      runtimeMode: "full-access",
      interactionMode: "default",
    },
    [],
  ),
};
describe("queued sidebar handoff", () => {
  it("keeps stable queue identities in canonical links and rejects malformed search values", () => {
    expect(parseQueuedThreadSearch({ queueId: "durable-queue", unrelated: true })).toEqual({
      queueId: "durable-queue",
    });
    expect(parseQueuedThreadSearch({ queueId: ["bad"] })).toEqual({});
    expect(parseQueuedThreadSearch({ queueId: "" })).toEqual({});
  });
  it("keeps legacy company conversation followups in the conversations list while offline", () => {
    const [entry] = mergeThreadQueueEntries(
      [],
      [{ ...pending, localProjectId: "conversations:company" }],
    );
    expect(entry?.localProjectId).toBeNull();
  });
  it("keeps acknowledged threads visible across an older list snapshot until its revision arrives", () => {
    const receipt = { ...cloud, revision: 3, queuedCount: 1 };
    const first = reconcileQueuedThreadReceipts([], new Map([[cloud.threadId, receipt]]));
    expect(first.rows).toEqual([receipt]);
    const stale = reconcileQueuedThreadReceipts([cloud], first.pending);
    expect(stale.rows).toEqual([receipt]);
    const caughtUp = reconcileQueuedThreadReceipts([receipt], stale.pending);
    expect(caughtUp.rows).toEqual([receipt]);
    expect(caughtUp.pending.size).toBe(0);
    expect(reconcileQueuedThreadReceipts([], caughtUp.pending).rows).toEqual([]);
  });
  it("retains local followups on a cloud-backed thread and reports their unsynced state", () => {
    expect(mergeThreadQueueEntries([cloud], [pending])).toEqual([
      { ...cloud, waitingToSync: true, cloudSaved: true, queuedCount: 1, updatedAt: 3 },
    ]);
  });
  it("retains canceled device-only work without claiming cloud durability", () => {
    const [entry] = mergeThreadQueueEntries([], [{ ...pending, canceled: true }]);
    expect(entry).toMatchObject({ state: "canceled", cloudSaved: false, waitingToSync: false });
  });
  it("keeps matching thread IDs in separate environments independent", () => {
    const other = { ...cloud, environmentId: "other", queueId: "other-queue" };
    const first = { ...cloud, queueId: "first-queue" };
    const entries = mergeThreadQueueEntries([first, other], [pending]);
    expect(entries).toHaveLength(2);
    expect(entries.find((row) => row.queueId === "first-queue")?.waitingToSync).toBe(true);
    expect(entries.find((row) => row.queueId === "other-queue")?.waitingToSync).toBe(false);
    expect(findQueuedThread(entries, "other", "thread")?.queueId).toBe("other-queue");
    expect(findQueuedThread(entries, "missing", "thread")).toBeUndefined();
  });
  it("merges a moved receipt by stable queue identity", () => {
    const before = { ...cloud, queueId: "queue", originEnvironmentId: "environment" };
    const moved = { ...before, environmentId: "replacement", revision: 3 };
    const merged = reconcileQueuedThreadReceipts([before], new Map([["queue", moved]]));
    expect(merged.rows).toEqual([moved]);
    expect(mergeThreadQueueEntries([moved], [{ ...pending, queueId: "queue" }])).toHaveLength(1);
    expect(mergeThreadQueueEntries([moved], [pending])).toHaveLength(1);
    expect(findQueuedThread([moved], "environment", "thread")).toEqual(moved);
  });
});
