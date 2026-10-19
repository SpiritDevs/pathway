// @effect-diagnostics globalDate:off -- Tests exercise device-local quiet-hours boundaries.
import { describe, expect, it } from "vite-plus/test";
import {
  advanceAlertDelivery,
  isInAlertQuietHours,
  isAlertThreadEligible,
  type AlertDeliveryEvent,
  type AlertDeliveryState,
} from "./index.ts";

const NOW = Date.parse("2026-09-08T12:00:00Z");
function event(id: string, overrides: Partial<AlertDeliveryEvent> = {}): AlertDeliveryEvent {
  return {
    eventId: id,
    environmentId: "env",
    threadId: "thread",
    kind: "finished-unsettled",
    createdAt: NOW,
    threadTitle: "A thread",
    projectName: "A project",
    alertEligibleAtCreation: true,
    isRead: false,
    ...overrides,
  };
}
const emptyState = (): AlertDeliveryState => ({
  installationId: "install",
  cursor: NOW - 10_000,
  handled: {},
  pending: [],
  groups: {},
});
const step = (
  state: AlertDeliveryState | null,
  events: readonly AlertDeliveryEvent[],
  overrides: Partial<Parameters<typeof advanceAlertDelivery>[0]> = {},
) =>
  advanceAlertDelivery({
    state,
    events,
    installationId: "install",
    now: NOW,
    quiet: false,
    catchUp: false,
    eligible: () => true,
    focused: () => false,
    ...overrides,
  });

describe("installation alert delivery", () => {
  it("baselines existing history and never delivers it later", () => {
    const baseline = step(null, [event("old")]);
    expect(baseline.actions).toEqual([]);
    expect(step(baseline.state, [event("old")]).actions).toEqual([]);
    expect(step(baseline.state, [event("new", { createdAt: NOW + 1 })]).actions).toHaveLength(1);
  });
  it("handles equal timestamps independently and ignores replay and older history", () => {
    const first = step(emptyState(), [event("a")]);
    const next = step(first.state, [
      event("a"),
      event("b"),
      event("older", { createdAt: NOW - 1 }),
    ]);
    expect(next.actions).toHaveLength(1);
    expect(next.actions[0]).toMatchObject({
      type: "event",
      event: { eventId: "b" },
      count: 2,
      sound: false,
    });
    expect(step(next.state, [event("a"), event("b")]).actions).toEqual([]);
  });
  it("keeps cursor ties handled after local retention expires", () => {
    const first = step(emptyState(), [event("a")]);
    const prune = step(first.state, [event("a")], { now: NOW + 40 * 86_400_000 });
    expect(step(prune.state, [event("a")], { now: NOW + 41 * 86_400_000 }).actions).toEqual([]);
  });
  it("snapshots eligibility and handles muted, read, or focused events without delivery", () => {
    const muted = event("muted", { alertEligibleAtCreation: false });
    const initial = step(
      emptyState(),
      [muted, event("read", { isRead: true }), event("focused"), event("disabled")],
      {
        eligible: (e) => e.eventId !== "disabled",
        focused: (e) => e.eventId === "focused",
      },
    );
    expect(initial.actions).toEqual([]);
    expect(Object.keys(initial.state.handled)).toHaveLength(4);
    expect(step(initial.state, [muted], { eligible: () => true }).actions).toEqual([]);
  });
  it("coalesces for three seconds per environment and thread without replaying sound", () => {
    const first = step(emptyState(), [event("a")]);
    const second = step(first.state, [event("b", { createdAt: NOW + 2000 })], { now: NOW + 2000 });
    expect(second.actions[0]).toMatchObject({ id: "thread-alert:a", count: 2, sound: false });
    const third = step(second.state, [event("c", { createdAt: NOW + 3000 })], { now: NOW + 3000 });
    expect(third.actions[0]).toMatchObject({ id: "thread-alert:c", count: 1, sound: true });
    const other = step(first.state, [event("other", { environmentId: "other" })]);
    expect(other.actions[0]).toMatchObject({ count: 1, sound: true });
  });
  it("combines reconnect with quiet-hours pending events once, rechecking reads and policy", () => {
    const quiet = step(emptyState(), [event("pending"), event("read"), event("disabled")], {
      quiet: true,
    });
    expect(quiet.actions).toEqual([]);
    const rows = [
      event("pending"),
      event("read", { isRead: true }),
      event("disabled"),
      event("new", { createdAt: NOW + 1, threadId: "second" }),
    ];
    const resume = step(quiet.state, rows, {
      catchUp: true,
      eligible: (e) => e.eventId !== "disabled",
    });
    expect(resume.actions).toEqual([
      { type: "summary", id: `thread-alert:summary:${NOW}`, eventCount: 2, threadCount: 2 },
    ]);
    expect(resume.state.pending).toEqual([]);
    expect(step(resume.state, rows, { catchUp: true }).actions).toEqual([]);
  });
  it("summarizes delayed reconnect snapshots but delivers later live events individually", () => {
    const result = step(
      emptyState(),
      [event("catch-up"), event("live", { createdAt: NOW + 2000 })],
      { catchUpBefore: NOW + 1000 },
    );
    expect(result.actions).toHaveLength(2);
    expect(result.actions[0]).toMatchObject({ type: "event", event: { eventId: "live" } });
    expect(result.actions[1]).toMatchObject({ type: "summary", eventCount: 1 });
  });
  it("does not wake events enabled after their occurrence or close lifecycle pending events", () => {
    const quiet = step(
      emptyState(),
      [event("old", { alertEligibleAtCreation: false }), event("closed")],
      { quiet: true },
    );
    expect(quiet.state.pending).toEqual(["closed"]);
    expect(step(quiet.state, [event("closed")], { eligible: () => false }).actions).toEqual([]);
  });
});

describe("quiet hours and lifecycle", () => {
  const schedule = { enabled: true, weekdays: [1], start: "22:00", end: "08:00" };
  it("uses the starting weekday for overnight schedules and excludes the end", () => {
    expect(isInAlertQuietHours(schedule, new Date(2026, 8, 7, 22, 0))).toBe(true);
    expect(isInAlertQuietHours(schedule, new Date(2026, 8, 8, 7, 59))).toBe(true);
    expect(isInAlertQuietHours(schedule, new Date(2026, 8, 8, 8, 0))).toBe(false);
    expect(isInAlertQuietHours(schedule, new Date(2026, 8, 7, 7, 59))).toBe(false);
  });
  it("supports same-day and full-day schedules", () => {
    expect(
      isInAlertQuietHours({ ...schedule, start: "09:00", end: "17:00" }, new Date(2026, 8, 7, 12)),
    ).toBe(true);
    expect(
      isInAlertQuietHours({ ...schedule, start: "09:00", end: "17:00" }, new Date(2026, 8, 7, 17)),
    ).toBe(false);
    expect(
      isInAlertQuietHours({ ...schedule, start: "00:00", end: "00:00" }, new Date(2026, 8, 7, 12)),
    ).toBe(true);
    expect(isInAlertQuietHours({ ...schedule, enabled: false }, new Date(2026, 8, 7, 23))).toBe(
      false,
    );
  });
  it("rejects unknown, archived, deleted, and settled threads", () => {
    expect(isAlertThreadEligible(null)).toBe(false);
    expect(isAlertThreadEligible({})).toBe(true);
    expect(isAlertThreadEligible({ archivedAt: NOW })).toBe(false);
    expect(isAlertThreadEligible({ settledAt: NOW })).toBe(false);
    expect(isAlertThreadEligible({ deletedAt: NOW })).toBe(false);
  });
});

describe("hydration and bounded delivery history", () => {
  it("defers unknown lifecycle or policy without losing events behind the cursor", () => {
    const waiting = step(emptyState(), [event("unknown"), event("newer", { createdAt: NOW + 1 })], {
      eligible: (e) => (e.eventId === "unknown" ? null : true),
    });
    expect(waiting.state.deferred).toEqual(["unknown"]);
    expect(waiting.state.handled.unknown).toBeUndefined();
    const hydrated = step(
      waiting.state,
      [event("unknown"), event("newer", { createdAt: NOW + 1 })],
      { catchUp: true },
    );
    expect(hydrated.actions).toEqual([
      { type: "summary", id: `thread-alert:summary:${NOW}`, eventCount: 1, threadCount: 1 },
    ]);
    expect(hydrated.state.deferred).toEqual([]);
  });
  it("retains quiet-hours pending events during a policy refresh", () => {
    const quiet = step(emptyState(), [event("pending")], { quiet: true });
    const loading = step(quiet.state, [event("pending")], { eligible: () => null });
    expect(loading.state.pending).toEqual(["pending"]);
    expect(loading.actions).toEqual([]);
    expect(step(loading.state, [event("pending")]).actions[0]).toMatchObject({
      type: "summary",
      eventCount: 1,
    });
  });
  it("bounds handled history to the retained feed and cursor ties", () => {
    const previous = {
      ...emptyState(),
      cursor: NOW,
      handled: { expired: NOW - 1, tie: NOW },
      deferred: ["removed"],
    };
    const result = step(previous, [event("new", { createdAt: NOW + 1 })]);
    expect(Object.keys(result.state.handled).sort()).toEqual(["new", "tie"]);
    expect(result.state.deferred).toEqual([]);
    expect(step(result.state, [event("new", { createdAt: NOW + 1 })]).state.handled).toEqual({
      new: NOW + 1,
    });
  });
});
