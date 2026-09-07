// @effect-diagnostics globalDate:off -- Convex provides deterministic transaction time without an Effect runtime.
/** Owner-only mailbox subscriptions and explicit user actions. */
import { v } from "convex/values";
import { mutation, query, internalMutation } from "./_generated/server.js";
import { internal } from "./_generated/api.js";
import { mailBrain, mailBucket } from "./lib/mailSchema.ts";
import {
  assertActive,
  mailOwner,
  ownedMailAccount,
  ownedMailMessage,
  mailAccount,
  mailScope,
  publicAccount,
  publicMessage,
  publicDraft,
  queueMailJob,
  disconnectMailAccount,
  queueMailBlobCleanup,
} from "./lib/mail.ts";
import { backendError } from "./lib/errors.ts";
import { mintDomainId } from "./lib/domainIds.ts";
const companyArg = { companyId: v.string() };

export const listAccounts = query({
  args: companyArg,
  handler: async (ctx, args) => {
    const actor = await mailOwner(ctx, args.companyId);
    const active = await ctx.db
      .query("mailAccounts")
      .withIndex("by_owner_status", (q) =>
        q
          .eq("companyId", actor.company._id)
          .eq("ownerMembershipId", actor.membership._id)
          .eq("status", "active"),
      )
      .take(50);
    const reconnect = await ctx.db
      .query("mailAccounts")
      .withIndex("by_owner_status", (q) =>
        q
          .eq("companyId", actor.company._id)
          .eq("ownerMembershipId", actor.membership._id)
          .eq("status", "reauth_required"),
      )
      .take(50);
    return [...active, ...reconnect].map(publicAccount);
  },
});
export const configureBrain = mutation({
  args: { ...companyArg, accountId: v.string(), brain: mailBrain },
  handler: async (ctx, args) => {
    const account = await ownedMailAccount(ctx, args.companyId, args.accountId);
    assertActive(account);
    for (const environmentId of [
      args.brain.primaryEnvironmentId,
      args.brain.backupEnvironmentId,
    ].filter((id): id is string => Boolean(id))) {
      const registration = await ctx.db
        .query("environmentRegistrations")
        .withIndex("by_company_and_environment", (q) =>
          q.eq("companyId", account.companyId).eq("environmentId", environmentId),
        )
        .unique();
      if (!registration || registration.state !== "active")
        throw backendError(
          "mail-environment-unavailable",
          "Choose an active environment in this workspace.",
        );
    }
    if (args.brain.backupEnvironmentId === args.brain.primaryEnvironmentId)
      throw backendError("invalid-mail-brain", "Backup must be a different environment.");
    await ctx.db.patch(account._id, {
      brain: args.brain,
      primaryEnvironmentId: args.brain.primaryEnvironmentId,
      backupEnvironmentId: args.brain.backupEnvironmentId,
      updatedAt: Date.now(),
    });
    return null;
  },
});
const pageArgs = {
  ...companyArg,
  accountId: v.optional(v.string()),
  bucket: v.optional(mailBucket),
  cursor: v.optional(v.string()),
  limit: v.optional(v.number()),
};
export const listMessages = query({
  args: pageArgs,
  handler: async (ctx, args) => {
    const actor = await mailOwner(ctx, args.companyId);
    if (args.accountId) await ownedMailAccount(ctx, args.companyId, args.accountId);
    const rows = args.accountId
      ? args.bucket
        ? ctx.db
            .query("mailMessages")
            .withIndex("by_account_bucket", (q) =>
              q.eq("accountId", args.accountId!).eq("bucket", args.bucket!),
            )
        : ctx.db
            .query("mailMessages")
            .withIndex("by_account_date", (q) => q.eq("accountId", args.accountId!))
      : args.bucket
        ? ctx.db
            .query("mailMessages")
            .withIndex("by_owner_bucket", (q) =>
              q
                .eq("companyId", actor.company._id)
                .eq("ownerMembershipId", actor.membership._id)
                .eq("bucket", args.bucket!),
            )
        : ctx.db
            .query("mailMessages")
            .withIndex("by_owner_date", (q) =>
              q.eq("companyId", actor.company._id).eq("ownerMembershipId", actor.membership._id),
            );
    const page = await rows.order("desc").paginate({
      cursor: args.cursor ?? null,
      numItems: Math.max(1, Math.min(100, Math.floor(args.limit ?? 50))),
    });
    return {
      messages: page.page.map(publicMessage),
      nextCursor: page.isDone ? null : page.continueCursor,
    };
  },
});
export const getThread = query({
  args: {
    ...companyArg,
    accountId: v.string(),
    providerThreadId: v.string(),
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await ownedMailAccount(ctx, args.companyId, args.accountId);
    const page = await ctx.db
      .query("mailMessages")
      .withIndex("by_thread", (q) =>
        q.eq("accountId", args.accountId).eq("providerThreadId", args.providerThreadId),
      )
      .order("desc")
      .paginate({
        cursor: args.cursor ?? null,
        numItems: Math.max(1, Math.min(100, Math.floor(args.limit ?? 50))),
      });
    return {
      messages: page.page.map(publicMessage),
      nextCursor: page.isDone ? null : page.continueCursor,
    };
  },
});
export const getMessage = query({
  args: { ...companyArg, messageId: v.string() },
  handler: async (ctx, args) => {
    const message = await ownedMailMessage(ctx, args.companyId, args.messageId);
    const body = await ctx.db
      .query("mailBodies")
      .withIndex("by_message", (q) => q.eq("messageId", message.id))
      .unique();
    return {
      ...publicMessage(message),
      ...(body
        ? {
            textBody: body.textBody,
            htmlBody: body.htmlBody,
            bodyBlobKey: body.bodyBlobKey,
            bodyTruncated: body.bodyTruncated ?? Boolean(body.bodyBlobKey),
          }
        : {}),
    };
  },
});
export const setBucket = mutation({
  args: { ...companyArg, messageId: v.string(), bucket: mailBucket },
  handler: async (ctx, args) => {
    const message = await ownedMailMessage(ctx, args.companyId, args.messageId);
    const account = await mailAccount(ctx, message.accountId);
    const now = Date.now();
    const patch = {
      bucket: args.bucket,
      reason: "You chose this bucket for this sender.",
      classificationRevision: message.classificationRevision + 1,
      briefing: undefined,
      analysisStatus: args.bucket === "priority" ? ("pending" as const) : ("ready" as const),
      updatedAt: now,
    };
    await ctx.db.patch(message._id, patch);
    const email = message.from.email.toLowerCase();
    const rule = await ctx.db
      .query("mailSenderRules")
      .withIndex("by_sender", (q) => q.eq("accountId", account.id).eq("email", email))
      .unique();
    if (rule) await ctx.db.patch(rule._id, { bucket: args.bucket, updatedAt: now });
    else
      await ctx.db.insert("mailSenderRules", {
        ...mailScope(account),
        accountId: account.id,
        email,
        bucket: args.bucket,
        updatedAt: now,
      });
    if (args.bucket === "priority")
      await queueMailJob(
        ctx,
        account,
        { ...message, classificationRevision: patch.classificationRevision, bucket: patch.bucket },
        "brief",
      );
    return null;
  },
});
export const setRead = mutation({
  args: { ...companyArg, messageId: v.string(), read: v.boolean() },
  handler: async (ctx, args) => {
    const message = await ownedMailMessage(ctx, args.companyId, args.messageId);
    const now = Date.now();
    await ctx.db.patch(message._id, { read: args.read, updatedAt: now });
    const pending = await ctx.db
      .query("mailLabelUpdates")
      .withIndex("by_message", (q) => q.eq("messageId", message.id))
      .unique();
    if (pending)
      await ctx.db.patch(pending._id, {
        read: args.read,
        status: "pending",
        generation: pending.generation + 1,
        leaseToken: undefined,
        leaseExpiresAt: undefined,
        updatedAt: now,
      });
    else
      await ctx.db.insert("mailLabelUpdates", {
        id: mintDomainId(now),
        accountId: message.accountId,
        messageId: message.id,
        providerMessageId: message.providerMessageId,
        read: args.read,
        status: "pending",
        generation: 0,
        updatedAt: now,
      });
    const account = await mailAccount(ctx, message.accountId);
    await ctx.db.patch(account._id, { nextSyncAt: 0 });
    return null;
  },
});
export const getSender = query({
  args: { ...companyArg, accountId: v.string(), email: v.string() },
  handler: async (ctx, args) => {
    await ownedMailAccount(ctx, args.companyId, args.accountId);
    const sender = await ctx.db
      .query("mailSenderKnowledge")
      .withIndex("by_sender", (q) =>
        q.eq("accountId", args.accountId).eq("email", args.email.toLowerCase()),
      )
      .unique();
    if (!sender) return null;
    return {
      accountId: sender.accountId,
      email: sender.email,
      name: sender.name,
      summary: sender.summary,
      messageCount: sender.messageCount,
      lastMessageAt: sender.lastMessageAt,
      updatedAt: sender.updatedAt,
    };
  },
});
export const listDrafts = query({
  args: { ...companyArg, accountId: v.string() },
  handler: async (ctx, args) => {
    await ownedMailAccount(ctx, args.companyId, args.accountId);
    return (
      await ctx.db
        .query("mailDrafts")
        .withIndex("by_account", (q) => q.eq("accountId", args.accountId))
        .order("desc")
        .take(100)
    ).map(publicDraft);
  },
});
export const saveDraft = mutation({
  args: {
    ...companyArg,
    accountId: v.string(),
    draftId: v.optional(v.string()),
    replyToMessageId: v.optional(v.string()),
    to: v.array(v.string()),
    subject: v.string(),
    text: v.string(),
  },
  handler: async (ctx, args) => {
    const account = await ownedMailAccount(ctx, args.companyId, args.accountId);
    assertActive(account);
    const now = Date.now();
    if (args.to.length > 100 || args.subject.length > 2000 || args.text.length > 200000)
      throw backendError("mail-too-large", "Draft exceeds the message size limit.");
    if (args.replyToMessageId) {
      const reply = await ownedMailMessage(ctx, args.companyId, args.replyToMessageId);
      if (reply.accountId !== account.id)
        throw backendError("invalid-mail-reply", "Reply must use the same mailbox.");
    }
    const fields = {
      to: args.to,
      subject: args.subject,
      text: args.text,
      ...(args.replyToMessageId ? { replyToMessageId: args.replyToMessageId } : {}),
      updatedAt: now,
    };
    if (args.draftId) {
      const draft = await ctx.db
        .query("mailDrafts")
        .withIndex("by_domain_id", (q) => q.eq("id", args.draftId!))
        .unique();
      if (!draft || draft.accountId !== account.id)
        throw backendError("mail-not-found", "Draft not found.");
      if (draft.status !== "draft" && draft.status !== "failed")
        throw backendError("mail-send-locked", "This draft has already been submitted.");
      await ctx.db.patch(draft._id, { ...fields, status: "draft", lastError: undefined });
      return draft.id;
    }
    const id = mintDomainId(now);
    await ctx.db.insert("mailDrafts", {
      ...mailScope(account),
      ...fields,
      id,
      accountId: account.id,
      status: "draft",
      generation: 0,
      createdAt: now,
    });
    return id;
  },
});
export const requestDraft = mutation({
  args: { ...companyArg, messageId: v.string(), instructions: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const message = await ownedMailMessage(ctx, args.companyId, args.messageId);
    const account = await mailAccount(ctx, message.accountId);
    assertActive(account);
    if (!account.brain)
      throw backendError("mail-brain-required", "Choose a mail analysis environment first.");
    return await queueMailJob(ctx, account, message, "draft", args.instructions?.slice(0, 10000));
  },
});
export const requestSend = mutation({
  args: { ...companyArg, draftId: v.string() },
  handler: async (ctx, args) => {
    const draft = await ctx.db
      .query("mailDrafts")
      .withIndex("by_domain_id", (q) => q.eq("id", args.draftId))
      .unique();
    if (!draft) throw backendError("mail-not-found", "Draft not found.");
    const account = await ownedMailAccount(ctx, args.companyId, draft.accountId);
    assertActive(account);
    if (draft.status !== "draft" && draft.status !== "failed")
      throw backendError(
        "mail-send-locked",
        "This message was already submitted. Check Gmail before sending an uncertain delivery again.",
      );
    if (
      draft.to.length === 0 ||
      draft.to.some((email) => !/^[^\s@<>\r\n]+@[^\s@<>\r\n]+\.[^\s@<>\r\n]+$/.test(email)) ||
      /[\r\n]/.test(draft.subject)
    )
      throw backendError(
        "invalid-mail-recipient",
        "Provide valid recipients and a single-line subject.",
      );
    await ctx.db.patch(draft._id, {
      status: "queued",
      lastError: undefined,
      updatedAt: Date.now(),
    });
    await ctx.db.patch(account._id, { nextSyncAt: 0 });
    return null;
  },
});
export const disconnectAccount = mutation({
  args: { ...companyArg, accountId: v.string() },
  handler: async (ctx, args) => {
    const account = await ownedMailAccount(ctx, args.companyId, args.accountId);
    await disconnectMailAccount(ctx, account);
    await ctx.scheduler.runAfter(0, internal.mail.purgeAccount, { accountId: account.id });
    return null;
  },
});
/** Bounded deletion batches keep disconnect safe for large mailboxes. */
export const purgeAccount = internalMutation({
  args: { accountId: v.string() },
  handler: async (ctx, args) => {
    const account = await mailAccount(ctx, args.accountId);
    if (account.status !== "disconnected") return;
    let more = false;
    for (const table of [
      "mailBodies",
      "mailSenderRules",
      "mailSenderKnowledge",
      "mailJobs",
      "mailDrafts",
      "mailLabelUpdates",
    ] as const) {
      const rows = await ctx.db
        .query(table)
        .withIndex("by_account", (q) => q.eq("accountId", args.accountId))
        .take(100);
      for (const row of rows) {
        if ("rawBlobKey" in row && row.rawBlobKey) await queueMailBlobCleanup(ctx, row.rawBlobKey);
        if ("bodyBlobKey" in row && row.bodyBlobKey)
          await queueMailBlobCleanup(ctx, row.bodyBlobKey);
        await ctx.db.delete(row._id);
      }
      more ||= rows.length === 100;
    }
    const messages = await ctx.db
      .query("mailMessages")
      .withIndex("by_account_date", (q) => q.eq("accountId", args.accountId))
      .take(100);
    for (const row of messages) {
      for (const attachment of row.attachments)
        if (attachment.blobKey) await queueMailBlobCleanup(ctx, attachment.blobKey);
      await ctx.db.delete(row._id);
    }
    more ||= messages.length === 100;
    if (more) await ctx.scheduler.runAfter(0, internal.mail.purgeAccount, args);
  },
});
export const retryAnalysis = mutation({
  args: { ...companyArg, messageId: v.string() },
  handler: async (ctx, args) => {
    const message = await ownedMailMessage(ctx, args.companyId, args.messageId);
    const account = await mailAccount(ctx, message.accountId);
    assertActive(account);
    if (!account.brain)
      throw backendError("mail-brain-required", "Choose a mail analysis environment first.");
    await ctx.db.patch(message._id, { analysisStatus: "pending", updatedAt: Date.now() });
    return await queueMailJob(
      ctx,
      account,
      message,
      message.bucket === "priority" ? "brief" : "analyze",
    );
  },
});
export const disableBrain = mutation({
  args: { ...companyArg, accountId: v.string() },
  handler: async (ctx, args) => {
    const account = await ownedMailAccount(ctx, args.companyId, args.accountId);
    await ctx.db.patch(account._id, {
      brain: undefined,
      primaryEnvironmentId: undefined,
      backupEnvironmentId: undefined,
      updatedAt: Date.now(),
    });
    return null;
  },
});
export const listSenderRules = query({
  args: { ...companyArg, accountId: v.string() },
  handler: async (ctx, args) => {
    await ownedMailAccount(ctx, args.companyId, args.accountId);
    return (
      await ctx.db
        .query("mailSenderRules")
        .withIndex("by_account", (q) => q.eq("accountId", args.accountId))
        .take(200)
    ).map((rule) => ({ email: rule.email, bucket: rule.bucket, updatedAt: rule.updatedAt }));
  },
});
export const removeSenderRule = mutation({
  args: { ...companyArg, accountId: v.string(), email: v.string() },
  handler: async (ctx, args) => {
    await ownedMailAccount(ctx, args.companyId, args.accountId);
    const rule = await ctx.db
      .query("mailSenderRules")
      .withIndex("by_sender", (q) =>
        q.eq("accountId", args.accountId).eq("email", args.email.toLowerCase()),
      )
      .unique();
    if (rule) await ctx.db.delete(rule._id);
    return null;
  },
});
