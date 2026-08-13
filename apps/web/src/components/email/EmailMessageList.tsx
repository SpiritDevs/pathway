/**
 * The left pane: one scope's captured mail, newest first.
 *
 * Virtualized with the house `LegendList` because retention lets an inbox hold hundreds of rows
 * and this list sits beside a reading pane that is already doing real work.
 *
 * A row carries two separate gestures. Pressing it opens the message in the reading pane; the
 * checkbox — revealed on hover or focus, and pinned once checked — puts it in the selection the
 * bulk bar acts on. They never imply each other: checking twenty messages must not mark twenty
 * read, and opening one must not disturb what is checked.
 *
 * @module components/email/EmailMessageList
 */
import { LegendList } from "@legendapp/list/react";
import type { CapturedEmailSummary, EmailMessageId } from "@t3tools/contracts";
import { CheckIcon, KeyRoundIcon, PaperclipIcon } from "lucide-react";
import { useMemo, type MouseEvent } from "react";

import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { cn } from "~/lib/utils";
import { Checkbox } from "../ui/checkbox";
import { EmailActionMenu } from "./EmailActionMenu";
import {
  emailActionMenuItems,
  emailRowActionCounts,
  type EmailMessageAction,
} from "./emailList.logic";
import { emailAddressDisplayName, formatEmailTimestamp } from "./emailView.logic";

/** Two lines of ~34px plus padding; the rows are uniform, so one estimate covers the list. */
const ESTIMATED_ROW_HEIGHT = 72;

const keyExtractor = (message: CapturedEmailSummary) => message.id;

export interface EmailMessageListSelection {
  readonly ids: ReadonlySet<EmailMessageId>;
  /** Passed as counts rather than rows: every row needs them and none of them needs the rows. */
  readonly count: number;
  readonly unreadCount: number;
}

export function EmailMessageList({
  messages,
  selectedMessageId,
  selection,
  onSelect,
  onToggleSelect,
  onAction,
  onContextMenu,
  now,
}: {
  messages: ReadonlyArray<CapturedEmailSummary>;
  selectedMessageId: EmailMessageId | null;
  selection: EmailMessageListSelection;
  onSelect: (message: CapturedEmailSummary) => void;
  onToggleSelect: (message: CapturedEmailSummary, modifiers: { shiftKey: boolean }) => void;
  onAction: (message: CapturedEmailSummary, action: EmailMessageAction) => void;
  onContextMenu: (
    message: CapturedEmailSummary,
    position: { readonly x: number; readonly y: number },
  ) => void;
  /** Passed in so every row's timestamp is read from one clock per render, never from a timer. */
  now: Date;
}) {
  // LegendList memoizes mounted rows independently of renderItem. Selection and the open message
  // live outside its data array, so they must explicitly invalidate those cached row elements.
  const extraData = useMemo(
    () => ({
      selectedMessageId,
      selectedIds: selection.ids,
      selectionCount: selection.count,
      selectionUnreadCount: selection.unreadCount,
    }),
    [selectedMessageId, selection.count, selection.ids, selection.unreadCount],
  );
  const renderItem = ({ item }: { item: CapturedEmailSummary }) => (
    <EmailMessageRow
      checked={selection.ids.has(item.id)}
      message={item}
      now={now}
      onAction={onAction}
      onContextMenu={onContextMenu}
      onSelect={onSelect}
      onToggleSelect={onToggleSelect}
      selected={item.id === selectedMessageId}
      selectionCount={selection.count}
      selectionUnreadCount={selection.unreadCount}
    />
  );

  return (
    <LegendList<CapturedEmailSummary>
      aria-label="Captured mail"
      className="scrollbar-gutter-both h-full min-h-0 overflow-x-hidden"
      data={messages}
      estimatedItemSize={ESTIMATED_ROW_HEIGHT}
      extraData={extraData}
      keyExtractor={keyExtractor}
      renderItem={renderItem}
      role="list"
    />
  );
}

export function EmailMessageRow({
  message,
  selected,
  checked,
  selectionCount,
  selectionUnreadCount,
  onSelect,
  onToggleSelect,
  onAction,
  onContextMenu,
  now,
}: {
  message: CapturedEmailSummary;
  selected: boolean;
  checked: boolean;
  selectionCount: number;
  selectionUnreadCount: number;
  onSelect: (message: CapturedEmailSummary) => void;
  onToggleSelect: (message: CapturedEmailSummary, modifiers: { shiftKey: boolean }) => void;
  onAction: (message: CapturedEmailSummary, action: EmailMessageAction) => void;
  onContextMenu: (
    message: CapturedEmailSummary,
    position: { readonly x: number; readonly y: number },
  ) => void;
  now: Date;
}) {
  const sender = message.from[0];
  const subject =
    message.subject === null || message.subject.trim().length === 0
      ? "(no subject)"
      : message.subject;

  const menuItems = emailActionMenuItems({
    ...emailRowActionCounts({
      isRead: message.isRead,
      checked,
      selectionCount,
      selectionUnreadCount,
    }),
    includeOpen: true,
  });

  const showContextMenu = (event: MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    onContextMenu(message, { x: event.clientX, y: event.clientY });
  };

  return (
    <div
      className={cn(
        "group relative border-b border-border/40 transition-colors",
        selected ? "bg-accent/60" : checked ? "bg-primary/10" : "hover:bg-accent/30",
      )}
      data-checked={checked ? "true" : undefined}
      onContextMenu={showContextMenu}
      role="listitem"
    >
      <button
        aria-current={selected ? "true" : undefined}
        aria-label={`Open ${subject}`}
        className="absolute inset-0 z-0 size-full text-start outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        onClick={() => onSelect(message)}
        type="button"
      />

      <div className="pointer-events-none relative z-10 flex w-full items-start gap-1.5 px-3 py-2 text-start">
        {/* One 16px column holds both states: the unread dot by default, the checkbox once the row
            is hovered, focused, or checked. Same slot, so nothing shifts when it swaps. */}
        <span className="relative mt-1 flex size-4 shrink-0 items-center justify-center">
          <span
            aria-hidden="true"
            className={cn(
              "absolute size-1.5 rounded-full transition-opacity",
              message.isRead ? "bg-transparent" : "bg-primary",
              checked
                ? "opacity-0"
                : "group-hover:opacity-0 group-focus-within:opacity-0 [@media(hover:none)]:-start-1.5 [@media(hover:none)]:opacity-100 motion-reduce:transition-none",
            )}
          />
          <Checkbox
            aria-label={`Select ${subject}`}
            checked={checked}
            className={cn(
              "pointer-events-auto absolute size-4 transition-opacity sm:size-4",
              checked
                ? null
                : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100 motion-reduce:transition-none",
            )}
            // The modifier lives on the DOM event, so the press is read here rather than from the
            // checkbox's own value: shift-check extends from the last row checked without one.
            onClick={(event) => onToggleSelect(message, { shiftKey: event.shiftKey })}
          />
        </span>

        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-1.5">
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-xs",
                message.isRead ? "text-muted-foreground" : "font-medium text-foreground",
              )}
            >
              {sender === undefined ? "Unknown sender" : emailAddressDisplayName(sender)}
            </span>
            {message.attachmentCount > 0 ? (
              <PaperclipIcon
                aria-label={`${message.attachmentCount} ${message.attachmentCount === 1 ? "attachment" : "attachments"}`}
                className="size-3 shrink-0 text-muted-foreground/70"
              />
            ) : null}
            <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/70">
              {formatEmailTimestamp(message.receivedAt, now)}
            </span>
            {/* Reserved rather than revealed into place: a button that appears on hover and pushes
                the timestamp sideways is a moving target. */}
            <EmailActionMenu
              className="pointer-events-auto -my-1 size-5 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100 [@media(hover:none)]:opacity-100 motion-reduce:transition-none sm:size-5"
              items={menuItems}
              label={`Actions for ${subject}`}
              onAction={(action) => onAction(message, action)}
            />
          </span>

          <span
            className={cn(
              "truncate text-sm",
              message.isRead ? "text-foreground/80" : "font-medium text-foreground",
            )}
          >
            {subject}
          </span>

          <span className="flex min-w-0 items-center gap-1.5">
            {message.detectedCode === null ? null : (
              <EmailDetectedCodeButton code={message.detectedCode} />
            )}
            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground/70">
              {message.textPreview}
            </span>
          </span>
        </span>
      </div>
    </div>
  );
}

export function EmailDetectedCodeButton({ code }: { code: string }) {
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: "verification code" });

  return (
    <button
      aria-label={isCopied ? `Copied verification code ${code}` : `Copy verification code ${code}`}
      className="pointer-events-auto flex shrink-0 items-center gap-1 rounded bg-primary/10 px-1 py-px font-mono text-[11px] text-primary tabular-nums outline-none transition-colors hover:bg-primary/20 focus-visible:ring-2 focus-visible:ring-ring"
      onClick={() => copyToClipboard(code, undefined)}
      title={isCopied ? "Copied" : "Copy verification code"}
      type="button"
    >
      {isCopied ? (
        <CheckIcon aria-hidden="true" className="size-3" />
      ) : (
        <KeyRoundIcon aria-hidden="true" className="size-3" />
      )}
      {code}
    </button>
  );
}
