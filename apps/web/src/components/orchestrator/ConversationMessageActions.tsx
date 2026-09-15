import { useState, type ReactNode } from "react";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CopyIcon,
  MoreHorizontalIcon,
  PencilIcon,
  ReplyIcon,
  SendIcon,
  XIcon,
} from "lucide-react";
import { makeFunctionReference } from "convex/server";
import type {
  OrchestratorMessage,
  OrchestratorWorkerAction,
  OrchestratorWorkerMessage,
} from "@spiritdevs/contracts/aiOrchestrator";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { mapEnvironmentControlError } from "../../cloud/environmentControl";
import { useOrchestrators } from "./OrchestratorContext";
import { replyToMessage } from "./conversationReply";

export function ConversationMessageActions({
  message,
  children,
}: {
  message: OrchestratorMessage;
  children: ReactNode;
}) {
  const state = useOrchestrators();
  const [point, setPoint] = useState<{ x: number; y: number }>();
  const delivery = message.delivery;
  const pending = delivery?.state === "pending";
  const canDirect = state.contacts.some(
    (contact) =>
      contact.canDirect &&
      (message.senderKind !== "orchestrator" || contact.id === message.senderId),
  );
  const reply = () => state.setReply(message.chatId, replyToMessage(message));
  const run = async (action: OrchestratorWorkerAction) => {
    try {
      await state.request("aiOrchestratorControls:control", {
        chatId: message.chatId,
        action:
          action.kind === "reorderWorkMessages" ? { ...action, queue: [...action.queue] } : action,
      });
    } catch (cause) {
      state.setError(mapEnvironmentControlError(cause).message);
    }
  };
  const move = async (offset: number) => {
    if (!delivery || !state.client) return;
    try {
      const result = await state.client.query(
        makeFunctionReference<
          "query",
          { chatId: string; workId: string },
          { messages: OrchestratorWorkerMessage[] }
        >("aiOrchestratorControls:conversation"),
        { chatId: message.chatId, workId: delivery.workId },
      );
      const queue = result.messages
        .filter((item) => item.state === "pending")
        .sort((a, b) => a.position - b.position)
        .map(({ id, revision, mode }) => ({ id, revision, mode }));
      const index = queue.findIndex(
        (item) => item.id === delivery.id && item.revision === delivery.revision,
      );
      if (index < 0) throw new Error("This message has changed. Open its menu again.");
      let destination = index + offset;
      while (
        destination >= 0 &&
        destination < queue.length &&
        queue[destination]!.mode !== delivery.mode
      ) {
        destination += offset;
      }
      if (destination < 0 || destination >= queue.length) return;
      [queue[index], queue[destination]] = [queue[destination]!, queue[index]!];
      await run({
        kind: "reorderWorkMessages",
        workId: delivery.workId,
        queue: queue.map(({ id, revision }) => ({ id, revision })),
      });
    } catch (cause) {
      state.setError(mapEnvironmentControlError(cause).message);
    }
  };
  return (
    <div
      className="group/message relative"
      onContextMenu={(event) => {
        event.preventDefault();
        setPoint({ x: event.clientX, y: event.clientY });
      }}
    >
      {children}
      <button
        type="button"
        aria-label={`Actions for message from ${message.senderName}`}
        className="absolute -top-3 right-1 flex size-7 items-center justify-center rounded-full border bg-popover text-foreground opacity-0 shadow-sm transition-opacity group-hover/message:opacity-100 focus:opacity-100 data-[open=true]:opacity-100"
        data-open={!!point}
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          setPoint({ x: rect.right, y: rect.bottom });
        }}
      >
        <MoreHorizontalIcon className="size-4" />
      </button>
      {point && (
        <Menu
          open
          onOpenChange={(open) => {
            if (!open) setPoint(undefined);
          }}
        >
          <MenuTrigger
            nativeButton={false}
            render={<span />}
            className="pointer-events-none fixed size-0"
            style={{ left: point.x, top: point.y }}
            tabIndex={-1}
          >
            <span className="sr-only">Message actions</span>
          </MenuTrigger>
          <MenuPopup
            align="start"
            anchor={{ getBoundingClientRect: () => new DOMRect(point.x, point.y, 0, 0) }}
            className="w-48"
          >
            <MenuItem onClick={reply}>
              <ReplyIcon />
              Reply
            </MenuItem>
            <MenuItem
              onClick={() => {
                void navigator.clipboard
                  .writeText(message.text)
                  .catch(() => state.setError("Could not copy this message."));
              }}
            >
              <CopyIcon />
              Copy text
            </MenuItem>
            {pending && canDirect && delivery.mode !== "answer" && (
              <>
                <MenuSeparator />
                <MenuItem
                  onClick={() => {
                    state.setReply(message.chatId, {
                      kind: "edit",
                      name: message.senderName,
                      text: message.text,
                      workId: delivery.workId,
                      deliveryId: delivery.id,
                      revision: delivery.revision,
                      previousDraft: state.drafts[message.chatId] ?? "",
                    });
                    state.setDraft(message.chatId, message.text);
                  }}
                >
                  <PencilIcon />
                  Edit message
                </MenuItem>
                <MenuItem
                  onClick={() => {
                    void move(-1);
                  }}
                >
                  <ArrowUpIcon />
                  Move earlier
                </MenuItem>
                <MenuItem
                  onClick={() => {
                    void move(1);
                  }}
                >
                  <ArrowDownIcon />
                  Move later
                </MenuItem>
                {delivery.mode === "queue" && (
                  <MenuItem
                    onClick={() => {
                      void run({
                        kind: "editWorkMessage",
                        workId: delivery.workId,
                        id: delivery.id,
                        revision: delivery.revision,
                        text: message.text,
                        mode: "steer",
                      });
                    }}
                  >
                    <SendIcon />
                    Send to active turn
                  </MenuItem>
                )}
              </>
            )}
            {!delivery &&
              message.senderId === state.accountID &&
              (message.status === "queued" || message.status === "failed") && (
                <MenuItem
                  variant={message.status === "queued" ? "destructive" : "default"}
                  onClick={() => {
                    void state
                      .request(
                        message.status === "queued"
                          ? "aiOrchestrators:cancelMessage"
                          : "aiOrchestrators:retryMessage",
                        { chatId: message.chatId, messageId: message.id },
                      )
                      .catch((cause) => state.setError(mapEnvironmentControlError(cause).message));
                  }}
                >
                  {message.status === "queued" ? <XIcon /> : <SendIcon />}
                  {message.status === "queued" ? "Cancel message" : "Retry message"}
                </MenuItem>
              )}
            {pending && canDirect && (
              <MenuItem
                variant="destructive"
                onClick={() => {
                  void run({
                    kind: "removeWorkMessage",
                    workId: delivery.workId,
                    id: delivery.id,
                    revision: delivery.revision,
                  });
                }}
              >
                <XIcon />
                Cancel message
              </MenuItem>
            )}
          </MenuPopup>
        </Menu>
      )}
    </div>
  );
}
