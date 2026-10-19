import { dictationDictionaryError } from "@spiritdevs/contracts/dictation";
import { v } from "convex/values";
import { mutation, query } from "./_generated/server.js";
import { requireUser } from "./lib/identity.ts";
import { backendError } from "./lib/errors.ts";
import { dictationDictionaryLists } from "./lib/dictationDictionary.ts";

export const read = query({
  args: {},
  returns: v.object({ revision: v.number(), lists: dictationDictionaryLists }),
  handler: async (ctx) => {
    const user = await requireUser(ctx);
    const row = await ctx.db
      .query("dictationDictionaries")
      .withIndex("by_user", (q) => q.eq("userId", user.clerkSubject))
      .unique();
    return { revision: row?.revision ?? 0, lists: row?.lists ?? [] };
  },
});

export const save = mutation({
  args: { revision: v.number(), lists: dictationDictionaryLists },
  returns: v.number(),
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const error = dictationDictionaryError(args.lists);
    if (error) throw backendError("invalid-arguments", error);
    const existing = await ctx.db
      .query("dictationDictionaries")
      .withIndex("by_user", (q) => q.eq("userId", user.clerkSubject))
      .unique();
    if (args.revision !== (existing?.revision ?? 0))
      throw backendError(
        "invalid-arguments",
        "Your dictionary changed on another computer. Reload it before saving again.",
      );
    const revision = args.revision + 1;
    const value = { userId: user.clerkSubject, revision, lists: args.lists };
    if (existing) await ctx.db.replace(existing._id, value);
    else await ctx.db.insert("dictationDictionaries", value);
    return revision;
  },
});
