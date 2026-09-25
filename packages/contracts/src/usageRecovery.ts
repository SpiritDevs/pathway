import * as Schema from "effect/Schema";
import { CommandId, IsoDateTime, RunId, ThreadId } from "./baseSchemas.ts";

export const UsageRecovery = Schema.Struct({
  id: CommandId,
  threadId: ThreadId,
  sourceRunId: RunId,
  status: Schema.Literals(["scheduled", "monitoring", "completed", "failed", "cancelled"]),
  /**
   * `pause` resumes work the user paused before reaching the limit; its run stops at the next
   * step boundary first. Absent means recovery after a usage-limit failure.
   */
  reason: Schema.optional(Schema.Literal("pause")),
  /** When a pause stopped its run. Null while the run is still finishing its current step. */
  pausedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  resumeAt: IsoDateTime,
  attempts: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 3 })),
  message: Schema.String,
});
export type UsageRecovery = typeof UsageRecovery.Type;

export const UsageRecoveryThreadInput = Schema.Struct({ threadId: ThreadId });
export const UsageRecoveryScheduleInput = Schema.Struct({
  commandId: CommandId,
  threadId: ThreadId,
  sourceRunId: RunId,
  resumeAt: IsoDateTime,
});
export type UsageRecoveryScheduleInput = typeof UsageRecoveryScheduleInput.Type;
/** Pause the thread's running work until `resumeAt`, normally the allowance reset. */
export const UsageRecoveryPauseInput = Schema.Struct({
  commandId: CommandId,
  threadId: ThreadId,
  resumeAt: IsoDateTime,
});
export type UsageRecoveryPauseInput = typeof UsageRecoveryPauseInput.Type;
export const UsageRecoveryResult = Schema.Struct({
  recovery: Schema.NullOr(UsageRecovery),
  eligibility: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        sourceRunId: RunId,
        suggestedResumeAt: Schema.NullOr(IsoDateTime),
        /** Latest reported allowance reset. Once it has passed, clients offer to resume now. */
        resetAt: Schema.optional(Schema.NullOr(IsoDateTime)),
        childCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      }),
    ),
  ),
});
export type UsageRecoveryResult = typeof UsageRecoveryResult.Type;

export class UsageRecoveryError extends Schema.TaggedErrorClass<UsageRecoveryError>()(
  "UsageRecoveryError",
  { message: Schema.String },
) {}
