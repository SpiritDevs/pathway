import {
  CheckCircle2Icon,
  ChevronDownIcon,
  ChevronUpIcon,
  MessageCircleIcon,
  MessagesSquareIcon,
  MinusIcon,
  XIcon,
} from "lucide-react";
import * as Schema from "effect/Schema";
import { type MouseEvent, type PointerEvent, type Ref, type RefObject, useRef } from "react";
import { flushSync } from "react-dom";

import { Button } from "~/components/ui/button";
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "~/components/ui/menu";
import { cn } from "~/lib/utils";

import { COMPOSER_CONTEXT_STRIP_CLASS_NAME } from "./composerContextStrip";

/** First paragraph of a reply as plain text, for a one-line preview. */
export function replyPreview(markdown: string): string {
  const paragraph =
    markdown
      .split(/\n\s*\n/)
      .map((part) => part.trim())
      .find((part) => part.length > 0 && !part.startsWith("```")) ?? "";
  return paragraph
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^#+\s+|^>\s?|^[-*+]\s+|^\d+\.\s+/gm, "")
    .replace(/[*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Top of the floating chat while expanded over a maximized browser. */
export const FloatingChatCorner = Schema.Literals([
  "bottom-right",
  "bottom-center",
  "bottom-left",
  "top-right",
  "top-left",
]);
export type FloatingChatCorner = typeof FloatingChatCorner.Type;

/** Where the floating chat sits in the panel; the insets match the spot math below. */
export const FLOATING_CHAT_CORNER_CLASS_NAME: Record<FloatingChatCorner, string> = {
  "bottom-right": "right-3 bottom-1",
  "bottom-center": "inset-x-0 mx-auto bottom-1",
  "bottom-left": "left-3 bottom-1",
  "top-right": "right-3 top-3",
  "top-left": "left-3 top-3",
};
const SIDE_INSET_PX = 12;
const TOP_INSET_PX = 12;
const BOTTOM_INSET_PX = 4;
const DRAG_THRESHOLD_PX = 4;

/** The spot whose resting place is closest to where the chat was dropped. */
export function nearestFloatingChatCorner(
  bounds: Pick<DOMRect, "left" | "top" | "width" | "height">,
  chat: Pick<DOMRect, "left" | "top" | "width" | "height">,
): FloatingChatCorner {
  const x = chat.left - bounds.left + chat.width / 2;
  const y = chat.top - bounds.top + chat.height / 2;
  const restingX = {
    left: SIDE_INSET_PX + chat.width / 2,
    center: bounds.width / 2,
    right: bounds.width - SIDE_INSET_PX - chat.width / 2,
  };
  const restingY = {
    top: TOP_INSET_PX + chat.height / 2,
    bottom: bounds.height - BOTTOM_INSET_PX - chat.height / 2,
  };
  let nearest: FloatingChatCorner = "bottom-right";
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const corner of FloatingChatCorner.literals) {
    const [vertical, horizontal] = corner.split("-") as [
      keyof typeof restingY,
      keyof typeof restingX,
    ];
    const distance = Math.hypot(restingX[horizontal] - x, restingY[vertical] - y);
    if (distance < nearestDistance) {
      nearest = corner;
      nearestDistance = distance;
    }
  }
  return nearest;
}

/**
 * Pointer handlers for the floating chat's handles: the chat follows the pointer, then flies
 * to the nearest spot when let go. The drag moves the element directly, without rendering.
 * A handle can be a button: a press without a drag still clicks it.
 */
export function useFloatingChatDrag(
  chatRef: RefObject<HTMLElement | null>,
  onCornerChange: (corner: FloatingChatCorner) => void,
) {
  const dragRef = useRef<{ pointerId: number; x: number; y: number; moved: boolean } | null>(null);
  const draggedRef = useRef(false);
  const endDrag = (event: PointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    const chat = chatRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !chat) return;
    dragRef.current = null;
    if (!drag.moved) return;
    draggedRef.current = true;
    const container = chat.offsetParent;
    const dropped = chat.getBoundingClientRect();
    if (container && event.type === "pointerup") {
      flushSync(() =>
        onCornerChange(nearestFloatingChatCorner(container.getBoundingClientRect(), dropped)),
      );
    }
    chat.style.translate = "";
    const settled = chat.getBoundingClientRect();
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    // Start from where it was dropped and fly the rest of the way.
    chat.style.translate = `${dropped.left - settled.left}px ${dropped.top - settled.top}px`;
    chat.getBoundingClientRect();
    chat.style.transition = "translate 240ms cubic-bezier(0.2, 0, 0, 1)";
    chat.style.translate = "";
    chat.addEventListener("transitionend", () => chat.style.removeProperty("transition"), {
      once: true,
    });
  };
  return {
    onPointerDown: (event: PointerEvent<HTMLElement>) => {
      const control = (event.target as Element).closest("button, a, input");
      if (event.button !== 0 || (control && control !== event.currentTarget)) return;
      draggedRef.current = false;
      event.currentTarget.setPointerCapture(event.pointerId);
      chatRef.current?.style.removeProperty("transition");
      dragRef.current = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        moved: false,
      };
    },
    onPointerMove: (event: PointerEvent<HTMLElement>) => {
      const drag = dragRef.current;
      const chat = chatRef.current;
      if (!drag || drag.pointerId !== event.pointerId || !chat) return;
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
      drag.moved = true;
      chat.style.translate = `${dx}px ${dy}px`;
    },
    onPointerUp: endDrag,
    onPointerCancel: endDrag,
    onClickCapture: (event: MouseEvent<HTMLElement>) => {
      if (!draggedRef.current) return;
      draggedRef.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
  };
}

const THREAD_CHAT_VALUE = "thread";

/**
 * The expanded floating chat's header. With side chats open, the title switches between the
 * thread and its side chats; `selectedSideChatId` is null while the thread shows.
 */
export function FloatingChatHeader(props: {
  title: string;
  sideChats: ReadonlyArray<{ id: string; title: string }>;
  selectedSideChatId: string | null;
  onSelectSideChat: (sideChatId: string | null) => void;
  /** Receives the header's trailing slot, where the side chat shown puts its controls. */
  actionsRef?: Ref<HTMLDivElement>;
  dragHandlers?: ReturnType<typeof useFloatingChatDrag>;
  onMinimize: () => void;
}) {
  const selectedTitle =
    props.sideChats.find((sideChat) => sideChat.id === props.selectedSideChatId)?.title ??
    props.title;
  return (
    <div
      className="mx-px flex h-11 shrink-0 cursor-grab touch-none items-center gap-2 rounded-t-[22px] border border-border/60 bg-background px-3 select-none active:cursor-grabbing"
      {...props.dragHandlers}
    >
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label="Minimize chat"
        title="Minimize chat"
        onClick={props.onMinimize}
      >
        <MinusIcon />
      </Button>
      {props.sideChats.length === 0 ? (
        <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">{props.title}</span>
      ) : (
        <div className="flex min-w-0 flex-1">
          <Menu>
            <MenuTrigger
              render={
                <Button
                  size="xs"
                  variant="ghost"
                  className="min-w-0 max-w-full text-sm font-normal text-muted-foreground sm:text-sm"
                />
              }
            >
              <span className="truncate">{selectedTitle}</span>
              <ChevronDownIcon className="size-3.5 shrink-0 opacity-70" />
            </MenuTrigger>
            <MenuPopup align="start" className="max-w-80">
              <MenuRadioGroup
                value={props.selectedSideChatId ?? THREAD_CHAT_VALUE}
                onValueChange={(value: string) =>
                  props.onSelectSideChat(value === THREAD_CHAT_VALUE ? null : value)
                }
              >
                <MenuRadioItem value={THREAD_CHAT_VALUE} closeOnClick>
                  <span className="flex min-w-0 items-center gap-2">
                    <MessageCircleIcon className="text-muted-foreground" />
                    <span className="truncate">{props.title}</span>
                  </span>
                </MenuRadioItem>
                {props.sideChats.map((sideChat) => (
                  <MenuRadioItem key={sideChat.id} value={sideChat.id} closeOnClick>
                    <span className="flex min-w-0 items-center gap-2">
                      <MessagesSquareIcon className="text-muted-foreground" />
                      <span className="truncate">{sideChat.title}</span>
                    </span>
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuPopup>
          </Menu>
        </div>
      )}
      <div ref={props.actionsRef} className="flex shrink-0 items-center empty:hidden" />
    </div>
  );
}

/** The agent's latest reply, shown above the collapsed floating composer when a turn ends. */
export function FloatingChatReplyCard(props: {
  title: string;
  text: string;
  onOpen: () => void;
  onDismiss: () => void;
  dragHandlers?: ReturnType<typeof useFloatingChatDrag>;
}) {
  return (
    <div className="group pointer-events-auto relative mb-2">
      <button
        type="button"
        onClick={props.onOpen}
        {...props.dragHandlers}
        className="flex w-full cursor-pointer touch-none flex-col select-none gap-0.5 rounded-2xl border border-border/70 bg-popover px-4 py-3 text-start shadow-lg hover:bg-accent"
      >
        <span className="flex items-center gap-2 text-sm font-medium">
          <CheckCircle2Icon className="size-4 shrink-0 text-success" />
          <span className="truncate">{props.title}</span>
        </span>
        <span className="truncate text-sm text-muted-foreground">{replyPreview(props.text)}</span>
      </button>
      <Button
        size="icon-xs"
        variant="outline"
        className="absolute -top-2 -left-2 rounded-full bg-popover opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
        aria-label="Dismiss reply"
        onClick={props.onDismiss}
      >
        <XIcon />
      </Button>
    </div>
  );
}

/** Sits in the composer's context strip once the chat has an answer; opens the conversation. */
export function FloatingChatTitleBar(props: {
  title: string;
  onExpand: () => void;
  dragHandlers?: ReturnType<typeof useFloatingChatDrag>;
}) {
  return (
    <button
      type="button"
      data-floating-chat-title-bar
      aria-label={`Show conversation: ${props.title}`}
      title="Show conversation"
      onClick={props.onExpand}
      {...props.dragHandlers}
      className={cn(
        COMPOSER_CONTEXT_STRIP_CLASS_NAME,
        "cursor-pointer touch-none text-start select-none text-muted-foreground hover:text-foreground",
      )}
    >
      <span className="flex h-7 min-w-0 flex-1 items-center gap-2 px-2.5 text-sm">
        <span className="min-w-0 flex-1 truncate">{props.title}</span>
        <ChevronUpIcon className="size-3.5 shrink-0 opacity-60" aria-hidden />
      </span>
    </button>
  );
}
