import { scopedThreadKey, scopeThreadRef } from "@spiritdevs/client-runtime/environment";
import {
  ALL_FOCUS_ID,
  CONVERSATIONS_FOCUS_ID,
  sortFocuses,
  focusIdForThread,
  focusNotificationProjectKey,
  type ActiveFocusId,
} from "@spiritdevs/client-runtime/state/focuses";
import type {
  AttentionEventKind,
  Focus,
  FocusAssignment,
  FocusNotification,
} from "@spiritdevs/contracts/focus";

const EVENT_LABELS = {
  "finished-unsettled": "Finished",
  "pending-approval": "Needs approval",
  "awaiting-input": "Waiting for input",
  failed: "Failed",
} satisfies Record<AttentionEventKind, string>;

export interface FocusNotificationRowModel {
  readonly notification: FocusNotification;
  readonly eventLabel: string;
  readonly threadTitle: string;
  readonly projectName: string;
  readonly focusId: ActiveFocusId;
  readonly focusName: string;
  readonly unread: boolean;
}

export interface FocusNotificationGroupModel {
  readonly focusId: ActiveFocusId;
  readonly focusName: string;
  readonly rows: ReadonlyArray<FocusNotificationRowModel>;
}

export function focusNotificationEventLabel(eventKind: AttentionEventKind): string {
  return EVENT_LABELS[eventKind];
}

function truncatedId(value: string): string {
  if (value.length <= 18) return value;
  return `${value.slice(0, 10)}…${value.slice(-5)}`;
}

function projectIdFromKey(projectKey: string): string {
  const separatorIndex = projectKey.indexOf(":");
  return separatorIndex === -1 ? projectKey : projectKey.slice(separatorIndex + 1);
}

export function buildFocusNotificationRows(input: {
  readonly notifications: ReadonlyArray<FocusNotification>;
  readonly unreadCount: number;
  readonly focuses: ReadonlyArray<Focus>;
  readonly assignments: ReadonlyArray<Pick<FocusAssignment, "focusId" | "projectKey">>;
  readonly activeFocusId: ActiveFocusId;
  readonly threadTitlesByKey: ReadonlyMap<string, string>;
  readonly projectNamesByKey: ReadonlyMap<string, string>;
}): ReadonlyArray<FocusNotificationGroupModel> {
  const orderedFocuses = sortFocuses(input.focuses);
  const focusById = new Map(orderedFocuses.map((focus) => [focus.id, focus] as const));
  const focusIdByProjectKey = new Map(
    input.assignments.map((assignment) => [assignment.projectKey, assignment.focusId] as const),
  );
  const unreadCount = Math.max(0, Math.trunc(input.unreadCount));

  const rows = input.notifications
    .toSorted((left, right) => right.createdAt - left.createdAt || right.id.localeCompare(left.id))
    .map((notification, index) => {
      const projectKey = focusNotificationProjectKey(notification);
      const resolvedFocusId = focusIdForThread({
        projectKey,
        activeFocusId: input.activeFocusId,
        focuses: orderedFocuses,
        focusIdByProjectKey,
      });
      const focus = resolvedFocusId === ALL_FOCUS_ID ? undefined : focusById.get(resolvedFocusId);
      return {
        notification,
        eventLabel: focusNotificationEventLabel(notification.eventKind),
        threadTitle:
          input.threadTitlesByKey.get(
            scopedThreadKey(scopeThreadRef(notification.environmentId, notification.threadId)),
          ) ?? truncatedId(notification.threadId),
        projectName:
          projectKey === null
            ? "Conversation"
            : (input.projectNamesByKey.get(projectKey) ??
              truncatedId(projectIdFromKey(projectKey))),
        focusId: resolvedFocusId,
        focusName:
          resolvedFocusId === CONVERSATIONS_FOCUS_ID ? "Conversations" : (focus?.name ?? "All"),
        unread: notification.isRead === undefined ? index < unreadCount : !notification.isRead,
      };
    });

  const rowsByFocus = new Map<ActiveFocusId, FocusNotificationRowModel[]>();
  for (const row of rows) {
    const group = rowsByFocus.get(row.focusId) ?? [];
    group.push(row);
    rowsByFocus.set(row.focusId, group);
  }

  const focusOrder = orderedFocuses.map((focus) => focus.id);
  if (input.activeFocusId !== ALL_FOCUS_ID && focusById.has(input.activeFocusId)) {
    const activeIndex = focusOrder.indexOf(input.activeFocusId);
    focusOrder.splice(activeIndex, 1);
    focusOrder.unshift(input.activeFocusId);
  }

  const groups: FocusNotificationGroupModel[] = [];
  for (const focusId of focusOrder) {
    const focus = focusById.get(focusId);
    const focusRows = rowsByFocus.get(focusId);
    if (focus !== undefined && focusRows !== undefined) {
      groups.push({ focusId, focusName: focus.name, rows: focusRows });
    }
  }
  const conversations = rowsByFocus.get(CONVERSATIONS_FOCUS_ID);
  if (conversations)
    groups.push({
      focusId: CONVERSATIONS_FOCUS_ID,
      focusName: "Conversations",
      rows: conversations,
    });
  const unassignedRows = rowsByFocus.get(ALL_FOCUS_ID);
  if (unassignedRows !== undefined) {
    groups.push({ focusId: ALL_FOCUS_ID, focusName: "All", rows: unassignedRows });
  }
  return groups;
}
