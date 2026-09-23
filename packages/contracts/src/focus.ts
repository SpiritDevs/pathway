/** Synced Focus definitions, project assignments, and Attention Event notifications. */
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";

import { EnvironmentId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { CloudTimestamp } from "./company.ts";

const makeFocusEntityId = <Brand extends string>(brand: Brand) =>
  TrimmedNonEmptyString.pipe(Schema.brand(brand));

export const FocusId = makeFocusEntityId("FocusId");
export type FocusId = typeof FocusId.Type;

export const FocusProjectKey = TrimmedNonEmptyString.check(Schema.isPattern(/^[^:]+:.+$/)).pipe(
  Schema.brand("FocusProjectKey"),
);
export type FocusProjectKey = typeof FocusProjectKey.Type;

export const AttentionEventId = makeFocusEntityId("AttentionEventId");
export type AttentionEventId = typeof AttentionEventId.Type;

export const FocusNotificationId = makeFocusEntityId("FocusNotificationId");
export type FocusNotificationId = typeof FocusNotificationId.Type;

export const FOCUS_NOTIFICATION_MAX_PER_USER = 200;
export const FOCUS_NAME_MAX_CHARS = 60;
export const FocusName = TrimmedNonEmptyString.check(Schema.isMaxLength(FOCUS_NAME_MAX_CHARS));
export type FocusName = typeof FocusName.Type;

export const FocusIconName = TrimmedNonEmptyString;
export type FocusIconName = typeof FocusIconName.Type;

export const FocusAccentColor = TrimmedNonEmptyString.check(Schema.isPattern(/^#[0-9a-fA-F]{6}$/));
export type FocusAccentColor = typeof FocusAccentColor.Type;

export const Focus = Schema.Struct({
  includeConversations: Schema.optionalKey(Schema.Boolean),
  id: FocusId,
  name: FocusName,
  iconName: FocusIconName,
  accentColor: FocusAccentColor,
  orderKey: TrimmedNonEmptyString,
  createdAt: CloudTimestamp,
  updatedAt: CloudTimestamp,
});
export type Focus = typeof Focus.Type;

export const FocusAssignment = Schema.Struct({
  focusId: FocusId,
  projectKey: FocusProjectKey,
  createdAt: CloudTimestamp,
  updatedAt: CloudTimestamp,
});
export type FocusAssignment = typeof FocusAssignment.Type;

export const ATTENTION_EVENT_KINDS = [
  "finished-unsettled",
  "pending-approval",
  "awaiting-input",
  "failed",
] as const;
export const AttentionEventKind = Schema.Literals(ATTENTION_EVENT_KINDS);
export type AttentionEventKind = typeof AttentionEventKind.Type;

export const AttentionEvent = Schema.Struct({
  alertProjectKey: Schema.optionalKey(Schema.String),
  eventId: AttentionEventId,
  threadId: ThreadId,
  projectKey: FocusProjectKey,
  eventKind: AttentionEventKind,
});
export type AttentionEvent = typeof AttentionEvent.Type;

export const FocusNotification = Schema.Struct({
  alertProjectKey: Schema.optionalKey(Schema.String),
  alertEligibleAtCreation: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  isRead: Schema.optionalKey(Schema.Boolean),
  isSeen: Schema.optionalKey(Schema.Boolean),
  /** The Attention Event id is also the notification id within one user's feed. */
  id: FocusNotificationId,
  eventId: AttentionEventId,
  environmentId: EnvironmentId,
  threadId: ThreadId,
  projectKey: FocusProjectKey,
  eventKind: AttentionEventKind,
  createdAt: CloudTimestamp,
});
export type FocusNotification = typeof FocusNotification.Type;

/** Reserved view keys beside Focus ids: the All tab and the Conversations tab. */
export const ALL_FOCUS_VIEW_ID = "all";
export const CONVERSATIONS_FOCUS_VIEW_ID = "conversations";

export const FOCUS_THREAD_SORT_ORDERS = [
  "custom",
  "recent_work",
  "recent_activity",
  "created_at",
  "needs_attention",
  "project",
] as const;
export const FocusThreadSortOrder = Schema.Literals(FOCUS_THREAD_SORT_ORDERS);
export type FocusThreadSortOrder = typeof FocusThreadSortOrder.Type;

/** A sort written by a newer client reads as Custom order instead of failing the read model. */
export function focusThreadSortOrder(value: string | undefined): FocusThreadSortOrder {
  return (FOCUS_THREAD_SORT_ORDERS as readonly string[]).includes(value ?? "")
    ? (value as FocusThreadSortOrder)
    : "custom";
}

/** Per-user sidebar layout for one Focus, All, or Conversations. Synced across devices. */
export const FocusViewPreference = Schema.Struct({
  focusId: TrimmedNonEmptyString,
  sortOrder: Schema.String,
  collapsiblePinned: Schema.Boolean,
  updatedAt: CloudTimestamp,
});
export type FocusViewPreference = typeof FocusViewPreference.Type;

export const FocusReadModel = Schema.Struct({
  focuses: Schema.Array(Focus),
  assignments: Schema.Array(FocusAssignment),
  viewPreferences: Schema.Array(FocusViewPreference).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
});
export type FocusReadModel = typeof FocusReadModel.Type;
