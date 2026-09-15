import { useRef, useState, type ReactNode } from "react";
import type { OrchestratorChat } from "@spiritdevs/contracts/aiOrchestrator";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import {
  AlertDialog,
  AlertDialogPopup,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { useOrchestrators } from "./OrchestratorContext";

export function ConversationRowMenu({
  chat,
  children,
}: {
  chat: OrchestratorChat;
  children: ReactNode;
}) {
  const state = useOrchestrators();
  const row = useRef<HTMLDivElement>(null);
  const [point, setPoint] = useState<{ x: number; y: number }>();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const owner = chat.ownerSubject === state.accountID;
  const stopping = !!chat.lifecycle && chat.lifecycle !== "archived";
  const run = async (name: string, args: Record<string, unknown>) => {
    setBusy(true);
    try {
      await state.request(name, { chatId: chat.id, ...args });
      setConfirm(false);
    } catch (cause) {
      state.setError(
        cause instanceof Error ? cause.message : "Could not update this conversation.",
      );
    } finally {
      setBusy(false);
    }
  };
  const preference = (args: Record<string, boolean>) =>
    void run("aiOrchestrators:setChatPreferences", args);
  return (
    <div
      ref={row}
      onContextMenu={(event) => {
        event.preventDefault();
        setPoint({ x: event.clientX, y: event.clientY });
      }}
      onKeyDown={(event) => {
        if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
          event.preventDefault();
          const rect = event.currentTarget.getBoundingClientRect();
          setPoint({ x: rect.left + 24, y: rect.top + 24 });
        }
      }}
    >
      {children}
      {point && (
        <Menu
          open
          onOpenChange={(open) => {
            if (!open) {
              setPoint(undefined);
              row.current?.querySelector("button")?.focus();
            }
          }}
        >
          <MenuTrigger
            nativeButton={false}
            render={<span />}
            tabIndex={-1}
            className="pointer-events-none fixed size-0"
            style={{ left: point.x, top: point.y }}
          >
            <span className="sr-only">Conversation actions</span>
          </MenuTrigger>
          <MenuPopup
            align="start"
            anchor={{ getBoundingClientRect: () => new DOMRect(point.x, point.y, 0, 0) }}
            className="w-48"
          >
            <MenuItem onClick={() => preference({ pinned: !chat.pinned })}>
              {chat.pinned ? "Unpin" : "Pin"}
            </MenuItem>
            <MenuItem onClick={() => preference({ markedUnread: true })}>Mark as unread</MenuItem>
            <MenuItem onClick={() => preference({ muted: !chat.muted })}>
              {chat.muted ? "Show alerts" : "Hide alerts"}
            </MenuItem>
            <MenuItem
              disabled={!owner || stopping}
              onClick={() => void run("aiOrchestrators:updateChat", { archived: !chat.archived })}
            >
              {chat.archived ? "Restore conversation" : "Archive"}
            </MenuItem>
            <MenuItem
              variant="destructive"
              disabled={!owner || chat.lifecycle === "deleting"}
              onClick={() => setConfirm(true)}
            >
              Delete
            </MenuItem>
          </MenuPopup>
        </Menu>
      )}
      <AlertDialog
        open={confirm}
        onOpenChange={(open) => {
          if (!busy) setConfirm(open);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {chat.title}?</AlertDialogTitle>
            <AlertDialogDescription>
              This conversation may have unfinished work, active agent threads, or subagents.
              Deleting requests that its work stop. The conversation stays in Archived conversations
              until its workers confirm they have stopped, including offline workers. Unrelated
              conversations keep running. Deletion cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setConfirm(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => void run("aiOrchestrators:deleteChat", { confirmed: true })}
            >
              {busy ? "Requesting…" : "Delete conversation"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}
