import type { Doc } from "../_generated/dataModel.js";
import type { MutationCtx, QueryCtx } from "../_generated/server.js";

/**
 * The next server-assigned issue number, kept off the company row so issue creation and key leases
 * do not invalidate every company-scoped reader. Older companies are copied lazily on first write.
 */
const findCounter = (ctx: QueryCtx, company: Doc<"companies">) =>
  ctx.db
    .query("companyIssueCounters")
    .withIndex("by_company", (q) => q.eq("companyId", company._id))
    .unique();

export async function readNextIssueNumber(ctx: QueryCtx, company: Doc<"companies">) {
  return (await findCounter(ctx, company))?.nextIssueNumber ?? company.nextIssueNumber;
}

export async function writeNextIssueNumber(
  ctx: MutationCtx,
  company: Doc<"companies">,
  nextIssueNumber: number,
) {
  const counter = await findCounter(ctx, company);
  if (counter) await ctx.db.patch(counter._id, { nextIssueNumber });
  else await ctx.db.insert("companyIssueCounters", { companyId: company._id, nextIssueNumber });
}
