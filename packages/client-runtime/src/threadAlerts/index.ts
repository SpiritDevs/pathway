import type { AttentionEventKind } from "@spiritdevs/contracts/focus";

/** Installation-local delivery decisions. No provider messages enter this state. */
export interface AlertDeliveryEvent {
  readonly eventId: string;
  readonly environmentId: string;
  readonly threadId: string;
  readonly kind: AttentionEventKind;
  readonly createdAt: string | number;
  readonly threadTitle: string;
  readonly projectName: string;
  readonly alertEligibleAtCreation?: boolean;
  readonly isRead?: boolean;
}

export interface AlertQuietHours {
  readonly enabled: boolean;
  readonly weekdays: readonly number[];
  readonly start: string;
  readonly end: string;
}

export function isInAlertQuietHours(schedule: AlertQuietHours, now: Date): boolean {
  if (!schedule.enabled) return false;
  const minutes = (value: string) => {
    const [hours, mins] = value.split(":").map(Number);
    return (hours ?? 0) * 60 + (mins ?? 0);
  };
  const start = minutes(schedule.start);
  const end = minutes(schedule.end);
  const current = now.getHours() * 60 + now.getMinutes();
  if (start === end) return schedule.weekdays.includes(now.getDay());
  if (start < end) {
    return schedule.weekdays.includes(now.getDay()) && current >= start && current < end;
  }
  return (
    (current >= start && schedule.weekdays.includes(now.getDay())) ||
    (current < end && schedule.weekdays.includes((now.getDay() + 6) % 7))
  );
}

export function isAlertThreadEligible(
  thread:
    | {
        readonly archivedAt?: string | number | null;
        readonly deletedAt?: string | number | null;
        readonly settledAt?: string | number | null;
      }
    | null
    | undefined,
): boolean {
  return (
    thread != null &&
    thread.archivedAt == null &&
    thread.deletedAt == null &&
    thread.settledAt == null
  );
}

export const alertDeliveryThreadKey = (
  event: Pick<AlertDeliveryEvent, "environmentId" | "threadId">,
) => JSON.stringify([event.environmentId, event.threadId]);

export const alertEventTime = (event: AlertDeliveryEvent) =>
  typeof event.createdAt === "number" ? event.createdAt : Date.parse(event.createdAt);

interface DeliveryGroup {
  readonly id: string;
  readonly startedAt: number;
  readonly count: number;
}

export interface AlertDeliveryState {
  readonly installationId: string;
  readonly cursor: number;
  readonly handled: Readonly<Record<string, number>>;
  readonly pending: readonly string[];
  readonly deferred?: readonly string[];
  readonly groups: Readonly<Record<string, DeliveryGroup>>;
}

export type AlertDeliveryAction =
  | {
      readonly type: "event";
      readonly id: string;
      readonly event: AlertDeliveryEvent;
      readonly count: number;
      readonly sound: boolean;
    }
  | {
      readonly type: "summary";
      readonly id: string;
      readonly eventCount: number;
      readonly threadCount: number;
    };

/** Call inside the same transaction that saves the returned state, before delivering actions. */
export function advanceAlertDelivery(input: {
  readonly state: AlertDeliveryState | null;
  readonly installationId: string;
  readonly events: readonly AlertDeliveryEvent[];
  readonly now: number;
  readonly quiet: boolean;
  readonly catchUp: boolean;
  readonly catchUpBefore?: number;
  readonly eligible: (event: AlertDeliveryEvent) => boolean | null;
  readonly focused: (event: AlertDeliveryEvent) => boolean;
}): { state: AlertDeliveryState; actions: AlertDeliveryAction[] } {
  const events = input.events.filter((event) => Number.isFinite(alertEventTime(event)));
  const newest = Math.max(0, ...events.map(alertEventTime));
  if (input.state === null) {
    return {
      state: {
        installationId: input.installationId,
        cursor: newest,
        handled: Object.fromEntries(events.map((e) => [e.eventId, alertEventTime(e)])),
        pending: [],
        groups: {},
      },
      actions: [],
    };
  }
  const state = input.state;
  const byId = new Map(events.map((event) => [event.eventId, event]));
  const handled = Object.fromEntries(
    Object.entries(state.handled).filter(([id, time]) => time >= state.cursor || byId.has(id)),
  );
  const groups = Object.fromEntries(
    Object.entries(state.groups).filter(([, group]) => input.now - group.startedAt < 3_000),
  );
  const pending = new Set(state.pending);
  const deferred = new Set((state.deferred ?? []).filter((id) => byId.has(id)));
  const fresh = events
    .filter(
      (event) =>
        deferred.has(event.eventId) ||
        (!(event.eventId in state.handled) && alertEventTime(event) >= state.cursor),
    )
    .sort((a, b) => alertEventTime(a) - alertEventTime(b) || a.eventId.localeCompare(b.eventId));
  const deliverable = (event: AlertDeliveryEvent): boolean | null => {
    if (event.alertEligibleAtCreation !== true || event.isRead || input.focused(event))
      return false;
    return input.eligible(event);
  };
  const actions: AlertDeliveryAction[] = [];
  const summary = new Map<string, AlertDeliveryEvent>();
  // Rechecking pending rows removes acknowledgements, disabled policy, and closed threads.
  for (const id of pending) {
    const event = byId.get(id);
    const eligible = event ? deliverable(event) : false;
    if (eligible === null) continue;
    if (!event || !eligible) pending.delete(id);
    else if (!input.quiet) {
      summary.set(id, event);
      pending.delete(id);
    }
  }
  for (const event of fresh) {
    const eligible = deliverable(event);
    if (eligible === null) {
      deferred.add(event.eventId);
      continue;
    }
    deferred.delete(event.eventId);
    handled[event.eventId] = alertEventTime(event);
    if (!eligible) continue;
    if (input.quiet) {
      pending.add(event.eventId);
      continue;
    }
    if (input.catchUp || alertEventTime(event) <= (input.catchUpBefore ?? 0)) {
      summary.set(event.eventId, event);
      continue;
    }
    const threadKey = alertDeliveryThreadKey(event);
    const previous = groups[threadKey];
    const group = previous
      ? { ...previous, count: previous.count + 1 }
      : { id: `thread-alert:${event.eventId}`, startedAt: input.now, count: 1 };
    groups[threadKey] = group;
    actions.push({ type: "event", id: group.id, event, count: group.count, sound: !previous });
  }
  if (summary.size > 0) {
    actions.push({
      type: "summary",
      id: `thread-alert:summary:${input.now}`,
      eventCount: summary.size,
      threadCount: new Set([...summary.values()].map(alertDeliveryThreadKey)).size,
    });
  }
  return {
    state: {
      installationId: state.installationId,
      cursor: Math.max(state.cursor, newest),
      handled,
      pending: [...pending],
      deferred: [...deferred],
      groups,
    },
    actions,
  };
}

export { createThreadAlertLeadership, type AlertLockManager } from "./leadership.ts";
