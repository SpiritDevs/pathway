import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from "react";
import { makeFunctionReference } from "convex/server";
import { ListTodoIcon } from "lucide-react";
import type {
  OrchestratorChat,
  OrchestratorMessage,
  OrchestratorWorkItem,
} from "@spiritdevs/contracts/aiOrchestrator";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { useOrchestrators, useOrchestratorQuery } from "./OrchestratorContext";
import { ConversationAvatar, OrchestratorAvatar } from "./OrchestratorAvatar";
import { WorkList } from "./ConversationMetadata";

type MessagePage = { messages: OrchestratorMessage[]; nextBefore: number | null };
const errorMessage = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));
const ChatMarkdown = lazy(() => import("../ChatMarkdown"));
export function ConversationMessages({
  chat,
  work,
  search,
}: {
  chat: OrchestratorChat;
  work: readonly OrchestratorWorkItem[];
  search: string;
}) {
  const state = useOrchestrators();
  const result = useOrchestratorQuery<MessagePage>(
    state.client,
    state.accountID,
    "aiOrchestrators:messages",
    { chatId: chat.id },
  );
  const [older, setOlder] = useState<OrchestratorMessage[]>([]);
  const [nextBefore, setNextBefore] = useState<number | null | undefined>();
  const [loadingOlder, setLoadingOlder] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const pinned = useRef(!state.scrollPositions.current.has(chat.id));
  const initialized = useRef(false);
  const messages = [
    ...new Map(
      [...older, ...(result.value?.messages ?? [])].map((message) => [message.id, message]),
    ).values(),
  ].sort((a, b) => a.sequence - b.sequence);
  const visible = search
    ? messages.filter((message) =>
        (message.text + message.senderName).toLowerCase().includes(search.toLowerCase()),
      )
    : messages;
  useLayoutEffect(() => {
    const element = container.current;
    if (!element || !result.value) return;
    if (!initialized.current) {
      element.scrollTop = state.scrollPositions.current.get(chat.id) ?? element.scrollHeight;
      initialized.current = true;
      pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
    } else if (pinned.current) element.scrollTop = element.scrollHeight;
  }, [result.value, chat.id, state.scrollPositions]);
  const lastSequence = result.value?.messages.at(-1)?.sequence;
  useEffect(() => {
    const client = state.client;
    if (!client || lastSequence === undefined) return;
    const markRead = () => {
      if (document.visibilityState === "visible")
        void client
          .mutation(makeFunctionReference<"mutation">("aiOrchestrators:markRead"), {
            chatId: chat.id,
            sequence: lastSequence,
          })
          .catch((cause) => state.setError(errorMessage(cause)));
    };
    markRead();
    document.addEventListener("visibilitychange", markRead);
    return () => document.removeEventListener("visibilitychange", markRead);
  }, [state.client, chat.id, lastSequence]);
  const before = nextBefore === undefined ? result.value?.nextBefore : nextBefore;
  return (
    <div
      ref={container}
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-6 sm:px-8"
      onScroll={(event) => {
        const element = event.currentTarget;
        state.scrollPositions.current.set(chat.id, element.scrollTop);
        pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
      }}
    >
      <div className="mx-auto max-w-3xl space-y-6">
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
                void state.client
                  .query(
                    makeFunctionReference<"query", { chatId: string; before: number }, MessagePage>(
                      "aiOrchestrators:messages",
                    ),
                    { chatId: chat.id, before },
                  )
                  .then((page) => {
                    setOlder((current) => [...page.messages, ...current]);
                    setNextBefore(page.nextBefore);
                    requestAnimationFrame(() => {
                      if (container.current)
                        container.current.scrollTop += container.current.scrollHeight - height;
                    });
                  })
                  .catch((cause) => state.setError(errorMessage(cause)))
                  .finally(() => setLoadingOlder(false));
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
              contacts={state.contacts.filter((contact) =>
                chat.orchestratorIds.includes(contact.id),
              )}
              className="mx-auto justify-center"
            />
            <h2 className="mt-4 text-lg font-semibold">{chat.title}</h2>
            <p className="mx-auto mt-2 max-w-80 text-sm leading-relaxed text-muted-foreground">
              A continuing conversation. Share what you need, and your orchestrators will coordinate
              the work.
            </p>
          </div>
        )}
        {visible.map((message, index) => {
          const own = message.senderKind === "user" && message.senderId === state.accountID;
          const contact = state.contacts.find((item) => item.id === message.senderId);
          const newDay =
            index === 0 ||
            new Date(visible[index - 1]!.createdAt).toDateString() !==
              new Date(message.createdAt).toDateString();
          return (
            <div key={message.id}>
              {newDay && (
                <p className="mb-6 text-center text-[11px] text-muted-foreground">
                  {new Intl.DateTimeFormat(undefined, {
                    weekday: "long",
                    month: "short",
                    day: "numeric",
                  }).format(message.createdAt)}
                </p>
              )}
              {message.senderKind === "system" ? (
                <p className="text-center text-xs text-muted-foreground">
                  {message.senderId === "delegated-work" ? "Delegated work updated" : message.text}
                </p>
              ) : (
                <div className={cn("flex items-end gap-2.5", own && "justify-end")}>
                  {!own && <OrchestratorAvatar contact={contact} className="mb-5 size-8" />}
                  <div className={cn("max-w-[85%]", own && "text-right")}>
                    <div
                      className={cn("mb-1.5 flex items-baseline gap-2 px-1", own && "justify-end")}
                    >
                      <span className="text-[11px] font-medium">
                        {own ? "You" : message.senderName}
                      </span>
                      <time
                        className="text-[10px] text-muted-foreground"
                        dateTime={new Date(message.createdAt).toISOString()}
                      >
                        {new Intl.DateTimeFormat(undefined, {
                          hour: "numeric",
                          minute: "2-digit",
                        }).format(message.createdAt)}
                      </time>
                    </div>
                    <div
                      className={cn(
                        "rounded-[20px] px-4 py-3 text-left text-sm leading-relaxed break-words",
                        own
                          ? "rounded-br-md bg-blue-500 text-white whitespace-pre-wrap"
                          : "rounded-bl-md bg-muted/80 text-foreground",
                        message.status === "cancelled" && "opacity-50",
                      )}
                    >
                      {own ? (
                        message.text
                      ) : (
                        <Suspense fallback={<p className="whitespace-pre-wrap">{message.text}</p>}>
                          <ChatMarkdown text={message.text} cwd={undefined} />
                        </Suspense>
                      )}
                    </div>
                    <div
                      className={cn(
                        "mt-1 flex min-h-3 items-center gap-2 px-1 text-[10px] text-muted-foreground",
                        own && "justify-end",
                      )}
                    >
                      {message.status === "queued" ? (
                        <>
                          Queued{" "}
                          <button
                            type="button"
                            className="hover:text-foreground hover:underline"
                            onClick={() => {
                              void state
                                .request("aiOrchestrators:cancelMessage", {
                                  chatId: chat.id,
                                  messageId: message.id,
                                })
                                .catch((cause) => state.setError(errorMessage(cause)));
                            }}
                          >
                            Cancel
                          </button>
                        </>
                      ) : message.status === "working" ? (
                        "Coordinating…"
                      ) : message.status === "failed" ? (
                        <>
                          Could not complete this request{" "}
                          {own && (
                            <button
                              type="button"
                              className="hover:text-foreground hover:underline"
                              onClick={() => {
                                void state
                                  .request("aiOrchestrators:retryMessage", {
                                    chatId: chat.id,
                                    messageId: message.id,
                                  })
                                  .catch((cause) => state.setError(errorMessage(cause)));
                              }}
                            >
                              Retry
                            </button>
                          )}
                        </>
                      ) : message.status === "cancelled" ? (
                        "Cancelled"
                      ) : own ? (
                        "Delivered"
                      ) : (
                        ""
                      )}
                    </div>
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
        {!search && work.length > 0 && (
          <div className="ml-10 max-w-lg rounded-2xl border p-4">
            <div className="mb-1 flex items-center gap-2 text-xs font-semibold">
              <ListTodoIcon className="size-4" />
              Delegated work
            </div>
            <WorkList items={work.slice(0, 4)} />
          </div>
        )}
      </div>
    </div>
  );
}
