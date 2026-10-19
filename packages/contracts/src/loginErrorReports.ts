import * as Schema from "effect/Schema";

/** Anonymous diagnostics accepted before an Apple client can sign in. Never include raw error payloads. */
export const LoginErrorReport = Schema.Struct({
  reportId: Schema.String,
  installationId: Schema.String,
  occurredAt: Schema.String,
  appVersion: Schema.String,
  osVersion: Schema.String,
  errorDomain: Schema.String,
  errorCode: Schema.Number,
  kind: Schema.Literals(["cancelled", "connection", "unknown"]),
});
export type LoginErrorReport = typeof LoginErrorReport.Type;
