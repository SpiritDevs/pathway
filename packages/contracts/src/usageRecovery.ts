import * as Schema from "effect/Schema";
import { CommandId, IsoDateTime, RunId, ThreadId } from "./baseSchemas.ts";

export const UsageRecovery = Schema.Struct({
  id: CommandId,
  threadId: ThreadId,
  sourceRunId: RunId,
  status: Schema.Literals(["scheduled", "monitoring", "completed", "failed", "cancelled"]),
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
