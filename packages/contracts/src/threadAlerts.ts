import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { AttentionEventKind } from "./focus.ts";

export const ALERT_EVENT_KEYS = ["completion", "permission", "input", "failure"] as const;
export type AlertEventKey = (typeof ALERT_EVENT_KEYS)[number];
export const AlertPolicy = Schema.Struct({
  completion: Schema.Boolean,
  permission: Schema.Boolean,
  input: Schema.Boolean,
  failure: Schema.Boolean,
});
export type AlertPolicy = typeof AlertPolicy.Type;
export const AlertPolicyOverride = Schema.Struct({
  completion: Schema.optionalKey(Schema.Boolean),
  permission: Schema.optionalKey(Schema.Boolean),
  input: Schema.optionalKey(Schema.Boolean),
  failure: Schema.optionalKey(Schema.Boolean),
});
export type AlertPolicyOverride = typeof AlertPolicyOverride.Type;
export const AlertPolicyScopeKind = Schema.Literals(["global", "project", "thread"]);
export type AlertPolicyScopeKind = typeof AlertPolicyScopeKind.Type;
export const AlertPolicyRow = Schema.Struct({
  scopeKind: AlertPolicyScopeKind,
  scopeKey: Schema.String,
  choices: AlertPolicyOverride,
});
export type AlertPolicyRow = typeof AlertPolicyRow.Type;

export const DEFAULT_ALERT_POLICY: AlertPolicy = {
  completion: false,
  permission: false,
  input: false,
  failure: false,
};

/** Each event inherits independently; absent choices never override a parent. */
export function resolveAlertPolicy(
  global?: AlertPolicyOverride | null,
  project?: AlertPolicyOverride | null,
  thread?: AlertPolicyOverride | null,
): AlertPolicy {
  return {
    completion: thread?.completion ?? project?.completion ?? global?.completion ?? false,
    permission: thread?.permission ?? project?.permission ?? global?.permission ?? false,
    input: thread?.input ?? project?.input ?? global?.input ?? false,
    failure: thread?.failure ?? project?.failure ?? global?.failure ?? false,
  };
}

export function alertEventKey(kind: AttentionEventKind): AlertEventKey {
  switch (kind) {
    case "finished-unsettled":
      return "completion";
    case "pending-approval":
      return "permission";
    case "awaiting-input":
      return "input";
    case "failed":
      return "failure";
  }
}

export function alertProjectScopeKey(
  environmentId: string,
  projectId: string,
  canonicalKey?: string | null,
): string {
  return canonicalKey || `environment:${environmentId}:project:${projectId}`;
}

export function alertThreadScopeKey(environmentId: string, threadId: string): string {
  return `environment:${environmentId}:thread:${threadId}`;
}

const localTime = Schema.String.check(Schema.isPattern(/^([01]\d|2[0-3]):[0-5]\d$/));
export const AlertQuietHours = Schema.Struct({
  enabled: Schema.Boolean,
  weekdays: Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 6 }))),
  start: localTime,
  end: localTime,
});
export const AlertCustomSound = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  mimeType: Schema.String,
  size: Schema.Number,
  duration: Schema.Number,
});
export const DEFAULT_ALERT_DELIVERY_SETTINGS = {
  soundEnabled: true,
  osNotificationsEnabled: false,
  soundId: "default",
  customSound: null,
  quietHours: { enabled: false, weekdays: [0, 1, 2, 3, 4, 5, 6], start: "22:00", end: "08:00" },
};
export const AlertDeliverySettings = Schema.Struct({
  soundEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  osNotificationsEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  soundId: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed("default"))),
  customSound: Schema.NullOr(AlertCustomSound).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  quietHours: AlertQuietHours.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_ALERT_DELIVERY_SETTINGS.quietHours)),
  ),
});
export type AlertDeliverySettings = typeof AlertDeliverySettings.Type;

export const ThreadAlertTarget = Schema.NullOr(
  Schema.Struct({
    environmentId: Schema.String,
    threadId: Schema.String,
    eventId: Schema.String,
  }),
);
export type ThreadAlertTarget = typeof ThreadAlertTarget.Type;
export const DesktopThreadAlertInput = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  body: Schema.String,
  target: ThreadAlertTarget,
});
export type DesktopThreadAlertInput = typeof DesktopThreadAlertInput.Type;
export type ThreadAlertSupport = "available" | "blocked" | "unsupported";
export interface DesktopThreadAlertsBridge {
  getSupport: () => Promise<ThreadAlertSupport>;
  show: (input: DesktopThreadAlertInput) => Promise<void>;
  close: (id: string) => Promise<void>;
  playSystemSound: () => Promise<void>;
  openSettings: () => Promise<boolean>;
  onClick: (listener: (target: ThreadAlertTarget) => void) => () => void;
}
