// @effect-diagnostics globalDate:off -- Convex transaction clock.
import { v } from "convex/values";
import { makeFunctionReference } from "convex/server";
import {
  query,
  mutation,
  action,
  internalMutation,
  internalQuery,
  type QueryCtx,
  type MutationCtx,
} from "./_generated/server.js";
import type { Doc } from "./_generated/dataModel.js";
import type { Asset, AssetContext, AssetPage } from "@spiritdevs/contracts/assets";
import { ASSET_MAX_FILE_BYTES, ASSET_COMPANY_MAX_BYTES } from "@spiritdevs/contracts/assets";
import {
  requireCompanyActor,
  requireRecordPermission,
  membershipAuthorization,
  type CompanyActor,
  type MemberActor,
} from "./lib/identity.ts";
import { backendError } from "./lib/errors.ts";
import { assetContext } from "./lib/assetSchema.ts";
import { mintDomainId } from "./lib/domainIds.ts";
const base = { companyId: v.string(), assetId: v.string(), context: v.optional(assetContext) };
const uploadArgs = {
  companyId: v.string(),
  clientRequestId: v.string(),
  fileName: v.string(),
  mimeType: v.string(),
  byteSize: v.number(),
  checksum: v.string(),
  context: v.optional(assetContext),
};
const denied = () =>
  backendError("permission-denied", "This asset is not available to this caller.");
const admin = (a: CompanyActor) =>
  a.kind === "member" && (a.isOwner || a.permissions.company.has("company.manage"));
const ownerId = (a: CompanyActor) =>
  a.kind === "member" ? a.membership.id : `environment:${a.registration.environmentId}`;
const manageable = (a: CompanyActor, r: Doc<"assets">) =>
  a.kind === "member" && (admin(a) || r.uploaderId === ownerId(a));
const shareable = (a: CompanyActor, r: Doc<"assets">) =>
  manageable(a, r) && (a.permissions.isOwner || a.permissions.company.has("assets.share"));
function contextKey(c: AssetContext) {
  return `${c.kind}:${c.environmentId ?? ""}:${c.id}:${c.messageId ?? ""}`;
}
async function contextAllowed(ctx: QueryCtx, a: CompanyActor, c: AssetContext): Promise<boolean> {
  if (c.kind === "task") {
    if (a.kind !== "member") return false;
    const issue = await ctx.db
      .query("issues")
      .withIndex("by_company_and_domain_id", (q) => q.eq("companyId", a.company._id).eq("id", c.id))
      .unique();
    if (!issue || issue.deletedAt !== null) return false;
    try {
      requireRecordPermission(a, "issues.read", issue.teamIds);
      return true;
    } catch {
      return false;
    }
  }
  if (!c.environmentId) return false;
  if (a.kind === "environment" && a.registration.environmentId !== c.environmentId) return false;
  const published = await ctx.db
    .query("agentThreads")
    .withIndex("by_company_and_environment_and_thread", (q) =>
      q.eq("companyId", a.company._id).eq("environmentId", c.environmentId!).eq("threadId", c.id),
    )
    .unique();
  if (published && published.shell?.deletedAt == null)
    return (
      a.kind === "environment" ||
      a.permissions.isOwner ||
      a.permissions.company.has("environments.read")
    );
  const queues = await ctx.db
    .query("threadQueueThreads")
    .withIndex("by_company_environment_and_thread", (q) =>
      q.eq("companyId", a.company._id).eq("environmentId", c.environmentId!).eq("threadId", c.id),
    )
    .collect();
  return queues.some(
    (t) =>
      t.state !== "canceled" &&
      (a.kind === "environment" || t.issuedByMembershipId === a.membership._id),
  );
}
async function visible(ctx: QueryCtx, a: CompanyActor, r: Doc<"assets">) {
  if (r.state === "purged") return manageable(a, r);
  if (r.state === "trashed") return manageable(a, r);
  if (a.kind === "member" && (admin(a) || r.uploaderId === ownerId(a))) return true;
  for (const c of r.contexts) if (await contextAllowed(ctx, a, c)) return true;
  return false;
}
async function find(ctx: QueryCtx, a: CompanyActor, id: string) {
  return ctx.db
    .query("assets")
    .withIndex("by_identity", (q) => q.eq("companyId", a.company._id).eq("id", id))
    .unique();
}
async function access(ctx: QueryCtx, args: { companyId: string; assetId: string }, manage = false) {
  const actor = await requireCompanyActor(ctx, args.companyId);
  const row = await find(ctx, actor, args.assetId);
  if (!row || !(await visible(ctx, actor, row)) || (manage && !manageable(actor, row)))
    throw denied();
  return { actor, row };
}
async function wire(ctx: QueryCtx, a: CompanyActor, r: Doc<"assets">): Promise<Asset> {
  const contexts: AssetContext[] = [];
  for (const c of r.contexts)
    if (await contextAllowed(ctx, a, c)) {
      let title: string | undefined;
      if (c.kind === "task") {
        const task = await ctx.db
          .query("issues")
          .withIndex("by_company_and_domain_id", (q) =>
            q.eq("companyId", r.companyId).eq("id", c.id),
          )
          .unique();
        title = task?.title;
      } else if (c.environmentId) {
        const thread = await ctx.db
          .query("agentThreads")
          .withIndex("by_company_and_environment_and_thread", (q) =>
            q
              .eq("companyId", r.companyId)
              .eq("environmentId", c.environmentId!)
              .eq("threadId", c.id),
          )
          .unique();
        if (typeof thread?.shell?.title === "string") title = thread.shell.title;
      }
      contexts.push({ ...c, ...(title ? { title } : {}) });
    }
  const uploader = await ctx.db
    .query("memberships")
    .withIndex("by_company_and_domain_id", (q) =>
      q.eq("companyId", r.companyId).eq("id", r.uploaderId),
    )
    .unique();
  const shares = shareable(a, r)
    ? (
        await ctx.db
          .query("assetGrants")
          .withIndex("by_asset", (q) => q.eq("companyId", r.companyId).eq("assetId", r.id))
          .collect()
      )
        .filter((g) => g.kind === "share")
        .map((g) => ({ id: g._id, expiresAt: g.expiresAt, revokedAt: g.revokedAt }))
    : [];
  return {
    id: r.id,
    companyId: a.company.id,
    name: r.name,
    mimeType: r.mimeType,
    byteSize: r.byteSize,
    kind: r.kind as Asset["kind"],
    state: r.state as Asset["state"],
    previewState: r.previewState as Asset["previewState"],
    originalReady: r.originalReady,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    uploaderId: r.uploaderId,
    uploaderName: uploader?.displayNameSnapshot ?? "Environment",
    keepInLibrary: r.keepInLibrary,
    trashedAt: r.trashedAt,
    error: r.error,
    contexts,
    shares,
    permissions: { canManage: manageable(a, r), canShare: shareable(a, r) },
    reference: { type: "asset", assetId: r.id, companyId: a.company.id },
  };
}
async function quota(ctx: QueryCtx, a: CompanyActor) {
  return await ctx.db
    .query("assetQuotas")
    .withIndex("by_company", (q) => q.eq("companyId", a.company._id))
    .unique();
}
const defaultUsage = {
  usedBytes: 0,
  reservedBytes: 0,
  maxBytes: ASSET_COMPANY_MAX_BYTES,
  maxFileBytes: ASSET_MAX_FILE_BYTES,
};
export const get = query({
  args: base,
  handler: async (ctx, args) => {
    const a = await requireCompanyActor(ctx, args.companyId),
      r = await find(ctx, a, args.assetId);
    if (
      a.kind === "environment" &&
      (!args.context ||
        !r?.contexts.some(
          (c) =>
            contextKey(c) === contextKey(args.context!) ||
            (c.kind === args.context!.kind &&
              c.id === args.context!.id &&
              c.environmentId === args.context!.environmentId),
        ) ||
        !(await contextAllowed(ctx, a, args.context)))
    )
      return null;
    return r && (await visible(ctx, a, r)) ? wire(ctx, a, r) : null;
  },
});
export const list = query({
  args: {
    companyId: v.string(),
    threadId: v.optional(v.string()),
    environmentId: v.optional(v.string()),
    search: v.optional(v.string()),
    uploaderId: v.optional(v.string()),
    createdAfter: v.optional(v.number()),
    sort: v.optional(v.union(v.literal("newest"), v.literal("name"), v.literal("size"))),
    kind: v.optional(v.string()),
    trashed: v.optional(v.boolean()),
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<AssetPage> => {
    const a = await requireCompanyActor(ctx, args.companyId);
    if (
      a.kind === "environment" &&
      (!args.threadId || args.environmentId !== a.registration.environmentId)
    )
      throw denied();
    const source =
      args.sort === "name"
        ? ctx.db.query("assets").withIndex("by_name", (q) => q.eq("companyId", a.company._id))
        : args.sort === "size"
          ? ctx.db.query("assets").withIndex("by_size", (q) => q.eq("companyId", a.company._id))
          : ctx.db.query("assets").withIndex("by_company", (q) => q.eq("companyId", a.company._id));
    const page = await source
      .order(args.sort === "name" ? "asc" : "desc")
      .filter((q) =>
        q.and(
          ...(args.uploaderId ? [q.eq(q.field("uploaderId"), args.uploaderId)] : []),
          ...(args.createdAfter !== undefined
            ? [q.gte(q.field("createdAt"), args.createdAfter)]
            : []),
          ...(args.kind ? [q.eq(q.field("kind"), args.kind)] : []),
        ),
      )
      .paginate({
        cursor: args.cursor ?? null,
        numItems: Math.min(100, Math.max(1, args.limit ?? 40)),
      });
    const items: Asset[] = [];
    for (const r of page.page) {
      if (
        r.state === "purged" ||
        (r.state === "trashed") !== !!args.trashed ||
        (args.kind && r.kind !== args.kind) ||
        (args.search && !r.name.toLowerCase().includes(args.search.toLowerCase()))
      )
        continue;
      if (
        args.threadId &&
        !r.contexts.some(
          (c) =>
            c.kind === "thread" &&
            c.id === args.threadId &&
            (!args.environmentId || c.environmentId === args.environmentId),
        )
      )
        continue;
      if (await visible(ctx, a, r)) items.push(await wire(ctx, a, r));
    }
    const q = await quota(ctx, a);
    return {
      items,
      canConfigureQuota: admin(a),
      nextCursor: page.isDone ? null : page.continueCursor,
      usage: q
        ? {
            canConfigureQuota: admin(a),
            usedBytes: q.usedBytes,
            reservedBytes: q.reservedBytes,
            maxBytes: q.maxBytes,
            maxFileBytes: q.maxFileBytes,
          }
        : { ...defaultUsage, canConfigureQuota: admin(a) },
    };
  },
});
export const threadCounts = query({
  args: { companyId: v.string() },
  handler: async (ctx, args) => {
    const actor = await requireCompanyActor(ctx, args.companyId);
    if (actor.kind !== "member") throw denied();
    const rows = await ctx.db
      .query("assetThreadCounts")
      .withIndex("by_company", (q) => q.eq("companyId", actor.company._id))
      .collect();
    const result = [];
    for (const row of rows)
      if (
        await contextAllowed(ctx, actor, {
          kind: "thread",
          id: row.threadId,
          environmentId: row.environmentId,
        })
      )
        result.push({ threadId: row.threadId, environmentId: row.environmentId, count: row.count });
    return result;
  },
});

async function reserveUpload(
  ctx: MutationCtx,
  args: {
    companyId: string;
    clientRequestId: string;
    fileName: string;
    mimeType: string;
    byteSize: number;
    checksum: string;
    context?: AssetContext;
  },
) {
  const a = await requireCompanyActor(ctx, args.companyId);
  if (a.kind === "environment" && (!args.context || args.context.kind !== "thread")) throw denied();
  if (args.context && !(await contextAllowed(ctx, a, args.context))) throw denied();
  if (
    !args.fileName.trim() ||
    args.fileName.length > 255 ||
    !Number.isSafeInteger(args.byteSize) ||
    args.byteSize <= 0 ||
    !/^[a-f0-9]{64}$/.test(args.checksum) ||
    !args.clientRequestId.trim()
  )
    throw backendError("invalid-arguments", "Invalid upload name, size or SHA-256 checksum.");
  const existing = await ctx.db
    .query("assets")
    .withIndex("by_request", (q) =>
      q
        .eq("companyId", a.company._id)
        .eq("uploaderId", ownerId(a))
        .eq("requestId", args.clientRequestId),
    )
    .unique();
  if (existing) {
    if (
      existing.checksum !== args.checksum ||
      existing.byteSize !== args.byteSize ||
      existing.mimeType !== args.mimeType
    )
      throw backendError("idempotency-conflict", "This request identifies another original.");
    if (existing.state === "trashed" || existing.state === "purged" || existing.state === "failed")
      throw backendError("upload-expired", "Start a new upload request.");
    return existing;
  }
  const q = await quota(ctx, a),
    usage = q ?? defaultUsage;
  if (
    args.byteSize > usage.maxFileBytes ||
    usage.usedBytes + usage.reservedBytes + args.byteSize > usage.maxBytes
  )
    throw backendError(
      "asset-quota-exceeded",
      "The file or company storage limit would be exceeded.",
    );
  if (q) await ctx.db.patch(q._id, { reservedBytes: q.reservedBytes + args.byteSize });
  else
    await ctx.db.insert("assetQuotas", {
      companyId: a.company._id,
      ...defaultUsage,
      reservedBytes: args.byteSize,
    });
  const kind = args.mimeType.startsWith("image/")
    ? "image"
    : args.mimeType.startsWith("video/")
      ? "video"
      : args.mimeType.startsWith("audio/")
        ? "audio"
        : args.mimeType === "application/pdf" || args.mimeType.startsWith("text/")
          ? "document"
          : "file";
  const id = await ctx.db.insert("assets", {
    companyId: a.company._id,
    id: mintDomainId(Date.now()),
    requestId: args.clientRequestId,
    uploaderId: ownerId(a),
    name: args.fileName.trim(),
    mimeType: args.mimeType,
    byteSize: args.byteSize,
    checksum: args.checksum,
    kind,
    state: "uploading",
    previewState: "pending",
    originalReady: false,
    keepInLibrary: !args.context,
    contexts: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    trashedAt: null,
    error: null,
  });
  if (args.context) await patchAsset(ctx, id, { contexts: [args.context] });
  return (await ctx.db.get(id))!;
}
export const reserve = internalMutation({ args: uploadArgs, handler: reserveUpload });

export const setUpload = internalMutation({
  args: { ...base, key: v.string(), url: v.string() },
  handler: async (ctx, args) => {
    const { row, actor } = await access(ctx, args);
    if (row.uploaderId !== ownerId(actor) && !admin(actor)) throw denied();
    if (
      row.state !== "uploading" ||
      (row.uploadUrl && (row.uploadExpiresAt ?? 0) > Date.now() + 30_000)
    ) {
      if (row.key !== args.key)
        await ctx.scheduler.runAfter(
          0,
          makeFunctionReference<"action", { keys: string[] }, null>("assetStorage:deleteObjects"),
          { keys: [args.key] },
        );
      return row.state === "uploading" ? (row.uploadUrl ?? null) : null;
    }
    if (row.key && row.key !== args.key)
      await ctx.scheduler.runAfter(
        0,
        makeFunctionReference<"action", { keys: string[] }, null>("assetStorage:deleteObjects"),
        { keys: [row.key] },
      );
    await patchAsset(ctx, row._id, {
      key: args.key,
      uploadUrl: args.url,
      uploadExpiresAt: Date.now() + 600_000,
    });
    return args.url;
  },
});
export const uploadRecord = internalQuery({
  args: base,
  handler: async (ctx, args) => {
    const { row, actor } = await access(ctx, args);
    if (row.uploaderId !== ownerId(actor) && !admin(actor)) throw denied();
    return row;
  },
});
export const complete = internalMutation({
  args: {
    ...base,
    key: v.string(),
    byteSize: v.number(),
    checksum: v.string(),
    previewReady: v.boolean(),
  },
  handler: async (ctx, args) => {
    const { row, actor } = await access(ctx, args);
    if ((row.uploaderId !== ownerId(actor) && !admin(actor)) || row.key !== args.key)
      throw denied();
    if (row.originalReady) return wire(ctx, actor, row);
    if (row.state !== "uploading")
      throw backendError("upload-expired", "Upload reservation expired.");
    if (row.byteSize !== args.byteSize || row.checksum !== args.checksum)
      throw backendError("asset-integrity-mismatch", "Stored bytes do not match the original.");
    const q = await quota(ctx, actor);
    if (!q) throw new Error("Missing quota reservation");
    const previewReady =
      args.previewReady && (row.kind !== "image" || row.byteSize <= 10 * 1024 * 1024);
    await ctx.db.patch(q._id, {
      reservedBytes: q.reservedBytes - row.byteSize,
      usedBytes: q.usedBytes + row.byteSize,
    });
    await patchAsset(ctx, row._id, {
      originalReady: true,
      state: previewReady || row.kind === "file" || row.kind === "document" ? "ready" : "preparing",
      previewState: previewReady
        ? "ready"
        : row.kind === "file" || row.kind === "document"
          ? "unsupported"
          : "pending",
      updatedAt: Date.now(),
      uploadUrl: undefined,
      error: null,
    });
    return wire(ctx, actor, (await ctx.db.get(row._id))!);
  },
});
const reserveRef = makeFunctionReference<
  "mutation",
  {
    companyId: string;
    clientRequestId: string;
    fileName: string;
    mimeType: string;
    byteSize: number;
    checksum: string;
    context?: AssetContext;
  },
  Doc<"assets">
>("assets:reserve");
const storagePrepare = makeFunctionReference<
  "action",
  { fileName: string; mimeType: string; byteSize: number; customId: string },
  { key: string; url: string }
>("assetStorage:prepare");
export const prepareUpload = action({
  args: uploadArgs,
  handler: async (
    ctx,
    args,
  ): Promise<{ assetId: string; uploadUrl: string | null; state: string }> => {
    const row = await ctx.runMutation(reserveRef, args);
    if (row.originalReady) return { assetId: row.id, uploadUrl: null, state: row.state };
    if (row.uploadUrl && (row.uploadExpiresAt ?? 0) > Date.now() + 30_000)
      return { assetId: row.id, uploadUrl: row.uploadUrl, state: row.state };
    const prepared = await ctx.runAction(storagePrepare, {
      fileName: row.name,
      mimeType: row.mimeType,
      byteSize: row.byteSize,
      customId: row.id,
    });
    const uploadUrl = await ctx.runMutation(
      makeFunctionReference<
        "mutation",
        { companyId: string; assetId: string; key: string; url: string },
        string | null
      >("assets:setUpload"),
      { companyId: args.companyId, assetId: row.id, ...prepared },
    );
    return { assetId: row.id, uploadUrl, state: uploadUrl ? "uploading" : "ready" };
  },
});
export const finalizeUpload = action({
  args: base,
  handler: async (ctx, args): Promise<Asset> => {
    const row = await ctx.runQuery(
      makeFunctionReference<"query", { companyId: string; assetId: string }, Doc<"assets">>(
        "assets:uploadRecord",
      ),
      args,
    );
    if (!row.key) throw backendError("upload-incomplete", "Upload has not started.");
    const checked = await ctx.runAction(
      makeFunctionReference<
        "action",
        { key: string; maxBytes: number },
        { byteSize: number; checksum: string; previewReady: boolean }
      >("assetStorage:verify"),
      { key: row.key, maxBytes: row.byteSize },
    );
    return ctx.runMutation(
      makeFunctionReference<
        "mutation",
        {
          companyId: string;
          assetId: string;
          key: string;
          byteSize: number;
          checksum: string;
          previewReady: boolean;
        },
        Asset
      >("assets:complete"),
      { ...args, key: row.key, ...checked },
    );
  },
});
async function revoke(ctx: MutationCtx, r: Doc<"assets">) {
  for (const g of await ctx.db
    .query("assetGrants")
    .withIndex("by_asset", (q) => q.eq("companyId", r.companyId).eq("assetId", r.id))
    .collect())
    if (g.revokedAt === null) await ctx.db.patch(g._id, { revokedAt: Date.now() });
}
export const rename = mutation({
  args: { ...base, name: v.string() },
  handler: async (ctx, args) => {
    const { row } = await access(ctx, args, true);
    if (!args.name.trim() || args.name.length > 255)
      throw backendError("invalid-arguments", "Name must contain 1–255 characters.");
    await patchAsset(ctx, row._id, { name: args.name.trim(), updatedAt: Date.now() });
  },
});
export const keep = mutation({
  args: { ...base, keep: v.boolean() },
  handler: async (ctx, args) => {
    const { row } = await access(ctx, args, true);
    await patchAsset(ctx, row._id, { keepInLibrary: args.keep, updatedAt: Date.now() });
  },
});
export const trash = mutation({
  args: base,
  handler: async (ctx, args) => {
    const { row } = await access(ctx, args, true);
    if (row.state === "purged" || row.state === "trashed") return;
    await revoke(ctx, row);
    await patchAsset(ctx, row._id, {
      state: "trashed",
      trashedAt: Date.now(),
      updatedAt: Date.now(),
    });
  },
});
export const restore = mutation({
  args: base,
  handler: async (ctx, args) => {
    const { row } = await access(ctx, args, true);
    if (row.state !== "trashed") return;
    const contexts: AssetContext[] = [];
    for (const c of row.contexts) if (await contextExists(ctx, row.companyId, c)) contexts.push(c);
    await patchAsset(ctx, row._id, {
      state: row.originalReady
        ? row.previewState === "pending"
          ? "preparing"
          : "ready"
        : "failed",
      processingLease: undefined,
      processingEnvironmentId: undefined,
      processingExpiresAt: 0,
      contexts,
      trashedAt: null,
      updatedAt: Date.now(),
    });
  },
});
export const attach = mutation({
  args: { ...base, context: assetContext, confirmBroaderAccess: v.boolean() },
  handler: async (ctx, args) => {
    const { row, actor } = await access(ctx, args);
    if (
      row.state === "trashed" ||
      row.state === "purged" ||
      !(await contextAllowed(ctx, actor, args.context))
    )
      throw denied();
    if (row.contexts.some((c) => contextKey(c) === contextKey(args.context))) return;
    if (actor.kind === "environment" || !args.confirmBroaderAccess)
      throw backendError(
        "confirmation-required",
        "Attaching to a new context requires explicit visibility confirmation.",
      );
    await patchAsset(ctx, row._id, {
      contexts: [...row.contexts, args.context],
      updatedAt: Date.now(),
    });
  },
});
export const detach = mutation({
  args: { ...base, context: assetContext },
  handler: async (ctx, args) => {
    const { row } = await access(ctx, args, true);
    const contexts = row.contexts.filter((c) => contextKey(c) !== contextKey(args.context));
    await patchAsset(ctx, row._id, { contexts, updatedAt: Date.now() });
    if (!contexts.length && !row.keepInLibrary) {
      await revoke(ctx, row);
      await patchAsset(ctx, row._id, { state: "trashed", trashedAt: Date.now() });
    }
  },
});
function deliveryOrigin() {
  const origin = process.env.CONVEX_SITE_URL;
  if (!origin)
    throw backendError("asset-delivery-unconfigured", "Asset delivery origin is not configured.");
  return origin;
}
export const resolve = mutation({
  args: {
    ...base,
    representation: v.optional(
      v.union(v.literal("original"), v.literal("preview"), v.literal("poster")),
    ),
  },
  handler: async (ctx, args) => {
    const { row, actor } = await access(ctx, args);
    if (
      actor.kind === "environment" &&
      (!args.context ||
        !row.contexts.some(
          (c) =>
            c.kind === args.context!.kind &&
            c.id === args.context!.id &&
            c.environmentId === args.context!.environmentId,
        ) ||
        !(await contextAllowed(ctx, actor, args.context)))
    )
      throw denied();
    if (
      !row.originalReady ||
      row.state === "purged" ||
      (args.representation === "preview" && row.previewState !== "ready")
    )
      throw backendError("asset-not-ready", "The requested representation is not ready.");
    const representation =
      args.representation && args.representation !== "original"
        ? (
            await ctx.db
              .query("assetRepresentations")
              .withIndex("by_asset", (q) => q.eq("companyId", row.companyId).eq("assetId", row.id))
              .collect()
          ).find((r) => r.kind === args.representation && r.state === "ready")
        : undefined;
    if (args.representation === "poster" && !representation)
      throw backendError("asset-not-ready", "Poster is not ready.");
    const token = mintDomainId(Date.now()) + mintDomainId(Date.now());
    const expiresAt = Date.now() + 15 * 60_000;
    await ctx.db.insert("assetGrants", {
      companyId: row.companyId,
      assetId: row.id,
      token,
      kind: "read",
      ...(representation ? { representationId: representation._id } : {}),
      ...(args.context ? { context: args.context } : {}),
      ...(actor.kind === "member"
        ? { membershipId: actor.membership._id }
        : { environmentId: actor.registration.environmentId }),
      expiresAt,
      revokedAt: null,
      createdAt: Date.now(),
    });
    return {
      url: `${deliveryOrigin()}/assets/read?token=${token}`,
      expiresAt,
      name: representation?.name ?? row.name,
      mimeType: representation?.mimeType ?? row.mimeType,
      byteSize: representation?.byteSize ?? row.byteSize,
      checksum: representation?.checksum ?? row.checksum,
    };
  },
});
export const share = mutation({
  args: { ...base, expiresInDays: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const { row, actor } = await access(ctx, args, true);
    if (!shareable(actor, row) || !row.originalReady || row.state !== "ready") throw denied();
    const days = args.expiresInDays ?? 7;
    if (!Number.isFinite(days) || days <= 0 || days > 30)
      throw backendError("invalid-arguments", "Share expiry must be between zero and 30 days.");
    const token = mintDomainId(Date.now()) + mintDomainId(Date.now()),
      expiresAt = Date.now() + days * 86400_000;
    const id = await ctx.db.insert("assetGrants", {
      companyId: row.companyId,
      assetId: row.id,
      token,
      kind: "share",
      expiresAt,
      revokedAt: null,
      createdAt: Date.now(),
    });
    return { shareId: id, url: `${deliveryOrigin()}/assets/read?token=${token}`, expiresAt };
  },
});
export const revokeShare = mutation({
  args: { ...base, shareId: v.string() },
  handler: async (ctx, args) => {
    const { row, actor } = await access(ctx, args, true);
    if (!shareable(actor, row)) throw denied();
    const id = ctx.db.normalizeId("assetGrants", args.shareId),
      g = id ? await ctx.db.get(id) : null;
    if (!g || g.assetId !== row.id || g.companyId !== row.companyId || g.kind !== "share")
      throw denied();
    await ctx.db.patch(g._id, { revokedAt: Date.now() });
  },
});
export const authorizeRead = internalQuery({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    const g = await ctx.db
      .query("assetGrants")
      .withIndex("by_token", (q) => q.eq("token", args.token))
      .unique();
    if (!g || g.revokedAt !== null || g.expiresAt <= Date.now()) return null;
    const company = await ctx.db.get(g.companyId);
    if (!company || company.lifecycleState !== "active") return null;
    const r = await ctx.db
      .query("assets")
      .withIndex("by_identity", (q) => q.eq("companyId", g.companyId).eq("id", g.assetId))
      .unique();
    if (!r?.originalReady || !r.key || r.state === "purged") return null;
    if (g.kind === "share") {
      if (r.state === "trashed") return null;
    } else if (g.membershipId) {
      const membership = await ctx.db.get(g.membershipId);
      if (!membership || membership.state !== "active") return null;
      const user = await ctx.db.get(membership.userId);
      if (!user) return null;
      const isOwner =
        (await ctx.db
          .query("companyOwners")
          .withIndex("by_company_and_membership", (q) =>
            q.eq("companyId", company._id).eq("membershipId", membership._id),
          )
          .unique()) !== null;
      const authorization = await membershipAuthorization(ctx, membership, isOwner);
      const actor: MemberActor = {
        kind: "member",
        company,
        user,
        membership,
        isOwner,
        ...authorization,
      };
      if (!(await visible(ctx, actor, r))) return null;
    } else if (g.environmentId) {
      const registration = await ctx.db
        .query("environmentRegistrations")
        .withIndex("by_company_and_environment", (q) =>
          q.eq("companyId", company._id).eq("environmentId", g.environmentId!),
        )
        .unique();
      if (
        !registration ||
        registration.state !== "active" ||
        r.state === "trashed" ||
        (!g.lease &&
          !r.contexts.some(
            (c) =>
              c.kind === "thread" &&
              c.environmentId === g.environmentId &&
              (!g.context || c.id === g.context.id),
          ))
      )
        return null;
      if (g.lease) {
        if (registration.teamIds.length) return null;
        let permitted = false;
        for (const id of registration.serviceRoleIds) {
          const role = await ctx.db
            .query("roles")
            .withIndex("by_company_and_domain_id", (q) =>
              q.eq("companyId", company._id).eq("id", id),
            )
            .unique();
          if (role?.permissions.includes("assets.process")) permitted = true;
        }
        if (!permitted) return null;
      }
    } else return null;
    if (
      g.lease &&
      (r.processingLease !== g.lease ||
        r.processingEnvironmentId !== g.environmentId ||
        (r.processingExpiresAt ?? 0) <= Date.now())
    )
      return null;
    const representation = g.representationId ? await ctx.db.get(g.representationId) : null;
    if (
      g.representationId &&
      (!representation || representation.state !== "ready" || !representation.key)
    )
      return null;
    return {
      key: representation?.key ?? r.key,
      name: representation?.name ?? r.name,
      mimeType: representation?.mimeType ?? r.mimeType,
      byteSize: representation?.byteSize ?? r.byteSize,
    };
  },
});

const leaseArgs = { ...base, leaseToken: v.string() };
async function processingActor(ctx: QueryCtx, companyId: string) {
  const a = await requireCompanyActor(ctx, companyId);
  if (a.kind !== "environment" || !a.permissions.company.has("assets.process")) throw denied();
  return a;
}
async function leased(
  ctx: QueryCtx,
  args: { companyId: string; assetId: string; leaseToken: string },
) {
  const actor = await processingActor(ctx, args.companyId),
    row = await find(ctx, actor, args.assetId);
  if (
    !row ||
    row.state !== "preparing" ||
    row.processingEnvironmentId !== actor.registration.environmentId ||
    row.processingLease !== args.leaseToken ||
    (row.processingExpiresAt ?? 0) <= Date.now()
  )
    throw backendError("asset-lease-expired", "Processing claim is no longer current.");
  return { actor, row };
}
export const claimProcessing = mutation({
  args: { companyId: v.string() },
  handler: async (ctx, args) => {
    const actor = await processingActor(ctx, args.companyId);
    const row = await ctx.db
      .query("assets")
      .withIndex("by_processing", (q) =>
        q
          .eq("companyId", actor.company._id)
          .eq("state", "preparing")
          .eq("processingLease", undefined),
      )
      .first();
    if (!row) return null;
    const leaseToken = mintDomainId(Date.now()),
      expiresAt = Date.now() + 600_000,
      token = mintDomainId(Date.now()) + mintDomainId(Date.now());
    await patchAsset(ctx, row._id, {
      processingEnvironmentId: actor.registration.environmentId,
      processingLease: leaseToken,
      processingExpiresAt: expiresAt,
    });
    await ctx.scheduler.runAfter(
      600_000,
      makeFunctionReference<
        "mutation",
        { assetDocId: Doc<"assets">["_id"]; leaseToken: string },
        null
      >("assets:releaseProcessing"),
      { assetDocId: row._id, leaseToken },
    );
    await ctx.db.insert("assetGrants", {
      companyId: row.companyId,
      assetId: row.id,
      token,
      kind: "read",
      environmentId: actor.registration.environmentId,
      lease: leaseToken,
      expiresAt,
      revokedAt: null,
      createdAt: Date.now(),
    });
    return {
      assetId: row.id,
      leaseToken,
      expiresAt,
      original: {
        url: `${deliveryOrigin()}/assets/read?token=${token}`,
        name: row.name,
        mimeType: row.mimeType,
        byteSize: row.byteSize,
      },
      required: row.kind === "video" ? ["preview", "poster"] : ["preview"],
    };
  },
});
const representationArgs = {
  ...leaseArgs,
  kind: v.union(v.literal("preview"), v.literal("poster")),
  fileName: v.string(),
  mimeType: v.string(),
  byteSize: v.number(),
  checksum: v.string(),
};
export const reserveRepresentation = internalMutation({
  args: representationArgs,
  handler: async (ctx, args) => {
    const { actor, row } = await leased(ctx, args);
    if (
      !Number.isSafeInteger(args.byteSize) ||
      args.byteSize <= 0 ||
      !/^[a-f0-9]{64}$/.test(args.checksum)
    )
      throw backendError("invalid-arguments", "Invalid representation size or checksum.");
    const existing = (
      await ctx.db
        .query("assetRepresentations")
        .withIndex("by_asset", (q) => q.eq("companyId", row.companyId).eq("assetId", row.id))
        .collect()
    ).find(
      (r) =>
        r.lease === args.leaseToken &&
        r.kind === args.kind &&
        r.checksum === args.checksum &&
        r.state !== "failed",
    );
    if (existing) return existing._id;
    const q = await quota(ctx, actor);
    if (
      !q ||
      args.byteSize > q.maxFileBytes ||
      q.usedBytes + q.reservedBytes + args.byteSize > q.maxBytes
    )
      throw backendError("asset-quota-exceeded", "Representation exceeds storage quota.");

    await ctx.db.patch(q._id, { reservedBytes: q.reservedBytes + args.byteSize });
    return ctx.db.insert("assetRepresentations", {
      companyId: row.companyId,
      assetId: row.id,
      kind: args.kind,
      name: args.fileName,
      lease: args.leaseToken,
      byteSize: args.byteSize,
      checksum: args.checksum,
      mimeType: args.mimeType,
      state: "uploading",
      createdAt: Date.now(),
    });
  },
});
export const setRepresentationKey = internalMutation({
  args: {
    ...leaseArgs,
    representationId: v.id("assetRepresentations"),
    key: v.string(),
    url: v.string(),
  },
  handler: async (ctx, args) => {
    const { row } = await leased(ctx, args);
    const r = await ctx.db.get(args.representationId);
    if (!r || r.companyId !== row.companyId || r.assetId !== row.id || r.lease !== args.leaseToken)
      throw denied();
    if (r.key && r.uploadUrl) {
      if (r.key !== args.key)
        await ctx.scheduler.runAfter(
          0,
          makeFunctionReference<"action", { keys: string[] }, null>("assetStorage:deleteObjects"),
          { keys: [args.key] },
        );
      return r.uploadUrl;
    }
    await ctx.db.patch(r._id, { key: args.key, uploadUrl: args.url });
    return args.url;
  },
});
export const representationRecord = internalQuery({
  args: { ...leaseArgs, representationId: v.id("assetRepresentations") },
  handler: async (ctx, args) => {
    const { row } = await leased(ctx, args),
      r = await ctx.db.get(args.representationId);
    if (
      !r ||
      r.companyId !== row.companyId ||
      r.assetId !== row.id ||
      r.lease !== args.leaseToken ||
      !r.key
    )
      throw denied();
    return r;
  },
});
export const completeRepresentation = internalMutation({
  args: {
    ...leaseArgs,
    representationId: v.id("assetRepresentations"),
    byteSize: v.number(),
    checksum: v.string(),
  },
  handler: async (ctx, args) => {
    const { actor, row } = await leased(ctx, args),
      r = await ctx.db.get(args.representationId);
    if (!r || r.companyId !== row.companyId || r.assetId !== row.id || r.lease !== args.leaseToken)
      throw denied();
    if (r.byteSize !== args.byteSize || r.checksum !== args.checksum)
      throw backendError("asset-integrity-mismatch", "Representation bytes do not match.");
    if (r.state !== "ready") {
      const q = await quota(ctx, actor);
      if (!q) throw new Error("Missing representation quota");
      await ctx.db.patch(q._id, {
        reservedBytes: q.reservedBytes - r.byteSize,
        usedBytes: q.usedBytes + r.byteSize,
      });
      await ctx.db.patch(r._id, { state: "ready" });
    }
    const representations = await ctx.db
      .query("assetRepresentations")
      .withIndex("by_asset", (q) => q.eq("companyId", row.companyId).eq("assetId", row.id))
      .collect();
    const ready =
      representations.some((r) => r.kind === "preview" && r.state === "ready") &&
      (row.kind !== "video" ||
        representations.some((r) => r.kind === "poster" && r.state === "ready"));
    await patchAsset(ctx, row._id, {
      state: ready ? "ready" : "preparing",
      previewState: representations.some((r) => r.kind === "preview" && r.state === "ready")
        ? "ready"
        : "pending",
      updatedAt: Date.now(),
      error: null,
    });
    return wire(ctx, actor, (await ctx.db.get(row._id))!);
  },
});
export const prepareRepresentation = action({
  args: representationArgs,
  handler: async (
    ctx,
    args,
  ): Promise<{ uploadUrl: string; representationId: Doc<"assetRepresentations">["_id"] }> => {
    const representationId = await ctx.runMutation(
      makeFunctionReference<
        "mutation",
        {
          companyId: string;
          assetId: string;
          leaseToken: string;
          kind: "preview" | "poster";
          fileName: string;
          mimeType: string;
          byteSize: number;
          checksum: string;
        },
        Doc<"assetRepresentations">["_id"]
      >("assets:reserveRepresentation"),
      args,
    );
    const result = await ctx.runAction(storagePrepare, {
      fileName: args.fileName,
      mimeType: args.mimeType,
      byteSize: args.byteSize,
      customId: representationId,
    });
    const uploadUrl = await ctx.runMutation(
      makeFunctionReference<
        "mutation",
        {
          companyId: string;
          assetId: string;
          leaseToken: string;
          representationId: Doc<"assetRepresentations">["_id"];
          key: string;
          url: string;
        },
        string
      >("assets:setRepresentationKey"),
      {
        companyId: args.companyId,
        assetId: args.assetId,
        leaseToken: args.leaseToken,
        representationId,
        key: result.key,
        url: result.url,
      },
    );
    return { uploadUrl, representationId };
  },
});
export const finalizeRepresentation = action({
  args: { ...leaseArgs, representationId: v.id("assetRepresentations") },
  handler: async (ctx, args): Promise<Asset> => {
    const r = await ctx.runQuery(
      makeFunctionReference<
        "query",
        {
          companyId: string;
          assetId: string;
          leaseToken: string;
          representationId: Doc<"assetRepresentations">["_id"];
        },
        Doc<"assetRepresentations">
      >("assets:representationRecord"),
      args,
    );
    const result = await ctx.runAction(
      makeFunctionReference<
        "action",
        { key: string; maxBytes: number },
        { byteSize: number; checksum: string; previewReady: boolean }
      >("assetStorage:verify"),
      { key: r.key!, maxBytes: r.byteSize },
    );
    return ctx.runMutation(
      makeFunctionReference<
        "mutation",
        {
          companyId: string;
          assetId: string;
          leaseToken: string;
          representationId: Doc<"assetRepresentations">["_id"];
          byteSize: number;
          checksum: string;
        },
        Asset
      >("assets:completeRepresentation"),
      { ...args, byteSize: result.byteSize, checksum: result.checksum },
    );
  },
});
export const failProcessing = mutation({
  args: { ...leaseArgs, error: v.string() },
  handler: async (ctx, args) => {
    const { row } = await leased(ctx, args);
    await patchAsset(ctx, row._id, {
      state: "ready",
      previewState: "failed",
      error: args.error.slice(0, 300),
      processingLease: undefined,
      processingEnvironmentId: undefined,
      processingExpiresAt: 0,
      updatedAt: Date.now(),
    });
  },
});
export const retryProcessing = mutation({
  args: base,
  handler: async (ctx, args) => {
    const { row } = await access(ctx, args, true);
    if (row.originalReady && row.state === "ready" && row.previewState === "failed")
      await patchAsset(ctx, row._id, {
        state: "preparing",
        previewState: "pending",
        error: null,
        processingLease: undefined,
        processingEnvironmentId: undefined,
        processingExpiresAt: 0,
        updatedAt: Date.now(),
      });
  },
});

export const configureQuota = mutation({
  args: { companyId: v.string(), maxBytes: v.number(), maxFileBytes: v.number() },
  handler: async (ctx, args) => {
    const actor = await requireCompanyActor(ctx, args.companyId);
    if (!admin(actor)) throw denied();
    if (
      !Number.isSafeInteger(args.maxBytes) ||
      !Number.isSafeInteger(args.maxFileBytes) ||
      args.maxFileBytes <= 0 ||
      args.maxFileBytes > ASSET_MAX_FILE_BYTES ||
      args.maxBytes < args.maxFileBytes
    )
      throw backendError(
        "invalid-arguments",
        "Invalid storage limits; current per-file deployment ceiling is 250 MB.",
      );
    const q = await quota(ctx, actor);
    if (q) {
      if (args.maxBytes < q.usedBytes + q.reservedBytes)
        throw backendError(
          "asset-quota-exceeded",
          "The new quota is below stored and reserved bytes.",
        );
      await ctx.db.patch(q._id, { maxBytes: args.maxBytes, maxFileBytes: args.maxFileBytes });
    } else
      await ctx.db.insert("assetQuotas", {
        companyId: actor.company._id,
        ...defaultUsage,
        maxBytes: args.maxBytes,
        maxFileBytes: args.maxFileBytes,
      });
  },
});
/** Bounded cleanup; bytes are deleted before their quota is released. Retried jobs are idempotent. */
export const cleanupCandidates = internalQuery({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - 30 * 86400_000;
    const trash = await ctx.db
      .query("assets")
      .withIndex("by_state", (q) => q.eq("state", "trashed"))
      .filter((q) => q.lte(q.field("trashedAt"), cutoff))
      .take(50);
    const pending = await ctx.db
      .query("assets")
      .withIndex("by_state", (q) => q.eq("state", "uploading"))
      .filter((q) => q.lt(q.field("createdAt"), Date.now() - 3600_000))
      .take(50);
    const failed = await ctx.db
      .query("assets")
      .withIndex("by_state", (q) => q.eq("state", "purged"))
      .filter((q) => q.neq(q.field("key"), undefined))
      .take(50);
    return [...trash, ...pending, ...failed].map((r) => ({ id: r._id, key: r.key ?? null }));
  },
});
export const cleanupKeys = internalQuery({
  args: { id: v.id("assets") },
  handler: async (ctx, args) => {
    const r = await ctx.db.get(args.id);
    if (!r) return [];
    const representations = await ctx.db
      .query("assetRepresentations")
      .withIndex("by_asset", (q) => q.eq("companyId", r.companyId).eq("assetId", r.id))
      .collect();
    return [...(r.key ? [r.key] : []), ...representations.flatMap((r) => (r.key ? [r.key] : []))];
  },
});
export const finishCleanup = internalMutation({
  args: { id: v.id("assets") },
  handler: async (ctx, args) => {
    const r = await ctx.db.get(args.id);
    if (!r || r.state !== "purged" || r.error === "storage-cleaned") return;
    const q = await ctx.db
      .query("assetQuotas")
      .withIndex("by_company", (q) => q.eq("companyId", r.companyId))
      .unique();
    const representations = await ctx.db
      .query("assetRepresentations")
      .withIndex("by_asset", (q) => q.eq("companyId", r.companyId).eq("assetId", r.id))
      .collect();
    const used =
      (r.originalReady ? r.byteSize : 0) +
      representations.filter((r) => r.state === "ready").reduce((n, r) => n + r.byteSize, 0);
    const reserved =
      (!r.originalReady ? r.byteSize : 0) +
      representations
        .filter((r) => r.state !== "ready" && !r.cleaned)
        .reduce((n, r) => n + r.byteSize, 0);
    if (q)
      await ctx.db.patch(q._id, {
        usedBytes: Math.max(0, q.usedBytes - used),
        reservedBytes: Math.max(0, q.reservedBytes - reserved),
      });
    for (const representation of representations) await ctx.db.delete(representation._id);
    await revoke(ctx, r);
    await patchAsset(ctx, r._id, {
      state: "purged",
      key: undefined,
      error: "storage-cleaned",
      uploadUrl: undefined,
      originalReady: false,
      updatedAt: Date.now(),
    });
  },
});

export const claimCleanup = internalMutation({
  args: { id: v.id("assets") },
  handler: async (ctx, args) => {
    const r = await ctx.db.get(args.id);
    if (!r) return false;
    if (r.state === "purged") return r.error !== "storage-cleaned";
    if (
      !(
        (r.state === "trashed" && (r.trashedAt ?? Date.now()) <= Date.now() - 30 * 86400_000) ||
        (r.state === "uploading" && r.createdAt < Date.now() - 3600_000)
      )
    )
      return false;
    await revoke(ctx, r);
    await patchAsset(ctx, r._id, { state: "purged", updatedAt: Date.now() });
    return true;
  },
});
/** Queue publication is the uploader's initial attachment, not an implicit cross-context share. */
export async function bindQueuedAsset(
  ctx: MutationCtx,
  actor: MemberActor,
  assetId: string,
  context: AssetContext,
) {
  const row = await find(ctx, actor, assetId);
  if (
    !row ||
    row.uploaderId !== actor.membership.id ||
    !row.originalReady ||
    row.state === "trashed" ||
    row.state === "purged" ||
    !(await contextAllowed(ctx, actor, context))
  )
    throw denied();
  if (row.contexts.some((c) => contextKey(c) === contextKey(context))) return;
  if (
    row.contexts.length &&
    !row.contexts.some(
      (c) =>
        c.kind === context.kind && c.id === context.id && c.environmentId === context.environmentId,
    )
  )
    throw backendError(
      "confirmation-required",
      "Reuse in another conversation requires explicit visibility confirmation.",
    );
  await patchAsset(ctx, row._id, {
    contexts: [...row.contexts, context],
    keepInLibrary: false,
    updatedAt: Date.now(),
  });
}
export async function queuedAssetMetadata(ctx: QueryCtx, actor: CompanyActor, assetId: string) {
  const row = await find(ctx, actor, assetId);
  if (
    !row ||
    !row.originalReady ||
    row.state === "trashed" ||
    row.state === "purged" ||
    !(await visible(ctx, actor, row))
  )
    throw denied();
  return {
    type: "asset" as const,
    id: row.id,
    assetId: row.id,
    companyId: actor.company.id,
    name: row.name,
    mimeType: row.mimeType,
    sizeBytes: row.byteSize,
  };
}
export const processingHead = query({
  args: { companyId: v.string() },
  handler: async (ctx, args) => {
    const actor = await processingActor(ctx, args.companyId);
    const row = await ctx.db
      .query("assets")
      .withIndex("by_processing", (q) =>
        q
          .eq("companyId", actor.company._id)
          .eq("state", "preparing")
          .eq("processingLease", undefined),
      )
      .first();
    return { count: row ? 1 : 0, revision: row?.updatedAt ?? 0 };
  },
});
export const releaseProcessing = internalMutation({
  args: { assetDocId: v.id("assets"), leaseToken: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.assetDocId);
    if (
      row &&
      row.state === "preparing" &&
      row.processingLease === args.leaseToken &&
      (row.processingExpiresAt ?? 0) <= Date.now()
    )
      await patchAsset(ctx, row._id, {
        processingLease: undefined,
        processingEnvironmentId: undefined,
        processingExpiresAt: 0,
        updatedAt: Date.now(),
      });
  },
});
/** Called only for explicit context deletion, never an environment going offline or unpublishing. */
export async function removeAssetContext(
  ctx: MutationCtx,
  companyId: Doc<"companies">["_id"],
  context: AssetContext,
) {
  for (const row of await ctx.db
    .query("assets")
    .withIndex("by_company", (q) => q.eq("companyId", companyId))
    .collect()) {
    if (row.state === "trashed" || row.state === "purged") continue;
    const contexts = row.contexts.filter(
      (c) =>
        !(
          c.kind === context.kind &&
          c.id === context.id &&
          c.environmentId === context.environmentId
        ),
    );
    if (contexts.length === row.contexts.length) continue;
    await patchAsset(ctx, row._id, { contexts, updatedAt: Date.now() });
    if (!contexts.length && !row.keepInLibrary) {
      await revoke(ctx, row);
      await patchAsset(ctx, row._id, { state: "trashed", trashedAt: Date.now() });
    }
  }
}
/** Read-only adapters inventory existing cloud uploads without changing historical public links. */
export const legacyList = query({
  args: {
    companyId: v.string(),
    source: v.union(v.literal("tasks"), v.literal("queue")),
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const actor = await requireCompanyActor(ctx, args.companyId);
    if (actor.kind !== "member") throw denied();
    if (args.source === "tasks") {
      const page = await ctx.db
        .query("issueAttachments")
        .withIndex("by_company_and_state", (q) =>
          q.eq("companyId", actor.company._id).eq("state", "ready"),
        )
        .paginate({
          cursor: args.cursor ?? null,
          numItems: Math.min(100, Math.max(1, args.limit ?? 40)),
        });
      const items = [];
      for (const r of page.page) {
        if (
          r.deletedAt !== null ||
          !(await contextAllowed(ctx, actor, { kind: "task", id: r.issueId }))
        )
          continue;
        items.push({
          id: r.id,
          name: r.fileName,
          mimeType: r.mimeType,
          byteSize: r.byteSize,
          createdAt: r.createdAt,
          context: { kind: "task" as const, id: r.issueId },
          storage: r.uploadthingFileUrl ? ("legacy-public" as const) : ("legacy-cloud" as const),
          ...(await legacyMigrationStatus(ctx, actor, "tasks", r.id)),
          canMigrate: admin(actor) || r.uploadedByMembershipId === actor.membership._id,
        });
      }
      return { items, nextCursor: page.isDone ? null : page.continueCursor };
    }
    const page = await ctx.db
      .query("threadQueueAttachments")
      .withIndex("by_company_and_member", (q) =>
        q.eq("companyId", actor.company._id).eq("issuedByMembershipId", actor.membership._id),
      )
      .paginate({
        cursor: args.cursor ?? null,
        numItems: Math.min(100, Math.max(1, args.limit ?? 40)),
      });
    return {
      items: await Promise.all(
        page.page.map(async (r) => ({
          id: r._id,
          name: r.attachment.name as string,
          mimeType: r.attachment.mimeType as string,
          byteSize: r.attachment.sizeBytes as number,
          createdAt: r.createdAt,
          storage: "legacy-cloud" as const,
          ...(await legacyMigrationStatus(ctx, actor, "queue", r._id)),
          canMigrate: true,
        })),
      ),
      nextCursor: page.isDone ? null : page.continueCursor,
    };
  },
});
export const claimStaleRepresentations = internalMutation({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("assetRepresentations")
      .filter((q) => q.and(q.neq(q.field("state"), "ready"), q.neq(q.field("cleaned"), true)))
      .take(100);
    const result = [];
    for (const r of rows) {
      const parent = await ctx.db
        .query("assets")
        .withIndex("by_identity", (q) => q.eq("companyId", r.companyId).eq("id", r.assetId))
        .unique();
      if (
        r.state === "uploading" &&
        parent?.state === "preparing" &&
        parent.processingLease === r.lease &&
        (parent.processingExpiresAt ?? 0) > Date.now()
      )
        continue;
      await ctx.db.patch(r._id, { state: "failed" });
      result.push({ id: r._id, key: r.key ?? null });
    }
    return result;
  },
});
export const finishRepresentationCleanup = internalMutation({
  args: { id: v.id("assetRepresentations") },
  handler: async (ctx, args) => {
    const r = await ctx.db.get(args.id);
    if (!r || r.state !== "failed" || r.cleaned) return;
    const q = await ctx.db
      .query("assetQuotas")
      .withIndex("by_company", (q) => q.eq("companyId", r.companyId))
      .unique();
    if (q) await ctx.db.patch(q._id, { reservedBytes: Math.max(0, q.reservedBytes - r.byteSize) });
    await ctx.db.patch(r._id, { key: undefined, uploadUrl: undefined, cleaned: true });
  },
});
const legacyArgs = {
  companyId: v.string(),
  source: v.union(v.literal("tasks"), v.literal("queue")),
  legacyId: v.string(),
};
export const reserveLegacyMigration = internalMutation({
  args: {
    ...legacyArgs,
    provenContexts: v.optional(v.array(assetContext)),
    acceptedAttachmentIds: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const actor = await requireCompanyActor(ctx, args.companyId);
    if (actor.kind !== "member") throw denied();
    let fileName: string,
      mimeType: string,
      byteSize: number,
      sourceUrl: string | null,
      context: AssetContext | undefined;
    let attachmentId: string | undefined;
    if (args.source === "tasks") {
      const r = await ctx.db
        .query("issueAttachments")
        .withIndex("by_company_and_domain_id", (q) =>
          q.eq("companyId", actor.company._id).eq("id", args.legacyId),
        )
        .unique();
      if (
        !r ||
        r.deletedAt !== null ||
        r.state !== "ready" ||
        !(await contextAllowed(ctx, actor, { kind: "task", id: r.issueId })) ||
        (!admin(actor) && r.uploadedByMembershipId !== actor.membership._id)
      )
        throw denied();
      if (r.uploadthingFileUrl) {
        const u = new URL(r.uploadthingFileUrl);
        if (
          u.protocol !== "https:" ||
          !(
            u.hostname === "utfs.io" ||
            u.hostname.endsWith(".utfs.io") ||
            u.hostname.endsWith(".ufs.sh") ||
            u.hostname.endsWith(".uploadthing.com")
          )
        )
          throw backendError("legacy-source-untrusted", "Legacy URL is not an UploadThing object.");
      }
      fileName = r.fileName;
      mimeType = r.mimeType;
      byteSize = r.byteSize;
      sourceUrl =
        r.uploadthingFileUrl ?? (r.storageId ? await ctx.storage.getUrl(r.storageId) : null);
      context = { kind: "task", id: r.issueId };
    } else {
      const id = ctx.db.normalizeId("threadQueueAttachments", args.legacyId),
        r = id ? await ctx.db.get(id) : null;
      if (
        !r ||
        r.companyId !== actor.company._id ||
        (!admin(actor) && r.issuedByMembershipId !== actor.membership._id)
      )
        throw denied();
      attachmentId = String(r.attachment.id);
      fileName = String(r.attachment.name);
      mimeType = String(r.attachment.mimeType);
      byteSize = Number(r.attachment.sizeBytes);
      sourceUrl = await ctx.storage.getUrl(r.storageId);
    }
    if (!sourceUrl)
      throw backendError("asset-unavailable", "The historical cloud original is unavailable.");
    const alias = await ctx.db
      .query("assetLegacyAliases")
      .withIndex("by_source", (q) =>
        q
          .eq("companyId", actor.company._id)
          .eq("source", args.source)
          .eq("legacyId", args.legacyId),
      )
      .unique();
    let retrySuffix = "";
    if (alias) {
      const row = await find(ctx, actor, alias.assetId);
      if (row?.state === "purged" && row.trashedAt === null) {
        await ctx.db.delete(alias._id);
        retrySuffix = `:${mintDomainId(Date.now())}`;
      } else {
        if (!row || row.state === "purged" || row.state === "trashed")
          throw backendError("asset-deleted", "The private replacement was deleted.");
        await bindLegacyUsages(
          ctx,
          actor,
          row,
          args.legacyId,
          args.provenContexts ?? [],
          args.acceptedAttachmentIds ?? [],
        );
        return { row: (await ctx.db.get(row._id))!, sourceUrl };
      }
    }
    const row = await reserveUpload(ctx, {
      companyId: args.companyId,
      clientRequestId: `migration:${args.source}:${args.legacyId}${retrySuffix}`,
      fileName,
      mimeType,
      byteSize,
      checksum: "0".repeat(64),
      ...(context ? { context } : {}),
    });
    await ctx.db.insert("assetLegacyAliases", {
      companyId: actor.company._id,
      source: args.source,
      legacyId: args.legacyId,
      assetId: row.id,
      ...(attachmentId ? { attachmentId } : {}),
    });
    await bindLegacyUsages(
      ctx,
      actor,
      row,
      args.legacyId,
      args.provenContexts ?? [],
      args.acceptedAttachmentIds ?? [],
    );
    return { row: (await ctx.db.get(row._id))!, sourceUrl };
  },
});
export const completeLegacyMigration = internalMutation({
  args: {
    ...legacyArgs,
    assetId: v.string(),
    key: v.string(),
    byteSize: v.number(),
    checksum: v.string(),
    previewReady: v.boolean(),
  },
  handler: async (ctx, args) => {
    const { actor, row } = await access(ctx, args);
    if (actor.kind !== "member" || (row.uploaderId !== actor.membership.id && !admin(actor)))
      throw denied();
    const alias = await ctx.db
      .query("assetLegacyAliases")
      .withIndex("by_source", (q) =>
        q.eq("companyId", row.companyId).eq("source", args.source).eq("legacyId", args.legacyId),
      )
      .unique();
    if (alias?.assetId !== row.id || row.key !== args.key || row.byteSize !== args.byteSize)
      throw denied();
    if (row.originalReady) return wire(ctx, actor, row);
    if (row.state !== "uploading")
      throw backendError("upload-expired", "Migration upload expired.");
    const q = await quota(ctx, actor);
    if (!q) throw new Error("Missing migration quota");
    await ctx.db.patch(q._id, {
      reservedBytes: q.reservedBytes - row.byteSize,
      usedBytes: q.usedBytes + row.byteSize,
    });
    const ready = args.previewReady && (row.kind !== "image" || row.byteSize <= 10 * 1024 * 1024);
    await patchAsset(ctx, row._id, {
      checksum: args.checksum,
      originalReady: true,
      state: ready || row.kind === "file" || row.kind === "document" ? "ready" : "preparing",
      previewState: ready
        ? "ready"
        : row.kind === "file" || row.kind === "document"
          ? "unsupported"
          : "pending",
      uploadUrl: undefined,
      updatedAt: Date.now(),
      error: null,
    });
    return wire(ctx, actor, (await ctx.db.get(row._id))!);
  },
});
export const migrateLegacy = action({
  args: legacyArgs,
  handler: async (ctx, args): Promise<Asset> => {
    const provenContexts: AssetContext[] = [],
      acceptedAttachmentIds: string[] = [];
    if (args.source === "queue") {
      let cursor: string | null = null;
      do {
        const page: {
          contexts: AssetContext[];
          attachmentIds: string[];
          nextCursor: string | null;
        } = await ctx.runQuery(
          makeFunctionReference<
            "query",
            { companyId: string; legacyId: string; cursor?: string },
            { contexts: AssetContext[]; attachmentIds: string[]; nextCursor: string | null }
          >("assets:legacyQueueUsages"),
          { companyId: args.companyId, legacyId: args.legacyId, ...(cursor ? { cursor } : {}) },
        );
        provenContexts.push(...page.contexts);
        acceptedAttachmentIds.push(...page.attachmentIds);
        cursor = page.nextCursor;
      } while (cursor);
    }
    const { row, sourceUrl } = await ctx.runMutation(
      makeFunctionReference<
        "mutation",
        {
          companyId: string;
          source: "tasks" | "queue";
          legacyId: string;
          provenContexts: AssetContext[];
          acceptedAttachmentIds: string[];
        },
        { row: Doc<"assets">; sourceUrl: string }
      >("assets:reserveLegacyMigration"),
      { ...args, provenContexts, acceptedAttachmentIds },
    );
    if (row.originalReady)
      return ctx.runQuery(
        makeFunctionReference<"query", { companyId: string; assetId: string }, Asset>("assets:get"),
        { companyId: args.companyId, assetId: row.id },
      );
    const prepared = await ctx.runAction(storagePrepare, {
      fileName: row.name,
      mimeType: row.mimeType,
      byteSize: row.byteSize,
      customId: row.id,
    });
    const uploadUrl = await ctx.runMutation(
      makeFunctionReference<
        "mutation",
        { companyId: string; assetId: string; key: string; url: string },
        string | null
      >("assets:setUpload"),
      { companyId: args.companyId, assetId: row.id, ...prepared },
    );
    if (!uploadUrl)
      throw backendError(
        "migration-in-progress",
        "Migration finished concurrently; refresh the asset.",
      );
    const current = await ctx.runQuery(
      makeFunctionReference<"query", { companyId: string; assetId: string }, Doc<"assets">>(
        "assets:uploadRecord",
      ),
      { companyId: args.companyId, assetId: row.id },
    );
    const verified = await ctx.runAction(
      makeFunctionReference<
        "action",
        {
          sourceUrl: string;
          uploadUrl: string;
          key: string;
          fileName: string;
          mimeType: string;
          byteSize: number;
        },
        { byteSize: number; checksum: string; previewReady: boolean }
      >("assetStorage:copyLegacy"),
      {
        sourceUrl,
        uploadUrl,
        key: current.key!,
        fileName: row.name,
        mimeType: row.mimeType,
        byteSize: row.byteSize,
      },
    );
    return ctx.runMutation(
      makeFunctionReference<
        "mutation",
        {
          companyId: string;
          source: "tasks" | "queue";
          legacyId: string;
          assetId: string;
          key: string;
          byteSize: number;
          checksum: string;
          previewReady: boolean;
        },
        Asset
      >("assets:completeLegacyMigration"),
      { ...args, assetId: row.id, key: current.key!, ...verified },
    );
  },
});
export const resolveLegacy = query({
  args: legacyArgs,
  handler: async (ctx, args) => {
    const actor = await requireCompanyActor(ctx, args.companyId);
    let alias = await ctx.db
      .query("assetLegacyAliases")
      .withIndex("by_source", (q) =>
        q
          .eq("companyId", actor.company._id)
          .eq("source", args.source)
          .eq("legacyId", args.legacyId),
      )
      .unique();
    if (!alias)
      alias = await ctx.db
        .query("assetLegacyAliases")
        .withIndex("by_attachment", (q) =>
          q
            .eq("companyId", actor.company._id)
            .eq("source", args.source)
            .eq("attachmentId", args.legacyId),
        )
        .first();
    if (!alias) return null;
    const row = await find(ctx, actor, alias.assetId);
    return row && row.originalReady && (await visible(ctx, actor, row))
      ? wire(ctx, actor, row)
      : null;
  },
});

async function legacyMigrationStatus(
  ctx: QueryCtx,
  actor: CompanyActor,
  source: "tasks" | "queue",
  legacyId: string,
) {
  const alias = await ctx.db
    .query("assetLegacyAliases")
    .withIndex("by_source", (q) =>
      q.eq("companyId", actor.company._id).eq("source", source).eq("legacyId", legacyId),
    )
    .unique();
  const row = alias ? await find(ctx, actor, alias.assetId) : null;
  return {
    migrationState: row?.originalReady ? ("migrated" as const) : ("not-migrated" as const),
    assetId: row?.originalReady ? row.id : null,
  };
}

async function contextExists(ctx: QueryCtx, companyId: Doc<"companies">["_id"], c: AssetContext) {
  if (c.kind === "task") {
    const issue = await ctx.db
      .query("issues")
      .withIndex("by_company_and_domain_id", (q) => q.eq("companyId", companyId).eq("id", c.id))
      .unique();
    return issue !== null && issue.deletedAt === null;
  }
  if (!c.environmentId) return false;
  const thread = await ctx.db
    .query("agentThreads")
    .withIndex("by_company_and_environment_and_thread", (q) =>
      q.eq("companyId", companyId).eq("environmentId", c.environmentId!).eq("threadId", c.id),
    )
    .unique();
  if (thread && thread.shell?.deletedAt == null) return true;
  return (
    await ctx.db
      .query("threadQueueThreads")
      .withIndex("by_company_environment_and_thread", (q) =>
        q.eq("companyId", companyId).eq("environmentId", c.environmentId!).eq("threadId", c.id),
      )
      .collect()
  ).some((t) => t.state !== "canceled");
}

/** Update the small per-thread badge aggregate atomically with attachment/lifecycle changes. */
async function patchAsset(
  ctx: MutationCtx,
  id: Doc<"assets">["_id"],
  patch: {
    [K in keyof Omit<Doc<"assets">, "_id" | "_creationTime">]?: undefined extends Doc<"assets">[K]
      ? Doc<"assets">[K] | undefined
      : Doc<"assets">[K];
  },
) {
  const before = await ctx.db.get(id);
  if (!before) throw new Error("Asset no longer exists.");
  const memberships = (row: Pick<Doc<"assets">, "state" | "contexts">) => {
    const result = new Map<string, { threadId: string; environmentId: string }>();
    if (row.state === "trashed" || row.state === "purged") return result;
    for (const c of row.contexts)
      if (c.kind === "thread" && c.environmentId)
        result.set(`${c.environmentId}:${c.id}`, {
          threadId: c.id,
          environmentId: c.environmentId,
        });
    return result;
  };
  const previous = memberships(before),
    next = memberships({ ...before, ...patch });
  for (const key of new Set([...previous.keys(), ...next.keys()])) {
    const delta = Number(next.has(key)) - Number(previous.has(key));
    if (!delta) continue;
    const context = next.get(key) ?? previous.get(key)!;
    const count = await ctx.db
      .query("assetThreadCounts")
      .withIndex("by_thread", (q) =>
        q
          .eq("companyId", before.companyId)
          .eq("environmentId", context.environmentId)
          .eq("threadId", context.threadId),
      )
      .unique();
    const value = (count?.count ?? 0) + delta;
    if (value <= 0) {
      if (count) await ctx.db.delete(count._id);
    } else if (count) await ctx.db.patch(count._id, { count: value });
    else
      await ctx.db.insert("assetThreadCounts", {
        companyId: before.companyId,
        ...context,
        count: value,
      });
  }
  await ctx.db.patch(id, patch);
}

/** Explicit service-role management is confined to one currently authorized conversation. */
export const agentManage = mutation({
  args: {
    ...base,
    context: assetContext,
    operation: v.union(
      v.literal("rename"),
      v.literal("detach"),
      v.literal("trash"),
      v.literal("restore"),
      v.literal("retry"),
      v.literal("share"),
      v.literal("revoke"),
      v.literal("attach"),
    ),
    name: v.optional(v.string()),
    shareId: v.optional(v.string()),
    expiresInDays: v.optional(v.number()),
    explicitUserInstruction: v.optional(v.boolean()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ asset: Asset; share?: { shareId: string; url: string; expiresAt: number } }> => {
    const actor = await requireCompanyActor(ctx, args.companyId);
    if (actor.kind !== "environment" || !actor.permissions.company.has("assets.manage"))
      throw backendError(
        "permission-denied",
        "This environment needs an explicit company assets.manage service grant.",
      );
    if (
      args.context.kind !== "thread" ||
      args.context.environmentId !== actor.registration.environmentId ||
      !(await contextAllowed(ctx, actor, args.context))
    )
      throw denied();
    const row = await find(ctx, actor, args.assetId);
    const sameThread = (context: AssetContext) =>
      context.kind === "thread" &&
      context.id === args.context.id &&
      context.environmentId === args.context.environmentId;
    if (!row || row.contexts.length === 0 || !row.contexts.every(sameThread))
      throw backendError(
        "permission-denied",
        "Agent management requires every asset usage to remain within the current thread. Use the company Assets library for shared or standalone files.",
      );
    if (row.state === "purged")
      throw backendError("asset-deleted", "This asset was permanently deleted.");
    const external = args.operation === "share" || args.operation === "revoke";
    if (external && !actor.permissions.company.has("assets.share"))
      throw backendError(
        "permission-denied",
        "This environment also needs an explicit company assets.share grant.",
      );
    if (
      ["detach", "trash", "share", "revoke", "attach"].includes(args.operation) &&
      args.explicitUserInstruction !== true
    )
      throw backendError(
        "confirmation-required",
        "This operation requires an explicit user instruction. An instruction does not grant additional asset permissions.",
      );
    let shareResult: { shareId: string; url: string; expiresAt: number } | undefined;
    switch (args.operation) {
      case "rename": {
        const name = args.name?.trim();
        if (!name || name.length > 255)
          throw backendError("invalid-arguments", "Name must contain 1–255 characters.");
        await patchAsset(ctx, row._id, { name, updatedAt: Date.now() });
        break;
      }
      case "attach": {
        if (row.state === "trashed")
          throw backendError("asset-deleted", "Restore the asset before attaching it.");
        if (!row.contexts.some((c) => contextKey(c) === contextKey(args.context)))
          await patchAsset(ctx, row._id, {
            contexts: [...row.contexts, args.context],
            updatedAt: Date.now(),
          });
        break;
      }
      case "detach": {
        const contexts = row.contexts.filter((c) =>
          args.context.messageId ? contextKey(c) !== contextKey(args.context) : !sameThread(c),
        );
        await patchAsset(ctx, row._id, { contexts, updatedAt: Date.now() });
        if (!contexts.length && !row.keepInLibrary) {
          await revoke(ctx, row);
          await patchAsset(ctx, row._id, {
            state: "trashed",
            trashedAt: Date.now(),
            updatedAt: Date.now(),
          });
        }
        break;
      }
      case "trash": {
        if (row.state !== "trashed") {
          await revoke(ctx, row);
          await patchAsset(ctx, row._id, {
            state: "trashed",
            trashedAt: Date.now(),
            updatedAt: Date.now(),
          });
        }
        break;
      }
      case "restore": {
        if (row.state === "trashed") {
          const contexts = [];
          for (const context of row.contexts)
            if (await contextExists(ctx, row.companyId, context)) contexts.push(context);
          await patchAsset(ctx, row._id, {
            contexts,
            state: row.originalReady
              ? row.previewState === "pending"
                ? "preparing"
                : "ready"
              : "failed",
            trashedAt: null,
            processingLease: undefined,
            processingEnvironmentId: undefined,
            processingExpiresAt: 0,
            updatedAt: Date.now(),
          });
        }
        break;
      }
      case "retry": {
        if (row.originalReady && row.state === "ready" && row.previewState === "failed")
          await patchAsset(ctx, row._id, {
            state: "preparing",
            previewState: "pending",
            error: null,
            processingLease: undefined,
            processingEnvironmentId: undefined,
            processingExpiresAt: 0,
            updatedAt: Date.now(),
          });
        break;
      }
      case "share": {
        if (!row.originalReady || row.state === "trashed")
          throw backendError("asset-not-ready", "The original is not available for sharing.");
        const days = args.expiresInDays ?? 7;
        if (!Number.isFinite(days) || days <= 0 || days > 30)
          throw backendError("invalid-arguments", "Share expiry must be between zero and 30 days.");
        const token = mintDomainId(Date.now()) + mintDomainId(Date.now()),
          expiresAt = Date.now() + days * 86400_000;
        const id = await ctx.db.insert("assetGrants", {
          companyId: row.companyId,
          assetId: row.id,
          token,
          kind: "share",
          expiresAt,
          revokedAt: null,
          createdAt: Date.now(),
        });
        shareResult = {
          shareId: id,
          url: `${deliveryOrigin()}/assets/read?token=${token}`,
          expiresAt,
        };
        break;
      }
      case "revoke": {
        const id = args.shareId ? ctx.db.normalizeId("assetGrants", args.shareId) : null,
          grant = id ? await ctx.db.get(id) : null;
        if (
          !grant ||
          grant.companyId !== row.companyId ||
          grant.assetId !== row.id ||
          grant.kind !== "share"
        )
          throw denied();
        await ctx.db.patch(grant._id, { revokedAt: Date.now() });
        break;
      }
    }
    return {
      asset: await wire(ctx, actor, (await ctx.db.get(row._id))!),
      ...(shareResult ? { share: shareResult } : {}),
    };
  },
});

/** Only explicit migration walks retained queue metadata; chat lookups remain indexed. */
export const legacyQueueUsages = internalQuery({
  args: { companyId: v.string(), legacyId: v.string(), cursor: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const actor = await requireCompanyActor(ctx, args.companyId);
    if (actor.kind !== "member") throw denied();
    const id = ctx.db.normalizeId("threadQueueAttachments", args.legacyId),
      source = id ? await ctx.db.get(id) : null;
    if (
      !source ||
      source.companyId !== actor.company._id ||
      (!admin(actor) && source.issuedByMembershipId !== actor.membership._id)
    )
      throw denied();
    const page = await ctx.db
      .query("threadQueueMessages")
      .withIndex("by_company_and_command", (q) => q.eq("companyId", actor.company._id))
      .paginate({ cursor: args.cursor ?? null, numItems: 16 });
    const contexts: AssetContext[] = [],
      attachmentIds: string[] = [];
    for (const message of page.page) {
      if (
        message.state === "canceled" ||
        message.issuedByMembershipId !== source.issuedByMembershipId ||
        !message.attachmentIds.includes(args.legacyId)
      )
        continue;
      const candidates = message.queueThreadId
        ? [await ctx.db.get(message.queueThreadId)]
        : await ctx.db
            .query("threadQueueThreads")
            .withIndex("by_company_and_thread", (q) =>
              q.eq("companyId", actor.company._id).eq("threadId", message.threadId),
            )
            .take(2);
      if (candidates.length !== 1) continue;
      const thread = candidates[0];
      if (
        !thread ||
        thread.companyId !== actor.company._id ||
        thread.threadId !== message.threadId ||
        thread.state === "canceled"
      )
        continue;
      const context: AssetContext = {
        kind: "thread",
        id: thread.threadId,
        environmentId: thread.environmentId,
        messageId: message.messageId,
      };
      if (!(await contextAllowed(ctx, actor, context))) continue;
      contexts.push(context);
      if (message.acceptedAt !== null || message.state === "delivered") {
        const id = await legacyAcceptedAttachmentId(thread.threadId, String(source.attachment.id));
        if (id) attachmentIds.push(id);
      }
    }
    return { contexts, attachmentIds, nextCursor: page.isDone ? null : page.continueCursor };
  },
});
async function legacyAcceptedAttachmentId(threadId: string, stableKey: string) {
  const segment = threadId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, 80)
    .replace(/[-_]+$/g, "");
  if (!segment || segment.startsWith("iss_")) return null;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify([threadId, stableKey])),
  );
  const hash = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
  return `${segment}-${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20)}`;
}
async function bindLegacyUsages(
  ctx: MutationCtx,
  actor: MemberActor,
  row: Doc<"assets">,
  sourceLegacyId: string,
  provenContexts: AssetContext[],
  acceptedIds: string[],
) {
  if (!provenContexts.length && !acceptedIds.length) return;
  const sourceId = ctx.db.normalizeId("threadQueueAttachments", sourceLegacyId),
    source = sourceId ? await ctx.db.get(sourceId) : null;
  if (!source || source.companyId !== row.companyId) throw denied();
  const contexts = [...row.contexts],
    validAcceptedIds = new Set<string>();
  for (const context of provenContexts) {
    if (
      !context.messageId ||
      context.kind !== "thread" ||
      !context.environmentId ||
      !(await contextAllowed(ctx, actor, context))
    )
      continue;
    const messages = await ctx.db
      .query("threadQueueMessages")
      .withIndex("by_company_and_message", (q) =>
        q.eq("companyId", row.companyId).eq("messageId", context.messageId!),
      )
      .collect();
    let confirmed = false;
    for (const message of messages) {
      if (
        message.threadId !== context.id ||
        message.state === "canceled" ||
        message.issuedByMembershipId !== source.issuedByMembershipId ||
        !message.attachmentIds.includes(sourceLegacyId)
      )
        continue;
      const candidates = message.queueThreadId
        ? [await ctx.db.get(message.queueThreadId)]
        : await ctx.db
            .query("threadQueueThreads")
            .withIndex("by_company_environment_and_thread", (q) =>
              q
                .eq("companyId", row.companyId)
                .eq("environmentId", context.environmentId!)
                .eq("threadId", context.id),
            )
            .take(2);
      const thread = candidates.length === 1 ? candidates[0] : null;
      if (
        !thread ||
        thread.companyId !== row.companyId ||
        thread.threadId !== context.id ||
        thread.environmentId !== context.environmentId ||
        thread.state === "canceled"
      )
        continue;
      confirmed = true;
      if (message.acceptedAt !== null || message.state === "delivered") {
        const id = await legacyAcceptedAttachmentId(thread.threadId, String(source.attachment.id));
        if (id && acceptedIds.includes(id)) validAcceptedIds.add(id);
      }
    }
    if (!confirmed) continue;
    if (!contexts.some((c) => contextKey(c) === contextKey(context))) contexts.push(context);
  }
  if (contexts.length !== row.contexts.length)
    await patchAsset(ctx, row._id, { contexts, keepInLibrary: false, updatedAt: Date.now() });
  for (const attachmentId of validAcceptedIds) {
    const legacyId = `accepted:${attachmentId}`;
    const existing = await ctx.db
      .query("assetLegacyAliases")
      .withIndex("by_source", (q) =>
        q.eq("companyId", row.companyId).eq("source", "queue").eq("legacyId", legacyId),
      )
      .unique();
    if (existing) {
      if (existing.assetId !== row.id) {
        const previous = await find(ctx, actor, existing.assetId);
        if (previous?.state === "purged" && previous.trashedAt === null)
          await ctx.db.patch(existing._id, { assetId: row.id });
        else
          throw backendError(
            "legacy-alias-conflict",
            "An accepted attachment ID already names another private asset.",
          );
      }
    } else
      await ctx.db.insert("assetLegacyAliases", {
        companyId: row.companyId,
        source: "queue",
        legacyId,
        attachmentId,
        assetId: row.id,
      });
  }
}
