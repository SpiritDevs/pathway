import { useState, useEffect, type RefObject } from "react";
import {
  ArchiveIcon,
  PlusIcon,
  SearchIcon,
  SquarePenIcon,
  PanelLeftIcon,
  XIcon,
} from "lucide-react";
import { ContextualSidebarHeader } from "../sidebar/ContextualSidebarHeader";
import { Button } from "../ui/button";
import { useOrchestrators } from "./OrchestratorContext";
import { ConversationAvatar, OrchestratorAvatar } from "./OrchestratorAvatar";
import { Dialog } from "@base-ui/react/dialog";
import {
  unreadMessageTotal,
  unreadLabel,
  conversationTime,
  conversationPanelLayout,
} from "./conversationList";
import { cn } from "../../lib/utils";

export function ConversationList({ onSelect }: { onSelect?: () => void }) {
  const state = useOrchestrators();
  const [search, setSearch] = useState("");
  const [archived, setArchived] = useState(false);
  const chats = state.chats
    .toSorted((a, b) => (b.lastMessageAt ?? b.updatedAt) - (a.lastMessageAt ?? a.updatedAt))
    .filter(
      (chat) =>
        chat.archived === archived &&
        (chat.title + " " + chat.lastMessage).toLowerCase().includes(search.toLowerCase()),
    );
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="px-3 pb-3">
        <label className="flex items-center gap-2 rounded-xl bg-muted/65 px-3 py-2 text-muted-foreground">
          <SearchIcon className="size-4" />
          <input
            aria-label="Search conversations"
            placeholder="Search conversations"
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
      </div>
      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto px-2">
        {chats.map((chat) => (
          <button
            key={chat.id}
            type="button"
            onClick={() => {
              state.selectChat(chat.id);
              onSelect?.();
            }}
            aria-current={chat.id === state.selectedId ? "true" : undefined}
            className={cn(
              "flex w-full items-center gap-3 rounded-xl px-3 py-3.5 text-left hover:bg-muted/60",
              chat.id === state.selectedId && "bg-blue-500/10 hover:bg-blue-500/10",
            )}
          >
            <ConversationAvatar
              contacts={state.avatarContacts.filter((contact) =>
                chat.orchestratorIds.includes(contact.id ?? ""),
              )}
            />
            <span className="min-w-0 flex-1">
              <span className="flex items-baseline gap-2">
                <span className="truncate text-sm font-semibold">{chat.title}</span>
                <time
                  className="ml-auto shrink-0 text-[10px] text-muted-foreground"
                  dateTime={new Date(chat.lastMessageAt ?? chat.updatedAt).toISOString()}
                  title={new Date(chat.lastMessageAt ?? chat.updatedAt).toLocaleString()}
                >
                  {conversationTime(chat.lastMessageAt ?? chat.updatedAt)}
                </time>
              </span>
              <span className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                {chat.lastMessage || "Start a conversation"}
              </span>
            </span>
            {(chat.unreadCount ?? 0) > 0 ? (
              <span
                className="inline-flex min-w-5 shrink-0 items-center justify-center rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-semibold text-primary-foreground"
                aria-label={`${unreadLabel(chat.unreadCount!)} unread messages`}
              >
                {unreadLabel(chat.unreadCount!)}
              </span>
            ) : chat.lastSequence > chat.readSequence ? (
              <span
                className="size-2 shrink-0 rounded-full bg-blue-500"
                aria-label="Unread messages"
              />
            ) : null}
          </button>
        ))}
        {state.loading && (
          <p className="px-3 py-8 text-center text-sm text-muted-foreground">
            Loading conversations…
          </p>
        )}
        {!state.loading && chats.length === 0 && (
          <p className="px-3 py-6 text-center text-sm text-muted-foreground">
            {search
              ? "No conversations found."
              : archived
                ? "No archived conversations."
                : "Your conversations will appear here."}
          </p>
        )}
        {!search && !archived && state.contacts.length > 0 && (
          <div className="pt-5">
            <p className="px-3 pb-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Your orchestrators
            </p>
            {state.contacts
              .filter((contact) => contact.status !== "archived")
              .map((contact) => (
                <button
                  key={contact.id}
                  type="button"
                  className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left hover:bg-muted/60"
                  onClick={() => {
                    void state
                      .request("aiOrchestrators:createChat", {
                        title: contact.name,
                        orchestratorIds: [contact.id],
                        leadId: contact.id,
                        companyIds: state.companyId ? [state.companyId] : [],
                      })
                      .then((id) => {
                        if (typeof id === "string") state.selectChat(id);
                        onSelect?.();
                      })
                      .catch((cause: unknown) =>
                        state.setError(cause instanceof Error ? cause.message : String(cause)),
                      );
                  }}
                >
                  <OrchestratorAvatar contact={contact} className="size-8" />
                  <span className="flex-1 text-sm">{contact.name}</span>
                  <PlusIcon className="size-3.5 text-muted-foreground" />
                </button>
              ))}
          </div>
        )}
      </div>
      <div className="shrink-0 border-t p-2">
        <Button
          variant="ghost"
          className="w-full justify-start text-muted-foreground"
          onClick={() => setArchived((value) => !value)}
        >
          <ArchiveIcon />
          {archived ? "Back to conversations" : "Archived conversations"}
        </Button>
      </div>
    </div>
  );
}

export function OrchestratorSidebar() {
  const state = useOrchestrators();
  return (
    <>
      <ContextualSidebarHeader title="Orchestrators" />
      <div className="flex items-center justify-between px-4 pb-3">
        <span className="text-xs text-muted-foreground">Conversations</span>
        <Button
          variant="ghost"
          size="icon"
          aria-label="New conversation"
          onClick={() => state.setNewChatOpen(true)}
        >
          <SquarePenIcon className="size-4" />
        </Button>
      </div>
      <ConversationList />
    </>
  );
}

export function FloatingConversationSwitcher({
  anchor,
}: {
  anchor: RefObject<HTMLDivElement | null>;
}) {
  const state = useOrchestrators();
  const [open, setOpen] = useState(false);
  const unread = unreadMessageTotal(state.chats);
  const [layout, setLayout] = useState<ReturnType<typeof conversationPanelLayout> | null>(null);
  useEffect(() => {
    const element = anchor.current;
    if (!element) return;
    const measure = () => setLayout(conversationPanelLayout(element.getBoundingClientRect()));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [anchor]);
  const docked = layout?.docked ?? false;

  return (
    <Dialog.Root open={open} onOpenChange={setOpen} modal={false}>
      <Dialog.Trigger
        render={<Button variant="ghost" size="sm" />}
        className="shrink-0 gap-1.5 px-2"
        aria-label={`Conversations${unread ? `, ${unreadLabel(unread)} unread messages` : ""}`}
      >
        <PanelLeftIcon className="size-4" />
        {unread > 0 && (
          <span
            className="rounded-full bg-primary px-1.5 text-[10px] leading-5 font-semibold tabular-nums text-primary-foreground"
            aria-hidden="true"
          >
            {unreadLabel(unread)}
          </span>
        )}
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Viewport
          className={cn(
            "pointer-events-none fixed z-[130] overflow-hidden",
            !docked && "rounded-[26px]",
          )}
          style={
            layout
              ? {
                  left: layout.left,
                  top: layout.top,
                  width: layout.width,
                  height: layout.height,
                  right: "auto",
                  bottom: "auto",
                }
              : { visibility: "hidden" }
          }
        >
          {!docked && (
            <Dialog.Backdrop
              onClick={() => setOpen(false)}
              className="pointer-events-auto absolute inset-0 bg-black/40 transition-opacity duration-200 data-starting-style:opacity-0 data-ending-style:opacity-0 motion-reduce:transition-none"
            />
          )}
          <Dialog.Popup
            aria-label="Conversations"
            style={{ width: layout?.panelWidth }}
            className={cn(
              "pointer-events-auto relative flex h-full min-h-0 flex-col border bg-popover text-popover-foreground shadow-xl outline-none transition-transform duration-250 ease-[cubic-bezier(0.25,1,0.5,1)] motion-reduce:transition-none",
              docked
                ? "w-full rounded-l-2xl data-starting-style:translate-x-full data-ending-style:translate-x-full"
                : "rounded-l-[26px] data-starting-style:-translate-x-full data-ending-style:-translate-x-full",
            )}
          >
            <div className="flex h-14 shrink-0 items-center justify-between px-4">
              <Dialog.Title className="text-sm font-semibold">Conversations</Dialog.Title>
              <div className="flex gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="New conversation"
                  onClick={() => {
                    setOpen(false);
                    state.setNewChatOpen(true);
                  }}
                >
                  <SquarePenIcon className="size-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Close conversations"
                  onClick={() => setOpen(false)}
                >
                  <XIcon className="size-4" />
                </Button>
              </div>
            </div>
            <ConversationList onSelect={() => setOpen(false)} />
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
