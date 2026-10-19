import {
  memo,
  type KeyboardEventHandler,
  type MouseEventHandler,
  type PointerEventHandler,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  ChevronDownIcon,
  ChevronLeftIcon,
  CornerDownRightIcon,
  ListEndIcon,
  MessageSquarePlusIcon,
  PanelRightOpenIcon,
} from "lucide-react";
import type { ActiveTurnSendMode } from "@spiritdevs/contracts/settings";
import { useEnvironmentIdentificationMode } from "~/hooks/useSettings";
import { cn } from "~/lib/utils";
import { StageBackdropButtonArt, useSidebarStageBackdropVariant } from "../SidebarStageBackdrop";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

interface PendingActionState {
  questionIndex: number;
  isLastQuestion: boolean;
  canAdvance: boolean;
  isResponding: boolean;
  isComplete: boolean;
}

interface ComposerPrimaryActionsProps {
  compact: boolean;
  pendingAction: PendingActionState | null;
  isRunning: boolean;
  activeTurnSendMode?: ActiveTurnSendMode;
  showPlanFollowUpPrompt: boolean;
  promptHasText: boolean;
  isSendBusy: boolean;
  isConnecting: boolean;
  isEnvironmentUnavailable: boolean;
  isPreparingWorktree: boolean;
  hasSendableContent: boolean;
  preserveComposerFocusOnPointerDown?: boolean;
  sideChatAvailable?: boolean;
  onPreviousPendingQuestion: () => void;
  onInterrupt: () => void;
  onImplementPlanInNewThread: () => void;
  onSendWithMode?: (mode: "queue" | "steer") => void;
  onStartInNewChat?: () => void;
  onStartInSideChat?: () => void;
}

export type ComposerSendMenuAction = "queue" | "steer" | "new-chat" | "side-chat";

export function composerSendMenuActions(input: {
  readonly isRunning: boolean;
  readonly sideChatAvailable: boolean;
}): ReadonlyArray<{ action: ComposerSendMenuAction; disabled: boolean }> {
  return [
    ...(input.isRunning
      ? ([
          { action: "queue", disabled: false },
          { action: "steer", disabled: false },
        ] as const)
      : []),
    { action: "new-chat", disabled: false },
    { action: "side-chat", disabled: !input.sideChatAvailable },
  ];
}

export const formatPendingPrimaryActionLabel = (input: {
  compact: boolean;
  isLastQuestion: boolean;
  isResponding: boolean;
  questionIndex: number;
}) => {
  if (input.isResponding) {
    return "Submitting...";
  }
  if (input.compact) {
    return input.isLastQuestion ? "Submit" : "Next";
  }
  if (!input.isLastQuestion) {
    return "Next question";
  }
  return input.questionIndex > 0 ? "Submit answers" : "Submit answer";
};

const preventPointerFocus: PointerEventHandler<HTMLElement> = (event) => {
  event.preventDefault();
};

export const ComposerPrimaryActions = memo(function ComposerPrimaryActions({
  compact,
  pendingAction,
  isRunning,
  activeTurnSendMode = "steer",
  showPlanFollowUpPrompt,
  promptHasText,
  isSendBusy,
  isConnecting,
  isEnvironmentUnavailable,
  isPreparingWorktree,
  hasSendableContent,
  preserveComposerFocusOnPointerDown = false,
  sideChatAvailable = false,
  onPreviousPendingQuestion,
  onInterrupt,
  onImplementPlanInNewThread,
  onSendWithMode,
  onStartInNewChat,
  onStartInSideChat,
}: ComposerPrimaryActionsProps) {
  const pointerFocusProps = preserveComposerFocusOnPointerDown
    ? { onPointerDown: preventPointerFocus }
    : undefined;
  const environmentIdentificationMode = useEnvironmentIdentificationMode();
  const stageBackdropVariant = useSidebarStageBackdropVariant(
    environmentIdentificationMode === "artwork",
  );
  const [sendOptionsOpen, setSendOptionsOpen] = useState(false);
  const sendButtonRef = useRef<HTMLButtonElement | null>(null);
  const holdTimerRef = useRef<number | null>(null);
  const holdOpenedRef = useRef(false);
  const pointerOriginRef = useRef<{ x: number; y: number } | null>(null);

  const cancelHoldTimer = useCallback(() => {
    if (holdTimerRef.current !== null) {
      window.clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
    pointerOriginRef.current = null;
  }, []);

  useEffect(() => cancelHoldTimer, [cancelHoldTimer]);

  const openSendOptions = useCallback(() => {
    if (isSendBusy || isConnecting || isEnvironmentUnavailable || !hasSendableContent) {
      return;
    }
    holdOpenedRef.current = true;
    setSendOptionsOpen(true);
  }, [hasSendableContent, isConnecting, isEnvironmentUnavailable, isSendBusy]);

  const handleSendPointerDown: PointerEventHandler<HTMLButtonElement> = (event) => {
    if (preserveComposerFocusOnPointerDown) {
      event.preventDefault();
    }
    if (event.button !== 0 || event.currentTarget.disabled) return;
    cancelHoldTimer();
    holdOpenedRef.current = false;
    pointerOriginRef.current = { x: event.clientX, y: event.clientY };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    holdTimerRef.current = window.setTimeout(() => {
      holdTimerRef.current = null;
      pointerOriginRef.current = null;
      openSendOptions();
    }, 450);
  };

  const handleSendPointerMove: PointerEventHandler<HTMLButtonElement> = (event) => {
    const origin = pointerOriginRef.current;
    if (!origin) return;
    if (Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > 8) {
      cancelHoldTimer();
    }
  };

  const handleSendPointerEnd: PointerEventHandler<HTMLButtonElement> = () => {
    cancelHoldTimer();
  };

  const handleSendClick: MouseEventHandler<HTMLButtonElement> = (event) => {
    if (!holdOpenedRef.current) return;
    event.preventDefault();
    holdOpenedRef.current = false;
  };

  const handleSendKeyDown: KeyboardEventHandler<HTMLButtonElement> = (event) => {
    if (event.key !== "ArrowDown" && event.key !== "ContextMenu") return;
    event.preventDefault();
    openSendOptions();
  };

  const handleSendContextMenu: MouseEventHandler<HTMLButtonElement> = (event) => {
    event.preventDefault();
    openSendOptions();
  };

  const renderStopGenerationButton = (insidePendingAction: boolean) => (
    <button
      type="button"
      className={cn(
        "flex cursor-pointer items-center justify-center rounded-full bg-destructive/90 text-white shadow-xs shadow-destructive/24 inset-shadow-[0_1px_--theme(--color-white/16%)] transition-all duration-150 hover:bg-destructive hover:scale-105 active:inset-shadow-[0_1px_--theme(--color-black/8%)] active:shadow-none",
        insidePendingAction ? "size-8 sm:size-7" : "size-8 sm:h-8 sm:w-8",
      )}
      {...pointerFocusProps}
      onClick={onInterrupt}
      aria-label="Stop generation"
    >
      <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
        <rect x="2" y="2" width="8" height="8" rx="1.5" />
      </svg>
    </button>
  );

  if (pendingAction) {
    return (
      <div className={cn("flex items-center justify-end", compact ? "gap-1.5" : "gap-2")}>
        {isRunning ? renderStopGenerationButton(true) : null}
        {pendingAction.questionIndex > 0 ? (
          compact ? (
            <Button
              size="icon-sm"
              variant="outline"
              className="rounded-full"
              {...pointerFocusProps}
              onClick={onPreviousPendingQuestion}
              disabled={pendingAction.isResponding}
              aria-label="Previous question"
            >
              <ChevronLeftIcon className="size-3.5" />
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              className="rounded-full"
              {...pointerFocusProps}
              onClick={onPreviousPendingQuestion}
              disabled={pendingAction.isResponding}
            >
              Previous
            </Button>
          )
        ) : null}
        <Button
          type="submit"
          size="sm"
          className={cn("rounded-full", compact ? "px-3" : "px-4")}
          {...pointerFocusProps}
          disabled={
            isEnvironmentUnavailable ||
            pendingAction.isResponding ||
            (pendingAction.isLastQuestion ? !pendingAction.isComplete : !pendingAction.canAdvance)
          }
        >
          {formatPendingPrimaryActionLabel({
            compact,
            isLastQuestion: pendingAction.isLastQuestion,
            isResponding: pendingAction.isResponding,
            questionIndex: pendingAction.questionIndex,
          })}
        </Button>
      </div>
    );
  }

  if (isRunning && !hasSendableContent) {
    return renderStopGenerationButton(false);
  }

  if (showPlanFollowUpPrompt) {
    if (promptHasText) {
      return (
        <Button
          type="submit"
          size="sm"
          className={cn("rounded-full", compact ? "h-9 px-3 sm:h-8" : "h-9 px-4 sm:h-8")}
          {...pointerFocusProps}
          disabled={isSendBusy || isConnecting || isEnvironmentUnavailable}
        >
          {isConnecting || isSendBusy ? "Sending..." : "Refine"}
        </Button>
      );
    }

    return (
      <div data-chat-composer-implement-actions="true" className="flex items-center justify-end">
        <Button
          type="submit"
          size="sm"
          className="h-9 rounded-l-full rounded-r-none px-4 sm:h-8"
          {...pointerFocusProps}
          disabled={isSendBusy || isConnecting || isEnvironmentUnavailable}
        >
          {isConnecting || isSendBusy ? "Sending..." : "Implement"}
        </Button>
        <Menu>
          <MenuTrigger
            render={
              <Button
                size="sm"
                variant="default"
                className="h-9 rounded-l-none rounded-r-full border-l-white/12 px-2 sm:h-8"
                aria-label="Implementation actions"
                {...pointerFocusProps}
                disabled={isSendBusy || isConnecting || isEnvironmentUnavailable}
              />
            }
          >
            <ChevronDownIcon className="size-3.5" />
          </MenuTrigger>
          <MenuPopup align="end" side="top">
            <MenuItem
              disabled={isSendBusy || isConnecting || isEnvironmentUnavailable}
              onClick={() => void onImplementPlanInNewThread()}
            >
              Implement in a new thread
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>
    );
  }

  const sendButton = (
    <button
      ref={sendButtonRef}
      type="submit"
      className={cn(
        "relative isolate flex h-9 w-9 items-center justify-center overflow-hidden rounded-full shadow-xs transition-all duration-150 enabled:cursor-pointer enabled:inset-shadow-[0_1px_--theme(--color-white/16%)] hover:scale-105 active:inset-shadow-[0_1px_--theme(--color-black/8%)] active:shadow-none disabled:pointer-events-none disabled:opacity-30 disabled:shadow-none disabled:hover:scale-100 sm:h-8 sm:w-8",
        stageBackdropVariant
          ? "bg-transparent text-white enabled:shadow-black/24 enabled:hover:brightness-110"
          : "bg-message-action text-message-action-foreground enabled:shadow-message-action/24 hover:bg-message-action-hover",
      )}
      onPointerDown={handleSendPointerDown}
      onPointerMove={handleSendPointerMove}
      onPointerUp={handleSendPointerEnd}
      onPointerCancel={handleSendPointerEnd}
      onClick={handleSendClick}
      onKeyDown={handleSendKeyDown}
      onContextMenu={handleSendContextMenu}
      disabled={isSendBusy || isConnecting || isEnvironmentUnavailable || !hasSendableContent}
      aria-expanded={sendOptionsOpen}
      aria-haspopup="menu"
      aria-label={
        isEnvironmentUnavailable
          ? "Environment disconnected"
          : isConnecting
            ? "Connecting"
            : isPreparingWorktree
              ? "Preparing worktree"
              : isSendBusy
                ? "Sending"
                : isRunning
                  ? activeTurnSendMode === "queue"
                    ? "Queue message behind active turn"
                    : "Send message to steer active turn"
                  : "Send message"
      }
    >
      {stageBackdropVariant ? (
        <span className="absolute inset-0 -z-10" aria-hidden="true">
          <StageBackdropButtonArt variant={stageBackdropVariant} />
        </span>
      ) : null}
      {isConnecting || isSendBusy ? (
        <Spinner className="size-3.5" aria-hidden="true" />
      ) : (
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <path
            d="M7 11.5V2.5M7 2.5L3 6.5M7 2.5L11 6.5"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
    </button>
  );

  const sendMenuActions = composerSendMenuActions({ isRunning, sideChatAvailable });
  const sendButtonTooltip = isRunning
    ? activeTurnSendMode === "queue"
      ? "Queue behind the active turn. Hold for message options"
      : "Send now to steer the active turn. Hold for message options"
    : "Send message. Hold for message options";

  return (
    <Menu
      open={sendOptionsOpen}
      onOpenChange={(open) => {
        setSendOptionsOpen(open);
        if (!open) holdOpenedRef.current = false;
      }}
    >
      <MenuTrigger
        className="pointer-events-none fixed size-0"
        nativeButton={false}
        render={<span />}
        tabIndex={-1}
      >
        <span className="sr-only">Message options</span>
      </MenuTrigger>
      <Tooltip>
        <TooltipTrigger render={sendButton} />
        <TooltipPopup side="top">{sendButtonTooltip}</TooltipPopup>
      </Tooltip>
      <MenuPopup align="end" anchor={sendButtonRef} className="min-w-48" side="top">
        {sendMenuActions.map(({ action, disabled }) => {
          if (action === "queue") {
            return (
              <MenuItem key={action} onClick={() => onSendWithMode?.("queue")}>
                <ListEndIcon />
                Queue message
              </MenuItem>
            );
          }
          if (action === "steer") {
            return (
              <MenuItem key={action} onClick={() => onSendWithMode?.("steer")}>
                <CornerDownRightIcon />
                Steer conversation
              </MenuItem>
            );
          }
          if (action === "new-chat") {
            return (
              <MenuItem key={action} onClick={() => onStartInNewChat?.()}>
                <MessageSquarePlusIcon />
                Start in a new chat
              </MenuItem>
            );
          }
          return (
            <MenuItem key={action} disabled={disabled} onClick={() => onStartInSideChat?.()}>
              <PanelRightOpenIcon />
              <span className="grid">
                <span>Start in a side chat</span>
                {disabled ? (
                  <span className="text-muted-foreground text-xs">
                    Available after a completed turn
                  </span>
                ) : null}
              </span>
            </MenuItem>
          );
        })}
      </MenuPopup>
    </Menu>
  );
});
