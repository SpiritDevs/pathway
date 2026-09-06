// @effect-diagnostics globalDate:off -- Convex mutations use the transaction clock.
/** Company contacts. Human members read; projects.manage administers the company directory. */
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel.js";
import { mutation, query } from "./_generated/server.js";
import { backendError } from "./lib/errors.ts";
import { requireCompanyActor, requirePermission } from "./lib/identity.ts";
import { contactFields, contactWire } from "./lib/businessToolsSchema.ts";

function encode(row: Doc<"businessContacts">) {
  const { id, name, role, company, email, phone, notes, favorite, createdAt, revision } = row;
  return { id, name, role, company, email, phone, notes, favorite, createdAt, revision };
}
function validate(fields: {
  name: string;
  role: string;
  company: string;
  email: string;
  phone: string;
  notes: string;
  favorite: boolean;
}) {
  const result = {
    ...fields,
    name: fields.name.trim(),
    role: fields.role.trim(),
    company: fields.company.trim(),
    email: fields.email.trim(),
    phone: fields.phone.trim(),
  };
  if (
    !result.name ||
    result.name.length > 240 ||
    [result.role, result.company, result.email, result.phone].some((value) => value.length > 500) ||
    result.notes.length > 20_000
  ) {
    throw backendError(
      "invalid-arguments",
      "Enter a contact name up to 240 characters; notes may contain up to 20,000 characters.",
    );
  }
  return result;
}
export const list = query({
  args: { companyId: v.string() },
  returns: v.array(contactWire),
  handler: async (ctx, args) => {
    const actor = await requireCompanyActor(ctx, args.companyId);
    if (actor.kind !== "member")
      throw backendError("permission-denied", "Contacts require a company member.");
    const rows = await ctx.db
      .query("businessContacts")
      .withIndex("by_company_and_deleted", (q) =>
        q.eq("companyId", actor.company._id).eq("deletedAt", null),
      )
      .collect();
    return rows
      .filter((row) => row.deletedAt === null)
      .map(encode)
      .sort((a, b) => Number(b.favorite) - Number(a.favorite) || a.name.localeCompare(b.name));
  },
});
export const upsert = mutation({
  args: {
    companyId: v.string(),
    id: v.string(),
    requestId: v.string(),
    expectedRevision: v.union(v.number(), v.null()),
    ...contactFields,
  },
  returns: contactWire,
  handler: async (ctx, args) => {
    const actor = await requireCompanyActor(ctx, args.companyId);
    if (actor.kind !== "member")
      throw backendError("permission-denied", "Contacts require a company member.");
    requirePermission(actor, "projects.manage");
    if (!args.id.trim() || !args.requestId.trim())
      throw backendError("invalid-arguments", "A contact and request identity are required.");
    const row = await ctx.db
      .query("businessContacts")
      .withIndex("by_company_and_id", (q) => q.eq("companyId", actor.company._id).eq("id", args.id))
      .unique();
    if (row?.lastRequestId === args.requestId && row.lastRequestUserId === actor.user._id)
      return encode(row);
    if (
      row
        ? row.deletedAt !== null || row.revision !== args.expectedRevision
        : args.expectedRevision !== null
    )
      throw backendError(
        "conflict",
        "This contact changed on another device. Reload it before saving.",
      );
    const { name, role, company, email, phone, notes, favorite } = args;
    const fields = validate({ name, role, company, email, phone, notes, favorite });
    const updated = {
      ...fields,
      revision: (row?.revision ?? 0) + 1,
      lastRequestId: args.requestId,
      lastRequestUserId: actor.user._id,
    };
    if (row) {
      await ctx.db.patch(row._id, updated);
      return encode({ ...row, ...updated });
    }
    const id = await ctx.db.insert("businessContacts", {
      ...updated,
      id: args.id,
      companyId: actor.company._id,
      createdAt: new Date().toISOString(),
      deletedAt: null,
    });
    const created = await ctx.db.get(id);
    if (!created) throw backendError("entity-not-found", "The contact could not be saved.");
    return encode(created);
  },
});
export const remove = mutation({
  args: { companyId: v.string(), id: v.string(), expectedRevision: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const actor = await requireCompanyActor(ctx, args.companyId);
    if (actor.kind !== "member")
      throw backendError("permission-denied", "Contacts require a company member.");
    requirePermission(actor, "projects.manage");
    const row = await ctx.db
      .query("businessContacts")
      .withIndex("by_company_and_id", (q) => q.eq("companyId", actor.company._id).eq("id", args.id))
      .unique();
    if (!row || row.deletedAt !== null) return null;
    if (row.revision !== args.expectedRevision)
      throw backendError("conflict", "This contact changed. Reload it before deleting.");
    await ctx.db.patch(row._id, { deletedAt: Date.now(), revision: row.revision + 1 });
    return null;
  },
});
export const importLocal = mutation({
  args: {
    companyId: v.string(),
    contacts: v.array(v.object({ id: v.string(), ...contactFields, createdAt: v.string() })),
  },
  returns: v.object({ imported: v.number() }),
  handler: async (ctx, args) => {
    const actor = await requireCompanyActor(ctx, args.companyId);
    if (actor.kind !== "member")
      throw backendError("permission-denied", "Contacts require a company member.");
    requirePermission(actor, "projects.manage");
    if (args.contacts.length > 200)
      throw backendError("invalid-arguments", "Import no more than 200 contacts at once.");
    let imported = 0;
    for (const contact of args.contacts) {
      const id = `local:${actor.user._id}:${contact.id}`;
      const existing = await ctx.db
        .query("businessContacts")
        .withIndex("by_company_and_id", (q) => q.eq("companyId", actor.company._id).eq("id", id))
        .unique();
      if (existing) continue;
      const { name, role, company, email, phone, notes, favorite } = contact;
      const fields = validate({ name, role, company, email, phone, notes, favorite });
      await ctx.db.insert("businessContacts", {
        ...fields,
        id,
        companyId: actor.company._id,
        createdAt: Number.isFinite(Date.parse(contact.createdAt))
          ? contact.createdAt
          : new Date().toISOString(),
        revision: 1,
        deletedAt: null,
        lastRequestId: id,
        lastRequestUserId: actor.user._id,
      });
      imported++;
    }
    return { imported };
  },
});
