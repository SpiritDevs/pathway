import { useEffect, useRef } from "react";
import type { FocusNotification } from "@spiritdevs/contracts/focus";

/** A visit acknowledges the current thread's events, including events arriving while it is open. */
export function useReadThreadNotifications(options: {
  readonly account: string | null;
  readonly thread: { readonly environmentId: string; readonly threadId: string } | null;
  readonly notifications: readonly FocusNotification[];
  readonly markRead: ((eventId: string) => Promise<null>) | undefined;
}) {
  const { account, notifications, markRead } = options;
  const environmentId = options.thread?.environmentId;
  const threadId = options.thread?.threadId;
  const acknowledged = useRef(new Set<string>());
  useEffect(() => {
    acknowledged.current = new Set();
  }, [account]);

  useEffect(() => {
    if (!account || !environmentId || !threadId || !markRead) return;
    const pending = acknowledged.current;
    const retainedIds = new Set(notifications.map((row) => row.eventId as string));
    for (const id of pending) {
      if (!retainedIds.has(id)) pending.delete(id);
    }
    const unread = notifications.filter(
      (row) => !row.isRead && row.environmentId === environmentId && row.threadId === threadId,
    );
    const read = () => {
      if (document.visibilityState !== "visible" || !document.hasFocus()) return;
      for (const row of unread) {
        if (pending.has(row.eventId)) continue;
        pending.add(row.eventId);
        void markRead(row.eventId).catch((error: unknown) => {
          pending.delete(row.eventId);
          console.warn("Could not mark thread notification as read.", error);
        });
      }
    };
    read();
    window.addEventListener("focus", read);
    document.addEventListener("visibilitychange", read);
    return () => {
      window.removeEventListener("focus", read);
      document.removeEventListener("visibilitychange", read);
    };
  }, [account, environmentId, threadId, notifications, markRead]);
}
