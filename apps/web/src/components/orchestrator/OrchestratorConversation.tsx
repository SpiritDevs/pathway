import { mapEnvironmentControlError } from "../../cloud/environmentControl";
import { ConversationAttachmentDrafts } from "./ConversationAttachments";
import { shouldHandleComposerAttachmentPaste } from "../chat/composerAttachmentFiles";
import { useEffect, useRef, useState, type RefObject } from "react";
import { useNavigate } from "@tanstack/react-router";
import { createPortal } from "react-dom";
import {
  ArrowUpIcon,
  ArrowUpRightIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  Maximize2Icon,
  MessageCircleIcon,
  MinusIcon,
  PanelRightIcon,
  PlusIcon,
  PaperclipIcon,
  SearchIcon,
  XIcon,
} from "lucide-react";
import type {
  OrchestratorChat,
  OrchestratorWorkItem,
  OrchestratorMessagePage,
  OrchestratorActivity,
} from "@spiritdevs/contracts/aiOrchestrator";
import { cn, randomUUID } from "../../lib/utils";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { Button } from "../ui/button";
import { SidebarInset } from "../ui/sidebar";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { RightPanelSheet } from "../RightPanelSheet";
import { SheetTitle } from "../ui/sheet";
import { useOrchestrators, useOrchestratorQuery } from "./OrchestratorContext";
import { ConversationAvatar, OrchestratorAvatar } from "./OrchestratorAvatar";
import { ConversationList, FloatingConversationSwitcher } from "./OrchestratorSidebar";
import { NewConversationDialog } from "./NewConversationDialog";
import { ConversationMessages } from "./ConversationMessages";
import { FloatingDetailsPanel } from "./FloatingDetailsPanel";
import { ConversationMetadata } from "./ConversationMetadata";

import type { ComposerSendMotion } from "./messageSendMotion";

const EMPTY_ACTIVITY: OrchestratorActivity = [];
const errorMessage = (cause: unknown) => mapEnvironmentControlError(cause).message;
export function Composer({
  chat,
  activity,
  sendMotion,
}: {
  chat: OrchestratorChat;
  activity: OrchestratorActivity;
  sendMotion: RefObject<ComposerSendMotion | null>;
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  const [now, setNow] = useState(Date.now);
  const activeIds = new Set(
    activity.filter((item) => item.expiresAt > Math.max(now, Date.now())).map((item) => item.id),
  );
  useEffect(() => {
    const current = Date.now();
    const nextExpiry = Math.min(
      ...activity.map((item) => item.expiresAt).filter((time) => time > current),
    );
    if (!Number.isFinite(nextExpiry)) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, nextExpiry - current));
    return () => clearTimeout(timer);
  }, [activity, now]);
  const state = useOrchestrators();
  const reply = state.replies[chat.id];
  useEffect(() => {
    if (reply) input.current?.focus();
  }, [reply]);
  const clearReply = () => {
    if (reply?.kind === "edit") state.setDraft(chat.id, reply.previousDraft ?? "");
    state.setReply(chat.id, undefined);
  };
  const sending = state.sendingChats.includes(chat.id);
  const setSending = (value: boolean) => state.setSendingChat(chat.id, value);
  const [target, setTarget] = useState(chat.leadId);
  const pending = state.pendingMessages.current;
  const fileInput = useRef<HTMLInputElement>(null);
  const drafts = reply?.kind === "edit" ? [] : (state.attachments.drafts[chat.id] ?? []);
  const blocked = drafts.some((draft) => draft.status !== "ready");
  const addFiles = (files: File[]) => {
    if (sending || !lead?.canDirect || reply?.kind === "edit") return;
    try {
      state.attachments.add(chat.id, lead.id, files);
      state.setError(undefined);
    } catch (cause) {
      state.setError(errorMessage(cause));
    }
  };
  const text = state.drafts[chat.id] ?? "";
  const contacts = state.contacts.filter((contact) => chat.orchestratorIds.includes(contact.id));
  const lead =
    contacts.find((contact) => contact.id === reply?.orchestratorId) ??
    contacts.find((contact) => contact.id === target) ??
    contacts.find((contact) => contact.id === chat.leadId);
  const send = () => {
    if (sending || blocked || (!text.trim() && !drafts.length) || chat.archived || !lead?.canDirect)
      return;
    const attachmentIds = drafts.map((draft) => draft.attachment.id);
    const previous = pending.get(chat.id);
    const message =
      previous?.text === text &&
      previous.targetId === lead.id &&
      previous.replyToId === reply?.messageId &&
      previous.workId === reply?.workId &&
      JSON.stringify(previous.attachmentIds) === JSON.stringify(attachmentIds)
        ? previous
        : {
            id: randomUUID(),
            text,
            targetId: lead.id,
            attachmentIds,
            ...(reply?.kind === "reply" ? { replyToId: reply.messageId } : {}),
            ...(reply?.workId ? { workId: reply.workId } : {}),
          };
    pending.set(chat.id, message);
    if (input.current && reply?.kind !== "edit")
      sendMotion.current = {
        chatId: chat.id,
        messageId: message.id,
        origin: input.current.getBoundingClientRect(),
        ready: false,
      };
    setSending(true);
    state.setError(undefined);
    void state
      .request(
        reply?.kind === "edit" ? "aiOrchestratorControls:control" : "aiOrchestrators:send",
        reply?.kind === "edit"
          ? {
              chatId: chat.id,
              action: {
                kind: "editWorkMessage",
                workId: reply.workId,
                id: reply.deliveryId,
                revision: reply.revision,
                text,
              },
            }
          : { chatId: chat.id, ...message },
      )
      .then(() => {
        if (sendMotion.current?.messageId === message.id) sendMotion.current.ready = true;
        state.setDraft(chat.id, reply?.kind === "edit" ? (reply.previousDraft ?? "") : "");
        state.setReply(chat.id, undefined);
        state.attachments.sent(chat.id, message.attachmentIds);
        pending.delete(chat.id);
      })
      .catch((cause) => {
        if (sendMotion.current?.messageId === message.id) sendMotion.current = null;
        state.setError(errorMessage(cause));
      })
      .finally(() => setSending(false));
  };
  if (chat.archived)
    return (
      <div className="border-t p-5 text-center">
        <Button
          variant="outline"
          onClick={() => {
            void state
              .request("aiOrchestrators:updateChat", { chatId: chat.id, archived: false })
              .catch((cause) => state.setError(errorMessage(cause)));
          }}
        >
          Unarchive to continue the conversation
        </Button>
      </div>
    );
  return (
    <div className="shrink-0 px-4 pb-4 pt-2 sm:px-6">
      <form
        className="mx-auto max-w-3xl"
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
      >
        <div
          role="status"
          aria-live="polite"
          className="flex flex-wrap items-center gap-x-3 gap-y-1 px-2 empty:hidden [&:not(:empty)]:pb-2"
        >
          {contacts
            .filter((contact) => activeIds.has(contact.id))
            .map((contact) => (
              <div key={contact.id} className="flex items-center gap-1.5">
                <OrchestratorAvatar contact={contact} className="size-5" status="working" />
                <span className="text-xs text-muted-foreground">{contact.name} is thinking</span>
              </div>
            ))}
        </div>
        {contacts.length > 1 && !reply?.workId && (
          <label className="mb-2 flex items-center gap-1 pl-2 text-[11px] text-muted-foreground">
            To
            <select
              aria-label="Address orchestrator"
              className="max-w-52 bg-transparent text-foreground outline-none"
              value={lead?.id ?? chat.leadId}
              onChange={(event) => setTarget(event.target.value)}
            >
              {contacts
                .filter((contact) => contact.canDirect)
                .map((contact) => (
                  <option key={contact.id} value={contact.id}>
                    {contact.name}
                    {contact.id === chat.leadId ? " · Lead" : ""}
                  </option>
                ))}
            </select>
          </label>
        )}
        <input
          ref={fileInput}
          type="file"
          multiple
          className="sr-only"
          tabIndex={-1}
          aria-label="Attach images and files"
          disabled={sending || !lead?.canDirect || reply?.kind === "edit"}
          onChange={(event) => {
            addFiles(Array.from(event.target.files ?? []));
            event.target.value = "";
          }}
        />
        <div
          className="rounded-[26px] border bg-background shadow-sm"
          onDragOver={(event) => {
            if (event.dataTransfer.types.includes("Files")) event.preventDefault();
          }}
          onDrop={(event) => {
            if (event.dataTransfer.files.length) {
              event.preventDefault();
              addFiles(Array.from(event.dataTransfer.files));
            }
          }}
        >
          {reply && (
            <div className="flex items-center gap-3 border-b border-border/60 px-4 py-3">
              <div className="min-w-0 flex-1 border-l-2 border-blue-500 pl-3 text-xs">
                <p className="font-medium text-blue-500">
                  {reply.kind === "edit"
                    ? "Editing message"
                    : reply.kind === "worker"
                      ? `To ${reply.name}`
                      : `Replying to ${reply.name}`}
                </p>
                <p className="mt-0.5 truncate text-muted-foreground">{reply.text}</p>
              </div>
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                aria-label={reply.kind === "edit" ? "Cancel editing" : "Cancel reply"}
                onClick={clearReply}
              >
                <XIcon />
              </Button>
            </div>
          )}
          {drafts.length > 0 && (
            <ConversationAttachmentDrafts
              drafts={drafts}
              disabled={sending}
              remove={(id) => state.attachments.remove(chat.id, id)}
              retry={(id) => {
                if (lead) state.attachments.retry(chat.id, lead.id, id);
              }}
            />
          )}
          <div className="flex items-end gap-2 p-2">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="mb-0.5 rounded-full"
              aria-label="Attach images and files"
              disabled={sending || !lead?.canDirect || reply?.kind === "edit"}
              onClick={() => fileInput.current?.click()}
            >
              <PaperclipIcon className="size-5" />
            </Button>
            <textarea
              ref={input}
              aria-label={`Message ${chat.title}`}
              placeholder={`Message ${chat.title}`}
              className="field-sizing-content max-h-40 min-h-9 min-w-0 flex-1 resize-none bg-transparent py-2 text-sm leading-5 outline-none placeholder:text-muted-foreground"
              rows={1}
              value={text}
              onChange={(event) => state.setDraft(chat.id, event.target.value)}
              maxLength={32000}
              disabled={sending}
              onPaste={(event) => {
                const files = Array.from(event.clipboardData.files);
                const plainText = event.clipboardData.getData("text/plain");
                const hasImageFile = files.some((file) =>
                  file.type.toLowerCase().startsWith("image/"),
                );
                if (
                  shouldHandleComposerAttachmentPaste({
                    files,
                    plainText,
                  })
                ) {
                  if (!plainText.length || hasImageFile) event.preventDefault();
                  addFiles(files);
                }
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape" && reply) {
                  event.preventDefault();
                  clearReply();
                  return;
                }
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  send();
                }
              }}
            />
            <Button
              type="submit"
              size="icon"
              className="size-9 shrink-0 rounded-full bg-blue-500 text-white hover:bg-blue-600"
              aria-label={reply?.kind === "edit" ? "Save message" : "Send message"}
              disabled={sending || blocked || (!text.trim() && !drafts.length) || !lead?.canDirect}
            >
              <ArrowUpIcon className="size-5" />
            </Button>
          </div>
        </div>
        {sending && reply?.kind !== "edit" && (
          <p role="status" className="mt-2 px-3 text-right text-[11px] text-muted-foreground">
            Sending…
          </p>
        )}
        {blocked && (
          <p role="status" className="mt-2 px-3 text-[11px] text-muted-foreground">
            {drafts.some((draft) => draft.status === "failed")
              ? "Retry or remove the failed attachment before sending."
              : "Attachments still uploading…"}
          </p>
        )}
        {lead?.status === "paused" && (
          <p className="mt-2 px-3 text-[11px] text-muted-foreground">
            {lead.name} is paused. Your message will wait in the queue.
          </p>
        )}
      </form>
    </div>
  );
}
export function OrchestratorConversation({ floating = false }: { floating?: boolean }) {
  const state = useOrchestrators();
  const navigate = useNavigate();
  const [switcher, setSwitcher] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const sendMotion = useRef<ComposerSendMotion | null>(null);
  const [details, setDetails] = useState(
    () => !floating && window.matchMedia("(min-width: 1280px)").matches,
  );
  const [floatingDetails, setFloatingDetails] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState("");
  const narrow = useMediaQuery("(max-width: 1279px)");
  const chat = state.selected;
  useEffect(() => {
    sendMotion.current = null;
  }, [chat?.id]);
  const contacts = state.contacts.filter((contact) => chat?.orchestratorIds.includes(contact.id));
  const work = useOrchestratorQuery<OrchestratorWorkItem[]>(
    state.client,
    state.accountID,
    "aiOrchestrators:work",
    chat ? { chatId: chat.id } : null,
  );
  const messages = useOrchestratorQuery<OrchestratorMessagePage>(
    state.client,
    state.accountID,
    "aiOrchestrators:messages",
    chat ? { chatId: chat.id } : null,
  );
  const activity = useOrchestratorQuery<OrchestratorActivity>(
    state.client,
    state.accountID,
    "aiOrchestrators:activity",
    chat ? { chatId: chat.id } : null,
  );
  const sheet = details && (floatingDetails || floating || narrow);
  return (
    <div
      ref={panelRef}
      data-conversation-surface
      className={cn(
        "relative flex h-full min-h-0 min-w-0 flex-1 bg-background",
        floating && "dark:bg-popover",
      )}
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header
          className={cn(
            "flex shrink-0 items-center gap-3 border-b px-5",
            floating ? "h-14" : "h-20 pl-12 sm:pl-6",
          )}
        >
          {floating && <FloatingConversationSwitcher anchor={panelRef} />}
          <Popover open={switcher} onOpenChange={setSwitcher}>
            <PopoverTrigger className="flex min-w-0 flex-1 items-center gap-3 rounded-lg py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <ConversationAvatar
                key={chat?.id ?? "welcome"}
                contacts={state.avatarContacts.filter((contact) =>
                  chat?.orchestratorIds.includes(contact.id ?? ""),
                )}
                fallbackContact={state.personalAvatar}
                messages={messages.value?.messages}
                work={work.value}
                activity={activity.value}
                idle="frequent"
              />
              <span className="min-w-0">
                <span className="flex items-center gap-2 text-sm font-semibold">
                  <span className="truncate">{chat?.title ?? "Your orchestrators"}</span>
                  <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground" />
                </span>
                <span className="mt-1 block truncate text-xs text-muted-foreground">
                  {chat
                    ? `You, ${contacts.map((contact) => contact.name).join(", ")}`
                    : "A little help with everything"}
                </span>
              </span>
            </PopoverTrigger>
            <PopoverPopup align="start" className="w-80" viewportClassName="p-0">
              <div className="flex items-center justify-between p-3">
                <span className="text-sm font-semibold">Conversations</span>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="New conversation"
                  onClick={() => {
                    setSwitcher(false);
                    state.setNewChatOpen(true);
                  }}
                >
                  <PlusIcon className="size-4" />
                </Button>
              </div>
              <div className="flex h-96 flex-col">
                <ConversationList onSelect={() => setSwitcher(false)} />
              </div>
            </PopoverPopup>
          </Popover>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              aria-label="Search this conversation"
              onClick={() => setSearchOpen((value) => !value)}
            >
              <SearchIcon className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Conversation details"
              aria-pressed={details}
              onClick={() => setDetails((value) => !value)}
            >
              <PanelRightIcon className="size-4" />
            </Button>
            {floating ? (
              <>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Expand conversation"
                  onClick={() => {
                    state.setFloating(false);
                    void navigate({ to: "/orchestrator" });
                  }}
                >
                  <Maximize2Icon className="size-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Minimize companion"
                  onClick={() => state.setFloating(false)}
                >
                  <MinusIcon className="size-4" />
                </Button>
              </>
            ) : (
              <Button
                variant="ghost"
                size="icon"
                aria-label="Open floating companion"
                onClick={() => {
                  state.setFloating(true);
                }}
              >
                <ArrowUpRightIcon className="size-4" />
              </Button>
            )}
          </div>
        </header>
        {searchOpen && (
          <label className="flex items-center gap-3 border-b px-6 py-2">
            <SearchIcon className="size-4 text-muted-foreground" />
            <input
              aria-label="Search messages"
              placeholder="Search messages"
              className="min-w-0 flex-1 bg-transparent text-sm outline-none"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <Button
              size="icon"
              variant="ghost"
              aria-label="Close search"
              onClick={() => {
                setSearchOpen(false);
                setSearch("");
              }}
            >
              <XIcon className="size-4" />
            </Button>
          </label>
        )}
        {state.error && (
          <div
            role="alert"
            className="flex items-start gap-3 border-b border-destructive/20 bg-destructive/5 px-5 py-3 text-xs text-destructive"
          >
            <p className="flex-1">{state.error}</p>
            <button
              type="button"
              aria-label="Dismiss error"
              onClick={() => state.setError(undefined)}
            >
              <XIcon className="size-4" />
            </button>
          </div>
        )}
        {chat ? (
          <>
            <ConversationMessages
              key={`messages:${chat.id}`}
              chat={chat}
              work={work.value ?? []}
              search={search}
              result={messages}
              sendMotion={sendMotion}
            />
            <Composer
              key={`composer:${chat.id}`}
              chat={chat}
              activity={activity.value ?? EMPTY_ACTIVITY}
              sendMotion={sendMotion}
            />
          </>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-8 text-center">
            <OrchestratorAvatar
              contact={state.personalAvatar}
              className="size-24"
              interactive
              idle
            />
            <h1 className="mt-6 text-2xl font-semibold tracking-tight">
              A colleague for every part of your day.
            </h1>
            <p className="mt-3 max-w-sm text-sm leading-relaxed text-muted-foreground">
              Talk through your plans, bring projects together, and let your orchestrators keep the
              work moving.
            </p>
            <Button className="mt-6" onClick={() => state.setNewChatOpen(true)}>
              <MessageCircleIcon />
              Start a conversation
            </Button>
            <Button
              className="mt-2"
              variant="ghost"
              onClick={() => {
                void navigate({ to: "/settings/orchestrators-overview" });
              }}
            >
              Set up your orchestrators
              <ChevronRightIcon className="size-4" />
            </Button>
          </div>
        )}
      </div>
      {details && !sheet && chat && (
        <aside className="w-[310px] shrink-0 border-l">
          <ConversationMetadata
            chat={chat}
            work={work.value ?? []}
            onClose={() => setDetails(false)}
            onFloat={() => setFloatingDetails(true)}
            floating={false}
          />
        </aside>
      )}
      {chat && floating && (
        <FloatingDetailsPanel anchor={panelRef} open={details} onClose={() => setDetails(false)}>
          <ConversationMetadata
            chat={chat}
            work={work.value ?? []}
            onClose={() => setDetails(false)}
            onFloat={() => {
              setFloatingDetails(false);
              state.setFloating(false);
              void navigate({ to: "/orchestrator" });
            }}
            floating
            companion
          />
        </FloatingDetailsPanel>
      )}
      {chat && !floating && (
        <RightPanelSheet
          open={sheet}
          onClose={() => setDetails(false)}
          defaultWidth={340}
          widthStorageKey="pathway:orchestrator-details-width"
        >
          <SheetTitle className="sr-only">Conversation details</SheetTitle>
          <ConversationMetadata
            chat={chat}
            work={work.value ?? []}
            onClose={() => setDetails(false)}
            onFloat={() => {
              setFloatingDetails(false);
              if (floating) {
                state.setFloating(false);
                void navigate({ to: "/orchestrator" });
              }
            }}
            floating
          />
        </RightPanelSheet>
      )}
    </div>
  );
}
export function OrchestratorFullView() {
  const state = useOrchestrators();
  return (
    <SidebarInset className="min-h-0 overflow-hidden">
      {state.floating ? (
        <div className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center">
          <MessageCircleIcon className="size-8 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            Your conversation is open in the floating companion.
          </p>
          <Button variant="outline" onClick={() => state.setFloating(false)}>
            Bring conversation here
          </Button>
        </div>
      ) : (
        <OrchestratorConversation />
      )}
    </SidebarInset>
  );
}
export function OrchestratorOverlay() {
  const state = useOrchestrators();
  return (
    <>
      <NewConversationDialog />
      {state.floating &&
        createPortal(
          <section
            aria-label="Floating orchestrator companion"
            data-floating-companion
            className="fixed right-4 bottom-4 z-[80] flex h-[min(760px,calc(100dvh-88px))] w-[min(650px,calc(100vw-32px))] flex-col overflow-hidden rounded-[26px] border border-border bg-background shadow-[0_18px_80px_-12px_rgb(0_0_0/0.28)] dark:border-foreground/15 dark:bg-popover dark:shadow-[0_18px_80px_-12px_rgb(0_0_0/0.65)]"
          >
            <OrchestratorConversation floating />
          </section>,
          document.body,
        )}
    </>
  );
}
