// @effect-diagnostics globalDate:off -- Convex writes use the transaction clock.
/** Personal password storage. Company sync, environment tokens, and agent tools cannot read it. */
import { makeFunctionReference } from "convex/server";
import { v } from "convex/values";
import {
  browserPasswordKeyringFromEnv,
  decryptBrowserPassword,
  encryptBrowserPassword,
  normalizeBrowserPasswordOrigin,
} from "../src/browserPasswordCrypto.ts";
import { action, internalMutation, internalQuery, mutation, query } from "./_generated/server.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import { requireUser } from "./lib/identity.ts";
import { backendError } from "./lib/errors.ts";
import { mintDomainId } from "./lib/domainIds.ts";

const metadata = v.object({
  id: v.string(),
  label: v.string(),
  origin: v.string(),
  username: v.string(),
  revision: v.number(),
  createdAt: v.number(),
  updatedAt: v.number(),
});
const cipherFields = {
  keyId: v.string(),
  iv: v.string(),
  ciphertext: v.string(),
  authenticationTag: v.string(),
};
const present = (row: Doc<"browserPasswords">) => ({
  id: row.id,
  label: row.label,
  origin: row.origin,
  username: row.username,
  revision: row.revision,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});
type Metadata = ReturnType<typeof present>;

const authorizeReference = makeFunctionReference<"query", Record<string, never>, Id<"users">>(
  "browserPasswords:authorize",
);
const readReference = makeFunctionReference<"query", { id: string }, Doc<"browserPasswords">>(
  "browserPasswords:readOwned",
);
const storeReference = makeFunctionReference<
  "mutation",
  {
    id: string;
    userId: Id<"users">;
    label: string;
    origin: string;
    username: string;
    keyId: string;
    iv: string;
    ciphertext: string;
    authenticationTag: string;
    expectedRevision: number | null;
  },
  Metadata
>("browserPasswords:storeEncrypted");

export const authorize = internalQuery({
  args: {},
  returns: v.id("users"),
  handler: async (ctx) => (await requireUser(ctx))._id,
});

export const list = query({
  args: { origin: v.optional(v.string()) },
  returns: v.array(metadata),
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const origin =
      args.origin === undefined ? undefined : normalizeBrowserPasswordOrigin(args.origin);
    const rows = await ctx.db
      .query("browserPasswords")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .take(500);
    return rows
      .filter((row) => origin === undefined || row.origin === origin)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(present);
  },
});

export const readOwned = internalQuery({
  args: { id: v.string() },
  handler: async (ctx, args): Promise<Doc<"browserPasswords">> => {
    const user = await requireUser(ctx);
    const row = await ctx.db
      .query("browserPasswords")
      .withIndex("by_user_id", (q) => q.eq("userId", user._id).eq("id", args.id))
      .unique();
    if (!row) throw backendError("password-not-found", "This saved password is unavailable.");
    return row;
  },
});

export const storeEncrypted = internalMutation({
  args: {
    id: v.string(),
    userId: v.id("users"),
    label: v.string(),
    origin: v.string(),
    username: v.string(),
    ...cipherFields,
    expectedRevision: v.union(v.number(), v.null()),
  },
  returns: metadata,
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    if (user._id !== args.userId)
      throw backendError("forbidden", "This password belongs to a different account.");
    const existing = await ctx.db
      .query("browserPasswords")
      .withIndex("by_user_id", (q) => q.eq("userId", user._id).eq("id", args.id))
      .unique();
    if ((existing?.revision ?? null) !== args.expectedRevision) {
      throw backendError(
        "password-conflict",
        "This password changed on another device. Refresh before saving.",
      );
    }
    if (!existing) {
      const rows = await ctx.db
        .query("browserPasswords")
        .withIndex("by_user", (q) => q.eq("userId", user._id))
        .take(500);
      if (rows.length >= 500)
        throw backendError(
          "vault-full",
          "This account has reached its limit of 500 saved passwords.",
        );
    }
    const { expectedRevision: _, ...fields } = args;
    const now = Date.now();
    const record = {
      ...fields,
      revision: (existing?.revision ?? 0) + 1,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    if (existing) await ctx.db.patch(existing._id, record);
    else await ctx.db.insert("browserPasswords", record);
    return {
      id: record.id,
      label: record.label,
      origin: record.origin,
      username: record.username,
      revision: record.revision,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  },
});

export const save = action({
  args: {
    id: v.optional(v.string()),
    label: v.string(),
    origin: v.string(),
    username: v.string(),
    password: v.string(),
    expectedRevision: v.optional(v.number()),
  },
  returns: metadata,
  handler: async (ctx, args): Promise<Metadata> => {
    const userId = await ctx.runQuery(authorizeReference, {});
    if (
      !args.label.trim() ||
      args.label.length > 200 ||
      args.username.length > 1024 ||
      !args.password ||
      args.password.length > 16_384 ||
      args.origin.length > 2048 ||
      (args.id !== undefined && (!args.id.trim() || args.id.length > 128))
    ) {
      throw backendError(
        "invalid-arguments",
        "Enter a label, website, username, and password within the supported lengths.",
      );
    }
    const origin = normalizeBrowserPasswordOrigin(args.origin);
    const id = args.id ?? mintDomainId(Date.now());
    const sealed = await encryptBrowserPassword(
      args.password,
      { userId, credentialId: id, origin },
      browserPasswordKeyringFromEnv(),
    );
    return await ctx.runMutation(storeReference, {
      id,
      userId,
      label: args.label.trim(),
      origin,
      username: args.username,
      expectedRevision: args.expectedRevision ?? null,
      ...sealed,
    });
  },
});

/** Called only after the signed-in person selects a login for this exact website. */
export const getForAutofill = action({
  args: { id: v.string(), origin: v.string() },
  returns: v.object({
    id: v.string(),
    origin: v.string(),
    username: v.string(),
    password: v.string(),
  }),
  handler: async (ctx, args) => {
    const row = await ctx.runQuery(readReference, { id: args.id });
    if (normalizeBrowserPasswordOrigin(args.origin) !== row.origin) {
      throw backendError(
        "password-origin-mismatch",
        "This password is saved for a different website.",
      );
    }
    const password = await decryptBrowserPassword(
      row,
      { userId: row.userId, credentialId: row.id, origin: row.origin },
      browserPasswordKeyringFromEnv(),
    );
    return { id: row.id, origin: row.origin, username: row.username, password };
  },
});

export const remove = mutation({
  args: { id: v.string(), expectedRevision: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const row = await ctx.db
      .query("browserPasswords")
      .withIndex("by_user_id", (q) => q.eq("userId", user._id).eq("id", args.id))
      .unique();
    if (!row) throw backendError("password-not-found", "This saved password is unavailable.");
    if (row.revision !== args.expectedRevision)
      throw backendError(
        "password-conflict",
        "This password changed on another device. Refresh before deleting.",
      );
    await ctx.db.delete(row._id);
    return null;
  },
});
