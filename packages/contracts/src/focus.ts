/** Synced Focus definitions, project assignments, and Attention Event notifications. */
import * as Schema from "effect/Schema";

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
  eventId: AttentionEventId,
  threadId: ThreadId,
  projectKey: FocusProjectKey,
  eventKind: AttentionEventKind,
});
export type AttentionEvent = typeof AttentionEvent.Type;

export const FocusNotification = Schema.Struct({
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

export const FocusReadModel = Schema.Struct({
  focuses: Schema.Array(Focus),
  assignments: Schema.Array(FocusAssignment),
});
export type FocusReadModel = typeof FocusReadModel.Type;
