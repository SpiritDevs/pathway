/** Shared online Contacts and Time Tracker records. Convex is their cross-device authority. */
import * as Schema from "effect/Schema";

export const BusinessContact = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  role: Schema.String,
  company: Schema.String,
  email: Schema.String,
  phone: Schema.String,
  notes: Schema.String,
  favorite: Schema.Boolean,
  createdAt: Schema.String,
  revision: Schema.Number,
});
export type BusinessContact = typeof BusinessContact.Type;
export const TrackedSession = Schema.Struct({
  id: Schema.String,
  description: Schema.String,
  title: Schema.optionalKey(Schema.String),
  environmentId: Schema.optionalKey(Schema.String),
  threadId: Schema.optionalKey(Schema.String),
  projectKey: Schema.String,
  projectName: Schema.String,
  startedAt: Schema.String,
  stoppedAt: Schema.NullOr(Schema.String),
  durationMs: Schema.Number,
  source: Schema.optional(Schema.Literals(["manual", "agent", "issue"])),
});
export type TrackedSession = typeof TrackedSession.Type;

export const TrackedSessionPage = Schema.Struct({
  active: Schema.NullOr(TrackedSession),
  entries: Schema.Array(TrackedSession),
  cursor: Schema.NullOr(Schema.String),
  isDone: Schema.Boolean,
});
export type TrackedSessionPage = typeof TrackedSessionPage.Type;
export const RecentTrackedTimeTotals = Schema.Struct({
  todayMs: Schema.Number,
  weekMs: Schema.Number,
  todayClippedMs: Schema.Number,
  weekClippedMs: Schema.Number,
  complete: Schema.Boolean,
});
export type RecentTrackedTimeTotals = typeof RecentTrackedTimeTotals.Type;

export const BusinessContactPage = Schema.Struct({
  contacts: Schema.Array(BusinessContact),
  cursor: Schema.NullOr(Schema.String),
  isDone: Schema.Boolean,
});
export type BusinessContactPage = typeof BusinessContactPage.Type;
export type BusinessContactSearchField = "name" | "role" | "company" | "email" | "phone";

/** One manual, issue, or agent activity with the intervals when work was happening. */
export const TrackedActivitySession = Schema.Struct({
  ...TrackedSession.fields,
  source: Schema.Literals(["manual", "agent", "issue"]),
  state: Schema.Literals(["running", "paused", "stopped"]),
  threadId: Schema.NullOr(Schema.String),
  issueId: Schema.NullOr(Schema.String),
  intervals: Schema.Array(Schema.Struct({ start: Schema.Number, end: Schema.Number })),
  runningSince: Schema.NullOr(Schema.Number),
  observedAt: Schema.NullOr(Schema.Number),
});
export type TrackedActivitySession = typeof TrackedActivitySession.Type;

export const ActiveTrackedActivities = Schema.Struct({
  sessions: Schema.Array(TrackedActivitySession),
  complete: Schema.Boolean,
});
export type ActiveTrackedActivities = typeof ActiveTrackedActivities.Type;

const TrackedActivityTotals = Schema.Struct({
  workMs: Schema.Number,
  elapsedMs: Schema.Number,
  manualMs: Schema.Number,
  agentMs: Schema.Number,
  issueMs: Schema.Number,
});
export const TrackedActivityOverview = Schema.Struct({
  complete: Schema.Boolean,
  totals: TrackedActivityTotals,
  projects: Schema.Array(
    Schema.Struct({
      ...TrackedActivityTotals.fields,
      projectKey: Schema.String,
      projectName: Schema.String,
    }),
  ),
  days: Schema.Array(Schema.Struct({ ...TrackedActivityTotals.fields, date: Schema.String })),
});
export type TrackedActivityOverview = typeof TrackedActivityOverview.Type;
