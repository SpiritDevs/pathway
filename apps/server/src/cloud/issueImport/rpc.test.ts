import {
  EnvironmentId,
  IssueImportRpcError,
  type IssueImportExecuteResult,
  type IssueImportPreviewResult,
  type IssueImportRequest,
} from "@spiritdevs/contracts";
import { CompanyId } from "@spiritdevs/contracts/company";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { IssueImportStartRequiredError, type IssueImportExecutionResult } from "./executor.ts";
import { makeIssueImportRpcHandlers, mapIssueImportRpcError } from "./rpc.ts";

const input = {
  companyId: "company-1",
  importingMembershipId: "member-1",
  selectedIssueKeyPrefix: "ISS",
};

const emptyIssueCounts = {
  issue: 0,
  issueStatus: 0,
  issueLabel: 0,
  issueMilestone: 0,
  issueCycle: 0,
  issueTodo: 0,
  issueRelation: 0,
  issueComment: 0,
  issueAttachment: 0,
  issueView: 0,
  issueAuditEvent: 0,
  issueThreadLink: 0,
} as const;

const preview: IssueImportPreviewResult = {
  runId: "run-1",
  sourceEnvironmentId: "environment-1",
  selectedIssueKeyPrefix: "ISS",
  preview: {
    counts: emptyIssueCounts,
    issueKeyPrefix: { source: "ISS", selected: "ISS" },
    issueKeyRange: { first: null, last: null, lowestNumber: null, highestNumber: null },
    nextIssueNumber: 1,
    attachments: { count: 0, totalBytes: 0 },
    rejected: [],
  },
  fidelityGaps: [],
  preflight: {
    passed: true,
    cloudSyncConfigured: true,
    companyMatches: true,
    environmentLinked: true,
    bootstrapReady: true,
    targetCompanyEmpty: true,
    reasons: [],
  },
};

const resultCounts = Object.fromEntries(
  ["cloudProject", ...Object.keys(emptyIssueCounts)].map((kind) => [
    kind,
    { applied: 0, alreadyApplied: 0, rejected: 0 },
  ]),
) as IssueImportExecutionResult["counts"];

function execution(): IssueImportExecutionResult {
  return {
    runId: "run-1",
    resumed: true,
    plan: {
      mode: "empty-company",
      companyId: CompanyId.make("company-1"),
      sourceEnvironmentId: EnvironmentId.make("environment-1"),
      importRunId: "run-1",
      trackerConfig: {
        sourcePrefix: "ISS",
        selectedPrefix: "ISS",
        sourceNextNumber: 1,
        nextIssueNumber: 1,
      },
      entities: [],
      attachmentUploads: [],
      operationBatches: [],
      preview: preview.preview,
      fidelityGaps: [],
    },
    counts: resultCounts,
    rejects: [],
    attachmentUploads: [],
    finalRun: {
      id: "run-1",
      companyId: "company-1",
      sourceEnvironmentId: "environment-1",
      createdByMembershipId: "member-1",
      importingMembershipId: "member-1",
      selectedIssueKeyPrefix: "ISS",
      mode: "empty-company",
      state: "completed",
      progress: Object.fromEntries(
        Object.entries(resultCounts).map(([kind, count]) => [kind, count.applied]),
      ) as IssueImportExecutionResult["finalRun"]["progress"],
      trackerApplied: true,
      trackerNextIssueNumber: 1,
      createdAt: 1,
      updatedAt: 2,
      completedAt: 2,
      abandonedAt: null,
    },
  };
}

describe("issue import RPC handlers", () => {
  it.effect("uses injected preview and executor boundaries", () =>
    Effect.gen(function* () {
      const handlers = makeIssueImportRpcHandlers({
        readSnapshot: Effect.die("not used"),
        preview: () => Effect.succeed(preview),
        execute: () => Effect.succeed(execution()),
      }) as {
        readonly preview: (
          request: IssueImportRequest,
        ) => Effect.Effect<IssueImportPreviewResult, IssueImportRpcError>;
        readonly execute: (
          request: IssueImportRequest,
        ) => Stream.Stream<IssueImportExecuteResult, IssueImportRpcError>;
      };

      expect(yield* handlers.preview(input)).toEqual(preview);
      const events = yield* Stream.runCollect(handlers.execute(input));
      expect([...events]).toEqual([
        expect.objectContaining({
          runId: "run-1",
          resumed: true,
          preview: preview.preview,
          finalRun: expect.objectContaining({ state: "completed" }),
        }),
      ]);
      expect("plan" in events[0]!).toBe(false);
    }),
  );

  it("maps tagged executor failures without exposing causes", () => {
    const error = mapIssueImportRpcError(
      new IssueImportStartRequiredError({ message: "A member must start this run." }),
    );
    expect(Schema.is(IssueImportRpcError)(error)).toBe(true);
    expect(error).toMatchObject({
      kind: "start-required",
      code: null,
      message: "A member must start this run.",
      attachmentIds: [],
    });
    expect("cause" in error).toBe(false);
  });
});
