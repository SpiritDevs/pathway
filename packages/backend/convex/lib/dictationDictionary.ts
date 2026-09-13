import { v } from "convex/values";

export const dictationDictionaryLists = v.array(
  v.object({
    id: v.string(),
    name: v.string(),
    terms: v.array(
      v.object({
        id: v.string(),
        spelling: v.string(),
        aliases: v.array(v.string()),
      }),
    ),
  }),
);
