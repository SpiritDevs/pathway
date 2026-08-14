import {
  IsoDateTime,
  IssueId,
  ModelSelection,
  NonNegativeInt,
  TrimmedNonEmptyString,
} from "@spiritdevs/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { IssueTrackerRepositoryError } from "../Errors.ts";

export const IssueAutomationAuditRun = Schema.Struct({
  id: TrimmedNonEmptyString,
  issueId: IssueId,
  triggerKey: TrimmedNonEmptyString,
  ruleId: TrimmedNonEmptyString,
  auditorIndex: NonNegativeInt,
  modelSelection: ModelSelection,
  state: Schema.Literals(["running", "done", "failed"]),
  verdict: Schema.NullOr(Schema.Literals(["pass", "changes_requested"])),
  summary: Schema.NullOr(Schema.String),
  findings: Schema.Array(Schema.String),
  error: Schema.NullOr(Schema.String),
  remediationCycle: NonNegativeInt,
  createdAt: IsoDateTime,
  finishedAt: Schema.NullOr(IsoDateTime),
});
export type IssueAutomationAuditRun = typeof IssueAutomationAuditRun.Type;

export interface IssueAutomationAuditRepositoryShape {
  /** A server restart means no prior in-process auditor can still own a running claim. */
  readonly releaseInterruptedClaims: () => Effect.Effect<void, IssueTrackerRepositoryError>;
  /** Insert the running row, or return false when this exact auditor already claimed the trigger. */
  readonly claim: (
    run: IssueAutomationAuditRun,
  ) => Effect.Effect<boolean, IssueTrackerRepositoryError>;
  readonly finish: (
    run: IssueAutomationAuditRun,
  ) => Effect.Effect<void, IssueTrackerRepositoryError>;
  readonly listByTrigger: (input: {
    readonly issueId: IssueId;
    readonly triggerKey: string;
  }) => Effect.Effect<ReadonlyArray<IssueAutomationAuditRun>, IssueTrackerRepositoryError>;
  readonly countChangesRequested: (
    issueId: IssueId,
  ) => Effect.Effect<number, IssueTrackerRepositoryError>;
}

export class IssueAutomationAuditRepository extends Context.Service<
  IssueAutomationAuditRepository,
  IssueAutomationAuditRepositoryShape
>()(
  "@spiritdevs/pathway/persistence/Services/IssueAutomationAudits/IssueAutomationAuditRepository",
) {}
