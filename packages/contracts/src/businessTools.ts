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
  projectKey: Schema.String,
  projectName: Schema.String,
  startedAt: Schema.String,
  stoppedAt: Schema.NullOr(Schema.String),
  durationMs: Schema.Number,
});
export type TrackedSession = typeof TrackedSession.Type;
