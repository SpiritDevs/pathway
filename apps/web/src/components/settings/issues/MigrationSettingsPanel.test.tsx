import type {
  IssueImportExecuteResult,
  IssueImportPreviewResult,
  IssueImportRun,
} from "@spiritdevs/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { IssueImportProgressView, IssueImportResultView } from "./MigrationSettingsPanel";

const counts = {
  issue: 2,
  issueStatus: 1,
  issueLabel: 0,
  issueMilestone: 0,
  issueCycle: 0,
  issueTodo: 0,
  issueRelation: 0,
  issueComment: 0,
  issueAttachment: 1,
  issueView: 0,
  issueAuditEvent: 0,
  issueThreadLink: 0,
} as const;

const progress = { cloudProject: 1, ...counts };
const run: IssueImportRun = {
  id: "run-1",
  companyId: "company-1",
  sourceEnvironmentId: "environment-1",
  createdByMembershipId: "member-1",
  importingMembershipId: "member-1",
  selectedIssueKeyPrefix: "ISS",
  mode: "empty-company",
  state: "applying",
  progress,
  trackerApplied: true,
  trackerNextIssueNumber: 3,
  createdAt: 1,
  updatedAt: 2,
  completedAt: null,
  abandonedAt: null,
};

const preview: IssueImportPreviewResult = {
  runId: run.id,
  sourceEnvironmentId: run.sourceEnvironmentId,
  selectedIssueKeyPrefix: "ISS",
  preview: {
    counts,
    issueKeyPrefix: { source: "ISS", selected: "ISS" },
    issueKeyRange: { first: "ISS-1", last: "ISS-2", lowestNumber: 1, highestNumber: 2 },
    nextIssueNumber: 3,
    attachments: { count: 1, totalBytes: 12 },
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

describe("issue migration status views", () => {
  it("renders live per-kind progress against the preview", () => {
    const markup = renderToStaticMarkup(<IssueImportProgressView run={run} preview={preview} />);
    expect(markup).toContain("Migration applying");
    expect(markup).toContain("Issue migration progress");
    expect(markup).toContain("Attachments");
  });

  it("renders resumable ledger counts and rejected records", () => {
    const resultCounts = Object.fromEntries(
      Object.keys(progress).map((kind) => [
        kind,
        {
          applied: kind === "issue" ? 1 : 0,
          alreadyApplied: kind === "issue" ? 1 : 0,
          rejected: 0,
        },
      ]),
    ) as IssueImportExecuteResult["counts"];
    const result: IssueImportExecuteResult = {
      runId: run.id,
      resumed: true,
      preview: preview.preview,
      counts: resultCounts,
      rejects: [{ entityKind: "issue", entityId: "issue-3", code: "bad-row", message: "Skipped." }],
      attachmentUploads: [
        {
          attachmentId: "attachment-1",
          status: "alreadyFinalized",
          byteSize: 2048,
          checksum: "sha256:abc",
        },
      ],
      finalRun: { ...run, state: "completed", completedAt: 3 },
    };
    const markup = renderToStaticMarkup(<IssueImportResultView result={result} />);
    expect(markup).toContain("Cloud issue migration completed");
    expect(markup).toContain("resumed from the import ledger");
    expect(markup).toContain("issue-3: Skipped.");
    expect(markup).toContain("attachment-1: alreadyFinalized · 2.0 KB");
  });
});
