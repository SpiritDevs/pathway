import { ScrollToEndButton } from "../chat/ScrollToEndButton";
import { useTheme } from "../../hooks/useTheme";
import { useConversationActivity } from "./useConversationActivity";
import { conversationAtBottom } from "./conversationActivity";
import { redundantReplyPreviews } from "./conversationReplyPreviews";
import { ConversationReaders } from "./ConversationReaders";
import { conversationReceiptLabel, placeConversationReaders } from "./conversationReceipts";
import { useConversationReadPosition } from "./useConversationReadPosition";
import { ConversationMessageActions } from "./ConversationMessageActions";
import { ConversationMessageAttachment } from "./ConversationAttachments";
import {
  lazy,
  Suspense,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { makeFunctionReference } from "convex/server";
import { ListTodoIcon } from "lucide-react";
import type {
  OrchestratorActivity,
  OrchestratorChat,
  OrchestratorMessagePage,
  OrchestratorWorkItem,
} from "@spiritdevs/contracts/aiOrchestrator";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { useOrchestrators } from "./OrchestratorContext";
import { ConversationAvatar } from "./OrchestratorAvatar";
import {
  buildConversationTimeline,
  conversationMessageTime,
  conversationTimeMarker,
} from "./conversationTimeline";
import { WorkList } from "./ConversationMetadata";

import { animateSentMessage, type ComposerSendMotion } from "./messageSendMotion";

const EMPTY_ACTIVITY: OrchestratorActivity = [];
type MessagePage = OrchestratorMessagePage;
const errorMessage = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));
const ChatMarkdown = lazy(() => import("../ChatMarkdown"));
export function ConversationMessages({
  chat,
  work,
  search,
  result,
  sendMotion,
  activity = EMPTY_ACTIVITY,
}: {
  chat: OrchestratorChat;
  activity?: OrchestratorActivity;
  work: readonly OrchestratorWorkItem[];
  search: string;
  result: { value?: MessagePage; error?: string };
  sendMotion?: RefObject<ComposerSendMotion | null>;
}) {
  const state = useOrchestrators();
  const { resolvedTheme } = useTheme();
  const activeIds = useConversationActivity(activity);
  const typing = chat.orchestratorIds.some((id) => activeIds.has(id));
  const [atBottom, setAtBottom] = useState(true);
  const [olderPages, setOlderPages] = useState<Record<number, MessagePage>>({});
  const historySubscriptions = useRef(new Map<number, () => void>());
  useEffect(() => {
    const subscriptions = historySubscriptions.current;
    setOlderPages({});
    setNextBefore(undefined);
    setLoadingOlder(false);
    return () => {
      for (const unsubscribe of subscriptions.values()) unsubscribe();
      subscriptions.clear();
    };
  }, [state.client, chat.id]);
  const [nextBefore, setNextBefore] = useState<number | null | undefined>();
  const [loadingOlder, setLoadingOlder] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const pinned = useRef(!state.scrollPositions.current.has(chat.id));
  const initialized = useRef(false);
  const stopFlight = useRef<(() => void) | undefined>(undefined);
  useEffect(() => () => stopFlight.current?.(), []);
  const messages = [
    ...new Map(
      [
        ...Object.values(olderPages).flatMap((page) => page.messages),
        ...(result.value?.messages ?? []),
      ].map((message) => [message.id, message]),
    ).values(),
  ].sort((a, b) => a.sequence - b.sequence);
  const visible = search
    ? messages.filter((message) =>
        (
          message.text +
          message.senderName +
          (message.attachments ?? []).map((a) => a.name).join(" ")
        )
          .toLowerCase()
          .includes(search.toLowerCase()),
      )
    : messages;
  const hiddenReplyPreviews = redundantReplyPreviews(search ? [] : messages);
  const timeline = buildConversationTimeline(visible, search ? [] : work);
  useLayoutEffect(() => {
    const element = container.current;
    if (!element || !result.value) return;
    if (!initialized.current) {
      element.scrollTop = state.scrollPositions.current.get(chat.id) ?? element.scrollHeight;
      initialized.current = true;
      pinned.current = conversationAtBottom(element);
      setAtBottom(pinned.current);
    } else if (pinned.current) element.scrollTop = element.scrollHeight;
    setAtBottom(conversationAtBottom(element));
  }, [result.value, work, chat.id, state.scrollPositions]);
  useLayoutEffect(() => {
    const pending = sendMotion?.current;
    const element = container.current;
    if (
      !sendMotion ||
      !pending?.ready ||
      pending.chatId !== chat.id ||
      !element ||
      !messages.some((message) => message.id === pending.messageId)
    )
      return;
    sendMotion.current = null;
    stopFlight.current?.();
    if (search) return;
    const bubble = element.querySelector<HTMLElement>(
      `[data-message-id="${CSS.escape(pending.messageId)}"]`,
    );
    if (!bubble) return;
    element.scrollTop = element.scrollHeight;
    pinned.current = true;
    setAtBottom(true);
    stopFlight.current = animateSentMessage(bubble, element, pending.origin);
  });
  const readers = result.value?.readers ?? [];
  const readerPlacements = placeConversationReaders(visible, readers, state.accountID);
  useConversationReadPosition(
    container,
    chat.id,
    chat.readSequence,
    visible.map((message) => message.id).join(","),
    !!search,
  );
  const before = nextBefore === undefined ? result.value?.nextBefore : nextBefore;
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={container}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-6 sm:px-8"
        onScroll={(event) => {
          const element = event.currentTarget;
          state.scrollPositions.current.set(chat.id, element.scrollTop);
          pinned.current = conversationAtBottom(element);
          setAtBottom(pinned.current);
        }}
      >
        <div className="mx-auto max-w-3xl">
          {before && (
            <div className="text-center">
              <Button
                size="sm"
                variant="ghost"
                disabled={loadingOlder}
                onClick={() => {
                  if (!state.client) return;
                  setLoadingOlder(true);
                  const height = container.current?.scrollHeight ?? 0;
                  let first = true;
                  let active = true;
                  const unsubscribe = state.client.onUpdate(
                    makeFunctionReference<"query", { chatId: string; before: number }, MessagePage>(
                      "aiOrchestrators:messages",
                    ),
                    { chatId: chat.id, before },
                    (page) => {
                      if (!active) return;
                      setOlderPages((current) => ({ ...current, [before]: page }));
                      if (!first) return;
                      first = false;
                      setLoadingOlder(false);
                      setNextBefore(page.nextBefore);
                      requestAnimationFrame(() => {
                        if (active && container.current)
                          container.current.scrollTop += container.current.scrollHeight - height;
                      });
                    },
                    (cause) => {
                      if (!active) return;
                      setLoadingOlder(false);
                      // Withdraw stale status-dependent controls if access or the query fails.
                      setOlderPages((current) => {
                        const next = { ...current };
                        delete next[before];
                        return next;
                      });
                      state.setError(errorMessage(cause));
                    },
                  );
                  historySubscriptions.current.get(before)?.();
                  historySubscriptions.current.set(before, () => {
                    active = false;
                    unsubscribe();
                  });
                }}
              >
                {loadingOlder ? "Loading…" : "Earlier messages"}
              </Button>
            </div>
          )}
          {!result.value && !result.error && (
            <p className="py-12 text-center text-sm text-muted-foreground">Loading messages…</p>
          )}
          {result.error && (
            <p role="alert" className="text-sm text-destructive">
              {result.error}
            </p>
          )}
          {result.value && messages.length === 0 && (
            <div className="py-16 text-center">
              <ConversationAvatar
                contacts={state.avatarContacts.filter((contact) =>
                  chat.orchestratorIds.includes(contact.id ?? ""),
                )}
                className="mx-auto justify-center"
              />
              <h2 className="mt-4 text-lg font-semibold">{chat.title}</h2>
              <p className="mx-auto mt-2 max-w-80 text-sm leading-relaxed text-muted-foreground">
                A continuing conversation. Share what you need, and your orchestrators will
                coordinate the work.
              </p>
            </div>
          )}
          {timeline.map((entry) => {
            if (entry.kind === "work") {
              return (
                <div key={entry.id} className="my-5 max-w-lg">
                  <div className="mb-1 flex items-center gap-2 text-xs font-semibold">
                    <ListTodoIcon className="size-4" />
                    Delegated work
                  </div>
                  <WorkList items={entry.items} />
                </div>
              );
            }
            const { message, index, startsGroup, endsGroup, timeMarker } = entry;
            const own = message.senderKind === "user" && message.senderId === state.accountID;
            return (
              <div
                data-message-sequence={message.sequence}
                key={message.id}
                className={startsGroup ? "mt-5 first:mt-0" : "mt-1.5"}
              >
                {timeMarker && (
                  <div
                    className={cn(
                      "text-center text-xs text-muted-foreground",
                      index === 0 ? "mb-6" : "my-7",
                    )}
                  >
                    <time dateTime={new Date(message.createdAt).toISOString()}>
                      {conversationTimeMarker(message.createdAt)}
                    </time>
                  </div>
                )}
                {message.senderKind === "system" ? (
                  <p className="text-center text-xs text-muted-foreground">
                    {message.senderId === "delegated-work"
                      ? "Delegated work updated"
                      : message.text}
                  </p>
                ) : (
                  <div className={cn("flex items-end gap-2.5", own && "justify-end")}>
                    <div className={cn("min-w-0 max-w-[92%] sm:max-w-[88%]", own && "text-right")}>
                      {startsGroup && (
                        <p className="mb-1.5 px-1.5 text-xs leading-5 text-muted-foreground">
                          {own ? "You" : message.senderName}
                        </p>
                      )}
                      <ConversationMessageActions message={message}>
                        <div
                          data-message-id={message.id}
                          style={
                            sendMotion?.current?.messageId === message.id &&
                            !sendMotion.current.ready
                              ? { opacity: 0 }
                              : undefined
                          }
                          className={cn(
                            "rounded-[22px] px-4 py-2.5 text-left text-sm leading-relaxed break-words",
                            own
                              ? "bg-foreground text-background whitespace-pre-wrap"
                              : "bg-foreground/5 text-foreground",
                            message.status === "cancelled" && "opacity-50",
                          )}
                        >
                          {message.replyToId && !hiddenReplyPreviews.has(message.id) && (
                            <button
                              type="button"
                              className="mb-2 block max-w-full border-l-2 border-current/30 pl-2.5 text-left text-xs opacity-75 hover:opacity-100"
                              onClick={() => {
                                container.current
                                  ?.querySelector<HTMLElement>(
                                    `[data-message-id="${CSS.escape(message.replyToId!)}"]`,
                                  )
                                  ?.scrollIntoView({
                                    block: "center",
                                    behavior: window.matchMedia("(prefers-reduced-motion: reduce)")
                                      .matches
                                      ? "instant"
                                      : "smooth",
                                  });
                              }}
                              disabled={
                                !visible.some((original) => original.id === message.replyToId)
                              }
                              aria-label={
                                visible.some((original) => original.id === message.replyToId)
                                  ? "Show original message"
                                  : "Quoted message"
                              }
                            >
                              <span className="block font-medium">
                                {message.reply?.senderName ?? "Earlier message"}
                              </span>
                              <span className="mt-0.5 block line-clamp-2">
                                {message.reply?.text ?? "The original message is unavailable."}
                              </span>
                            </button>
                          )}
                          {message.mentions?.map((mention) => (
                            <span key={mention.id} className="mr-1 text-blue-500">
                              @
                              {readers.find(
                                (reader) => reader.kind === "user" && reader.id === mention.id,
                              )?.name ?? "Participant"}
                            </span>
                          ))}
                          {message.attachments?.map((attachment) => (
                            <ConversationMessageAttachment
                              key={attachment.id}
                              attachment={attachment}
                            />
                          ))}
                          {own ? (
                            message.text
                          ) : (
                            <Suspense
                              fallback={<p className="whitespace-pre-wrap">{message.text}</p>}
                            >
                              <ChatMarkdown text={message.text} cwd={undefined} />
                            </Suspense>
                          )}
                        </div>
                      </ConversationMessageActions>
                      {(endsGroup ||
                        message.status !== "sent" ||
                        message.delivery ||
                        readerPlacements.has(message.id)) && (
                        <div
                          className={cn(
                            "mt-1.5 flex min-h-4 flex-wrap items-center gap-x-2 gap-y-1 px-1 text-[10px] text-muted-foreground",
                            own && "justify-end",
                          )}
                        >
                          <time
                            dateTime={new Date(message.createdAt).toISOString()}
                            title={new Date(message.createdAt).toLocaleString()}
                          >
                            {conversationMessageTime.format(message.createdAt)}
                          </time>
                          {own && (
                            <span>
                              {conversationReceiptLabel(
                                message,
                                readers,
                                state.sendingChats.includes(chat.id) &&
                                  state.pendingMessages.current.get(chat.id)?.id === message.id,
                              )}
                            </span>
                          )}
                          {chat.kind === "group" && readerPlacements.has(message.id) && (
                            <ConversationReaders readers={readerPlacements.get(message.id)!} />
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
          {search && visible.length === 0 && (
            <p className="text-center text-sm text-muted-foreground">
              No matching messages in the loaded history.
            </p>
          )}
        </div>
      </div>
      {!atBottom && !search && (
        <div className="pointer-events-none absolute inset-x-0 bottom-3 z-30 flex justify-center">
          <ScrollToEndButton
            isWorking={typing}
            activityLabel="Typing…"
            theme={resolvedTheme}
            onClick={() => {
              const element = container.current;
              if (!element) return;
              element.scrollTo({ top: element.scrollHeight, behavior: "instant" });
              pinned.current = true;
              setAtBottom(true);
              state.scrollPositions.current.set(chat.id, element.scrollTop);
            }}
          />
        </div>
      )}
    </div>
  );
}
