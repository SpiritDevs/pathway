import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_ISSUE_STATUSES,
  isDefaultIssueStatusSet,
  isPristineIssueImportTarget,
} from "./issueImport.ts";

const statuses = DEFAULT_ISSUE_STATUSES.map((status) => ({
  ...status,
  companyId: "company-one",
  scope: "company",
  teamId: null,
  baseStatusId: null,
  hidden: false,
  createdAt: 1,
  updatedAt: 2,
}));

describe("empty-company issue import target", () => {
  it("accepts an empty domain and the untouched default workflow", () => {
    expect(isPristineIssueImportTarget([])).toBe(true);
    expect(
      isPristineIssueImportTarget(
        statuses.map((payload) => ({ entityKind: "issueStatus", payload })),
      ),
    ).toBe(true);
    expect(isDefaultIssueStatusSet([...statuses].reverse())).toBe(true);
  });

  it("rejects customized workflows and every other issue-domain row", () => {
    expect(
      isDefaultIssueStatusSet(
        statuses.map((row, index) => (index === 0 ? { ...row, name: "Inbox" } : row)),
      ),
    ).toBe(false);
    expect(
      isPristineIssueImportTarget([
        ...statuses.map((payload) => ({ entityKind: "issueStatus", payload })),
        { entityKind: "issue", payload: { id: "issue-one" } },
      ]),
    ).toBe(false);
  });
});
