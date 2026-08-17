// @effect-diagnostics globalDate:off -- Convex mutations use the transaction clock.
/** Online administration for the company-wide captured-email tag catalog. */
import { v } from "convex/values";

import { mutation } from "./_generated/server.js";
import { appendCompanyChanges, encodeEmailTag } from "./lib/companyApply.ts";
import { backendError } from "./lib/errors.ts";
import { actorRecord, requireCompanyActor, requirePermission } from "./lib/identity.ts";
import { domainIdArg } from "./lib/validators.ts";

const MAX_TAG_NAME_LENGTH = 80;
const COLOR_PATTERN = /^#[0-9a-f]{6}$/iu;

function nameOf(value: string): string {
  const name = value.trim();
  if (name.length === 0 || name.length > MAX_TAG_NAME_LENGTH) {
    throw backendError("invalid-arguments", "Email tag names must be 1–80 characters.");
  }
  return name;
}

function colorOf(value: string): string {
  const color = value.trim().toLowerCase();
  if (!COLOR_PATTERN.test(color)) {
    throw backendError("invalid-arguments", "Email tag colours must be six-digit hex values.");
  }
  return color;
}

export const create = mutation({
  args: { companyId: domainIdArg, id: domainIdArg, name: v.string(), color: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const actor = await requireCompanyActor(ctx, args.companyId);
    requirePermission(actor, "projects.manage");
    const name = nameOf(args.name);
    const color = colorOf(args.color);
    const existing = await ctx.db
      .query("emailTags")
      .withIndex("by_company_and_domain_id", (q) =>
        q.eq("companyId", actor.company._id).eq("id", args.id),
      )
      .unique();
    if (existing !== null) throw backendError("foreign-id-conflict", "That email tag id exists.");
    const siblings = await ctx.db
      .query("emailTags")
      .withIndex("by_company", (q) => q.eq("companyId", actor.company._id))
      .collect();
    if (siblings.some((row) => row.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
      throw backendError("conflict", "An email tag with that name already exists.");
    }
    const now = Date.now();
    const rowId = await ctx.db.insert("emailTags", {
      id: args.id,
      companyId: actor.company._id,
      name,
      color,
      createdAt: now,
      updatedAt: now,
    });
    const row = await ctx.db.get(rowId);
    if (row === null) throw backendError("entity-not-found", "The email tag vanished.");
    await appendCompanyChanges(ctx, {
      companyId: actor.company._id,
      actor: actorRecord(actor),
      changes: [
        {
          entityKind: "emailTag",
          entityId: row.id,
          changeKind: "upsert",
          versionDocId: row._id,
          payload: encodeEmailTag(row),
        },
      ],
    });
    return null;
  },
});

export const update = mutation({
  args: {
    companyId: domainIdArg,
    tagId: domainIdArg,
    name: v.optional(v.string()),
    color: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const actor = await requireCompanyActor(ctx, args.companyId);
    requirePermission(actor, "projects.manage");
    const row = await ctx.db
      .query("emailTags")
      .withIndex("by_company_and_domain_id", (q) =>
        q.eq("companyId", actor.company._id).eq("id", args.tagId),
      )
      .unique();
    if (row === null) throw backendError("entity-not-found", "Email tag not found.");
    const name = args.name === undefined ? row.name : nameOf(args.name);
    const color = args.color === undefined ? row.color : colorOf(args.color);
    const siblings = await ctx.db
      .query("emailTags")
      .withIndex("by_company", (q) => q.eq("companyId", actor.company._id))
      .collect();
    if (
      siblings.some(
        (candidate) =>
          candidate.id !== row.id &&
          candidate.name.toLocaleLowerCase() === name.toLocaleLowerCase(),
      )
    ) {
      throw backendError("conflict", "An email tag with that name already exists.");
    }
    if (name === row.name && color === row.color) return null;
    await ctx.db.patch(row._id, { name, color, updatedAt: Date.now() });
    const updated = await ctx.db.get(row._id);
    if (updated === null) throw backendError("entity-not-found", "The email tag vanished.");
    await appendCompanyChanges(ctx, {
      companyId: actor.company._id,
      actor: actorRecord(actor),
      changes: [
        {
          entityKind: "emailTag",
          entityId: updated.id,
          changeKind: "upsert",
          versionDocId: updated._id,
          payload: encodeEmailTag(updated),
        },
      ],
    });
    return null;
  },
});

export const remove = mutation({
  args: { companyId: domainIdArg, tagId: domainIdArg },
  returns: v.null(),
  handler: async (ctx, args) => {
    const actor = await requireCompanyActor(ctx, args.companyId);
    requirePermission(actor, "projects.manage");
    const row = await ctx.db
      .query("emailTags")
      .withIndex("by_company_and_domain_id", (q) =>
        q.eq("companyId", actor.company._id).eq("id", args.tagId),
      )
      .unique();
    if (row === null) return null;
    await ctx.db.delete(row._id);
    await appendCompanyChanges(ctx, {
      companyId: actor.company._id,
      actor: actorRecord(actor),
      changes: [
        {
          entityKind: "emailTag",
          entityId: row.id,
          changeKind: "tombstone",
          versionDocId: null,
          payload: null,
        },
      ],
    });
    return null;
  },
});
