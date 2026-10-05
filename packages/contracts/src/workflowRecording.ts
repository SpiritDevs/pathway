import * as Schema from "effect/Schema";
import { IsoDateTime, ThreadId } from "./baseSchemas.ts";

export const WORKFLOW_RECORDING_MAX_DURATION_MS = 30 * 60 * 1_000;
export const WORKFLOW_RECORDING_METHODS = {
  status: "computer.recording.status",
  start: "computer.recording.start",
  stop: "computer.recording.stop",
  cancel: "computer.recording.cancel",
} as const;

export const WorkflowRecordingAction = Schema.Literals(["status", "start", "stop", "cancel"]);
export type WorkflowRecordingAction = typeof WorkflowRecordingAction.Type;
export const WorkflowRecordingInput = Schema.Struct({ threadId: ThreadId });
export type WorkflowRecordingInput = typeof WorkflowRecordingInput.Type;

/** Status carries no captured text. Artifact paths are returned only to the owning thread. */
export const WorkflowRecordingStatus = Schema.Struct({
  supported: Schema.Boolean,
  targetName: Schema.optional(Schema.String.check(Schema.isMaxLength(256))),
  phase: Schema.Literals([
    "idle",
    "awaiting-confirmation",
    "recording",
    "stopping",
    "completed",
    "cancelled",
    "failed",
    "busy",
  ]),
  recordingId: Schema.optional(Schema.String),
  startedAt: Schema.optional(IsoDateTime),
  endedAt: Schema.optional(IsoDateTime),
  eventCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  maxDurationMs: Schema.Int.check(Schema.isGreaterThan(0)),
  eventsPath: Schema.optional(Schema.String),
  metadataPath: Schema.optional(Schema.String),
  skillPrompt: Schema.optional(Schema.String.check(Schema.isMaxLength(16_000))),
  endReason: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
});
export type WorkflowRecordingStatus = typeof WorkflowRecordingStatus.Type;

export const idleWorkflowRecording = (supported: boolean): WorkflowRecordingStatus => ({
  supported,
  phase: "idle",
  eventCount: 0,
  maxDurationMs: WORKFLOW_RECORDING_MAX_DURATION_MS,
});
