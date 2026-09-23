import type { Doc, Id } from "../_generated/dataModel.js";
import type { QueryCtx } from "../_generated/server.js";

/**
 * Rows tied to a project either directly or through one of its issues, read through the project
 * and issue indexes rather than every row in the company.
 */
function dedupe<Row extends { readonly _id: string }>(rows: ReadonlyArray<Row>): Row[] {
  return [...new Map(rows.map((row) => [row._id, row])).values()];
}

export async function projectAutomationJobs(
  ctx: QueryCtx,
  companyId: Id<"companies">,
  cloudProjectId: Id<"cloudProjects">,
  issueIds: ReadonlySet<string>,
): Promise<Doc<"issueAutomationJobs">[]> {
  const [byProject, ...byIssue] = await Promise.all([
    ctx.db
      .query("issueAutomationJobs")
      .withIndex("by_company_and_project", (q) =>
        q.eq("companyId", companyId).eq("cloudProjectId", cloudProjectId),
      )
      .collect(),
    ...[...issueIds].map((issueId) =>
      ctx.db
        .query("issueAutomationJobs")
        .withIndex("by_company_and_issue", (q) =>
          q.eq("companyId", companyId).eq("issueId", issueId),
        )
        .collect(),
    ),
  ]);
  return dedupe([...byProject, ...byIssue.flat()]);
}

export async function projectSlackAutomationIntents(
  ctx: QueryCtx,
  companyId: Id<"companies">,
  cloudProjectId: Id<"cloudProjects">,
  issueIds: ReadonlySet<string>,
): Promise<Doc<"slackIssueAutomationIntents">[]> {
  const [byProject, ...byIssue] = await Promise.all([
    ctx.db
      .query("slackIssueAutomationIntents")
      .withIndex("by_company_and_project", (q) =>
        q.eq("companyId", companyId).eq("cloudProjectId", cloudProjectId),
      )
      .collect(),
    ...[...issueIds].map((issueId) =>
      ctx.db
        .query("slackIssueAutomationIntents")
        .withIndex("by_company_and_issue", (q) =>
          q.eq("companyId", companyId).eq("issueId", issueId),
        )
        .collect(),
    ),
  ]);
  return dedupe([...byProject, ...byIssue.flat()]);
}
