import type { Doc } from "../_generated/dataModel.js";
import type { MutationCtx, QueryCtx } from "../_generated/server.js";

const findHead = (ctx: QueryCtx, company: Doc<"companies">) =>
  ctx.db
    .query("companySyncHeads")
    .withIndex("by_company", (q) => q.eq("companyId", company._id))
    .unique();

/** Older companies are copied lazily by their first feed write; authorization never reads this row. */
export async function readCompanySyncVersion(ctx: QueryCtx, company: Doc<"companies">) {
  return (await findHead(ctx, company))?.version ?? company.syncVersion;
}

/** Called in the same transaction as feed inserts, preserving one ordered sequence per company. */
export async function writeCompanySyncVersion(
  ctx: MutationCtx,
  company: Doc<"companies">,
  version: number,
) {
  const head = await findHead(ctx, company);
  const previous = head?.version ?? company.syncVersion;
  if (version < previous) throw new Error("The company sync head cannot move backwards.");
  if (version === previous) return;
  if (head) await ctx.db.patch(head._id, { version });
  else await ctx.db.insert("companySyncHeads", { companyId: company._id, version });
}
