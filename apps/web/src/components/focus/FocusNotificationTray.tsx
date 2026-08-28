import type { Focus, FocusAssignment, FocusNotification } from "@spiritdevs/contracts/focus";
import type { LucideIcon } from "lucide-react";
import {
  BellIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleXIcon,
  MessageCircleQuestionIcon,
} from "lucide-react";
import { useMemo } from "react";

import { formatRelativeTimeLabel } from "../../timestampFormat";
import { cn } from "../../lib/utils";
import {
  buildFocusNotificationRows,
  type FocusNotificationRowModel,
} from "./FocusNotificationTray.logic";

const EVENT_ICONS = {
  "finished-unsettled": CircleCheckIcon,
  "pending-approval": CircleAlertIcon,
  "awaiting-input": MessageCircleQuestionIcon,
  failed: CircleXIcon,
} satisfies Record<FocusNotification["eventKind"], LucideIcon>;

function FocusNotificationRow(props: {
  readonly row: FocusNotificationRowModel;
  readonly onSelect: (notification: FocusNotification) => void;
}) {
  const { notification } = props.row;
  const EventIcon = EVENT_ICONS[notification.eventKind];
  const createdAt = new Date(notification.createdAt);
  const timestamp = Number.isNaN(createdAt.getTime())
    ? ""
    : formatRelativeTimeLabel(createdAt.toISOString());
  return (
    <li>
      <button
        type="button"
        onClick={() => props.onSelect(notification)}
        className={cn(
          "group relative flex w-full cursor-pointer items-start gap-2.5 rounded-md px-2.5 py-2 text-left outline-none transition-colors hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-sidebar-ring",
          props.row.unread && "bg-primary/[0.04]",
        )}
      >
        {props.row.unread ? (
          <span
            aria-label="Unread"
            className="absolute left-1 top-3 size-1.5 rounded-full bg-primary"
          />
        ) : null}
        <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md bg-muted/70 text-muted-foreground group-hover:text-foreground">
          <EventIcon aria-hidden className="size-3.5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
              {props.row.eventLabel}
            </span>
            {timestamp ? (
              <span className="shrink-0 text-[10px] text-muted-foreground/60 tabular-nums">
                {timestamp}
              </span>
            ) : null}
          </span>
          <span className="mt-0.5 block truncate text-xs text-foreground/80">
            {props.row.threadTitle}
          </span>
          <span className="mt-0.5 block truncate text-[11px] text-muted-foreground/65">
            {props.row.projectName} · {props.row.focusName}
          </span>
        </span>
      </button>
    </li>
  );
}

export function FocusNotificationTray(props: {
  readonly notifications: ReadonlyArray<FocusNotification>;
  readonly unreadCount: number;
  readonly focuses: ReadonlyArray<Focus>;
  readonly assignments: ReadonlyArray<FocusAssignment>;
  readonly threadTitlesByKey: ReadonlyMap<string, string>;
  readonly projectNamesByKey: ReadonlyMap<string, string>;
  readonly onSelect: (notification: FocusNotification) => void;
}) {
  const rows = useMemo(
    () =>
      buildFocusNotificationRows({
        notifications: props.notifications,
        unreadCount: props.unreadCount,
        focuses: props.focuses,
        assignments: props.assignments,
        threadTitlesByKey: props.threadTitlesByKey,
        projectNamesByKey: props.projectNamesByKey,
      }),
    [
      props.assignments,
      props.focuses,
      props.notifications,
      props.projectNamesByKey,
      props.threadTitlesByKey,
      props.unreadCount,
    ],
  );

  return (
    <div className="w-[min(22rem,calc(100vw-1rem))]">
      <div className="border-b border-border/60 px-3 py-2">
        <div className="text-xs font-medium text-foreground">Notifications</div>
      </div>
      {rows.length === 0 ? (
        <div className="flex flex-col items-center gap-2 px-6 py-8 text-center text-xs text-muted-foreground/60">
          <BellIcon aria-hidden className="size-4" />
          <span>You're all caught up</span>
        </div>
      ) : (
        <ul className="max-h-[min(26rem,calc(100vh-8rem))] space-y-0.5 overflow-y-auto p-1.5">
          {rows.map((row) => (
            <FocusNotificationRow key={row.notification.id} row={row} onSelect={props.onSelect} />
          ))}
        </ul>
      )}
    </div>
  );
}
