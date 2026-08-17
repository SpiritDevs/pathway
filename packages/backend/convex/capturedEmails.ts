// @effect-diagnostics globalDate:off -- Convex mutations use the transaction clock.
/** Environment-published parsed SMTP captures for cross-environment reading. */
import { v } from "convex/values";

import type { Doc } from "./_generated/dataModel.js";
import { mutation, type MutationCtx } from "./_generated/server.js";
import { appendCompanyChanges, encodeCapturedEmail } from "./lib/companyApply.ts";
import { backendError } from "./lib/errors.ts";
import {
  actorRecord,
  requireCompanyActor,
  requirePermission,
  requireRecordPermission,
} from "./lib/identity.ts";
import { domainIdArg } from "./lib/validators.ts";

const MAX_RECONCILE_REMOVALS = 100;
/** Leaves room for the change envelope below Convex's one-megabyte document/read limit. */
const MAX_CAPTURED_EMAIL_JSON_BYTES = 700_000;
const MESSAGE_FIELDS = new Set([
  "id",
  "attribution",
  "envelope",
  "parsedHeaders",
  "textBody",
  "htmlBody",
  "attachments",
  "smtpTransactionLog",
  "timings",
  "sizeBytes",
  "isRead",
  "detectedCode",
  "deliverability",
]);

function capturedEmailId(environmentId: string, messageId: string): string {
  return `${environmentId}:${messageId}`;
}

function requireTrimmed(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed !== value) {
    throw backendError("invalid-arguments", `${label} must be a non-empty, trimmed string.`);
  }
  return trimmed;
}

function requireEnvironmentActor(
  actor: Awaited<ReturnType<typeof requireCompanyActor>>,
  environmentId: string,
) {
  requirePermission(actor, "projects.manage");
  if (actor.kind !== "environment" || actor.registration.environmentId !== environmentId) {
    throw backendError(
      "permission-denied",
      "An environment may publish captured mail only for itself.",
    );
  }
}

function validateMessage(message: unknown, messageId: string, localProjectId: string | null) {
  if (typeof message !== "object" || message === null || Array.isArray(message)) {
    throw backendError("invalid-arguments", "Captured email must be an object.");
  }
  const record = message as Record<string, unknown>;
  const fields = Object.keys(record);
  if (fields.length !== MESSAGE_FIELDS.size || fields.some((key) => !MESSAGE_FIELDS.has(key))) {
    throw backendError(
      "invalid-arguments",
      "Captured email fields do not match the wire contract.",
    );
  }
  const attribution = record["attribution"];
  const projectId =
    typeof attribution === "object" && attribution !== null && !Array.isArray(attribution)
      ? (attribution as Record<string, unknown>)["projectId"]
      : undefined;
  if (record["id"] !== messageId || projectId !== localProjectId) {
    throw backendError(
      "invalid-arguments",
      "Captured email identity must match its message and local project.",
    );
  }
  if (
    typeof record["isRead"] !== "boolean" ||
    !Array.isArray(record["attachments"]) ||
    !Array.isArray(record["smtpTransactionLog"]) ||
    typeof record["parsedHeaders"] !== "object" ||
    record["parsedHeaders"] === null ||
    typeof record["timings"] !== "object" ||
    record["timings"] === null
  ) {
    throw backendError("invalid-arguments", "Captured email has an invalid field shape.");
  }
  const encoded = JSON.stringify(message);
  if (new TextEncoder().encode(encoded).byteLength > MAX_CAPTURED_EMAIL_JSON_BYTES) {
    throw backendError(
      "invalid-arguments",
      "Captured email is too large to replicate safely; it remains on the source environment.",
    );
  }
}

async function activeBinding(
  ctx: MutationCtx,
  companyId: Doc<"companies">["_id"],
  environmentId: string,
  localProjectId: string,
) {
  return (
    await ctx.db
      .query("environmentBindings")
      .withIndex("by_company_and_environment", (q) =>
        q.eq("companyId", companyId).eq("environmentId", environmentId),
      )
      .collect()
  ).find((binding) => binding.localProjectId === localProjectId && binding.status === "active");
}

/** Upserts one parsed capture after resolving its environment-local project binding. */
export const upsert = mutation({
  args: {
    companyId: domainIdArg,
    environmentId: v.string(),
    messageId: v.string(),
    localProjectId: v.union(v.string(), v.null()),
    message: v.any(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const actor = await requireCompanyActor(ctx, args.companyId);
    const environmentId = requireTrimmed(args.environmentId, "Environment id");
    const messageId = requireTrimmed(args.messageId, "Message id");
    const localProjectId =
      args.localProjectId === null ? null : requireTrimmed(args.localProjectId, "Local project id");
    requireEnvironmentActor(actor, environmentId);
    validateMessage(args.message, messageId, localProjectId);

    const id = capturedEmailId(environmentId, messageId);
    const deletion = await ctx.db
      .query("capturedEmailDeletions")
      .withIndex("by_company_and_domain_id", (q) =>
        q.eq("companyId", actor.company._id).eq("id", id),
      )
      .unique();
    // The source may have been offline when another client deleted this message. Refusing the
    // stale upsert is the signal its publisher uses to remove the remaining local files.
    if (deletion !== null) return false;

    const binding =
      localProjectId === null
        ? null
        : await activeBinding(ctx, actor.company._id, environmentId, localProjectId);
    if (localProjectId !== null && binding === undefined) {
      throw backendError(
        "entity-not-found",
        "The captured email project has no active binding on this environment.",
      );
    }
    const cloudProjectId = binding?.cloudProjectId ?? null;
    const existing = await ctx.db
      .query("capturedEmails")
      .withIndex("by_company_and_domain_id", (q) =>
        q.eq("companyId", actor.company._id).eq("id", id),
      )
      .unique();
    if (
      existing !== null &&
      existing.cloudProjectId === cloudProjectId &&
      existing.localProjectId === localProjectId &&
      JSON.stringify(existing.message) === JSON.stringify(args.message)
    ) {
      return true;
    }

    const now = Date.now();
    let row: Doc<"capturedEmails">;
    if (existing === null) {
      const rowId = await ctx.db.insert("capturedEmails", {
        id,
        companyId: actor.company._id,
        environmentId,
        cloudProjectId,
        localProjectId,
        messageId,
        message: args.message,
        tagIds: [],
        updatedAt: now,
      });
      const inserted = await ctx.db.get(rowId);
      if (inserted === null) throw backendError("entity-not-found", "Captured email vanished.");
      row = inserted;
    } else {
      await ctx.db.patch(existing._id, {
        cloudProjectId,
        localProjectId,
        message: args.message,
        updatedAt: now,
      });
      const updated = await ctx.db.get(existing._id);
      if (updated === null) throw backendError("entity-not-found", "Captured email vanished.");
      row = updated;
    }

    const project = cloudProjectId === null ? null : await ctx.db.get(cloudProjectId);
    await appendCompanyChanges(ctx, {
      companyId: actor.company._id,
      actor: actorRecord(actor),
      changes: [
        {
          entityKind: "capturedEmail",
          entityId: row.id,
          changeKind: "upsert",
          teamIds: project?.teamIds ?? [],
          versionDocId: row._id,
          payload: await encodeCapturedEmail(ctx, row),
        },
      ],
    });
    return true;
  },
});

async function teamsForRow(ctx: MutationCtx, row: Doc<"capturedEmails">) {
  const project = row.cloudProjectId === null ? null : await ctx.db.get(row.cloudProjectId);
  return project?.teamIds ?? [];
}

/** Replaces one tag's membership on one captured message and republishes the complete row. */
export const setTag = mutation({
  args: {
    companyId: domainIdArg,
    environmentId: v.string(),
    messageId: v.string(),
    tagId: domainIdArg,
    present: v.boolean(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const actor = await requireCompanyActor(ctx, args.companyId);
    const id = capturedEmailId(
      requireTrimmed(args.environmentId, "Environment id"),
      requireTrimmed(args.messageId, "Message id"),
    );
    const row = await ctx.db
      .query("capturedEmails")
      .withIndex("by_company_and_domain_id", (q) =>
        q.eq("companyId", actor.company._id).eq("id", id),
      )
      .unique();
    if (row === null) throw backendError("entity-not-found", "Captured email not found.");
    const teamIds = await teamsForRow(ctx, row);
    requireRecordPermission(actor, "projects.manage", teamIds);
    const tag = await ctx.db
      .query("emailTags")
      .withIndex("by_company_and_domain_id", (q) =>
        q.eq("companyId", actor.company._id).eq("id", args.tagId),
      )
      .unique();
    if (tag === null) throw backendError("entity-not-found", "Email tag not found.");
    const current = row.tagIds ?? [];
    const has = current.includes(args.tagId);
    if (has === args.present) return null;
    const tagIds = args.present
      ? [...current, args.tagId]
      : current.filter((tagId) => tagId !== args.tagId);
    await ctx.db.patch(row._id, { tagIds, updatedAt: Date.now() });
    const updated = await ctx.db.get(row._id);
    if (updated === null) throw backendError("entity-not-found", "Captured email vanished.");
    await appendCompanyChanges(ctx, {
      companyId: actor.company._id,
      actor: actorRecord(actor),
      changes: [
        {
          entityKind: "capturedEmail",
          entityId: updated.id,
          changeKind: "upsert",
          teamIds,
          versionDocId: updated._id,
          payload: await encodeCapturedEmail(ctx, updated),
        },
      ],
    });
    return null;
  },
});

/** Deletes visible cloud rows and records durable intent for their source environments. */
export const remove = mutation({
  args: {
    companyId: domainIdArg,
    messages: v.array(v.object({ environmentId: v.string(), messageId: v.string() })),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const actor = await requireCompanyActor(ctx, args.companyId);
    if (args.messages.length === 0 || args.messages.length > 100) {
      throw backendError("invalid-arguments", "Delete between 1 and 100 captured emails at once.");
    }
    const rows: Doc<"capturedEmails">[] = [];
    const deletions: Array<{ id: string; environmentId: string; messageId: string }> = [];
    const seen = new Set<string>();
    for (const message of args.messages) {
      const environmentId = requireTrimmed(message.environmentId, "Environment id");
      const messageId = requireTrimmed(message.messageId, "Message id");
      const id = capturedEmailId(environmentId, messageId);
      if (seen.has(id)) continue;
      seen.add(id);
      const existingDeletion = await ctx.db
        .query("capturedEmailDeletions")
        .withIndex("by_company_and_domain_id", (q) =>
          q.eq("companyId", actor.company._id).eq("id", id),
        )
        .unique();
      if (existingDeletion !== null) continue;
      const row = await ctx.db
        .query("capturedEmails")
        .withIndex("by_company_and_domain_id", (q) =>
          q.eq("companyId", actor.company._id).eq("id", id),
        )
        .unique();
      if (row === null) continue;
      requireRecordPermission(actor, "projects.manage", await teamsForRow(ctx, row));
      rows.push(row);
      deletions.push({ id, environmentId, messageId });
    }
    const now = Date.now();
    for (const deletion of deletions) {
      await ctx.db.insert("capturedEmailDeletions", {
        ...deletion,
        companyId: actor.company._id,
        deletedAt: now,
      });
    }
    await removeRows(ctx, actor, rows);
    return null;
  },
});

async function removeRows(
  ctx: MutationCtx,
  actor: Awaited<ReturnType<typeof requireCompanyActor>>,
  rows: readonly Doc<"capturedEmails">[],
) {
  if (rows.length === 0) return;
  const changes = [];
  for (const row of rows) {
    const project = row.cloudProjectId === null ? null : await ctx.db.get(row.cloudProjectId);
    await ctx.db.delete(row._id);
    changes.push({
      entityKind: "capturedEmail" as const,
      entityId: row.id,
      changeKind: "tombstone" as const,
      teamIds: project?.teamIds ?? [],
      versionDocId: null,
      payload: null,
    });
  }
  await appendCompanyChanges(ctx, {
    companyId: actor.company._id,
    actor: actorRecord(actor),
    changes,
  });
}

/** Repairs retention and clear-inbox removals missed while the publisher was disconnected. */
export const reconcile = mutation({
  args: {
    companyId: domainIdArg,
    environmentId: v.string(),
    currentMessageIds: v.array(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const actor = await requireCompanyActor(ctx, args.companyId);
    const environmentId = requireTrimmed(args.environmentId, "Environment id");
    requireEnvironmentActor(actor, environmentId);
    const current = new Set(args.currentMessageIds.map((id) => requireTrimmed(id, "Message id")));
    const stale = (
      await ctx.db
        .query("capturedEmails")
        .withIndex("by_company_and_environment", (q) =>
          q.eq("companyId", actor.company._id).eq("environmentId", environmentId),
        )
        .collect()
    )
      .filter((row) => !current.has(row.messageId))
      .slice(0, MAX_RECONCILE_REMOVALS);
    await removeRows(ctx, actor, stale);
    return null;
  },
});
