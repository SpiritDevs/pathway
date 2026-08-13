/**
 * The left pane: one scope's captured mail, newest first.
 *
 * Virtualized with the house `LegendList` because retention lets an inbox hold hundreds of rows
 * and this list sits beside a reading pane that is already doing real work.
 *
 * @module components/email/EmailMessageList
 */
import { LegendList } from "@legendapp/list/react";
import type { CapturedEmailSummary, EmailMessageId } from "@t3tools/contracts";
import { CheckIcon, KeyRoundIcon, PaperclipIcon } from "lucide-react";

import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { cn } from "~/lib/utils";
import { emailAddressDisplayName, formatEmailTimestamp } from "./emailView.logic";

/** Two lines of ~34px plus padding; the rows are uniform, so one estimate covers the list. */
const ESTIMATED_ROW_HEIGHT = 72;

const keyExtractor = (message: CapturedEmailSummary) => message.id;

export function EmailMessageList({
  messages,
  selectedMessageId,
  onSelect,
  now,
}: {
  messages: ReadonlyArray<CapturedEmailSummary>;
  selectedMessageId: EmailMessageId | null;
  onSelect: (message: CapturedEmailSummary) => void;
  /** Passed in so every row's timestamp is read from one clock per render, never from a timer. */
  now: Date;
}) {
  const renderItem = ({ item }: { item: CapturedEmailSummary }) => (
    <EmailMessageRow
      message={item}
      now={now}
      onSelect={onSelect}
      selected={item.id === selectedMessageId}
    />
  );

  return (
    <LegendList<CapturedEmailSummary>
      aria-label="Captured mail"
      className="scrollbar-gutter-both h-full min-h-0 overflow-x-hidden"
      data={messages}
      estimatedItemSize={ESTIMATED_ROW_HEIGHT}
      keyExtractor={keyExtractor}
      renderItem={renderItem}
      role="list"
    />
  );
}

function EmailMessageRow({
  message,
  selected,
  onSelect,
  now,
}: {
  message: CapturedEmailSummary;
  selected: boolean;
  onSelect: (message: CapturedEmailSummary) => void;
  now: Date;
}) {
  const sender = message.from[0];
  const subject =
    message.subject === null || message.subject.trim().length === 0
      ? "(no subject)"
      : message.subject;

  return (
    <div
      className={cn(
        "group relative border-b border-border/40 transition-colors",
        selected ? "bg-accent/60" : "hover:bg-accent/30",
      )}
      role="listitem"
    >
      <button
        aria-current={selected ? "true" : undefined}
        aria-label={`Open ${subject}`}
        className="absolute inset-0 z-0 size-full text-start outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        onClick={() => onSelect(message)}
        type="button"
      />

      <div className="pointer-events-none relative z-10 flex w-full flex-col gap-0.5 px-3 py-2 text-start">
        <span className="flex min-w-0 items-center gap-1.5">
          {/* Unread is a dot rather than bold-everything: the subject line is the thing being read. */}
          <span
            aria-hidden="true"
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              message.isRead ? "bg-transparent" : "bg-primary",
            )}
          />
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
              aria-label={`${message.attachmentCount} attachments`}
              className="size-3 shrink-0 text-muted-foreground/70"
            />
          ) : null}
          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/70">
            {formatEmailTimestamp(message.receivedAt, now)}
          </span>
        </span>

        <span
          className={cn(
            "truncate ps-3 text-sm",
            message.isRead ? "text-foreground/80" : "font-medium text-foreground",
          )}
        >
          {subject}
        </span>

        <span className="flex min-w-0 items-center gap-1.5 ps-3">
          {message.detectedCode === null ? null : (
            <EmailDetectedCodeButton code={message.detectedCode} />
          )}
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground/70">
            {message.textPreview}
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
