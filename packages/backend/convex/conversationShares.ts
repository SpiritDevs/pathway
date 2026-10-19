// @effect-diagnostics globalDate:off -- Convex uses the transaction clock.
import { makeFunctionReference } from "convex/server";
import { v } from "convex/values";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import { CloudAgentThreadShell } from "@spiritdevs/contracts/cloudProject";

import {
  connectGrantExpiresAt,
  generateConnectGrantToken,
  hashConnectGrantToken,
} from "../src/connectGrants.ts";
import type { Doc, Id } from "./_generated/dataModel.js";
import {
  action,
  internalMutation,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server.js";
import { backendError } from "./lib/errors.ts";
import { isEnvironmentIdentity, requireIdentity, requireUser } from "./lib/identity.ts";

const access = v.union(v.literal("view"), v.literal("collaborate"));
const decodeCloudShell = Schema.decodeUnknownOption(CloudAgentThreadShell);
const encodeCloudShell = Schema.encodeSync(CloudAgentThreadShell);
const address = { environmentId: v.string(), threadId: v.string() };
const sessionResult = v.object({
  shareId: v.string(),
  environmentId: v.string(),
  threadId: v.string(),
  ownerUserId: v.string(),
  userId: v.string(),
  membershipId: v.string(),
  access,
  conversations: v.array(v.object({ threadId: v.string(), ownerUserId: v.string(), access })),
});
const shareResult = v.object({
  id: v.string(),
  companyId: v.string(),
  companyName: v.string(),
  recipientUserId: v.string(),
  recipientName: v.string(),
  access,
});

async function requireEnvironment(ctx: QueryCtx, environmentId: string) {
  const identity = await requireIdentity(ctx);
  if (!isEnvironmentIdentity(identity) || identity.subject !== environmentId) {
    throw backendError(
      "permission-denied",
      "Only the owning environment may publish conversations.",
    );
  }
}

async function conversationAt(ctx: QueryCtx, environmentId: string, threadId: string) {
  return await ctx.db
    .query("personalConversations")
    .withIndex("by_environment_and_thread", (q) =>
      q.eq("environmentId", environmentId).eq("threadId", threadId),
    )
    .unique();
}

async function ownedConversation(ctx: QueryCtx, environmentId: string, threadId: string) {
  const user = await requireUser(ctx);
  const row = await conversationAt(ctx, environmentId, threadId);
  if (row === null || row.ownerUserId !== user._id) {
    throw backendError("permission-denied", "Only the conversation owner may manage sharing.");
  }
  return row;
}

async function activeMembership(ctx: QueryCtx, companyId: Id<"companies">, userId: Id<"users">) {
  const member = await ctx.db
    .query("memberships")
    .withIndex("by_company_and_user", (q) => q.eq("companyId", companyId).eq("userId", userId))
    .unique();
  return member?.state === "active" ? member : null;
}

/** Recheck both memberships on discovery, connection, every operation, and every delivered event. */
export async function resolveConversationShare(ctx: QueryCtx, shareId: string) {
  const id = ctx.db.normalizeId("conversationShares", shareId);
  if (id === null) return null;
  const share = await ctx.db.get(id);
  if (share === null) return null;
  const [conversation, company, owner, recipient, ownerMember, recipientMember] = await Promise.all(
    [
      ctx.db.get(share.conversationId),
      ctx.db.get(share.companyId),
      ctx.db.get(share.ownerUserId),
      ctx.db.get(share.recipientUserId),
      activeMembership(ctx, share.companyId, share.ownerUserId),
      activeMembership(ctx, share.companyId, share.recipientUserId),
    ],
  );
  if (
    conversation === null ||
    conversation.ownerUserId !== share.ownerUserId ||
    company?.lifecycleState !== "active" ||
    owner === null ||
    recipient === null ||
    ownerMember === null ||
    recipientMember === null
  )
    return null;
  const link = await ctx.db
    .query("relayEnvironmentLinks")
    .withIndex("by_user_and_environment", (q) =>
      q.eq("userId", owner.clerkSubject).eq("environmentId", conversation.environmentId),
    )
    .unique();
  if (link === null || link.revokedAt !== null) return null;
  return {
    share,
    conversation,
    company,
    owner,
    recipient,
    session: {
      shareId: share._id,
      environmentId: conversation.environmentId,
      threadId: conversation.threadId,
      ownerUserId: owner.clerkSubject,
      userId: recipient.clerkSubject,
      membershipId: recipientMember.id,
      access: share.access,
    },
  };
}

async function removeConversation(ctx: MutationCtx, row: Doc<"personalConversations">) {
  const shares = await ctx.db
    .query("conversationShares")
    .withIndex("by_conversation", (q) => q.eq("conversationId", row._id))
    .collect();
  for (const share of shares) await ctx.db.delete(share._id);
  await ctx.db.delete(row._id);
}

/** Only an environment can register a real thread; a recipient cannot claim an arbitrary thread id. */
export const upsert = mutation({
  args: { ...address, ownerUserId: v.string(), shell: v.any() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireEnvironment(ctx, args.environmentId);
    const owner = await ctx.db
      .query("users")
      .withIndex("by_clerk_subject", (q) => q.eq("clerkSubject", args.ownerUserId))
      .unique();
    if (owner === null)
      throw backendError("entity-not-found", "The conversation owner is unavailable.");
    const link = await ctx.db
      .query("relayEnvironmentLinks")
      .withIndex("by_user_and_environment", (q) =>
        q.eq("userId", owner.clerkSubject).eq("environmentId", args.environmentId),
      )
      .unique();
    if (link === null || link.revokedAt !== null)
      throw backendError("permission-denied", "The owner must be linked to this environment.");
    const decoded = decodeCloudShell(args.shell);
    if (
      Option.isNone(decoded) ||
      decoded.value.id !== args.threadId ||
      decoded.value.ownerUserId !== args.ownerUserId
    ) {
      throw backendError(
        "invalid-arguments",
        "Conversation discovery must match its thread and owner.",
      );
    }
    const shell = encodeCloudShell(decoded.value);
    const existing = await conversationAt(ctx, args.environmentId, args.threadId);
    if (existing !== null && existing.ownerUserId !== owner._id)
      throw backendError("permission-denied", "Conversation ownership cannot change.");
    if (decoded.value.projectId !== null || decoded.value.deletedAt !== null) {
      if (existing !== null) await removeConversation(ctx, existing);
      return null;
    }
    if (existing === null)
      await ctx.db.insert("personalConversations", {
        environmentId: args.environmentId,
        threadId: args.threadId,
        ownerUserId: owner._id,
        shell,
        updatedAt: Date.now(),
      });
    else if (JSON.stringify(existing.shell) !== JSON.stringify(shell))
      await ctx.db.patch(existing._id, { shell, updatedAt: Date.now() });
    return null;
  },
});

export const remove = mutation({
  args: address,
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireEnvironment(ctx, args.environmentId);
    const row = await conversationAt(ctx, args.environmentId, args.threadId);
    if (row !== null) await removeConversation(ctx, row);
    return null;
  },
});

export const reconcile = mutation({
  args: { environmentId: v.string(), threadIds: v.array(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireEnvironment(ctx, args.environmentId);
    const current = new Set(args.threadIds);
    const rows = await ctx.db
      .query("personalConversations")
      .withIndex("by_environment", (q) => q.eq("environmentId", args.environmentId))
      .collect();
    for (const row of rows) if (!current.has(row.threadId)) await removeConversation(ctx, row);
    return null;
  },
});

export const list = query({
  args: {},
  returns: v.array(
    v.object({
      ...address,
      ownerUserId: v.string(),
      access: v.union(v.literal("owner"), access),
      shareId: v.union(v.string(), v.null()),
      shell: v.any(),
    }),
  ),
  handler: async (ctx) => {
    const user = await requireUser(ctx);
    const owned = await ctx.db
      .query("personalConversations")
      .withIndex("by_owner", (q) => q.eq("ownerUserId", user._id))
      .collect();
    const shares = await ctx.db
      .query("conversationShares")
      .withIndex("by_recipient", (q) => q.eq("recipientUserId", user._id))
      .collect();
    const results = owned.map((row) => ({
      environmentId: row.environmentId,
      threadId: row.threadId,
      ownerUserId: user.clerkSubject,
      access: "owner" as "owner" | "view" | "collaborate",
      shareId: null as string | null,
      shell: row.shell,
    }));
    for (const share of shares) {
      const resolved = await resolveConversationShare(ctx, share._id);
      if (resolved !== null)
        results.push({
          environmentId: resolved.conversation.environmentId,
          threadId: resolved.conversation.threadId,
          ownerUserId: resolved.owner.clerkSubject,
          access: share.access,
          shareId: share._id,
          shell: resolved.conversation.shell,
        });
    }
    return results;
  },
});

export const recipients = query({
  args: address,
  returns: v.array(
    v.object({
      companyId: v.string(),
      companyName: v.string(),
      userId: v.string(),
      name: v.string(),
    }),
  ),
  handler: async (ctx, args) => {
    const row = await ownedConversation(ctx, args.environmentId, args.threadId);
    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_user", (q) => q.eq("userId", row.ownerUserId))
      .collect();
    const result = [];
    for (const membership of memberships) {
      if (membership.state !== "active") continue;
      const company = await ctx.db.get(membership.companyId);
      if (company?.lifecycleState !== "active" || company.workspaceKind === "personal") continue;
      const members = await ctx.db
        .query("memberships")
        .withIndex("by_company_and_state", (q) =>
          q.eq("companyId", company._id).eq("state", "active"),
        )
        .collect();
      for (const member of members) {
        if (member.userId === row.ownerUserId) continue;
        const user = await ctx.db.get(member.userId);
        if (user !== null)
          result.push({
            companyId: company.id,
            companyName: company.name,
            userId: user.clerkSubject,
            name: user.displayName,
          });
      }
    }
    return result;
  },
});

export const listShares = query({
  args: address,
  returns: v.array(shareResult),
  handler: async (ctx, args) => {
    const row = await ownedConversation(ctx, args.environmentId, args.threadId);
    const shares = await ctx.db
      .query("conversationShares")
      .withIndex("by_conversation", (q) => q.eq("conversationId", row._id))
      .collect();
    const results = [];
    for (const share of shares) {
      const [company, recipient] = await Promise.all([
        ctx.db.get(share.companyId),
        ctx.db.get(share.recipientUserId),
      ]);
      if (company !== null && recipient !== null)
        results.push({
          id: share._id,
          companyId: company.id,
          companyName: company.name,
          recipientUserId: recipient.clerkSubject,
          recipientName: recipient.displayName,
          access: share.access,
        });
    }
    return results;
  },
});

export const share = mutation({
  args: { ...address, companyId: v.string(), recipientUserId: v.string(), access },
  returns: v.string(),
  handler: async (ctx, args) => {
    const row = await ownedConversation(ctx, args.environmentId, args.threadId);
    const company = await ctx.db
      .query("companies")
      .withIndex("by_domain_id", (q) => q.eq("id", args.companyId))
      .unique();
    const recipient = await ctx.db
      .query("users")
      .withIndex("by_clerk_subject", (q) => q.eq("clerkSubject", args.recipientUserId))
      .unique();
    if (
      company?.lifecycleState !== "active" ||
      company.workspaceKind === "personal" ||
      recipient === null ||
      recipient._id === row.ownerUserId ||
      (await activeMembership(ctx, company._id, row.ownerUserId)) === null ||
      (await activeMembership(ctx, company._id, recipient._id)) === null
    ) {
      throw backendError(
        "permission-denied",
        "Choose another active member of a company you belong to.",
      );
    }
    const existing = await ctx.db
      .query("conversationShares")
      .withIndex("by_conversation_and_recipient", (q) =>
        q.eq("conversationId", row._id).eq("recipientUserId", recipient._id),
      )
      .unique();
    if (existing !== null) {
      await ctx.db.patch(existing._id, {
        companyId: company._id,
        access: args.access,
        updatedAt: Date.now(),
      });
      return existing._id;
    }
    return await ctx.db.insert("conversationShares", {
      conversationId: row._id,
      ownerUserId: row.ownerUserId,
      recipientUserId: recipient._id,
      companyId: company._id,
      access: args.access,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  },
});

export const revoke = mutation({
  args: { shareId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const id = ctx.db.normalizeId("conversationShares", args.shareId);
    const share = id === null ? null : await ctx.db.get(id);
    if (share === null || share.ownerUserId !== user._id)
      throw backendError("permission-denied", "Only the conversation owner may revoke sharing.");
    await ctx.db.delete(share._id);
    return null;
  },
});

export const session = query({
  args: { environmentId: v.string(), shareId: v.string() },
  returns: v.union(v.null(), sessionResult),
  handler: async (ctx, args) => {
    await requireEnvironment(ctx, args.environmentId);
    const resolved = await resolveConversationShare(ctx, args.shareId);
    if (resolved?.conversation.environmentId !== args.environmentId) return null;
    const shares = await ctx.db
      .query("conversationShares")
      .withIndex("by_recipient", (q) => q.eq("recipientUserId", resolved.recipient._id))
      .collect();
    const conversations = [];
    for (const share of shares) {
      const candidate = await resolveConversationShare(ctx, share._id);
      if (candidate?.conversation.environmentId === args.environmentId)
        conversations.push({
          threadId: candidate.conversation.threadId,
          ownerUserId: candidate.owner.clerkSubject,
          access: share.access,
        });
    }
    return { ...resolved.session, conversations };
  },
});

const storeGrantReference = makeFunctionReference<
  "mutation",
  { shareId: string; tokenHash: string },
  { environmentId: string; expiresAt: number }
>("conversationShares:storeGrant");
export const issueConnectGrant = action({
  args: { shareId: v.string() },
  returns: v.object({ token: v.string(), environmentId: v.string(), expiresAt: v.number() }),
  handler: async (ctx, args) => {
    const token = generateConnectGrantToken();
    const grant = await ctx.runMutation(storeGrantReference, {
      shareId: args.shareId,
      tokenHash: await hashConnectGrantToken(token),
    });
    return { token, ...grant };
  },
});

export const storeGrant = internalMutation({
  args: { shareId: v.string(), tokenHash: v.string() },
  returns: v.object({ environmentId: v.string(), expiresAt: v.number() }),
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const resolved = await resolveConversationShare(ctx, args.shareId);
    if (resolved === null || resolved.recipient._id !== user._id)
      throw backendError("permission-denied", "This conversation is not shared with you.");
    const expiresAt = connectGrantExpiresAt(Date.now());
    await ctx.db.insert("conversationConnectGrants", {
      shareId: resolved.share._id,
      tokenHash: args.tokenHash,
      expiresAt,
      consumedAt: null,
    });
    return { environmentId: resolved.conversation.environmentId, expiresAt };
  },
});

/** Existing relay connect-grant validation consumes this token in the same transaction. */
export async function consumeConversationConnectGrant(ctx: MutationCtx, tokenHash: string) {
  const grant = await ctx.db
    .query("conversationConnectGrants")
    .withIndex("by_token_hash", (q) => q.eq("tokenHash", tokenHash))
    .unique();
  if (grant === null || grant.consumedAt !== null || grant.expiresAt <= Date.now()) return null;
  const resolved = await resolveConversationShare(ctx, grant.shareId);
  if (resolved === null) return null;
  await ctx.db.patch(grant._id, { consumedAt: Date.now() });
  return {
    status: "accepted" as const,
    environmentId: resolved.conversation.environmentId,
    membershipId: resolved.session.membershipId,
    permission: "remoteAgents.control" as const,
    expiresAt: grant.expiresAt,
    conversationShareId: resolved.share._id,
    conversationUserId: resolved.recipient.clerkSubject,
  };
}
