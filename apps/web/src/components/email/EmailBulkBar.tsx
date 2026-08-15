/**
 * The strip that appears under the toolbar while any message is checked.
 *
 * `IssuesBulkBar` floats over the bottom of a full-width list; this one is a row in the flow
 * instead, because the same treatment in a 352px pane would sit on top of the messages it is
 * acting on. The read actions are inline and the rest live behind the same overflow menu the rows
 * use, so a disabled action reads identically wherever it is reached from.
 *
 * @module components/email/EmailBulkBar
 */
import type { CapturedEmailSummary } from "@spiritdevs/contracts";
import { MailIcon, MailOpenIcon, XIcon } from "lucide-react";

import { Button } from "../ui/button";
import { EmailActionMenu } from "./EmailActionMenu";
import { emailActionMenuItems, type EmailMessageAction } from "./emailList.logic";

export function EmailBulkBar({
  messages,
  onAction,
  onClear,
  disabled = false,
}: {
  /** The checked messages themselves, so the read actions can tell a no-op from a write. */
  messages: ReadonlyArray<CapturedEmailSummary>;
  onAction: (action: EmailMessageAction) => void;
  onClear: () => void;
  disabled?: boolean;
}) {
  const items = emailActionMenuItems({
    count: messages.length,
    unreadCount: messages.filter((message) => !message.isRead).length,
    includeOpen: false,
  });
  const markRead = items.find((item) => item.id === "mark-read");
  const markUnread = items.find((item) => item.id === "mark-unread");

  return (
    <div
      aria-label="Bulk mail actions"
      className="flex items-center gap-1 border-b border-border/50 bg-accent/40 px-3 py-1"
      role="group"
    >
      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
        {messages.length} selected
      </span>
      <span className="ms-auto flex shrink-0 items-center gap-0.5">
        <Button
          className="h-6 px-1.5 text-xs"
          disabled={disabled || (markRead?.disabled ?? true)}
          onClick={() => onAction("mark-read")}
          size="xs"
          title={markRead?.unavailableReason ?? "Mark as read"}
          variant="ghost"
        >
          <MailOpenIcon aria-hidden="true" />
          Read
        </Button>
        <Button
          className="h-6 px-1.5 text-xs"
          disabled={disabled || (markUnread?.disabled ?? true)}
          onClick={() => onAction("mark-unread")}
          size="xs"
          title={markUnread?.unavailableReason ?? "Mark as unread"}
          variant="ghost"
        >
          <MailIcon aria-hidden="true" />
          Unread
        </Button>
        <EmailActionMenu
          items={items.filter((item) => item.id !== "mark-read" && item.id !== "mark-unread")}
          disabled={disabled}
          label={`More actions for ${messages.length} selected ${messages.length === 1 ? "message" : "messages"}`}
          onAction={onAction}
        />
        <Button aria-label="Clear the selection" onClick={onClear} size="icon-xs" variant="ghost">
          <XIcon />
        </Button>
      </span>
    </div>
  );
}
