// @effect-diagnostics globalDate:off -- Convex provides deterministic transaction time without an Effect runtime.
/** Gmail ingestion and delivery persistence, callable only by the hosted relay. */
import { v } from "convex/values";
import { internal } from "./_generated/api.js";
import { mutation, query } from "./_generated/server.js";
import type { Doc } from "./_generated/dataModel.js";
import type { MutationCtx, QueryCtx } from "./_generated/server.js";
import { requireRelayControlPlane } from "./lib/relayIdentity.ts";
import {
  mailAccount,
  mailScope,
  queueMailJob,
  assertActive,
  disconnectMailAccount,
  queueMailBlobCleanup,
} from "./lib/mail.ts";
import { mailIntakeMessage } from "./lib/mailSchema.ts";
import { backendError } from "./lib/errors.ts";
import { mintDomainId } from "./lib/domainIds.ts";
const fence = { accountId: v.string(), leaseToken: v.string(), generation: v.number() };
const continuation = v.object({
  mode: v.union(v.literal("backfill"), v.literal("history")),
  pageToken: v.string(),
  baselineCursor: v.string(),
  messageOffset: v.optional(v.number()),
  deletedOffset: v.optional(v.number()),
});
async function relayAccount(ctx: QueryCtx, accountId: string) {
  const account = await mailAccount(ctx, accountId);
  const credentials = await ctx.db
    .query("mailCredentials")
    .withIndex("by_account", (q) => q.eq("accountId", accountId))
    .unique();
  const company = await ctx.db.get(account.companyId);
  return {
    ...account,
    companyId: company?.id ?? "",
    encryptedCredentials: credentials?.encryptedCredentials ?? "",
  };
}
async function ownerAvailable(ctx: QueryCtx, account: Doc<"mailAccounts">) {
  const company = await ctx.db.get(account.companyId);
  const membership = await ctx.db.get(account.ownerMembershipId);
  return company?.lifecycleState === "active" && membership?.state === "active";
}
async function retireUnavailable(ctx: MutationCtx, account: Doc<"mailAccounts">) {
  if (await ownerAvailable(ctx, account)) return false;
  if (account.status !== "disconnected") {
    await disconnectMailAccount(ctx, account);
    await ctx.scheduler.runAfter(0, internal.mail.purgeAccount, { accountId: account.id });
  }
  return true;
}
async function syncFence(
  ctx: QueryCtx,
  args: { accountId: string; leaseToken: string; generation: number },
) {
  await requireRelayControlPlane(ctx);
  const account = await mailAccount(ctx, args.accountId);
  assertActive(account);
  if (!(await ownerAvailable(ctx, account)))
    throw backendError(
      "mail-owner-unavailable",
      "Mailbox owner is no longer active in this workspace.",
    );
  if (
    account.leaseToken !== args.leaseToken ||
    account.generation !== args.generation ||
    (account.leaseExpiresAt ?? 0) <= Date.now()
  )
    throw backendError("mail-stale-lease", "This mailbox sync lease expired.");
  return account;
}
export const putOAuthState = mutation({
  args: { stateHash: v.string(), encryptedState: v.string(), expiresAt: v.number() },
  handler: async (ctx, args) => {
    await requireRelayControlPlane(ctx);
    if (args.expiresAt > Date.now() + 20 * 60_000)
      throw backendError("invalid-oauth-state", "OAuth state lifetime is too long.");
    const previous = await ctx.db
      .query("mailOAuthStates")
      .withIndex("by_hash", (q) => q.eq("stateHash", args.stateHash))
      .unique();
    if (previous) throw backendError("invalid-oauth-state", "OAuth state already exists.");
    await ctx.db.insert("mailOAuthStates", args);
    const expired = await ctx.db
      .query("mailOAuthStates")
      .withIndex("by_expiry", (q) => q.lt("expiresAt", Date.now()))
      .take(50);
    for (const row of expired) await ctx.db.delete(row._id);
    return null;
  },
});
export const consumeOAuthState = mutation({
  args: { stateHash: v.string() },
  handler: async (ctx, args) => {
    await requireRelayControlPlane(ctx);
    const row = await ctx.db
      .query("mailOAuthStates")
      .withIndex("by_hash", (q) => q.eq("stateHash", args.stateHash))
      .unique();
    if (!row) return null;
    await ctx.db.delete(row._id);
    return row.expiresAt > Date.now() ? row.encryptedState : null;
  },
});
export const connectAccount = mutation({
  args: {
    ownerSubject: v.string(),
    companyId: v.string(),
    email: v.string(),
    encryptedCredentials: v.string(),
    credentialSource: v.union(v.literal("byo"), v.literal("hosted")),
  },
  handler: async (ctx, args) => {
    await requireRelayControlPlane(ctx);
    const now = Date.now();
    const company = await ctx.db
      .query("companies")
      .withIndex("by_domain_id", (q) => q.eq("id", args.companyId))
      .unique();
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerk_subject", (q) => q.eq("clerkSubject", args.ownerSubject))
      .unique();
    if (!company || !user || company.lifecycleState !== "active")
      throw backendError("permission-denied", "Workspace membership is required.");
    const membership = await ctx.db
      .query("memberships")
      .withIndex("by_company_and_user", (q) =>
        q.eq("companyId", company._id).eq("userId", user._id),
      )
      .unique();
    if (!membership || membership.state !== "active")
      throw backendError("permission-denied", "Active workspace membership is required.");
    const email = args.email.trim().toLowerCase();
    const sameEmail = await ctx.db
      .query("mailAccounts")
      .withIndex("by_email", (q) => q.eq("email", email))
      .take(100);
    for (const previous of sameEmail) {
      if (previous.ownerSubject !== args.ownerSubject || previous.status !== "disconnected")
        continue;
      const cleanup = await ctx.db
        .query("mailAccountCleanup")
        .withIndex("by_account", (q) => q.eq("accountId", previous.id))
        .unique();
      if (cleanup && (cleanup.leaseExpiresAt ?? 0) > now)
        throw backendError(
          "mail-disconnect-running",
          "Mailbox disconnect is finishing. Try connecting again shortly.",
        );
    }
    const matches = await ctx.db
      .query("mailAccounts")
      .withIndex("by_owner_email", (q) =>
        q.eq("companyId", company._id).eq("ownerMembershipId", membership._id).eq("email", email),
      )
      .order("desc")
      .take(100);
    const existing = matches.find((a) => a.status !== "disconnected");
    const id = existing?.id ?? mintDomainId(now);
    const fields = {
      email,
      credentialSource: args.credentialSource,
      status: "active" as const,
      nextSyncAt: 0,
      updatedAt: now,
    };
    if (existing)
      await ctx.db.patch(existing._id, {
        ...fields,
        lastError: undefined,
        generation: existing.generation + 1,
        leaseToken: undefined,
        leaseExpiresAt: undefined,
      });
    else
      await ctx.db.insert("mailAccounts", {
        ...fields,
        id,
        companyId: company._id,
        ownerMembershipId: membership._id,
        ownerSubject: args.ownerSubject,
        generation: 0,
        lastClaimAt: 0,
        lastAuthCheckAt: 0,
        createdAt: now,
      });
    const credential = await ctx.db
      .query("mailCredentials")
      .withIndex("by_account", (q) => q.eq("accountId", id))
      .unique();
    if (credential)
      await ctx.db.patch(credential._id, { encryptedCredentials: args.encryptedCredentials });
    else
      await ctx.db.insert("mailCredentials", {
        accountId: id,
        encryptedCredentials: args.encryptedCredentials,
      });
    return await relayAccount(ctx, id);
  },
});
export const dueAccounts = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    await requireRelayControlPlane(ctx);
    return await ctx.db
      .query("mailAccounts")
      .withIndex("by_due", (q) => q.eq("status", "active").lte("nextSyncAt", Date.now()))
      .take(Math.min(100, Math.max(1, args.limit ?? 50)));
  },
});
export const findByEmail = query({
  args: { email: v.string() },
  handler: async (ctx, args) => {
    await requireRelayControlPlane(ctx);
    return (
      await ctx.db
        .query("mailAccounts")
        .withIndex("by_email", (q) => q.eq("email", args.email.toLowerCase()))
        .take(100)
    ).filter((a) => a.status === "active");
  },
});
export const claimSync = mutation({
  args: { accountId: v.string(), leaseToken: v.string() },
  handler: async (ctx, args) => {
    await requireRelayControlPlane(ctx);
    const account = await mailAccount(ctx, args.accountId);
    if (await retireUnavailable(ctx, account)) return null;
    if (account.status !== "active" || (account.leaseExpiresAt ?? 0) > Date.now()) return null;
    await ctx.db.patch(account._id, {
      leaseToken: args.leaseToken,
      leaseExpiresAt: Date.now() + 120_000,
      generation: account.generation + 1,
    });
    return await relayAccount(ctx, args.accountId);
  },
});
export const renewSync = mutation({
  args: fence,
  handler: async (ctx, args) => {
    const account = await syncFence(ctx, args);
    await ctx.db.patch(account._id, { leaseExpiresAt: Date.now() + 120_000 });
    return true;
  },
});
export const ingestPage = mutation({
  args: { ...fence, messages: v.array(mailIntakeMessage), cursor: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const account = await syncFence(ctx, args);
    if (args.messages.length > 50)
      throw backendError("mail-page-too-large", "Ingest at most 50 messages at once.");
    const now = Date.now();
    let inserted = 0;
    for (const input of args.messages) {
      const existing = await ctx.db
        .query("mailMessages")
        .withIndex("by_provider", (q) =>
          q.eq("accountId", account.id).eq("providerMessageId", input.providerMessageId),
        )
        .unique();
      if (input.deleted) {
        if (existing) {
          const body = await ctx.db
            .query("mailBodies")
            .withIndex("by_message", (q) => q.eq("messageId", existing.id))
            .unique();
          if (body) {
            if (body.rawBlobKey) await queueMailBlobCleanup(ctx, body.rawBlobKey);
            if (body.bodyBlobKey) await queueMailBlobCleanup(ctx, body.bodyBlobKey);
            await ctx.db.delete(body._id);
          }
          for (const attachment of existing.attachments)
            if (attachment.blobKey) await queueMailBlobCleanup(ctx, attachment.blobKey);
          const jobs = await ctx.db
            .query("mailJobs")
            .withIndex("by_message", (q) => q.eq("messageId", existing.id))
            .take(100);
          for (const job of jobs) await ctx.db.delete(job._id);
          await ctx.db.delete(existing._id);
        }
        continue;
      }
      const { textBody, htmlBody, rawBlobKey, bodyBlobKey, bodyTruncated, deleted, ...metadata } =
        input;
      void deleted;
      if ((textBody?.length ?? 0) + (htmlBody?.length ?? 0) > 300000)
        throw backendError(
          "mail-body-too-large",
          "Store large mail content in private blob storage.",
        );
      if (existing) {
        const pending = await ctx.db
          .query("mailLabelUpdates")
          .withIndex("by_message", (q) => q.eq("messageId", existing.id))
          .unique();
        await ctx.db.patch(existing._id, {
          labels: input.labels,
          read: pending?.read ?? !input.labels.includes("UNREAD"),
          historyId: input.historyId,
          updatedAt: now,
        });
        if (
          pending?.status === "awaiting_sync" &&
          pending.read === !input.labels.includes("UNREAD")
        )
          await ctx.db.delete(pending._id);
        continue;
      }
      for (const key of [rawBlobKey, bodyBlobKey, ...input.attachments.map((a) => a.blobKey)]) {
        if (!key) continue;
        const reservation = await ctx.db
          .query("mailBlobCleanup")
          .withIndex("by_blob", (q) => q.eq("blobKey", key))
          .unique();
        if (!reservation || (reservation.leaseExpiresAt ?? 0) > now)
          throw backendError(
            "mail-blob-reservation-expired",
            "Private mail upload expired. Upload it again before ingestion.",
          );
      }
      const email = input.from.email.toLowerCase();
      const rule = await ctx.db
        .query("mailSenderRules")
        .withIndex("by_sender", (q) => q.eq("accountId", account.id).eq("email", email))
        .unique();
      const id = mintDomainId(now);
      const bucket = rule?.bucket ?? "noise";
      const messageId = await ctx.db.insert("mailMessages", {
        ...mailScope(account),
        ...metadata,
        id,
        accountId: account.id,
        from: { ...input.from, email },
        read: !input.labels.includes("UNREAD"),
        bucket,
        reason: rule ? "Your sender rule." : "Waiting for your mail analysis environment.",
        analysisStatus: "pending",
        classificationRevision: 0,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("mailBodies", {
        accountId: account.id,
        messageId: id,
        ...(textBody !== undefined ? { textBody } : {}),
        ...(htmlBody !== undefined ? { htmlBody } : {}),
        ...(rawBlobKey ? { rawBlobKey } : {}),
        ...(bodyBlobKey ? { bodyBlobKey } : {}),
        ...(bodyTruncated !== undefined ? { bodyTruncated } : {}),
      });
      for (const key of [rawBlobKey, bodyBlobKey, ...input.attachments.map((a) => a.blobKey)]) {
        if (!key) continue;
        const pending = await ctx.db
          .query("mailBlobCleanup")
          .withIndex("by_blob", (q) => q.eq("blobKey", key))
          .unique();
        if (pending) await ctx.db.delete(pending._id);
      }
      const sender = await ctx.db
        .query("mailSenderKnowledge")
        .withIndex("by_sender", (q) => q.eq("accountId", account.id).eq("email", email))
        .unique();
      if (sender)
        await ctx.db.patch(sender._id, {
          messageCount: sender.messageCount + 1,
          lastMessageAt: Math.max(sender.lastMessageAt, input.receivedAt),
          updatedAt: now,
        });
      else
        await ctx.db.insert("mailSenderKnowledge", {
          ...mailScope(account),
          accountId: account.id,
          email,
          ...(input.from.name ? { name: input.from.name } : {}),
          summary: "",
          messageCount: 1,
          lastMessageAt: input.receivedAt,
          updatedAt: now,
        });
      const message = await ctx.db.get(messageId);
      if (message) await queueMailJob(ctx, account, message, "analyze");
      inserted++;
    }
    // Cursor publication belongs to finishSync after every page has committed.
    return { inserted };
  },
});
export const finishSync = mutation({
  args: {
    ...fence,
    cursor: v.optional(v.string()),
    continuation: v.optional(continuation),
    watchExpiresAt: v.optional(v.number()),
    watchError: v.optional(v.string()),
    nextSyncAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const account = await syncFence(ctx, args);
    await ctx.db.patch(account._id, {
      ...(args.cursor ? { cursor: args.cursor } : {}),
      continuation: args.continuation,
      ...(args.watchExpiresAt ? { watchExpiresAt: args.watchExpiresAt } : {}),
      lastSyncAt: Date.now(),
      lastError: args.watchError?.slice(0, 500),
      nextSyncAt: args.nextSyncAt ?? Date.now() + 300_000,
      leaseToken: undefined,
      leaseExpiresAt: undefined,
      updatedAt: Date.now(),
    });
    return true;
  },
});
export const failSync = mutation({
  args: { ...fence, error: v.string(), needsReauth: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const account = await syncFence(ctx, args);
    await ctx.db.patch(account._id, {
      status: args.needsReauth ? "reauth_required" : "active",
      lastError: args.error.slice(0, 500),
      nextSyncAt: Date.now() + 300_000,
      leaseToken: undefined,
      leaseExpiresAt: undefined,
      updatedAt: Date.now(),
    });
    return true;
  },
});
export const knownMessages = query({
  args: { accountId: v.string(), providerMessageIds: v.array(v.string()) },
  handler: async (ctx, args) => {
    await requireRelayControlPlane(ctx);
    if (args.providerMessageIds.length > 100)
      throw backendError("mail-page-too-large", "Request at most 100 message ids.");
    const found = [];
    for (const id of args.providerMessageIds) {
      const message = await ctx.db
        .query("mailMessages")
        .withIndex("by_provider", (q) =>
          q.eq("accountId", args.accountId).eq("providerMessageId", id),
        )
        .unique();
      if (!message) continue;
      const body = await ctx.db
        .query("mailBodies")
        .withIndex("by_message", (q) => q.eq("messageId", message.id))
        .unique();
      found.push({
        providerMessageId: id,
        historyId: message.historyId,
        rawBlobKey: body?.rawBlobKey,
      });
    }
    return found;
  },
});
export const deleteMessages = mutation({
  args: { ...fence, providerMessageIds: v.array(v.string()) },
  handler: async (ctx, args) => {
    await syncFence(ctx, args);
    if (args.providerMessageIds.length > 100)
      throw backendError("mail-page-too-large", "Delete at most 100 messages at once.");
    for (const id of args.providerMessageIds) {
      const message = await ctx.db
        .query("mailMessages")
        .withIndex("by_provider", (q) =>
          q.eq("accountId", args.accountId).eq("providerMessageId", id),
        )
        .unique();
      if (!message) continue;
      const body = await ctx.db
        .query("mailBodies")
        .withIndex("by_message", (q) => q.eq("messageId", message.id))
        .unique();
      if (body) {
        if (body.rawBlobKey) await queueMailBlobCleanup(ctx, body.rawBlobKey);
        if (body.bodyBlobKey) await queueMailBlobCleanup(ctx, body.bodyBlobKey);
        await ctx.db.delete(body._id);
      }
      const jobs = await ctx.db
        .query("mailJobs")
        .withIndex("by_message", (q) => q.eq("messageId", message.id))
        .take(100);
      for (const job of jobs) await ctx.db.delete(job._id);
      for (const attachment of message.attachments)
        if (attachment.blobKey) await queueMailBlobCleanup(ctx, attachment.blobKey);
      await ctx.db.delete(message._id);
    }
    return null;
  },
});
export const getOwnedBlob = query({
  args: {
    ownerSubject: v.string(),
    companyId: v.string(),
    messageId: v.string(),
    blobKey: v.string(),
  },
  handler: async (ctx, args) => {
    await requireRelayControlPlane(ctx);
    const message = await ctx.db
      .query("mailMessages")
      .withIndex("by_domain_id", (q) => q.eq("id", args.messageId))
      .unique();
    if (!message || message.ownerSubject !== args.ownerSubject) return null;
    const account = await mailAccount(ctx, message.accountId);
    if (account.status === "disconnected") return null;
    const company = await ctx.db.get(message.companyId);
    const member = await ctx.db.get(message.ownerMembershipId);
    if (
      company?.id !== args.companyId ||
      company.lifecycleState !== "active" ||
      member?.state !== "active"
    )
      return null;
    const body = await ctx.db
      .query("mailBodies")
      .withIndex("by_message", (q) => q.eq("messageId", message.id))
      .unique();
    const allowed =
      body?.rawBlobKey === args.blobKey ||
      body?.bodyBlobKey === args.blobKey ||
      message.attachments.some((a) => a.blobKey === args.blobKey);
    return allowed ? { blobKey: args.blobKey } : null;
  },
});
export const claimOutbox = mutation({
  args: { accountId: v.string(), leaseToken: v.string() },
  handler: async (ctx, args) => {
    await requireRelayControlPlane(ctx);
    const account = await mailAccount(ctx, args.accountId);
    if ((await retireUnavailable(ctx, account)) || account.status !== "active") return null;
    const sending = await ctx.db
      .query("mailDrafts")
      .withIndex("by_outbox", (q) => q.eq("accountId", account.id).eq("status", "sending"))
      .take(100);
    for (const draft of sending) {
      if ((draft.leaseExpiresAt ?? 0) <= Date.now())
        await ctx.db.patch(draft._id, {
          status: "unknown",
          lastError: "Delivery interrupted. Check Gmail Sent before sending another copy.",
          updatedAt: Date.now(),
        });
    }
    const draft = await ctx.db
      .query("mailDrafts")
      .withIndex("by_outbox", (q) => q.eq("accountId", account.id).eq("status", "queued"))
      .first();
    if (!draft) return null;
    const generation = draft.generation + 1;
    await ctx.db.patch(draft._id, {
      status: "sending",
      generation,
      leaseToken: args.leaseToken,
      leaseExpiresAt: Date.now() + 120_000,
      updatedAt: Date.now(),
    });
    const reply = draft.replyToMessageId
      ? await ctx.db
          .query("mailMessages")
          .withIndex("by_domain_id", (q) => q.eq("id", draft.replyToMessageId!))
          .unique()
      : null;
    return {
      ...draft,
      status: "sending" as const,
      generation,
      leaseToken: args.leaseToken,
      ...(reply
        ? {
            replyToProviderMessageId: reply.providerMessageId,
            replyToProviderThreadId: reply.providerThreadId,
          }
        : {}),
    };
  },
});
export const finishOutbox = mutation({
  args: {
    draftId: v.string(),
    leaseToken: v.string(),
    generation: v.number(),
    status: v.union(v.literal("sent"), v.literal("failed"), v.literal("unknown")),
    providerMessageId: v.optional(v.string()),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireRelayControlPlane(ctx);
    const draft = await ctx.db
      .query("mailDrafts")
      .withIndex("by_domain_id", (q) => q.eq("id", args.draftId))
      .unique();
    if (
      !draft ||
      draft.status !== "sending" ||
      draft.generation !== args.generation ||
      draft.leaseToken !== args.leaseToken ||
      (draft.leaseExpiresAt ?? 0) <= Date.now()
    )
      return false;
    const account = await mailAccount(ctx, draft.accountId);
    if (account.status !== "active") return false;
    await ctx.db.patch(draft._id, {
      status: args.status,
      ...(args.providerMessageId ? { providerMessageId: args.providerMessageId } : {}),
      ...(args.error ? { lastError: args.error.slice(0, 500) } : {}),
      leaseToken: undefined,
      leaseExpiresAt: undefined,
      updatedAt: Date.now(),
    });
    return true;
  },
});
async function relayOwner(ctx: QueryCtx, ownerSubject: string, companyId: string) {
  const company = await ctx.db
    .query("companies")
    .withIndex("by_domain_id", (q) => q.eq("id", companyId))
    .unique();
  const user = await ctx.db
    .query("users")
    .withIndex("by_clerk_subject", (q) => q.eq("clerkSubject", ownerSubject))
    .unique();
  if (!company || !user || company.lifecycleState !== "active")
    throw backendError("permission-denied", "Active workspace membership is required.");
  const membership = await ctx.db
    .query("memberships")
    .withIndex("by_company_and_user", (q) => q.eq("companyId", company._id).eq("userId", user._id))
    .unique();
  if (!membership || membership.state !== "active")
    throw backendError("permission-denied", "Active workspace membership is required.");
  return { company, membership };
}
export const assertOwner = query({
  args: { ownerSubject: v.string(), companyId: v.string() },
  handler: async (ctx, args) => {
    await requireRelayControlPlane(ctx);
    await relayOwner(ctx, args.ownerSubject, args.companyId);
    return true;
  },
});
export const getOwnedAccount = query({
  args: { ownerSubject: v.string(), companyId: v.string(), accountId: v.string() },
  handler: async (ctx, args) => {
    await requireRelayControlPlane(ctx);
    const owner = await relayOwner(ctx, args.ownerSubject, args.companyId);
    const account = await mailAccount(ctx, args.accountId);
    if (
      account.companyId !== owner.company._id ||
      account.ownerMembershipId !== owner.membership._id
    )
      throw backendError("permission-denied", "This mailbox belongs to another member.");
    return await relayAccount(ctx, account.id);
  },
});
export const disconnectAccount = mutation({
  args: { ownerSubject: v.string(), companyId: v.string(), accountId: v.string() },
  handler: async (ctx, args) => {
    await requireRelayControlPlane(ctx);
    const owner = await relayOwner(ctx, args.ownerSubject, args.companyId);
    const account = await mailAccount(ctx, args.accountId);
    if (
      account.companyId !== owner.company._id ||
      account.ownerMembershipId !== owner.membership._id
    )
      throw backendError("permission-denied", "This mailbox belongs to another member.");
    await disconnectMailAccount(ctx, account);
    await ctx.scheduler.runAfter(0, internal.mail.purgeAccount, { accountId: account.id });
    return null;
  },
});
export const registerBlobCleanup = mutation({
  args: { blobKeys: v.array(v.string()) },
  handler: async (ctx, args) => {
    await requireRelayControlPlane(ctx);
    if (args.blobKeys.length > 100)
      throw backendError("mail-page-too-large", "Register at most 100 blobs.");
    for (const key of args.blobKeys) await queueMailBlobCleanup(ctx, key, Date.now() + 60 * 60_000);
    return null;
  },
});
export const claimBlobCleanup = mutation({
  args: { leaseToken: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    await requireRelayControlPlane(ctx);
    const rows = await ctx.db
      .query("mailBlobCleanup")
      .withIndex("by_due", (q) => q.lte("dueAt", Date.now()))
      .take(Math.max(1, Math.min(100, args.limit ?? 50)));
    const result = [];
    for (const row of rows) {
      if ((row.leaseExpiresAt ?? 0) > Date.now()) continue;
      const generation = row.generation + 1;
      await ctx.db.patch(row._id, {
        generation,
        leaseToken: args.leaseToken,
        leaseExpiresAt: Date.now() + 120_000,
        dueAt: Date.now() + 120_000,
      });
      result.push({ id: row.id, blobKeys: [row.blobKey], generation });
    }
    return result;
  },
});
export const finishBlobCleanup = mutation({
  args: { id: v.string(), leaseToken: v.string(), generation: v.number() },
  handler: async (ctx, args) => {
    await requireRelayControlPlane(ctx);
    const row = await ctx.db
      .query("mailBlobCleanup")
      .withIndex("by_domain_id", (q) => q.eq("id", args.id))
      .unique();
    if (!row || row.leaseToken !== args.leaseToken || row.generation !== args.generation)
      return false;
    await ctx.db.delete(row._id);
    return true;
  },
});
export const claimAccountCleanup = mutation({
  args: { leaseToken: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    await requireRelayControlPlane(ctx);
    const rows = await ctx.db
      .query("mailAccountCleanup")
      .withIndex("by_due", (q) => q.lte("dueAt", Date.now()))
      .take(Math.max(1, Math.min(100, args.limit ?? 50)));
    const result = [];
    for (const row of rows) {
      if ((row.leaseExpiresAt ?? 0) > Date.now()) continue;
      const account = await mailAccount(ctx, row.accountId);
      const matchingAccounts = await ctx.db
        .query("mailAccounts")
        .withIndex("by_email", (q) => q.eq("email", account.email))
        .take(100);
      const revoke = !matchingAccounts.some(
        (a) =>
          a.id !== account.id &&
          a.ownerSubject === account.ownerSubject &&
          a.status !== "disconnected",
      );
      const generation = row.generation + 1;
      await ctx.db.patch(row._id, {
        generation,
        leaseToken: args.leaseToken,
        leaseExpiresAt: Date.now() + 120_000,
        dueAt: Date.now() + 120_000,
      });
      result.push({
        id: row.id,
        accountId: row.accountId,
        ownerSubject: account.ownerSubject,
        email: account.email,
        encryptedCredentials: row.encryptedCredentials,
        generation,
        revoke,
      });
    }
    return result;
  },
});
export const finishAccountCleanup = mutation({
  args: { id: v.string(), leaseToken: v.string(), generation: v.number() },
  handler: async (ctx, args) => {
    await requireRelayControlPlane(ctx);
    const row = await ctx.db
      .query("mailAccountCleanup")
      .withIndex("by_domain_id", (q) => q.eq("id", args.id))
      .unique();
    if (!row || row.leaseToken !== args.leaseToken || row.generation !== args.generation)
      return false;
    const credential = await ctx.db
      .query("mailCredentials")
      .withIndex("by_account", (q) => q.eq("accountId", row.accountId))
      .unique();
    if (credential) await ctx.db.delete(credential._id);
    await ctx.db.delete(row._id);
    return true;
  },
});
export const claimLabelUpdates = mutation({
  args: { accountId: v.string(), leaseToken: v.string() },
  handler: async (ctx, args) => {
    await requireRelayControlPlane(ctx);
    const account = await mailAccount(ctx, args.accountId);
    if ((await retireUnavailable(ctx, account)) || account.status !== "active") return [];
    const pending = await ctx.db
      .query("mailLabelUpdates")
      .withIndex("by_account_status", (q) =>
        q.eq("accountId", args.accountId).eq("status", "pending"),
      )
      .take(10);
    const running = await ctx.db
      .query("mailLabelUpdates")
      .withIndex("by_account_status", (q) =>
        q.eq("accountId", args.accountId).eq("status", "running"),
      )
      .take(10);
    const rows = [
      ...running.filter((row) => (row.leaseExpiresAt ?? 0) <= Date.now()),
      ...pending,
    ].slice(0, 10);
    const result = [];
    for (const row of rows) {
      if (
        row.status === "awaiting_sync" ||
        (row.status === "running" && (row.leaseExpiresAt ?? 0) > Date.now())
      )
        continue;
      const generation = row.generation + 1;
      await ctx.db.patch(row._id, {
        status: "running",
        generation,
        leaseToken: args.leaseToken,
        leaseExpiresAt: Date.now() + 120_000,
      });
      result.push({
        id: row.id,
        providerMessageId: row.providerMessageId,
        read: row.read,
        generation,
      });
    }
    return result;
  },
});
export const finishLabelUpdate = mutation({
  args: {
    id: v.string(),
    leaseToken: v.string(),
    generation: v.number(),
    success: v.boolean(),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireRelayControlPlane(ctx);
    const row = await ctx.db
      .query("mailLabelUpdates")
      .withIndex("by_domain_id", (q) => q.eq("id", args.id))
      .unique();
    if (
      !row ||
      row.status !== "running" ||
      row.generation !== args.generation ||
      row.leaseToken !== args.leaseToken ||
      (row.leaseExpiresAt ?? 0) <= Date.now()
    )
      return false;
    if (args.success)
      await ctx.db.patch(row._id, {
        status: "awaiting_sync",
        leaseToken: undefined,
        leaseExpiresAt: undefined,
        updatedAt: Date.now(),
      });
    else
      await ctx.db.patch(row._id, {
        status: "pending",
        leaseToken: undefined,
        leaseExpiresAt: undefined,
        lastError: args.error?.slice(0, 500),
        updatedAt: Date.now(),
      });
    return true;
  },
});

export const sweepUnavailableAccounts = mutation({
  args: {},
  handler: async (ctx) => {
    await requireRelayControlPlane(ctx);
    const accounts = await ctx.db.query("mailAccounts").withIndex("by_auth_check").take(50);
    let retired = 0;
    for (const account of accounts) {
      await ctx.db.patch(account._id, { lastAuthCheckAt: Date.now() });
      if (await retireUnavailable(ctx, account)) retired++;
    }
    return retired;
  },
});
