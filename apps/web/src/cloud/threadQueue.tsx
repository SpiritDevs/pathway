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
import { CompanyId } from "@spiritdevs/contracts/company";
import type {
  ThreadQueueDetail,
  ThreadQueuePage,
  ThreadQueueSubmission,
  ThreadQueueThread,
  ThreadQueueDestination,
} from "@spiritdevs/contracts/threadQueue";
import { ConvexClient } from "convex/browser";
import { ConvexError } from "convex/values";
import { makeFunctionReference } from "convex/server";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback, useEffect, useState } from "react";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readThreadShell, readThreadProjection } from "../state/entities";
import { environmentCatalog } from "../connection/catalog";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import {
  verifyReadyAttachmentUpload,
  uploadStandaloneFileAttachment,
} from "../lib/attachmentUploadQueue";
import { shouldSendTurnToEnvironment, prepareDirectTurnAttachments } from "./threadTurnDelivery";
import { watchQueueConnection, awaitQueueMutation } from "./threadQueueConnection";
import { subscribeThreadQueuePages } from "./threadQueuePages";
import { isDefinitiveQueueRejection } from "./threadQueueErrors";
import { scopedCompanyRegistryReplicasAtom } from "./activeCompany";
import { cloudAgentThreadCompanyId, cloudAgentProjectCompanyId } from "./agentThreadReadModel";
import { companyRegistryReplicasAtom } from "./companyRegistryReplica";
import { activeCompanyIdAtom, companyListAtom } from "./activeCompany";
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
  threadQueueHydratedAtom,
  threadQueueSessionRevisionAtom,
  localThreadQueueAtom,
  threadQueueAccountAtom,
  threadQueueDestinationsAtom,
  reconcileQueuedThreadReceipts,
  queuedThreadKey,
  findQueuedThread,
  mergeQueueDestinations,
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
  listPage: makeFunctionReference<
    "query",
    { companyId: string; paginationOpts: { numItems: number; cursor: string | null } },
    ThreadQueuePage
  >("threadQueue:listPage"),
  getThread: makeFunctionReference<
    "query",
    { companyId: string; threadId: string; environmentId?: string; queueId?: string },
    ThreadQueueDetail | null
  >("threadQueue:getThread"),
  enqueue: makeFunctionReference<
    "mutation",
    {
      companyId: string;
      environmentId: string;
      threadId: string;
      queueId?: string;
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

export function threadQueueErrorMessage(error: unknown) {
  if (error instanceof ConvexError) return mapEnvironmentControlError(error).message;
  return error instanceof Error ? error.message : "The queue could not be updated.";
}

let session: {
  client: ConvexClient;
  accountId: string;
  companyId: CompanyId | null;
  receipts: Map<string, ThreadQueueThread>;
  outboxLoaded: boolean;
  listLoaded: boolean;
  restarting: boolean;
  closed: Promise<void>;
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
  if (session?.accountId === accountId) {
    appAtomRegistry.set(
      localThreadQueueAtom,
      rows.filter((row) => !session?.companyId || row.companyId === session.companyId),
    );
    session.outboxLoaded = true;
    appAtomRegistry.set(threadQueueHydratedAtom, session.listLoaded && !session.restarting);
  }
};

/** One drain independent of route lifetime; cloud command IDs make retries idempotent. */
export function flushThreadQueue(): Promise<void> {
  if (drain) return drain;
  const current = session;
  if (!current) return Promise.resolve();
  if (!current.client.connectionState().isWebSocketConnected) return announce(current.accountId);
  const stillCurrent = () => session === current && !current.restarting;
  const currentDrain = (async () => {
    const rows = (await readQueuedIntents(current.accountId)) as ReadonlyArray<
      ThreadQueueOutboxRecord<ThreadQueueSubmission>
    >;
    if (!stillCurrent()) return;
    const blocked = new Set<string>();
    for (let row of rows) {
      if (!stillCurrent()) return;
      const knownThread = findQueuedThread(
        appAtomRegistry
          .get(threadQueueRowsAtom)
          .filter((thread) => !thread.companyId || thread.companyId === row.companyId),
        row.environmentId,
        row.threadId,
      );
      const threadKey = `${row.companyId}:${queuedThreadKey(knownThread ?? row)}`;
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
          ...(row.queueId ? { queueId: row.queueId } : {}),
          submission: row.submission,
          attachmentIds,
        });
        if (!stillCurrent()) return;
        if (!current.companyId || row.companyId === current.companyId) {
          current.receipts.set(queuedThreadKey(accepted.thread), {
            ...accepted.thread,
            companyId: row.companyId,
          });
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
    if (drain !== currentDrain) return;
    drain = null;
    if (drainAgain || session !== current) {
      drainAgain = false;
      void flushThreadQueue();
    }
  });
  drain = currentDrain;
  return currentDrain;
}

export function ThreadQueueRuntime() {
  const { getToken, isSignedIn, userId } = useAuth({ treatPendingAsSignedOut: false });
  const [connectionEpoch, setConnectionEpoch] = useState(0);
  const companyId = useAtomValue(activeCompanyIdAtom);
  const companies = useAtomValue(companyListAtom);
  const companyIdsKey = JSON.stringify(
    companyId ? [companyId] : companies.map((company) => company.id).sort(),
  );
  const cloudShellRevision = useAtomValue(scopedCompanyRegistryReplicasAtom);
  useEffect(() => {
    if (appAtomRegistry.get(localThreadQueueAtom).length === 0) return;
    if (drain) drainAgain = true;
    void flushThreadQueue();
  }, [cloudShellRevision]);
  useEffect(() => {
    const url = resolveCloudSyncConvexUrl();
    const accountScope = isSignedIn && userId && url ? `${userId}:${companyId}` : null;
    if (appAtomRegistry.get(threadQueueAccountAtom) !== accountScope) {
      appAtomRegistry.set(threadQueueAccountAtom, accountScope);
      appAtomRegistry.set(threadQueueRowsAtom, []);
      appAtomRegistry.set(threadQueueDestinationsAtom, []);
      appAtomRegistry.set(localThreadQueueAtom, []);
    }
    appAtomRegistry.set(threadQueueHydratedAtom, false);
    if (!isSignedIn || !userId || !url) return;
    const companyIds = (JSON.parse(companyIdsKey) as string[]).map((id) => CompanyId.make(id));
    const client = new ConvexClient(url);
    client.setAuth(makeClerkConvexTokenFetcher(getToken));
    let closeSession = () => {};
    const closed = new Promise<void>((resolve) => {
      closeSession = resolve;
    });
    const current = {
      closed,
      client,
      accountId: userId,
      companyId,
      receipts: new Map<string, ThreadQueueThread>(),
      outboxLoaded: false,
      listLoaded: false,
      restarting: false,
    };
    session = current;
    appAtomRegistry.set(
      threadQueueSessionRevisionAtom,
      appAtomRegistry.get(threadQueueSessionRevisionAtom) + 1,
    );
    const channel = new BroadcastChannel(`pathway-thread-queue:${userId}`);
    queueChannel = channel;
    channel.addEventListener("message", () => {
      if (session === current) void announce(userId).then(() => flushThreadQueue());
    });
    appAtomRegistry.set(threadQueueAccountAtom, `${userId}:${companyId}`);
    const companyRows = new Map<string, readonly ThreadQueueThread[]>();
    const loadedCompanies = new Set<string>();
    const companyDestinations = new Map<string, readonly ThreadQueueDestination[]>();
    const unsubscribes = companyIds.flatMap((scopeCompanyId) => [
      subscribeThreadQueuePages(
        (cursor, receive) =>
          client.onUpdate(
            ref.listPage,
            {
              companyId: scopeCompanyId,
              paginationOpts: { numItems: 128, cursor },
            },
            receive,
          ),
        (rows, hydrated) => {
          if (session !== current || current.restarting) return;
          companyRows.set(
            scopeCompanyId,
            rows.map((row) => ({ ...row, companyId: scopeCompanyId })),
          );
          if (hydrated) loadedCompanies.add(scopeCompanyId);
          else loadedCompanies.delete(scopeCompanyId);
          const merged = reconcileQueuedThreadReceipts(
            [...companyRows.values()].flat(),
            current.receipts,
          );
          current.receipts = merged.pending;
          current.listLoaded = loadedCompanies.size === companyIds.length;
          // Keep the visible queue until every fresh subscription has caught up.
          if (current.listLoaded) appAtomRegistry.set(threadQueueRowsAtom, merged.rows);
          appAtomRegistry.set(threadQueueHydratedAtom, current.listLoaded && current.outboxLoaded);
          void flushThreadQueue();
        },
      ),
      subscribeQueueDestinations(
        undefined,
        (destinations) => {
          if (session !== current || current.restarting) return;
          companyDestinations.set(scopeCompanyId, destinations);
          appAtomRegistry.set(
            threadQueueDestinationsAtom,
            mergeQueueDestinations([...companyDestinations.values()].flat()),
          );
        },
        scopeCompanyId,
      ),
    ]);
    const reconnect = () => {
      void flushThreadQueue();
    };
    const unsubscribeConnection = watchQueueConnection(
      client,
      () => {
        if (session !== current) return;
        current.restarting = true;
        current.listLoaded = false;
        appAtomRegistry.set(threadQueueHydratedAtom, false);
        // A fresh client cannot return cached pre-disconnect query results.
        setConnectionEpoch((epoch) => epoch + 1);
      },
      reconnect,
    );
    window.addEventListener("online", reconnect);
    window.addEventListener("focus", reconnect);
    void announce(userId).then(reconnect);
    return () => {
      closeSession();
      for (const unsubscribe of unsubscribes) unsubscribe();
      unsubscribeConnection();
      channel.close();
      if (queueChannel === channel) queueChannel = null;
      window.removeEventListener("online", reconnect);
      window.removeEventListener("focus", reconnect);
      if (session === current) {
        session = null;
        // Closing Convex does not settle pending mutation promises. The new session
        // retries durable command IDs without waiting for the abandoned drain.
        drain = null;
        drainAgain = false;
        appAtomRegistry.set(threadQueueHydratedAtom, false);
        if (!current.restarting) {
          appAtomRegistry.set(threadQueueAccountAtom, null);
          appAtomRegistry.set(threadQueueRowsAtom, []);
          appAtomRegistry.set(threadQueueDestinationsAtom, []);
          appAtomRegistry.set(localThreadQueueAtom, []);
        }
      }
      void client.close();
    };
  }, [companyId, companyIdsKey, connectionEpoch, getToken, isSignedIn, userId]);
  return null;
}

export interface QueuedThreadTurnTarget {
  readonly environmentId: EnvironmentId;
  readonly input: StartThreadTurnInput;
  readonly durableAttachments?: ReadonlyArray<{
    readonly metadata: ChatAttachment;
    readonly blob: Blob | null;
  }>;
}

export async function queueThreadTurn(target: QueuedThreadTurnTarget) {
  const current = session;
  if (!current) throw new Error("Sign in to Pathway Cloud before sending.");
  const files = target.durableAttachments
    ? target.durableAttachments.map((file, index) => {
        if (file.blob === null)
          throw new Error(`Attach ${file.metadata.name} again so it can be saved while offline.`);
        return {
          ...file,
          blob: file.blob,
          metadata: {
            ...file.metadata,
            id: ChatAttachmentId.make(`queue-${target.input.message.messageId}-${index}`),
          },
        };
      })
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
  if (session !== current)
    throw new Error(
      "The account changed while saving this message. Send it again from the current account.",
    );
  const existingThread = readThreadShell({
    environmentId: target.environmentId,
    threadId: target.input.threadId,
  });
  const queuedThread = findQueuedThread(
    appAtomRegistry.get(threadQueueRowsAtom),
    target.environmentId,
    target.input.threadId,
  );
  const companyId =
    cloudAgentThreadCompanyId(
      appAtomRegistry.get(companyRegistryReplicasAtom),
      target.environmentId,
      target.input.threadId,
    ) ??
    (queuedThread?.companyId ? CompanyId.make(queuedThread.companyId) : null) ??
    target.input.bootstrap?.createThread?.conversationCompanyId ??
    existingThread?.conversationCompanyId ??
    cloudAgentProjectCompanyId(
      appAtomRegistry.get(companyRegistryReplicasAtom),
      target.environmentId,
      target.input.bootstrap?.createThread?.projectId ?? existingThread?.projectId,
    ) ??
    current.companyId;
  if (!companyId) throw new Error("Select the company that owns this thread before sending.");
  const submission = buildThreadQueueSubmission(
    target.input,
    files.map((file) => file.metadata),
    existingThread,
    existingThread?.runtime?.activeRunId,
  );
  // Refuse invalid commands before clearing the composer or creating an unretryable outbox row.
  if (submission.kind === "launch") decodeQueueLaunch(submission.input);
  else decodeQueueMessage(submission.input);
  const queueId = queuedThread?.queueId;
  const record: ThreadQueueOutboxRecord<ThreadQueueSubmission> = {
    key: `${current.accountId}:${companyId}:${target.environmentId}:${submission.input.commandId}`,
    accountId: current.accountId,
    companyId,
    environmentId: target.environmentId,
    threadId: target.input.threadId,
    ...(queueId ? { queueId } : {}),
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
  const startTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  return useCallback(
    async (target: QueuedThreadTurnTarget) => {
      const accountSession = session;
      const canSendDirectly = () => {
        const queued = findQueuedThread(
          appAtomRegistry.get(threadQueueRowsAtom),
          target.environmentId,
          target.input.threadId,
        );
        const connected =
          Option.getOrNull(
            AsyncResult.value(
              appAtomRegistry.get(environmentCatalog.stateAtom(target.environmentId)),
            ),
          )?.phase === "connected";
        const localPending = appAtomRegistry
          .get(localThreadQueueAtom)
          .some(
            (message) =>
              !message.canceled &&
              message.threadId === target.input.threadId &&
              (message.queueId
                ? message.queueId === queued?.queueId
                : message.environmentId === target.environmentId),
          );
        const projection =
          readThreadProjection({
            environmentId: target.environmentId,
            threadId: target.input.threadId,
          })?.projection ?? null;
        const activeRun = projection?.runs.find((run) =>
          ["preparing", "starting", "running", "waiting"].includes(run.status),
        );
        const activeProviderThread =
          activeRun &&
          (projection?.providerThreads.find(
            (thread) => thread.id === projection.thread.activeProviderThreadId,
          ) ??
            projection?.providerThreads.find((thread) => thread.id === activeRun.providerThreadId));
        return shouldSendTurnToEnvironment({
          connected,
          activeProviderInstanceId: activeProviderThread?.providerInstanceId,
          requestedProviderInstanceId:
            target.input.modelSelection?.instanceId ?? projection?.thread.modelSelection.instanceId,
          dispatchMode: target.input.dispatchMode,
          queueHydrated:
            appAtomRegistry.get(threadQueueHydratedAtom) &&
            session !== null &&
            !session.restarting &&
            session.client.connectionState().isWebSocketConnected,
          hasThreadProjection: projection !== null,
          bootstrap: target.input.bootstrap,
          pendingCloudMessages: localPending || (queued?.queuedCount ?? 0) > 0,
        });
      };
      if (!canSendDirectly()) return settlePromise(() => queueThreadTurn(target));
      const attachments = await settlePromise(() =>
        target.durableAttachments
          ? prepareDirectTurnAttachments(target.durableAttachments, async ({ metadata, blob }) => {
              const uploaded = await verifyReadyAttachmentUpload({
                id: metadata.id,
                environmentId: target.environmentId,
              });
              if (uploaded?.status === "ready" && uploaded.environmentId === target.environmentId) {
                return { ...metadata, type: "file", id: uploaded.attachmentId };
              }
              if (blob === null) throw new Error(`Attach ${metadata.name} again before sending.`);
              return uploadStandaloneFileAttachment({
                environmentId: target.environmentId,
                file: new File([blob], metadata.name, { type: metadata.mimeType }),
                name: metadata.name,
                mimeType: metadata.mimeType,
                sizeBytes: metadata.sizeBytes,
              });
            })
          : Promise.resolve(target.input.message.attachments),
      );
      if (attachments._tag === "Failure") return attachments;
      if (session !== accountSession)
        return settlePromise(() => {
          throw new Error(
            "The account changed while preparing this message. Send it again from the current account.",
          );
        });
      if (!canSendDirectly()) return settlePromise(() => queueThreadTurn(target));
      // Do not resubmit through cloud after a transport failure: the environment
      // may already have accepted this turn before the acknowledgement was lost.
      return startTurn({
        environmentId: target.environmentId,
        input: {
          ...target.input,
          message: { ...target.input.message, attachments: attachments.value },
        },
      });
    },
    [startTurn],
  );
}

export function subscribeQueuedThread(
  identity: { threadId: string; environmentId: string; queueId?: string; companyId?: string },
  onChange: (detail: ThreadQueueDetail | null) => void,
  onError?: (error: Error) => void,
): () => void {
  if (!session) return () => {};
  return session.client.onUpdate(
    ref.getThread,
    { ...identity, companyId: identity.companyId ?? session.companyId ?? "" },
    onChange,
    onError,
  );
}

export async function mutateQueuedThread(
  action: "edit" | "cancel" | "retry" | "reassign",
  args: Record<string, string | number | null | object>,
) {
  const current = session;
  if (!current) throw new Error("Cloud authentication is unavailable.");
  return awaitQueueMutation(
    current.client.mutation(makeFunctionReference<"mutation">(`threadQueue:${action}`), {
      companyId: current.companyId,
      ...args,
    }),
    current.closed,
  );
}

export type { ThreadQueueDestination } from "@spiritdevs/contracts/threadQueue";
export function subscribeQueueDestinations(
  identity:
    | { threadId: string; environmentId: string; queueId?: string; companyId?: string }
    | undefined,
  onChange: (destinations: readonly ThreadQueueDestination[]) => void,
  companyId?: string,
) {
  if (!session) return () => {};
  return session.client.onUpdate(
    makeFunctionReference<
      "query",
      { companyId: string; threadId?: string; environmentId?: string; queueId?: string },
      readonly ThreadQueueDestination[]
    >("threadQueue:destinations"),
    { ...identity, companyId: companyId ?? identity?.companyId ?? session.companyId ?? "" },
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
  const local = localRows.find(
    (row) => row.key === key && (!current.companyId || row.companyId === current.companyId),
  );
  if (!local)
    throw new Error("The pending message is no longer on this device. Refresh the thread.");
  if (action === "cancel" && local.submission.kind === "launch")
    await cancelLocalQueuedThread(key, revision);
  else
    await editLocalQueuedIntent(key, revision, (stored) => {
      if (
        stored.accountId !== current.accountId ||
        (current.companyId && stored.companyId !== current.companyId)
      )
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
