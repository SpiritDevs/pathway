import { useAtomValue } from "@effect/atom-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MessageId } from "@spiritdevs/contracts";
import type { ThreadQueueOutboxRecord } from "@spiritdevs/client-runtime/sync/thread-queue-outbox";
import type { ThreadQueueSubmission } from "@spiritdevs/contracts/threadQueue";
import type { ThreadQueueDetail } from "@spiritdevs/contracts/threadQueue";
import {
  localThreadQueueAtom,
  threadQueueAccountAtom,
  threadQueueEntriesAtom,
  findQueuedThread,
} from "./threadQueueState";
import {
  mutateLocalQueuedMessage,
  mutateQueuedThread,
  subscribeQueuedThread,
  threadQueueErrorMessage,
} from "./threadQueue";
import {
  canEditQueuedChatMessage,
  canCancelQueuedChatMessage,
  canRetryQueuedChatMessage,
  queuedChatMessages,
  queuedLocalChatMessage,
  type QueuedChatMessage,
} from "./threadQueueChat";

/** Queue records feed the same messages and controls as environment-backed chat history. */
export function useThreadQueueChat(environmentId: string, threadId: string) {
  const rows = useAtomValue(threadQueueEntriesAtom);
  const local = useAtomValue(localThreadQueueAtom);
  const account = useAtomValue(threadQueueAccountAtom);
  const row = findQueuedThread(rows, environmentId, threadId);
  const key = `${account}:${environmentId}:${threadId}`;
  const [detailState, setDetailState] = useState<{ key: string; value: ThreadQueueDetail | null }>({
    key,
    value: null,
  });
  const detail = detailState.key === key ? detailState.value : null;
  const [error, setError] = useState<string | null>(null);
  const localMessages = useMemo(
    () =>
      local.filter(
        (local) =>
          local.threadId === threadId &&
          (local.queueId ? local.queueId === row?.queueId : local.environmentId === environmentId),
      ),
    [local, threadId, environmentId, row?.queueId],
  );
  const [observedLocal, setObservedLocal] = useState<{
    key: string;
    rows: readonly ThreadQueueOutboxRecord<ThreadQueueSubmission>[];
  }>({ key, rows: [] });
  const [localUrlState, setLocalUrls] = useState<{
    key: string;
    urls: ReadonlyMap<string, string>;
  }>({ key, urls: new Map() });
  const allocatedUrls = useRef(new Set<string>());
  useEffect(() => {
    const urls = allocatedUrls.current;
    return () => {
      for (const url of urls) URL.revokeObjectURL(url);
      urls.clear();
    };
  }, [key]);
  useEffect(() => {
    setObservedLocal((previous) => ({
      key,
      rows: [
        ...new Map([
          ...(previous.key === key ? previous.rows : []).map(
            (row) => [row.commandId, row] as const,
          ),
          ...localMessages.map((row) => [row.commandId, row] as const),
        ]).values(),
      ],
    }));
    setLocalUrls((previous) => {
      const urls = new Map(previous.key === key ? previous.urls : []);
      for (const row of localMessages)
        for (const file of row.attachments) {
          if (urls.has(file.metadata.id)) continue;
          const url = URL.createObjectURL(file.blob);
          allocatedUrls.current.add(url);
          urls.set(file.metadata.id, url);
        }
      return { key, urls };
    });
  }, [key, localMessages]);
  useEffect(() => {
    setDetailState({ key, value: null });
    setError(null);
    if (!row?.cloudSaved) return;
    let active = true;
    const unsubscribe = subscribeQueuedThread(
      {
        threadId,
        environmentId,
        ...(row.queueId ? { queueId: row.queueId } : {}),
        ...(row.companyId ? { companyId: row.companyId } : {}),
      },
      (next) => {
        if (!active) return;
        setError(null);
        setDetailState((previousState) => {
          const previous = previousState.key === key ? previousState.value : null;
          if (!next || !previous) return { key, value: next };
          const received = new Set(next.messages.map((message) => message.commandId));
          return {
            key,
            value: {
              ...next,
              attachmentUrls: { ...previous.attachmentUrls, ...next.attachmentUrls },
              messages: [
                ...previous.messages
                  .filter((message) => !received.has(message.commandId))
                  .map((message) => ({ ...message, state: "delivered" as const })),
                ...next.messages,
              ],
            },
          };
        });
      },
      (cause) => {
        if (active) setError(threadQueueErrorMessage(cause));
      },
    );
    return () => {
      active = false;
      unsubscribe();
    };
  }, [threadId, environmentId, account, key, row?.cloudSaved, row?.queueId, row?.companyId]);
  const messages = useMemo<readonly QueuedChatMessage[]>(() => {
    const cloud = detail?.thread.threadId === threadId ? detail.messages : [];
    const ids = new Set(cloud.map((message) => message.commandId));
    return [
      ...cloud.map((message) => ({ ...message, localKey: null, submissionStarted: false })),
      ...[
        ...new Map([
          ...(observedLocal.key === key ? observedLocal.rows : []).map(
            (message) => [message.commandId, message] as const,
          ),
          ...localMessages.map((message) => [message.commandId, message] as const),
        ]).values(),
      ]
        .filter((message) => !ids.has(message.commandId))
        .map((message) => {
          const projected = queuedLocalChatMessage(message);
          return localMessages.some((local) => local.commandId === message.commandId)
            ? projected
            : { ...projected, localKey: null, submissionStarted: true, state: "accepted" as const };
        }),
    ];
  }, [detail, localMessages, threadId, observedLocal, key]);
  const attachmentUrls = useMemo(
    () =>
      new Map([
        ...(localUrlState.key === key ? localUrlState.urls : []),
        ...Object.entries(detail?.attachmentUrls ?? {}),
      ]),
    [detail?.attachmentUrls, localUrlState, key],
  );
  const chatMessages = useMemo(
    () => queuedChatMessages(messages, attachmentUrls),
    [messages, attachmentUrls],
  );
  const messageById = useMemo(
    () => new Map(messages.map((message) => [message.messageId, message])),
    [messages],
  );
  const controls = useMemo(
    () =>
      new Map(
        messages.map((message) => [
          message.messageId,
          {
            editable: canEditQueuedChatMessage(message),
            cancelable: canCancelQueuedChatMessage(message),
            retryable: canRetryQueuedChatMessage(message),
            state: message.state,
            waitingToSync: message.localKey !== null,
            submissionStarted: message.submissionStarted,
          },
        ]),
      ),
    [messages],
  );
  const mutateMessage = useCallback(
    async (messageId: MessageId, action: "edit" | "cancel" | "retry", text?: string) => {
      const message = messageById.get(messageId);
      if (
        !message ||
        !(action === "retry"
          ? canRetryQueuedChatMessage(message)
          : action === "cancel"
            ? canCancelQueuedChatMessage(message)
            : canEditQueuedChatMessage(message))
      )
        return false;
      setError(null);
      try {
        if (message.localKey)
          await mutateLocalQueuedMessage(message.localKey, message.revision, action, text);
        else
          await mutateQueuedThread(action, {
            threadId,
            environmentId,
            ...(row?.companyId ? { companyId: row.companyId } : {}),
            ...(row?.queueId ? { queueId: row.queueId } : {}),
            commandId: message.commandId,
            revision: message.revision,
            ...(text === undefined ? {} : { text }),
          });
        return true;
      } catch (cause) {
        setError(threadQueueErrorMessage(cause));
        return false;
      }
    },
    [messageById, threadId, environmentId, row?.queueId, row?.companyId],
  );
  return { row, messages, chatMessages, attachmentUrls, controls, mutateMessage, error };
}
