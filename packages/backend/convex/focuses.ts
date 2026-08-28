// @effect-diagnostics globalDate:off -- Convex mutations use the transaction clock.
import { FOCUS_NAME_MAX_CHARS } from "@spiritdevs/contracts/focus";
import { v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx, QueryCtx } from "./_generated/server.js";
import { mutation, query } from "./_generated/server.js";
import { backendError } from "./lib/errors.ts";
import { requireUser } from "./lib/identity.ts";
import { domainIdArg } from "./lib/validators.ts";

const focusResult = v.object({
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

const readModelResult = v.object({
  focuses: v.array(focusResult),
  assignments: v.array(assignmentResult),
});

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
    const [focusRows, assignmentRows] = await Promise.all([
      ctx.db
        .query("focuses")
        .withIndex("by_user", (q) => q.eq("userId", user._id))
        .collect(),
      ctx.db
        .query("focusAssignments")
        .withIndex("by_user", (q) => q.eq("userId", user._id))
        .collect(),
    ]);
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
  },
  returns: focusResult,
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const row = await ownedFocus(ctx, user._id, args.focusId);
    const patch = {
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
