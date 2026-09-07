// @effect-diagnostics globalDate:off -- Convex provides deterministic transaction time without an Effect runtime.
import type { MutationCtx, QueryCtx } from "../_generated/server.js";
import type { Doc } from "../_generated/dataModel.js";
import { requireCompanyActor } from "./identity.ts";
import { backendError } from "./errors.ts";
import { mintDomainId } from "./domainIds.ts";

export async function mailOwner(ctx: QueryCtx, companyId: string) {
  const actor = await requireCompanyActor(ctx, companyId);
  if (actor.kind !== "member") throw backendError("permission-denied", "Mail requires its owner.");
  return actor;
}
export async function mailAccount(ctx: QueryCtx, accountId: string) {
  const account = await ctx.db
    .query("mailAccounts")
    .withIndex("by_domain_id", (q) => q.eq("id", accountId))
    .unique();
  if (!account) throw backendError("mail-not-found", "Mailbox not found.");
  return account;
}
export async function ownedMailAccount(ctx: QueryCtx, companyId: string, accountId: string) {
  const actor = await mailOwner(ctx, companyId);
  const account = await mailAccount(ctx, accountId);
  if (account.companyId !== actor.company._id || account.ownerMembershipId !== actor.membership._id)
    throw backendError("permission-denied", "This mailbox belongs to another member.");
  return account;
}
export async function ownedMailMessage(ctx: QueryCtx, companyId: string, messageId: string) {
  const message = await ctx.db
    .query("mailMessages")
    .withIndex("by_domain_id", (q) => q.eq("id", messageId))
    .unique();
  if (!message) throw backendError("mail-not-found", "Message not found.");
  await ownedMailAccount(ctx, companyId, message.accountId);
  return message;
}
export function mailScope(account: Doc<"mailAccounts">) {
  return {
    companyId: account.companyId,
    ownerMembershipId: account.ownerMembershipId,
    ownerSubject: account.ownerSubject,
  };
}
export function publicAccount(account: Doc<"mailAccounts">) {
  return {
    id: account.id,
    email: account.email,
    credentialSource: account.credentialSource,
    status: account.status,
    ...(account.brain ? { brain: account.brain } : {}),
    ...(account.lastSyncAt !== undefined ? { lastSyncAt: account.lastSyncAt } : {}),
    ...(account.lastError ? { lastError: account.lastError } : {}),
  };
}
export function publicMessage(message: Doc<"mailMessages">) {
  const { _id, _creationTime, ownerSubject, ownerMembershipId, companyId, ...record } = message;
  void _id;
  void _creationTime;
  void ownerSubject;
  void ownerMembershipId;
  void companyId;
  return record;
}
export function publicDraft(draft: Doc<"mailDrafts">) {
  const {
    _id,
    _creationTime,
    ownerSubject,
    ownerMembershipId,
    companyId,
    leaseToken,
    leaseExpiresAt,
    ...record
  } = draft;
  void _id;
  void _creationTime;
  void ownerSubject;
  void ownerMembershipId;
  void companyId;
  void leaseToken;
  void leaseExpiresAt;
  return record;
}
export async function queueMailJob(
  ctx: MutationCtx,
  account: Doc<"mailAccounts">,
  message: Doc<"mailMessages">,
  kind: "analyze" | "brief" | "draft",
  instructions?: string,
) {
  const now = Date.now();
  const jobs = await ctx.db
    .query("mailJobs")
    .withIndex("by_message", (q) => q.eq("messageId", message.id))
    .take(100);
  const existing = jobs.find(
    (j) =>
      j.kind === kind &&
      j.classificationRevision === message.classificationRevision &&
      (j.status === "pending" || j.status === "running"),
  );
  if (existing) return existing.id;
  const id = mintDomainId(now);
  await ctx.db.insert("mailJobs", {
    ...mailScope(account),
    id,
    accountId: account.id,
    messageId: message.id,
    kind,
    ...(instructions ? { instructions } : {}),
    status: "pending",
    generation: 0,
    classificationRevision: message.classificationRevision,
    attempts: 0,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}
export function assertActive(account: Doc<"mailAccounts">) {
  if (account.status !== "active")
    throw backendError("mail-unavailable", "Reconnect this mailbox first.");
}
/** A pending key is canceled by the same transaction that commits its message reference. */
export async function queueMailBlobCleanup(ctx: MutationCtx, blobKey: string, dueAt = Date.now()) {
  const existing = await ctx.db
    .query("mailBlobCleanup")
    .withIndex("by_blob", (q) => q.eq("blobKey", blobKey))
    .unique();
  if (existing) {
    await ctx.db.patch(existing._id, { dueAt: Math.min(existing.dueAt, dueAt) });
    return;
  }
  await ctx.db.insert("mailBlobCleanup", {
    id: mintDomainId(Date.now()),
    blobKey,
    dueAt,
    generation: 0,
  });
}
export async function disconnectMailAccount(ctx: MutationCtx, account: Doc<"mailAccounts">) {
  await ctx.db.patch(account._id, {
    status: "disconnected",
    brain: undefined,
    primaryEnvironmentId: undefined,
    backupEnvironmentId: undefined,
    leaseToken: undefined,
    leaseExpiresAt: undefined,
    generation: account.generation + 1,
    updatedAt: Date.now(),
  });
  const credential = await ctx.db
    .query("mailCredentials")
    .withIndex("by_account", (q) => q.eq("accountId", account.id))
    .unique();
  const cleanup = await ctx.db
    .query("mailAccountCleanup")
    .withIndex("by_account", (q) => q.eq("accountId", account.id))
    .unique();
  if (credential && !cleanup)
    await ctx.db.insert("mailAccountCleanup", {
      id: mintDomainId(Date.now()),
      accountId: account.id,
      encryptedCredentials: credential.encryptedCredentials,
      dueAt: Date.now(),
      generation: 0,
    });
}
