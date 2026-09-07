// @effect-diagnostics globalDate:off -- Convex provides deterministic transaction time without an Effect runtime.
/** Fenced, renewable analysis work on the mailbox owner's selected environments. */
import { v } from "convex/values";
import { mutation } from "./_generated/server.js";
import type { MutationCtx, QueryCtx } from "./_generated/server.js";
import type { Doc } from "./_generated/dataModel.js";
import { requireCompanyActor } from "./lib/identity.ts";
import { mailAccount, mailScope } from "./lib/mail.ts";
import { mailBucket } from "./lib/mailSchema.ts";
import { backendError } from "./lib/errors.ts";
import { mintDomainId } from "./lib/domainIds.ts";
const LEASE_MS = 90_000;
const jobArgs = { companyId: v.string(), jobId: v.string(), generation: v.number() };
async function environmentActor(ctx: QueryCtx, companyId: string) {
  const actor = await requireCompanyActor(ctx, companyId);
  if (actor.kind !== "environment")
    throw backendError(
      "permission-denied",
      "Only an authorized environment can run mail analysis.",
    );
  return actor;
}
async function eligible(
  ctx: QueryCtx,
  account: Doc<"mailAccounts">,
  environmentId: string,
  createdAt: number,
) {
  if (account.status !== "active" || !account.brain) return false;
  const membership = await ctx.db.get(account.ownerMembershipId);
  if (membership?.state !== "active") return false;
  if (account.brain.primaryEnvironmentId === environmentId) return true;
  if (account.brain.backupEnvironmentId !== environmentId) return false;
  const primary = await ctx.db
    .query("environmentRegistrations")
    .withIndex("by_company_and_environment", (q) =>
      q.eq("companyId", account.companyId).eq("environmentId", account.brain!.primaryEnvironmentId),
    )
    .unique();
  return (
    !primary ||
    primary.state !== "active" ||
    (primary.lastSeenAt ?? 0) < Date.now() - LEASE_MS ||
    createdAt < Date.now() - LEASE_MS
  );
}
async function currentClaim(
  ctx: MutationCtx,
  args: { companyId: string; jobId: string; generation: number },
) {
  const actor = await environmentActor(ctx, args.companyId);
  const job = await ctx.db
    .query("mailJobs")
    .withIndex("by_domain_id", (q) => q.eq("id", args.jobId))
    .unique();
  if (
    !job ||
    job.companyId !== actor.company._id ||
    job.status !== "running" ||
    job.generation !== args.generation ||
    job.claimedByEnvironmentId !== actor.registration.environmentId ||
    (job.leaseExpiresAt ?? 0) <= Date.now()
  )
    return null;
  const account = await mailAccount(ctx, job.accountId);
  if (
    account.status !== "active" ||
    !account.brain ||
    ![account.brain.primaryEnvironmentId, account.brain.backupEnvironmentId].includes(
      actor.registration.environmentId,
    ) ||
    (await ctx.db.get(account.ownerMembershipId))?.state !== "active"
  )
    return null;
  return { job, account, actor };
}
export const claim = mutation({
  args: { companyId: v.string() },
  handler: async (ctx, args) => {
    const actor = await environmentActor(ctx, args.companyId);
    const environmentId = actor.registration.environmentId;
    const now = Date.now();
    const ownRunning = await ctx.db
      .query("mailJobs")
      .withIndex("by_claimant", (q) =>
        q
          .eq("companyId", actor.company._id)
          .eq("claimedByEnvironmentId", environmentId)
          .eq("status", "running"),
      )
      .take(100);
    if (ownRunning.some((j) => (j.leaseExpiresAt ?? 0) > now)) return null;
    const primaryAccounts = await ctx.db
      .query("mailAccounts")
      .withIndex("by_primary", (q) =>
        q.eq("companyId", actor.company._id).eq("primaryEnvironmentId", environmentId),
      )
      .take(25);
    const backupAccounts = await ctx.db
      .query("mailAccounts")
      .withIndex("by_backup", (q) =>
        q.eq("companyId", actor.company._id).eq("backupEnvironmentId", environmentId),
      )
      .take(25);
    for (const account of [...primaryAccounts, ...backupAccounts].sort(
      (a, b) => a.lastClaimAt - b.lastClaimAt,
    )) {
      await ctx.db.patch(account._id, { lastClaimAt: now });
      const running = await ctx.db
        .query("mailJobs")
        .withIndex("by_account_status", (q) =>
          q.eq("accountId", account.id).eq("status", "running"),
        )
        .take(25);
      // User-requested work must stay responsive while historical mail is being analyzed.
      const pendingByKind = await Promise.all(
        (["brief", "draft", "analyze"] as const).map((kind) =>
          ctx.db
            .query("mailJobs")
            .withIndex("by_account_status_kind", (q) =>
              q.eq("accountId", account.id).eq("status", "pending").eq("kind", kind),
            )
            .take(25),
        ),
      );
      const [briefings = [], drafts = [], analyses = []] = pendingByKind;
      const requested = [...briefings, ...drafts].sort((a, b) => a.createdAt - b.createdAt);
      for (const job of [
        ...running.filter((j) => (j.leaseExpiresAt ?? 0) <= now),
        ...requested,
        ...analyses,
      ]) {
        if (!(await eligible(ctx, account, environmentId, job.createdAt))) continue;
        const message = await ctx.db
          .query("mailMessages")
          .withIndex("by_domain_id", (q) => q.eq("id", job.messageId))
          .unique();
        if (!message || message.classificationRevision !== job.classificationRevision) {
          await ctx.db.patch(job._id, { status: "completed", updatedAt: now });
          continue;
        }
        if (job.attempts >= 3) {
          await ctx.db.patch(job._id, {
            status: "failed",
            lastError: "Analysis interrupted repeatedly. Retry when an environment is ready.",
            updatedAt: now,
          });
          await ctx.db.patch(message._id, { analysisStatus: "failed", updatedAt: now });
          continue;
        }
        const body = await ctx.db
          .query("mailBodies")
          .withIndex("by_message", (q) => q.eq("messageId", message.id))
          .unique();
        const sender = await ctx.db
          .query("mailSenderKnowledge")
          .withIndex("by_sender", (q) =>
            q.eq("accountId", account.id).eq("email", message.from.email),
          )
          .unique();
        const rule = await ctx.db
          .query("mailSenderRules")
          .withIndex("by_sender", (q) =>
            q.eq("accountId", account.id).eq("email", message.from.email),
          )
          .unique();
        const generation = job.generation + 1;
        await ctx.db.patch(job._id, {
          status: "running",
          generation,
          claimedByEnvironmentId: environmentId,
          leaseExpiresAt: now + LEASE_MS,
          attempts: job.attempts + 1,
          updatedAt: now,
        });
        const selection =
          environmentId === account.brain!.backupEnvironmentId
            ? (account.brain!.backupSelection ?? account.brain!.selection)
            : account.brain!.selection;
        return {
          id: job.id,
          generation,
          kind: job.kind,
          ...(rule ? { forcedBucket: rule.bucket } : {}),
          message: {
            from: message.from,
            to: message.to,
            subject: message.subject,
            snippet: message.snippet,
            bucket: message.bucket,
            reason: message.reason,
            bodyTruncated: body?.bodyTruncated === true || Boolean(body?.bodyBlobKey),
            ...(body?.textBody ? { textBody: body.textBody } : {}),
            ...(body?.htmlBody ? { htmlBody: body.htmlBody } : {}),
          },
          selection,
          senderKnowledge: sender ? { summary: sender.summary } : null,
          ...(job.instructions ? { instructions: job.instructions } : {}),
        };
      }
    }
    return null;
  },
});
export const renew = mutation({
  args: jobArgs,
  handler: async (ctx, args) => {
    const claim = await currentClaim(ctx, args);
    if (!claim) return false;
    await ctx.db.patch(claim.job._id, {
      leaseExpiresAt: Date.now() + LEASE_MS,
      updatedAt: Date.now(),
    });
    return true;
  },
});
export const complete = mutation({
  args: {
    ...jobArgs,
    result: v.object({
      bucket: mailBucket,
      reason: v.string(),
      briefing: v.optional(v.string()),
      senderSummary: v.optional(v.string()),
      draft: v.optional(
        v.object({ to: v.array(v.string()), subject: v.string(), text: v.string() }),
      ),
    }),
  },
  handler: async (ctx, args) => {
    const claim = await currentClaim(ctx, args);
    if (!claim) return false;
    const { job, account } = claim;
    const now = Date.now();
    const message = await ctx.db
      .query("mailMessages")
      .withIndex("by_domain_id", (q) => q.eq("id", job.messageId))
      .unique();
    if (!message || message.classificationRevision !== job.classificationRevision) {
      await ctx.db.patch(job._id, { status: "completed", updatedAt: now });
      return false;
    }
    if (
      !args.result.reason.trim() ||
      args.result.reason.length > 4000 ||
      (args.result.briefing?.length ?? 0) > 30000 ||
      (args.result.senderSummary?.length ?? 0) > 30000
    )
      throw backendError(
        "invalid-mail-analysis",
        "Mail analysis is missing a reason or exceeds its size limit.",
      );
    const rule = await ctx.db
      .query("mailSenderRules")
      .withIndex("by_sender", (q) => q.eq("accountId", account.id).eq("email", message.from.email))
      .unique();
    const bucket = job.kind === "analyze" ? (rule?.bucket ?? args.result.bucket) : message.bucket;
    if (job.kind === "draft") {
      const draft = args.result.draft;
      if (
        !draft ||
        draft.text.length > 200000 ||
        draft.subject.length > 2000 ||
        draft.to.length > 100
      )
        throw backendError(
          "invalid-mail-draft",
          "The environment did not produce a valid reply draft.",
        );
      await ctx.db.insert("mailDrafts", {
        ...mailScope(account),
        id: mintDomainId(now),
        accountId: account.id,
        replyToMessageId: message.id,
        to: [message.from.email],
        subject: draft.subject.replace(/[\r\n]/g, " "),
        text: draft.text,
        status: "draft",
        generation: 0,
        createdAt: now,
        updatedAt: now,
      });
    } else {
      if (bucket === "priority" && !args.result.briefing?.trim())
        throw backendError("invalid-mail-analysis", "Priority messages require a briefing.");
      await ctx.db.patch(message._id, {
        bucket,
        reason:
          job.kind === "brief" ? message.reason : rule ? "Your sender rule." : args.result.reason,
        briefing: bucket === "priority" ? args.result.briefing : undefined,
        analysisStatus: "ready",
        updatedAt: now,
      });
    }
    if (args.result.senderSummary) {
      const sender = await ctx.db
        .query("mailSenderKnowledge")
        .withIndex("by_sender", (q) =>
          q.eq("accountId", account.id).eq("email", message.from.email),
        )
        .unique();
      if (sender)
        await ctx.db.patch(sender._id, { summary: args.result.senderSummary, updatedAt: now });
    }
    await ctx.db.patch(job._id, { status: "completed", leaseExpiresAt: undefined, updatedAt: now });
    return true;
  },
});
export const fail = mutation({
  args: { ...jobArgs, error: v.string() },
  handler: async (ctx, args) => {
    const claim = await currentClaim(ctx, args);
    if (!claim) return false;
    await ctx.db.patch(claim.job._id, {
      status: "failed",
      lastError: args.error.slice(0, 500),
      leaseExpiresAt: undefined,
      updatedAt: Date.now(),
    });
    const message = await ctx.db
      .query("mailMessages")
      .withIndex("by_domain_id", (q) => q.eq("id", claim.job.messageId))
      .unique();
    if (
      message &&
      message.classificationRevision === claim.job.classificationRevision &&
      claim.job.kind !== "draft"
    )
      await ctx.db.patch(message._id, {
        analysisStatus: "failed",
        reason:
          message.reason === "Waiting for your mail analysis environment."
            ? "Analysis failed. Check the selected environment and retry."
            : message.reason,
        updatedAt: Date.now(),
      });
    return true;
  },
});
