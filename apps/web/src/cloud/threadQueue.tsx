import { useAuth } from "@clerk/react";
import { useAtomValue } from "@effect/atom-react";
import {
  buildThreadQueueSubmission,
  type StartThreadTurnInput,
} from "@spiritdevs/client-runtime/operations";
import { settlePromise } from "@spiritdevs/client-runtime/state/runtime";
import {
  ChatAttachmentId,
  OrchestrationV2ThreadLaunchInput,
  OrchestrationV2Command,
  type ChatAttachment,
  type EnvironmentId,
} from "@spiritdevs/contracts";
import type { CompanyId } from "@spiritdevs/contracts/company";
import type {
  ThreadQueueDetail,
  ThreadQueueSubmission,
  ThreadQueueThread,
  ThreadQueueDestination,
} from "@spiritdevs/contracts/threadQueue";
import { ConvexClient } from "convex/browser";
import { ConvexError } from "convex/values";
import { makeFunctionReference } from "convex/server";
import * as Schema from "effect/Schema";
import { useCallback, useEffect } from "react";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readThreadShell } from "../state/entities";
import { activeCompanyIdAtom } from "./activeCompany";
import { resolveCloudSyncConvexUrl } from "./publicConfig";
import { makeClerkConvexTokenFetcher } from "./syncTransportAuth";
import { mapEnvironmentControlError } from "./environmentControl";
import {
  readQueuedIntents,
  changeQueuedIntent,
  claimQueuedIntent,
  cancelLocalQueuedThread,
  editLocalQueuedIntent,
  removeQueuedIntent,
  createQueuedIntent,
  type ThreadQueueOutboxRecord,
} from "@spiritdevs/client-runtime/sync/thread-queue-outbox";

import {
  threadQueueRowsAtom,
  localThreadQueueAtom,
  threadQueueAccountAtom,
  threadQueueDestinationsAtom,
  reconcileQueuedThreadReceipts,
} from "./threadQueueState";
export {
  threadQueueRowsAtom,
  localThreadQueueAtom,
  threadQueueAccountAtom,
  threadQueueDestinationsAtom,
} from "./threadQueueState";
const decodeQueueLaunch = Schema.decodeUnknownSync(OrchestrationV2ThreadLaunchInput);
const decodeQueueMessage = Schema.decodeUnknownSync(OrchestrationV2Command);
const ref = {
  list: makeFunctionReference<"query", { companyId: string }, ReadonlyArray<ThreadQueueThread>>(
    "threadQueue:list",
  ),
  getThread: makeFunctionReference<
    "query",
    { companyId: string; threadId: string },
    ThreadQueueDetail | null
  >("threadQueue:getThread"),
  enqueue: makeFunctionReference<
    "mutation",
    {
      companyId: string;
      environmentId: string;
      threadId: string;
      submission: ThreadQueueSubmission;
      attachmentIds: string[];
    },
    ThreadQueueDetail
  >("threadQueue:enqueue"),
  generateUploadUrl: makeFunctionReference<"mutation", { companyId: string }, string>(
    "threadQueue:generateUploadUrl",
  ),
  registerAttachment: makeFunctionReference<
    "mutation",
    { companyId: string; storageId: string; attachment: ChatAttachment },
    string
  >("threadQueue:registerAttachment"),
};
const definitiveQueueRejections = new Set([
  "invalid-arguments",
  "binding-unavailable",
  "permission-denied",
  "thread-unavailable",
  "attachment-unavailable",
  "invalid-command-state",
  "destination-changed",
  "provider-unavailable",
  "environment-unavailable",
  "not-a-member",
  "company-unavailable",
  "user-not-provisioned",
]);
function isDefinitiveQueueRejection(error: unknown) {
  return (
    error instanceof ConvexError &&
    error.data !== null &&
    typeof error.data === "object" &&
    "code" in error.data &&
    typeof error.data.code === "string" &&
    definitiveQueueRejections.has(error.data.code)
  );
}

export function threadQueueErrorMessage(error: unknown) {
  if (error instanceof ConvexError) return mapEnvironmentControlError(error).message;
  return error instanceof Error ? error.message : "The queue could not be updated.";
}

let session: {
  client: ConvexClient;
  accountId: string;
  companyId: CompanyId;
  receipts: Map<string, ThreadQueueThread>;
} | null = null;
let drain: Promise<void> | null = null;
let drainAgain = false;
let queueChannel: BroadcastChannel | null = null;
function notifyOtherTabs() {
  // eslint-disable-next-line unicorn/require-post-message-target-origin -- BroadcastChannel has no targetOrigin argument.
  queueChannel?.postMessage("changed");
}
const announce = async (accountId: string) => {
  const rows = (await readQueuedIntents(accountId)) as ReadonlyArray<
    ThreadQueueOutboxRecord<ThreadQueueSubmission>
  >;
  if (session?.accountId === accountId)
    appAtomRegistry.set(
      localThreadQueueAtom,
      rows.filter((row) => row.companyId === session?.companyId),
    );
};

/** One drain independent of route lifetime; cloud command IDs make retries idempotent. */
export function flushThreadQueue(): Promise<void> {
  if (drain) return drain;
  const current = session;
  if (!current) return Promise.resolve();
  if (!current.client.connectionState().isWebSocketConnected) return announce(current.accountId);
  const stillCurrent = () => session === current;
  drain = (async () => {
    const rows = (await readQueuedIntents(current.accountId)) as ReadonlyArray<
      ThreadQueueOutboxRecord<ThreadQueueSubmission>
    >;
    if (!stillCurrent()) return;
    const blocked = new Set<string>();
    for (let row of rows) {
      if (!stillCurrent()) return;
      const threadKey = `${row.companyId}:${row.threadId}`;
      if (blocked.has(threadKey)) continue;
      if (row.canceled) {
        if (row.submission.kind === "launch") blocked.add(threadKey);
        continue;
      }
      const revision = row.revision ?? 1;
      try {
        const attachmentIds: string[] = [];
        let superseded = false;
        for (const [index, file] of row.attachments.entries()) {
          let storageId = file.storageId;
          if (!storageId) {
            const url = await current.client.mutation(ref.generateUploadUrl, {
              companyId: row.companyId,
            });
            if (!stillCurrent()) return;
            const response = await fetch(url, {
              method: "POST",
              body: file.blob,
              headers: { "Content-Type": file.metadata.mimeType },
            });
            if (!stillCurrent()) return;
            if (!response.ok) throw new Error(`Attachment upload failed (${response.status}).`);
            const uploaded = (await response.json()) as { storageId: string };
            if (!stillCurrent()) return;
            storageId = uploaded.storageId;
            const updated = await changeQueuedIntent(row.key, (stored) => {
              if ((stored.revision ?? 1) !== revision || stored.canceled) return null;
              return {
                ...stored,
                attachments: stored.attachments.map((entry, i) =>
                  i === index ? { ...entry, storageId: uploaded.storageId } : entry,
                ),
              };
            });
            if (!stillCurrent()) return;
            if (!updated) {
              superseded = true;
              break;
            }
            row = updated as ThreadQueueOutboxRecord<ThreadQueueSubmission>;
          }
          const id = await current.client.mutation(ref.registerAttachment, {
            companyId: row.companyId,
            storageId,
            attachment: file.metadata as ChatAttachment,
          });
          if (!stillCurrent()) return;
          attachmentIds.push(id);
        }
        if (superseded) {
          blocked.add(threadKey);
          drainAgain = true;
          continue;
        }
        if (!current.client.connectionState().isWebSocketConnected) return;
        const claimed = await claimQueuedIntent(row.key, revision);
        if (!stillCurrent()) return;
        if (!claimed) {
          blocked.add(threadKey);
          drainAgain = true;
          continue;
        }
        await announce(current.accountId);
        if (!stillCurrent()) return;
        notifyOtherTabs();
        const accepted = await current.client.mutation(ref.enqueue, {
          companyId: row.companyId,
          environmentId: row.environmentId,
          threadId: row.threadId,
          submission: row.submission,
          attachmentIds,
        });
        if (!stillCurrent()) return;
        if (row.companyId === current.companyId) {
          current.receipts.set(accepted.thread.threadId, accepted.thread);
          const merged = reconcileQueuedThreadReceipts(
            appAtomRegistry.get(threadQueueRowsAtom),
            current.receipts,
          );
          appAtomRegistry.set(threadQueueRowsAtom, merged.rows);
        }
        await removeQueuedIntent(row.key);
        if (!stillCurrent()) return;
        notifyOtherTabs();
      } catch (error) {
        if (!stillCurrent()) return;
        await changeQueuedIntent(row.key, (stored) =>
          (stored.revision ?? 1) === revision
            ? {
                ...stored,
                error: threadQueueErrorMessage(error),
                ...(isDefinitiveQueueRejection(error) ? { submissionStarted: false } : {}),
              }
            : null,
        );
        if (!stillCurrent()) return;
        blocked.add(threadKey);
      }
    }
    await announce(current.accountId);
  })().finally(() => {
    drain = null;
    if (drainAgain || session !== current) {
      drainAgain = false;
      void flushThreadQueue();
    }
  });
  return drain;
}

export function ThreadQueueRuntime() {
  const { getToken, isSignedIn, userId } = useAuth({ treatPendingAsSignedOut: false });
  const companyId = useAtomValue(activeCompanyIdAtom);
  useEffect(() => {
    const url = resolveCloudSyncConvexUrl();
    if (!isSignedIn || !userId || !companyId || !url) return;
    const client = new ConvexClient(url);
    client.setAuth(makeClerkConvexTokenFetcher(getToken));
    const current = {
      client,
      accountId: userId,
      companyId,
      receipts: new Map<string, ThreadQueueThread>(),
    };
    session = current;
    const channel = new BroadcastChannel(`pathway-thread-queue:${userId}`);
    queueChannel = channel;
    channel.addEventListener("message", () => {
      if (session === current) void announce(userId).then(() => flushThreadQueue());
    });
    appAtomRegistry.set(threadQueueAccountAtom, `${userId}:${companyId}`);
    const unsubscribe = client.onUpdate(ref.list, { companyId }, (rows) => {
      if (session !== current) return;
      const merged = reconcileQueuedThreadReceipts(rows, current.receipts);
      current.receipts = merged.pending;
      appAtomRegistry.set(threadQueueRowsAtom, merged.rows);
      void flushThreadQueue();
    });
    const unsubscribeDestinations = subscribeQueueDestinations(undefined, (destinations) => {
      if (session === current) appAtomRegistry.set(threadQueueDestinationsAtom, destinations);
    });
    const reconnect = () => {
      void flushThreadQueue();
    };
    const unsubscribeConnection = client.subscribeToConnectionState((state) => {
      if (session === current && state.isWebSocketConnected) reconnect();
    });
    window.addEventListener("online", reconnect);
    window.addEventListener("focus", reconnect);
    void announce(userId).then(reconnect);
    return () => {
      unsubscribe();
      unsubscribeConnection();
      unsubscribeDestinations();
      channel.close();
      if (queueChannel === channel) queueChannel = null;
      window.removeEventListener("online", reconnect);
      window.removeEventListener("focus", reconnect);
      if (session === current) {
        session = null;
        appAtomRegistry.set(threadQueueAccountAtom, null);
        appAtomRegistry.set(threadQueueRowsAtom, []);
        appAtomRegistry.set(threadQueueDestinationsAtom, []);
        appAtomRegistry.set(localThreadQueueAtom, []);
      }
      void client.close();
    };
  }, [companyId, getToken, isSignedIn, userId]);
  return null;
}

export interface QueuedThreadTurnTarget {
  readonly environmentId: EnvironmentId;
  readonly input: StartThreadTurnInput;
  readonly durableAttachments?: ReadonlyArray<{
    readonly metadata: ChatAttachment;
    readonly blob: Blob;
  }>;
}

export async function queueThreadTurn(target: QueuedThreadTurnTarget) {
  const current = session;
  if (!current) throw new Error("Sign in to Pathway Cloud and select a company before sending.");
  const files = target.durableAttachments
    ? target.durableAttachments.map((file, index) => ({
        ...file,
        metadata: {
          ...file.metadata,
          id: ChatAttachmentId.make(`queue-${target.input.message.messageId}-${index}`),
        },
      }))
    : await Promise.all(
        target.input.message.attachments.map(async (attachment, index) => {
          if (!("dataUrl" in attachment))
            throw new Error(`Attach ${attachment.name} again so it can be saved to the cloud.`);
          const blob = await (await fetch(attachment.dataUrl)).blob();
          const { dataUrl: _, ...metadata } = attachment;
          return {
            metadata: {
              ...metadata,
              id: ChatAttachmentId.make(`queue-${target.input.message.messageId}-${index}`),
            },
            blob,
          };
        }),
      );
  const existingThread = readThreadShell({
    environmentId: target.environmentId,
    threadId: target.input.threadId,
  });
  const submission = buildThreadQueueSubmission(
    target.input,
    files.map((file) => file.metadata),
    existingThread,
    existingThread?.runtime?.activeRunId,
  );
  // Refuse invalid commands before clearing the composer or creating an unretryable outbox row.
  if (submission.kind === "launch") decodeQueueLaunch(submission.input);
  else decodeQueueMessage(submission.input);
  const record: ThreadQueueOutboxRecord<ThreadQueueSubmission> = {
    key: `${current.accountId}:${current.companyId}:${submission.input.commandId}`,
    accountId: current.accountId,
    companyId: current.companyId,
    environmentId: target.environmentId,
    threadId: target.input.threadId,
    commandId: submission.input.commandId,
    ...(existingThread
      ? { threadTitle: existingThread.title, localProjectId: existingThread.projectId }
      : {}),
    submission,
    attachments: files,
    createdAt: Date.now(),
    revision: 1,
  };
  await createQueuedIntent(record);
  if (session !== current) return { sequence: 0 };
  notifyOtherTabs();
  await announce(current.accountId);
  target.input.onLaunchDispatch?.();
  if (drain) drainAgain = true;
  void flushThreadQueue();
  return { sequence: 0 };
}

export function useQueuedStartThreadTurn() {
  return useCallback(
    (target: QueuedThreadTurnTarget) => settlePromise(() => queueThreadTurn(target)),
    [],
  );
}

export function subscribeQueuedThread(
  threadId: string,
  onChange: (detail: ThreadQueueDetail | null) => void,
): () => void {
  if (!session) return () => {};
  return session.client.onUpdate(
    ref.getThread,
    { companyId: session.companyId, threadId },
    onChange,
  );
}

export async function mutateQueuedThread(
  action: "edit" | "cancel" | "retry" | "reassign",
  args: Record<string, string | number | null | object>,
) {
  if (!session) throw new Error("Cloud authentication is unavailable.");
  return session.client.mutation(makeFunctionReference<"mutation">(`threadQueue:${action}`), {
    companyId: session.companyId,
    ...args,
  });
}

export type { ThreadQueueDestination } from "@spiritdevs/contracts/threadQueue";
export function subscribeQueueDestinations(
  threadId: string | undefined,
  onChange: (destinations: readonly ThreadQueueDestination[]) => void,
) {
  if (!session) return () => {};
  return session.client.onUpdate(
    makeFunctionReference<
      "query",
      { companyId: string; threadId?: string },
      readonly ThreadQueueDestination[]
    >("threadQueue:destinations"),
    { companyId: session.companyId, ...(threadId ? { threadId } : {}) },
    onChange,
  );
}

export async function mutateLocalQueuedMessage(
  key: string,
  revision: number,
  action: "edit" | "cancel" | "retry",
  text?: string,
) {
  const current = session;
  if (!current) throw new Error("Cloud authentication is unavailable.");
  const localRows = (await readQueuedIntents(
    current.accountId,
  )) as readonly ThreadQueueOutboxRecord<ThreadQueueSubmission>[];
  if (session !== current) return;
  const local = localRows.find((row) => row.key === key && row.companyId === current.companyId);
  if (!local)
    throw new Error("The pending message is no longer on this device. Refresh the thread.");
  if (action === "cancel" && local.submission.kind === "launch")
    await cancelLocalQueuedThread(key, revision);
  else
    await editLocalQueuedIntent(key, revision, (stored) => {
      if (stored.accountId !== current.accountId || stored.companyId !== current.companyId)
        throw new Error("This message belongs to another account or company.");
      const submission = stored.submission as ThreadQueueSubmission;
      const updated =
        action !== "edit"
          ? submission
          : submission.kind === "launch"
            ? {
                ...submission,
                input: {
                  ...submission.input,
                  initialMessage: { ...submission.input.initialMessage!, text: text! },
                },
              }
            : { ...submission, input: { ...submission.input, text: text! } };
      return { ...stored, submission: updated, canceled: action === "cancel", error: "" };
    });
  if (session !== current) return;
  await announce(current.accountId);
  if (session !== current) return;
  notifyOtherTabs();
  if (drain) drainAgain = true;
  void flushThreadQueue();
}
