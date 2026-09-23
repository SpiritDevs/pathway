// @effect-diagnostics globalDate:off -- Convex mutations use the transaction clock.
import {
  ALL_FOCUS_VIEW_ID,
  CONVERSATIONS_FOCUS_VIEW_ID,
  FOCUS_NAME_MAX_CHARS,
  FOCUS_THREAD_SORT_ORDERS,
  focusThreadSortOrder,
} from "@spiritdevs/contracts/focus";
import { v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx, QueryCtx } from "./_generated/server.js";
import { mutation, query } from "./_generated/server.js";
import { backendError } from "./lib/errors.ts";
import { requireUser } from "./lib/identity.ts";
import { domainIdArg } from "./lib/validators.ts";

const focusResult = v.object({
  includeConversations: v.optional(v.boolean()),
  id: v.string(),
  name: v.string(),
  iconName: v.string(),
  accentColor: v.string(),
  orderKey: v.string(),
  createdAt: v.number(),
  updatedAt: v.number(),
});

const assignmentResult = v.object({
  focusId: v.string(),
  projectKey: v.string(),
  createdAt: v.number(),
  updatedAt: v.number(),
});

const viewPreferenceResult = v.object({
  focusId: v.string(),
  sortOrder: v.string(),
  collapsiblePinned: v.boolean(),
  updatedAt: v.number(),
});

const readModelResult = v.object({
  focuses: v.array(focusResult),
  assignments: v.array(assignmentResult),
  viewPreferences: v.array(viewPreferenceResult),
});

const RESERVED_VIEW_IDS: ReadonlySet<string> = new Set([
  ALL_FOCUS_VIEW_ID,
  CONVERSATIONS_FOCUS_VIEW_ID,
]);

function trimRequired(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw backendError("invalid-arguments", `${label} is required.`);
  return trimmed;
}

function focusName(value: string): string {
  const name = trimRequired(value, "A Focus name");
  if (name.length > FOCUS_NAME_MAX_CHARS) {
    throw backendError(
      "invalid-arguments",
      `A Focus name cannot exceed ${FOCUS_NAME_MAX_CHARS} characters.`,
    );
  }
  return name;
}

function focusId(value: string): string {
  if (value.length === 0 || value !== value.trim()) {
    throw backendError("invalid-arguments", "A Focus id must be a trimmed non-empty string.");
  }
  return value;
}

function accentColor(value: string): string {
  const color = value.trim();
  if (!/^#[0-9a-fA-F]{6}$/.test(color)) {
    throw backendError("invalid-arguments", "A Focus accent color must be a six-digit hex color.");
  }
  return color.toLowerCase();
}

function focusProjectKey(value: string): string {
  if (value.length === 0 || value !== value.trim() || !/^[^:]+:.+$/.test(value)) {
    throw backendError(
      "invalid-arguments",
      "A Focus project key must contain an environment id and project id.",
    );
  }
  return value;
}

function encodeFocus(row: Doc<"focuses">) {
  return {
    id: row.id,
    includeConversations: row.includeConversations ?? false,
    name: row.name,
    iconName: row.iconName,
    accentColor: row.accentColor,
    orderKey: row.orderKey,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function ownedFocus(
  ctx: QueryCtx,
  userId: Id<"users">,
  focusId: string,
): Promise<Doc<"focuses">> {
  const row = await ctx.db
    .query("focuses")
    .withIndex("by_user_and_domain_id", (q) => q.eq("userId", userId).eq("id", focusId))
    .unique();
  if (row === null) throw backendError("entity-not-found", "No such Focus.");
  return row;
}

async function upsertProjectAssignment(
  ctx: MutationCtx,
  userId: Id<"users">,
  focusId: Id<"focuses">,
  projectKey: string,
): Promise<void> {
  const existing = await ctx.db
    .query("focusAssignments")
    .withIndex("by_user_and_project", (q) => q.eq("userId", userId).eq("projectKey", projectKey))
    .unique();
  if (existing?.focusId === focusId) return;

  const now = Date.now();
  if (existing === null) {
    await ctx.db.insert("focusAssignments", {
      userId,
      focusId,
      projectKey,
      createdAt: now,
      updatedAt: now,
    });
  } else {
    await ctx.db.patch(existing._id, { focusId, updatedAt: now });
  }
}

function compareFocus(left: Doc<"focuses">, right: Doc<"focuses">): number {
  if (left.orderKey !== right.orderKey) return left.orderKey < right.orderKey ? -1 : 1;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

export const list = query({
  args: {},
  returns: readModelResult,
  handler: async (ctx) => {
    const user = await requireUser(ctx);
    const [focusRows, assignmentRows, viewRows] = await Promise.all([
      ctx.db
        .query("focuses")
        .withIndex("by_user", (q) => q.eq("userId", user._id))
        .collect(),
      ctx.db
        .query("focusAssignments")
        .withIndex("by_user", (q) => q.eq("userId", user._id))
        .collect(),
      ctx.db
        .query("focusViewPreferences")
        .withIndex("by_user", (q) => q.eq("userId", user._id))
        .collect(),
    ]);
    const liveFocusIds = new Set(focusRows.map((focus) => focus.id));
    const focusIdByDocId = new Map(focusRows.map((focus) => [focus._id, focus.id] as const));
    return {
      focuses: [...focusRows].sort(compareFocus).map(encodeFocus),
      assignments: assignmentRows.flatMap((assignment) => {
        const focusId = focusIdByDocId.get(assignment.focusId);
        return focusId === undefined
          ? []
          : [
              {
                focusId,
                projectKey: assignment.projectKey,
                createdAt: assignment.createdAt,
                updatedAt: assignment.updatedAt,
              },
            ];
      }),
      viewPreferences: viewRows
        .filter((row) => RESERVED_VIEW_IDS.has(row.focusId) || liveFocusIds.has(row.focusId))
        .map((row) => ({
          focusId: row.focusId,
          sortOrder: focusThreadSortOrder(row.sortOrder),
          collapsiblePinned: row.collapsiblePinned ?? false,
          updatedAt: row.updatedAt,
        })),
    };
  },
});

export const create = mutation({
  args: {
    id: domainIdArg,
    name: v.string(),
    iconName: v.string(),
    accentColor: v.string(),
    orderKey: v.optional(v.string()),
    projectKeys: v.optional(v.array(v.string())),
    includeConversations: v.optional(v.boolean()),
  },
  returns: focusResult,
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const id = focusId(args.id);
    const projectKeys = (args.projectKeys ?? []).map(focusProjectKey);
    if (id === "all") {
      throw backendError("invalid-arguments", "The All Focus id is reserved.");
    }
    const duplicate = await ctx.db
      .query("focuses")
      .withIndex("by_user_and_domain_id", (q) => q.eq("userId", user._id).eq("id", id))
      .unique();
    if (duplicate !== null) throw backendError("entity-conflict", "That Focus already exists.");

    const last = await ctx.db
      .query("focuses")
      .withIndex("by_user_and_order", (q) => q.eq("userId", user._id))
      .order("desc")
      .first();
    const now = Date.now();
    const rowId = await ctx.db.insert("focuses", {
      id,
      userId: user._id,
      includeConversations: args.includeConversations ?? false,
      name: focusName(args.name),
      iconName: trimRequired(args.iconName, "A Focus icon"),
      accentColor: accentColor(args.accentColor),
      orderKey:
        args.orderKey === undefined
          ? `${last?.orderKey ?? ""}n`
          : trimRequired(args.orderKey, "An order key"),
      createdAt: now,
      updatedAt: now,
    });
    for (const projectKey of projectKeys) {
      await upsertProjectAssignment(ctx, user._id, rowId, projectKey);
    }
    const row = await ctx.db.get(rowId);
    if (row === null) throw backendError("entity-not-found", "The Focus insert vanished.");
    return encodeFocus(row);
  },
});

export const update = mutation({
  args: {
    focusId: domainIdArg,
    name: v.optional(v.string()),
    iconName: v.optional(v.string()),
    accentColor: v.optional(v.string()),
    includeConversations: v.optional(v.boolean()),
  },
  returns: focusResult,
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const row = await ownedFocus(ctx, user._id, args.focusId);
    const patch = {
      ...(args.includeConversations === undefined
        ? {}
        : { includeConversations: args.includeConversations }),
      ...(args.name === undefined ? {} : { name: focusName(args.name) }),
      ...(args.iconName === undefined
        ? {}
        : { iconName: trimRequired(args.iconName, "A Focus icon") }),
      ...(args.accentColor === undefined ? {} : { accentColor: accentColor(args.accentColor) }),
      updatedAt: Date.now(),
    };
    await ctx.db.patch(row._id, patch);
    return encodeFocus({ ...row, ...patch });
  },
});

export const reorder = mutation({
  args: { focusId: domainIdArg, orderKey: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const row = await ownedFocus(ctx, user._id, args.focusId);
    await ctx.db.patch(row._id, {
      orderKey: trimRequired(args.orderKey, "An order key"),
      updatedAt: Date.now(),
    });
    return null;
  },
});

export const remove = mutation({
  args: { focusId: domainIdArg },
  returns: v.null(),
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const row = await ownedFocus(ctx, user._id, args.focusId);
    const assignments = await ctx.db
      .query("focusAssignments")
      .withIndex("by_focus", (q) => q.eq("focusId", row._id))
      .collect();
    for (const assignment of assignments) await ctx.db.delete(assignment._id);
    const view = await ctx.db
      .query("focusViewPreferences")
      .withIndex("by_user_and_focus", (q) => q.eq("userId", user._id).eq("focusId", row.id))
      .unique();
    if (view !== null) await ctx.db.delete(view._id);
    await ctx.db.delete(row._id);
    return null;
  },
});

export const assignProject = mutation({
  args: { focusId: domainIdArg, projectKey: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const focus = await ownedFocus(ctx, user._id, args.focusId);
    const projectKey = focusProjectKey(args.projectKey);
    await upsertProjectAssignment(ctx, user._id, focus._id, projectKey);
    return null;
  },
});

export const unassignProject = mutation({
  args: { projectKey: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const projectKey = focusProjectKey(args.projectKey);
    const existing = await ctx.db
      .query("focusAssignments")
      .withIndex("by_user_and_project", (q) =>
        q.eq("userId", user._id).eq("projectKey", projectKey),
      )
      .unique();
    if (existing !== null) await ctx.db.delete(existing._id);
    return null;
  },
});

/** One view row per Focus key; omitted fields keep their stored value. */
export const setViewPreference = mutation({
  args: {
    focusId: v.string(),
    sortOrder: v.optional(v.string()),
    collapsiblePinned: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const viewId = focusId(args.focusId);
    if (!RESERVED_VIEW_IDS.has(viewId)) await ownedFocus(ctx, user._id, viewId);
    if (
      args.sortOrder !== undefined &&
      !(FOCUS_THREAD_SORT_ORDERS as readonly string[]).includes(args.sortOrder)
    )
      throw backendError("invalid-arguments", "Unknown thread sort order.");
    const patch = {
      ...(args.sortOrder === undefined ? {} : { sortOrder: args.sortOrder }),
      ...(args.collapsiblePinned === undefined
        ? {}
        : { collapsiblePinned: args.collapsiblePinned }),
      updatedAt: Date.now(),
    };
    const existing = await ctx.db
      .query("focusViewPreferences")
      .withIndex("by_user_and_focus", (q) => q.eq("userId", user._id).eq("focusId", viewId))
      .unique();
    if (existing === null)
      await ctx.db.insert("focusViewPreferences", { userId: user._id, focusId: viewId, ...patch });
    else await ctx.db.patch(existing._id, patch);
    return null;
  },
});
