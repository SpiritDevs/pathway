import { useState, type ReactNode } from "react";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CopyIcon,
  MoreHorizontalIcon,
  PencilIcon,
  ReplyIcon,
  SendIcon,
  ShareIcon,
  XIcon,
} from "lucide-react";
import { makeFunctionReference } from "convex/server";
import {
  ORCHESTRATOR_MESSAGE_REACTIONS,
  type OrchestratorMessage,
  type OrchestratorWorkerAction,
  type OrchestratorWorkerMessage,
} from "@spiritdevs/contracts/aiOrchestrator";
import { cn, isMacPlatform } from "../../lib/utils";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { mapEnvironmentControlError } from "../../cloud/environmentControl";
import { useOrchestrators } from "./OrchestratorContext";
import { groupReactions } from "./conversationReactions";
import { canDirectMessageWorker, replyToMessage } from "./conversationReply";

/**
 * A message with its right-click menu (react, reply, copy, share) and the reactions left on
 * it, shown as a tapback on its top corner. Touch screens cannot right-click, so they keep a button that opens the same menu.
 */
export function ConversationMessageActions({
  message,
  own,
  children,
}: {
  message: OrchestratorMessage;
  /** The viewer sent this message, so its reactions ride its top-left corner. */
  own: boolean;
  children: ReactNode;
}) {
  const state = useOrchestrators();
  const [point, setPoint] = useState<{ x: number; y: number }>();
  const delivery = message.delivery;
  const pending = delivery?.state === "pending";
  const canDirect = canDirectMessageWorker(message, state.contacts);
  const reply = () => state.setReply(message.chatId, replyToMessage(message));
  const reactions = groupReactions(message.reactions, state.accountID);
  const react = (emoji: string) => {
    void state
      .request("aiOrchestrators:react", { chatId: message.chatId, messageId: message.id, emoji })
      .catch((cause) => state.setError(mapEnvironmentControlError(cause).message));
  };
  // The desktop app opens the Mac share sheet; browsers that can share use their own.
  const shareOnDesktop = isMacPlatform(navigator.platform)
    ? window.desktopBridge?.shareText
    : undefined;
  const canShare = shareOnDesktop !== undefined || typeof navigator.share === "function";
  const share = (position: { x: number; y: number }) => {
    const failed = () => state.setError("Could not share this message.");
    if (shareOnDesktop) {
      void shareOnDesktop(message.text, position).then((opened) => {
        if (!opened) failed();
      }, failed);
      return;
    }
    void navigator.share({ text: message.text }).catch((cause: unknown) => {
      // Closing the share sheet is not a failure.
      if (!(cause instanceof DOMException && cause.name === "AbortError")) failed();
    });
  };
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
      // Room above for the tapback, which overlaps the bubble's top edge.
      className={cn("group/message relative", reactions.length > 0 && "mt-4")}
      onContextMenu={(event) => {
        event.preventDefault();
        setPoint({ x: event.clientX, y: event.clientY });
      }}
    >
      {children}
      <button
        type="button"
        aria-label={`Actions for message from ${message.senderName}`}
        className={cn(
          "absolute -top-3 hidden size-7 items-center justify-center rounded-full border bg-popover text-foreground shadow-sm pointer-coarse:flex",
          // Opposite the tapback's corner.
          own ? "right-1" : "left-1",
        )}
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
            className="w-56"
          >
            <div role="group" aria-label="React" className="flex justify-between px-1 pb-1">
              {ORCHESTRATOR_MESSAGE_REACTIONS.map((emoji) => (
                <MenuItem
                  key={emoji}
                  aria-label={`React with ${emoji}`}
                  className={cn(
                    "size-8 min-h-0 justify-center rounded-full p-0 text-lg sm:min-h-0 sm:text-lg",
                    reactions.some((reaction) => reaction.mine && reaction.emoji === emoji) &&
                      "bg-accent",
                  )}
                  onClick={() => react(emoji)}
                >
                  {emoji}
                </MenuItem>
              ))}
            </div>
            <MenuSeparator />
            <MenuItem onClick={reply} disabled={message.worker?.isSecret}>
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
              Copy
            </MenuItem>
            {canShare && (
              <MenuItem disabled={!message.text} onClick={() => share(point)}>
                <ShareIcon />
                Share…
              </MenuItem>
            )}
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
                      ...(message.worker?.orchestratorId
                        ? { orchestratorId: message.worker.orchestratorId }
                        : {}),
                    });
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
      {reactions.length > 0 && (
        // A tapback: it rides the bubble's outer top corner, away from the side it hangs on.
        <div
          className={cn(
            "absolute -top-3.5 flex h-7 items-center gap-0.5 rounded-full border bg-popover px-0.5 shadow-sm",
            own ? "-left-3" : "-right-3",
          )}
        >
          {reactions.map((reaction) => (
            <button
              key={reaction.emoji}
              type="button"
              aria-pressed={reaction.mine}
              aria-label={`${reaction.emoji} ${reaction.count}, ${reaction.mine ? "remove your reaction" : "react too"}`}
              className={cn(
                "flex h-6 min-w-6 items-center justify-center gap-0.5 rounded-full px-1 text-[11px] tabular-nums",
                reaction.mine ? "bg-blue-500 text-white" : "text-muted-foreground",
              )}
              onClick={() => react(reaction.emoji)}
            >
              <span
                className={cn(
                  "text-sm leading-none",
                  // Emoji keep their own colours, so red or yellow glyphs are flattened to
                  // white on the blue. A face would become a blank disc, so it stays as it is.
                  reaction.mine && reaction.emoji !== "😂" && "brightness-0 invert",
                )}
              >
                {reaction.emoji}
              </span>
              {reaction.count > 1 ? reaction.count : null}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
