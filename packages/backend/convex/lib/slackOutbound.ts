/** Transactional scheduling of company issue changes back to their owning Slack thread. */
import type { Doc } from "../_generated/dataModel.js";
import type { MutationCtx } from "../_generated/server.js";

function sourceIdentity(issue: Doc<"issues">): {
  integrationId: string;
  channelId: string;
  messageTs: string;
} | null {
  const source = issue.slackSource;
  if (typeof source !== "object" || source === null) return null;
  const value = source as Record<string, unknown>;
  return typeof value["integrationId"] === "string" &&
    typeof value["workspaceId"] === "string" &&
    typeof value["channelId"] === "string" &&
    typeof value["messageTs"] === "string"
    ? {
        integrationId: value["integrationId"],
        channelId: value["channelId"],
        messageTs: value["messageTs"],
      }
    : null;
}

export async function scheduleSlackOutbound(
  ctx: MutationCtx,
  company: Doc<"companies">,
  issue: Doc<"issues">,
  operationId: string,
  kind: "comment" | "status",
  text: string,
  now: number,
): Promise<void> {
  const source = sourceIdentity(issue);
  if (source === null) return;
  const integration = await ctx.db
    .query("slackIntegrations")
    .withIndex("by_company_and_domain_id", (q) =>
      q.eq("companyId", company._id).eq("id", source.integrationId),
    )
    .unique();
  if (integration === null || integration.state !== "active") return;
  const deliveryId = `issue-${kind}/${operationId}`.slice(0, 128);
  const existing = await ctx.db
    .query("slackOutboundDeliveries")
    .withIndex("by_integration_and_delivery", (q) =>
      q.eq("integrationId", integration._id).eq("deliveryId", deliveryId),
    )
    .unique();
  if (existing !== null) return;
  await ctx.db.insert("slackOutboundDeliveries", {
    companyId: company._id,
    integrationId: integration._id,
    deliveryId,
    channelId: source.channelId,
    threadTs: source.messageTs,
    kind,
    issueId: issue.id,
    text: text.trim().slice(0, 20_000),
    state: "pending",
    claimedByEnvironmentId: null,
    claimGeneration: 0,
    claimExpiresAt: null,
    slackMessageTs: null,
    createdAt: now,
    updatedAt: now,
  });
}
