// @effect-diagnostics globalDate:off -- Convex mutations use the transaction clock.
/** Online administration for exact email senders allowed to load remote assets. */
import { v } from "convex/values";

import { mutation } from "./_generated/server.js";
import { appendCompanyChanges, encodeTrustedEmailSender } from "./lib/companyApply.ts";
import { backendError } from "./lib/errors.ts";
import { actorRecord, requireCompanyActor, requirePermission } from "./lib/identity.ts";
import { domainIdArg } from "./lib/validators.ts";

const MAX_EMAIL_ADDRESS_LENGTH = 320;

function addressOf(value: string): string {
  const address = value.trim().toLowerCase();
  if (address.length === 0 || address.length > MAX_EMAIL_ADDRESS_LENGTH || !address.includes("@")) {
    throw backendError("invalid-arguments", "A valid sender email address is required.");
  }
  return address;
}

export const trust = mutation({
  args: { companyId: domainIdArg, id: domainIdArg, address: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const actor = await requireCompanyActor(ctx, args.companyId);
    requirePermission(actor, "projects.manage");
    const address = addressOf(args.address);
    const trusted = await ctx.db
      .query("trustedEmailSenders")
      .withIndex("by_company_and_address", (q) =>
        q.eq("companyId", actor.company._id).eq("address", address),
      )
      .unique();
    if (trusted !== null) return null;
    const idConflict = await ctx.db
      .query("trustedEmailSenders")
      .withIndex("by_company_and_domain_id", (q) =>
        q.eq("companyId", actor.company._id).eq("id", args.id),
      )
      .unique();
    if (idConflict !== null) {
      throw backendError("foreign-id-conflict", "That trusted sender id exists.");
    }
    const now = Date.now();
    const rowId = await ctx.db.insert("trustedEmailSenders", {
      id: args.id,
      companyId: actor.company._id,
      address,
      createdAt: now,
      updatedAt: now,
    });
    const row = await ctx.db.get(rowId);
    if (row === null) throw backendError("entity-not-found", "The trusted sender vanished.");
    await appendCompanyChanges(ctx, {
      companyId: actor.company._id,
      actor: actorRecord(actor),
      changes: [
        {
          entityKind: "trustedEmailSender",
          entityId: row.id,
          changeKind: "upsert",
          versionDocId: row._id,
          payload: encodeTrustedEmailSender(row),
        },
      ],
    });
    return null;
  },
});

export const remove = mutation({
  args: { companyId: domainIdArg, trustedSenderId: domainIdArg },
  returns: v.null(),
  handler: async (ctx, args) => {
    const actor = await requireCompanyActor(ctx, args.companyId);
    requirePermission(actor, "projects.manage");
    const row = await ctx.db
      .query("trustedEmailSenders")
      .withIndex("by_company_and_domain_id", (q) =>
        q.eq("companyId", actor.company._id).eq("id", args.trustedSenderId),
      )
      .unique();
    if (row === null) return null;
    await ctx.db.delete(row._id);
    await appendCompanyChanges(ctx, {
      companyId: actor.company._id,
      actor: actorRecord(actor),
      changes: [
        {
          entityKind: "trustedEmailSender",
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
