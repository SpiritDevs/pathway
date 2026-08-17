/**
 * The three-dot menu, rendered from the shared action list.
 *
 * A disabled read-state row keeps its reason beside the label rather than being dropped. Base UI
 * keeps disabled items focusable and `aria-disabled`, so the reason is reachable by keyboard and
 * spoken rather than being a hover-only hint.
 *
 * @module components/email/EmailActionMenu
 */
import { MoreHorizontalIcon } from "lucide-react";

import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import type { EmailActionMenuItem, EmailMessageAction } from "./emailList.logic";

export function EmailActionMenu({
  items,
  label,
  onAction,
  className,
  disabled = false,
}: {
  items: ReadonlyArray<EmailActionMenuItem>;
  /** What the trigger announces — the row's subject, or how many messages are checked. */
  label: string;
  onAction: (action: EmailMessageAction) => void;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            aria-label={label}
            className={className}
            disabled={disabled}
            size="icon-xs"
            variant="ghost"
          >
            <MoreHorizontalIcon />
          </Button>
        }
      />
      <MenuPopup align="end" className="min-w-52" side="bottom">
        {items.map((item) => (
          <EmailActionMenuRow item={item} key={item.id} onAction={onAction} />
        ))}
      </MenuPopup>
    </Menu>
  );
}

function EmailActionMenuRow({
  item,
  onAction,
}: {
  item: EmailActionMenuItem;
  onAction: (action: EmailMessageAction) => void;
}) {
  const row = (
    <MenuItem
      closeOnClick
      disabled={item.disabled}
      onClick={() => onAction(item.id)}
      variant={item.destructive ? "destructive" : "default"}
    >
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
      {item.unavailableReason === null ? null : (
        <span className="shrink-0 text-xs text-muted-foreground">{item.unavailableReason}</span>
      )}
    </MenuItem>
  );

  return item.separatorBefore ? (
    <>
      <MenuSeparator />
      {row}
    </>
  ) : (
    row
  );
}
