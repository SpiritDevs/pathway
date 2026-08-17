// @effect-diagnostics globalDate:off -- Convex actions and mutations use the platform clock directly.
/**
 * Authorized UploadThing storage for replica-backed issue attachments.
 *
 * UploadThing is only the byte store. Convex owns authorization, metadata, attachment identity,
 * comment binding, and lifecycle. Uploads use public-read ACL because a copied evidence link is
 * intentionally shareable; this module is still the only place the application hands that URL to
 * a caller, and `urls` checks live issue visibility first.
 *
 * @module issueAttachments
 */
import { v } from "convex/values";
import { makeFunctionReference } from "convex/server";
import {
  ISSUE_COMMENT_ATTACHMENT_MAX_BYTES,
  ISSUE_COMMENT_EVIDENCE_VIDEO_MAX_BYTES,
} from "@spiritdevs/contracts";

import type { Doc, Id } from "./_generated/dataModel.js";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  query,
} from "./_generated/server.js";
import type { ActionCtx, MutationCtx, QueryCtx } from "./_generated/server.js";
import { appendCompanyChanges } from "./lib/companyApply.ts";
import { mintDomainId } from "./lib/domainIds.ts";
import { backendError } from "./lib/errors.ts";
import {
  actorRecord,
  requireCompanyActor,
  requireRecordPermission,
  type MemberActor,
} from "./lib/identity.ts";
import { encodeIssueAttachment } from "./lib/issueApply.ts";
import { domainIdArg } from "./lib/validators.ts";

export const ISSUE_ATTACHMENT_PENDING_TTL_MS = 60 * 60 * 1000;
const UPLOAD_URL_TTL_SECONDS = 10 * 60;
const UPLOAD_URL_REUSE_FLOOR_MS = 30_000;
const GC_BATCH_SIZE = 100;

const uploadInput = v.object({
  clientRequestId: v.string(),
  fileName: v.string(),
  mimeType: v.string(),
  byteSize: v.number(),
  checksum: v.string(),
});

const preparedUpload = v.object({
  attachmentId: domainIdArg,
  state: v.union(v.literal("upload-required"), v.literal("ready")),
  uploadUrl: v.union(v.string(), v.null()),
});

const attachmentUrl = v.object({
  attachmentId: domainIdArg,
  fileName: v.string(),
  mimeType: v.string(),
  byteSize: v.number(),
  url: v.string(),
});

export interface UploadThingPreparedUpload {
  readonly key: string;
  readonly url: string;
  readonly expiresAt: number;
}

export interface UploadThingVerifiedUpload {
  readonly key: string;
  readonly url: string;
  readonly byteSize: number;
  readonly mimeType: string | null;
  readonly checksum: string;
}

/** The only outbound UploadThing seam. Tests replace it; no test needs a token or the network. */
export interface UploadThingClient {
  readonly prepareUpload: (input: {
    readonly fileName: string;
    readonly mimeType: string;
    readonly byteSize: number;
    readonly customId: string;
  }) => Promise<UploadThingPreparedUpload>;
  readonly verifyUpload: (key: string) => Promise<UploadThingVerifiedUpload>;
  readonly deleteFiles: (keys: ReadonlyArray<string>) => Promise<void>;
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function uploadThingToken(): string {
  const token = process.env.UPLOADTHING_TOKEN?.trim();
  if (!token) {
    throw backendError(
      "uploadthing-unconfigured",
      "This deployment has no UPLOADTHING_TOKEN configured.",
    );
  }
  return token;
}

async function jsonResponse(response: Response, operation: string): Promise<unknown> {
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw backendError(
      "uploadthing-request-failed",
      `${operation} failed with HTTP ${response.status}${detail ? `: ${detail.slice(0, 300)}` : "."}`,
    );
  }
  return await response.json();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Default-runtime REST client: no Node action module and no UploadThing SDK dependency. */
export function makeUploadThingRestClient(fetcher: FetchLike = fetch): UploadThingClient {
  const headers = () => ({
    "content-type": "application/json",
    "x-uploadthing-api-key": uploadThingToken(),
  });
  return {
    prepareUpload: async (input) => {
      const response = await fetcher("https://api.uploadthing.com/v7/prepareUpload", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          fileName: input.fileName,
          fileSize: input.byteSize,
          fileType: input.mimeType,
          customId: input.customId,
          contentDisposition: "inline",
          acl: "public-read",
          expiresIn: UPLOAD_URL_TTL_SECONDS,
        }),
      });
      const value = await jsonResponse(response, "UploadThing prepareUpload");
      if (!isRecord(value) || typeof value["key"] !== "string" || typeof value["url"] !== "string")
        throw backendError("uploadthing-invalid-response", "UploadThing returned no upload URL.");
      return {
        key: value["key"],
        url: value["url"],
        expiresAt: Date.now() + UPLOAD_URL_TTL_SECONDS * 1000,
      };
    },
    verifyUpload: async (key) => {
      const url = `https://utfs.io/f/${encodeURIComponent(key)}`;
      const response = await fetcher(url, { method: "GET", redirect: "follow" });
      if (!response.ok)
        throw backendError(
          "attachment-upload-incomplete",
          `UploadThing has not stored attachment ${key}.`,
        );
      const bytes = await response.arrayBuffer();
      return {
        key,
        url: response.url || url,
        byteSize: bytes.byteLength,
        mimeType: response.headers.get("content-type")?.split(";", 1)[0]?.toLowerCase() ?? null,
        checksum: await sha256Hex(bytes),
      };
    },
    deleteFiles: async (keys) => {
      if (keys.length === 0) return;
      const response = await fetcher("https://api.uploadthing.com/v6/deleteFiles", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ fileKeys: [...keys] }),
      });
      const value = await jsonResponse(response, "UploadThing deleteFiles");
      if (!isRecord(value) || value["success"] !== true)
        throw backendError("uploadthing-invalid-response", "UploadThing did not confirm deletion.");
    },
  };
}

let uploadThingClient: UploadThingClient | null = null;

/** Installs a hermetic client for tests; `null` restores the deployment REST client. */
export function setUploadThingClient(client: UploadThingClient | null): void {
  uploadThingClient = client;
}

function client(): UploadThingClient {
  return uploadThingClient ?? makeUploadThingRestClient();
}

function normalizeUpload(input: {
  readonly clientRequestId: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly checksum: string;
}) {
  const clientRequestId = input.clientRequestId.trim();
  const fileName = input.fileName.trim();
  const mimeType = input.mimeType.trim().toLowerCase().split(";", 1)[0] ?? "";
  const checksum = input.checksum.trim().toLowerCase();
  if (clientRequestId.length === 0 || clientRequestId.length > 128)
    throw backendError(
      "invalid-arguments",
      "An attachment request id must be 1 to 128 characters.",
    );
  if (fileName.length === 0 || fileName.length > 255)
    throw backendError("invalid-arguments", "An attachment file name must be 1 to 255 characters.");
  if (mimeType.length === 0 || mimeType.length > 100)
    throw backendError("invalid-arguments", "An attachment MIME type must be 1 to 100 characters.");
  if (!Number.isSafeInteger(input.byteSize) || input.byteSize <= 0)
    throw backendError("invalid-arguments", "An attachment must contain bytes.");
  const maxBytes = mimeType.startsWith("image/")
    ? ISSUE_COMMENT_ATTACHMENT_MAX_BYTES
    : mimeType === "video/mp4" || mimeType === "video/webm"
      ? ISSUE_COMMENT_EVIDENCE_VIDEO_MAX_BYTES
      : 0;
  if (maxBytes === 0)
    throw backendError("invalid-arguments", `Unsupported attachment MIME type ${mimeType}.`);
  if (input.byteSize > maxBytes)
    throw backendError("invalid-arguments", `The attachment exceeds the ${maxBytes} byte limit.`);
  if (!/^[a-f0-9]{64}$/.test(checksum))
    throw backendError("invalid-arguments", "An attachment checksum must be SHA-256 hex.");
  return { clientRequestId, fileName, mimeType, byteSize: input.byteSize, checksum } as const;
}

async function issueForUpload(
  ctx: QueryCtx,
  actor: MemberActor,
  issueId: string,
): Promise<Doc<"issues">> {
  const issue = await ctx.db
    .query("issues")
    .withIndex("by_company_and_domain_id", (q) =>
      q.eq("companyId", actor.company._id).eq("id", issueId),
    )
    .unique();
  if (issue === null || issue.deletedAt !== null)
    throw backendError("entity-not-found", `No issue ${issueId}.`);
  requireRecordPermission(actor, "comments.create", issue.teamIds);
  return issue;
}

async function memberForUpload(ctx: QueryCtx, companyId: string): Promise<MemberActor> {
  const actor = await requireCompanyActor(ctx, companyId);
  if (actor.kind !== "member")
    throw backendError(
      "permission-denied",
      "Issue attachments must be uploaded by an active company member.",
    );
  return actor;
}

const beginResult = v.object({
  attachmentDocId: v.id("issueAttachments"),
  attachmentId: domainIdArg,
  state: v.union(v.literal("pending"), v.literal("ready")),
  uploadthingFileKey: v.union(v.string(), v.null()),
  uploadUrl: v.union(v.string(), v.null()),
  uploadExpiresAt: v.union(v.number(), v.null()),
  fileName: v.string(),
  mimeType: v.string(),
  byteSize: v.number(),
});

interface BeginResult {
  readonly attachmentDocId: Id<"issueAttachments">;
  readonly attachmentId: string;
  readonly state: "pending" | "ready";
  readonly uploadthingFileKey: string | null;
  readonly uploadUrl: string | null;
  readonly uploadExpiresAt: number | null;
  readonly fileName: string;
  readonly mimeType: string;
  readonly byteSize: number;
}

interface DeletionTarget {
  readonly docId: Id<"issueAttachments">;
  readonly key: string | null;
}

const functions = {
  beginPrepare: makeFunctionReference<
    "mutation",
    { companyId: string; issueId: string; upload: Parameters<typeof normalizeUpload>[0] },
    BeginResult
  >("issueAttachments:beginPrepare"),
  completePrepare: makeFunctionReference<
    "mutation",
    {
      attachmentDocId: Id<"issueAttachments">;
      key: string;
      uploadUrl: string;
      uploadExpiresAt: number;
    },
    BeginResult
  >("issueAttachments:completePrepare"),
  finalizeCandidate: makeFunctionReference<
    "query",
    { companyId: string; attachmentId: string },
    {
      attachmentDocId: Id<"issueAttachments">;
      key: string;
      fileName: string;
      mimeType: string;
      byteSize: number;
      checksum: string;
      state: "pending" | "ready";
    }
  >("issueAttachments:finalizeCandidate"),
  commitFinalize: makeFunctionReference<
    "mutation",
    {
      companyId: string;
      attachmentId: string;
      key: string;
      url: string;
      byteSize: number;
      checksum: string;
    },
    { status: "ready" | "already-ready" }
  >("issueAttachments:commitFinalize"),
  purgeDeletedRows: makeFunctionReference<"mutation", { targets: DeletionTarget[] }, null>(
    "issueAttachments:purgeDeletedRows",
  ),
  deleteUploadThingFiles: makeFunctionReference<"action", { targets: DeletionTarget[] }, null>(
    "issueAttachments:deleteUploadThingFiles",
  ),
  claimExpiredPending: makeFunctionReference<"mutation", { cutoff: number }, DeletionTarget[]>(
    "issueAttachments:claimExpiredPending",
  ),
} as const;

export const beginPrepare = internalMutation({
  args: { companyId: domainIdArg, issueId: domainIdArg, upload: uploadInput },
  returns: beginResult,
  handler: async (ctx, args) => {
    const actor = await memberForUpload(ctx, args.companyId);
    const issue = await issueForUpload(ctx, actor, args.issueId);
    const upload = normalizeUpload(args.upload);
    const existing = await ctx.db
      .query("issueAttachments")
      .withIndex("by_company_uploader_and_request", (q) =>
        q
          .eq("companyId", actor.company._id)
          .eq("uploadedByMembershipId", actor.membership._id)
          .eq("clientRequestId", upload.clientRequestId),
      )
      .unique();
    if (existing !== null) {
      if (
        existing.issueId !== issue.id ||
        existing.fileName !== upload.fileName ||
        existing.mimeType !== upload.mimeType ||
        existing.byteSize !== upload.byteSize ||
        existing.checksum !== upload.checksum
      )
        throw backendError(
          "attachment-request-conflict",
          "This attachment request id was already used for different metadata.",
        );
      if (existing.deletedAt !== null)
        throw backendError("attachment-deleted", "This attachment upload was already discarded.");
      return {
        attachmentDocId: existing._id,
        attachmentId: existing.id,
        state: existing.state === "ready" ? ("ready" as const) : ("pending" as const),
        uploadthingFileKey: existing.uploadthingFileKey ?? null,
        uploadUrl: existing.uploadthingUploadUrl ?? null,
        uploadExpiresAt: existing.uploadthingUploadExpiresAt ?? null,
        fileName: existing.fileName,
        mimeType: existing.mimeType,
        byteSize: existing.byteSize,
      };
    }

    const now = Date.now();
    const attachmentId = mintDomainId(now);
    const attachmentDocId = await ctx.db.insert("issueAttachments", {
      id: attachmentId,
      companyId: actor.company._id,
      issueId: issue.id,
      commentId: null,
      storageId: null,
      clientRequestId: upload.clientRequestId,
      fileName: upload.fileName,
      mimeType: upload.mimeType,
      byteSize: upload.byteSize,
      checksum: upload.checksum,
      uploadedByMembershipId: actor.membership._id,
      state: "pending",
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      version: 0,
    });
    return {
      attachmentDocId,
      attachmentId,
      state: "pending" as const,
      uploadthingFileKey: null,
      uploadUrl: null,
      uploadExpiresAt: null,
      fileName: upload.fileName,
      mimeType: upload.mimeType,
      byteSize: upload.byteSize,
    };
  },
});

export const completePrepare = internalMutation({
  args: {
    attachmentDocId: v.id("issueAttachments"),
    key: v.string(),
    uploadUrl: v.string(),
    uploadExpiresAt: v.number(),
  },
  returns: beginResult,
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.attachmentDocId);
    if (row === null || row.deletedAt !== null)
      throw backendError("attachment-deleted", "This attachment upload was discarded.");
    if (
      row.uploadthingFileKey === undefined ||
      (row.state === "pending" &&
        (row.uploadthingUploadExpiresAt ?? 0) <= Date.now() + UPLOAD_URL_REUSE_FLOOR_MS)
    ) {
      await ctx.db.patch(row._id, {
        uploadthingFileKey: args.key,
        uploadthingUploadUrl: args.uploadUrl,
        uploadthingUploadExpiresAt: args.uploadExpiresAt,
        updatedAt: Date.now(),
      });
    }
    const current = (await ctx.db.get(row._id))!;
    return {
      attachmentDocId: current._id,
      attachmentId: current.id,
      state: current.state === "ready" ? ("ready" as const) : ("pending" as const),
      uploadthingFileKey: current.uploadthingFileKey ?? null,
      uploadUrl: current.uploadthingUploadUrl ?? null,
      uploadExpiresAt: current.uploadthingUploadExpiresAt ?? null,
      fileName: current.fileName,
      mimeType: current.mimeType,
      byteSize: current.byteSize,
    };
  },
});

export const prepareUpload = action({
  args: { companyId: domainIdArg, issueId: domainIdArg, uploads: v.array(uploadInput) },
  returns: v.array(preparedUpload),
  handler: async (ctx, args) => {
    if (args.uploads.length === 0 || args.uploads.length > 8)
      throw backendError("invalid-arguments", "Prepare between one and eight attachments.");
    const results: Array<{
      attachmentId: string;
      state: "upload-required" | "ready";
      uploadUrl: string | null;
    }> = [];
    for (const upload of args.uploads) {
      let row = await ctx.runMutation(functions.beginPrepare, {
        companyId: args.companyId,
        issueId: args.issueId,
        upload,
      });
      if (row.state === "ready") {
        results.push({ attachmentId: row.attachmentId, state: "ready", uploadUrl: null });
        continue;
      }
      if (
        row.uploadUrl === null ||
        row.uploadExpiresAt === null ||
        row.uploadExpiresAt <= Date.now() + UPLOAD_URL_REUSE_FLOOR_MS
      ) {
        const previousKey = row.uploadthingFileKey;
        const prepared = await client().prepareUpload({
          fileName: row.fileName,
          mimeType: row.mimeType,
          byteSize: row.byteSize,
          customId: row.attachmentId,
        });
        row = await ctx.runMutation(functions.completePrepare, {
          attachmentDocId: row.attachmentDocId,
          key: prepared.key,
          uploadUrl: prepared.url,
          uploadExpiresAt: prepared.expiresAt,
        });
        const unusedKeys = [
          ...(row.uploadthingFileKey !== prepared.key ? [prepared.key] : []),
          ...(previousKey !== null && previousKey !== row.uploadthingFileKey ? [previousKey] : []),
        ];
        if (unusedKeys.length > 0) await client().deleteFiles(unusedKeys);
      }
      if (row.state === "ready") {
        results.push({ attachmentId: row.attachmentId, state: "ready", uploadUrl: null });
      } else if (row.uploadUrl !== null) {
        results.push({
          attachmentId: row.attachmentId,
          state: "upload-required",
          uploadUrl: row.uploadUrl,
        });
      } else {
        throw backendError("attachment-prepare-failed", "No upload URL was retained.");
      }
    }
    return results;
  },
});

export const finalizeCandidate = internalQuery({
  args: { companyId: domainIdArg, attachmentId: domainIdArg },
  returns: v.object({
    attachmentDocId: v.id("issueAttachments"),
    key: v.string(),
    fileName: v.string(),
    mimeType: v.string(),
    byteSize: v.number(),
    checksum: v.string(),
    state: v.union(v.literal("pending"), v.literal("ready")),
  }),
  handler: async (ctx, args) => {
    const actor = await memberForUpload(ctx, args.companyId);
    const row = await ctx.db
      .query("issueAttachments")
      .withIndex("by_company_and_domain_id", (q) =>
        q.eq("companyId", actor.company._id).eq("id", args.attachmentId),
      )
      .unique();
    if (
      row === null ||
      row.deletedAt !== null ||
      row.uploadedByMembershipId !== actor.membership._id ||
      row.uploadthingFileKey === undefined
    )
      throw backendError("entity-not-found", `No pending attachment ${args.attachmentId}.`);
    await issueForUpload(ctx, actor, row.issueId);
    return {
      attachmentDocId: row._id,
      key: row.uploadthingFileKey,
      fileName: row.fileName,
      mimeType: row.mimeType,
      byteSize: row.byteSize,
      checksum: row.checksum,
      state: row.state === "ready" ? ("ready" as const) : ("pending" as const),
    };
  },
});

export const commitFinalize = internalMutation({
  args: {
    companyId: domainIdArg,
    attachmentId: domainIdArg,
    key: v.string(),
    url: v.string(),
    byteSize: v.number(),
    checksum: v.string(),
  },
  returns: v.object({ status: v.union(v.literal("ready"), v.literal("already-ready")) }),
  handler: async (ctx, args) => {
    const actor = await memberForUpload(ctx, args.companyId);
    const row = await ctx.db
      .query("issueAttachments")
      .withIndex("by_company_and_domain_id", (q) =>
        q.eq("companyId", actor.company._id).eq("id", args.attachmentId),
      )
      .unique();
    if (
      row === null ||
      row.deletedAt !== null ||
      row.uploadedByMembershipId !== actor.membership._id ||
      row.uploadthingFileKey !== args.key
    )
      throw backendError("entity-not-found", `No pending attachment ${args.attachmentId}.`);
    const issue = await issueForUpload(ctx, actor, row.issueId);
    if (row.state === "ready") return { status: "already-ready" as const };
    if (row.byteSize !== args.byteSize || row.checksum !== args.checksum)
      throw backendError(
        "attachment-upload-mismatch",
        "The stored attachment bytes do not match the prepared metadata.",
      );
    const now = Date.now();
    await ctx.db.patch(row._id, {
      uploadthingFileUrl: args.url,
      uploadthingUploadUrl: undefined,
      uploadthingUploadExpiresAt: undefined,
      state: "ready",
      updatedAt: now,
    });
    const ready = (await ctx.db.get(row._id))!;
    await appendCompanyChanges(ctx, {
      companyId: actor.company._id,
      actor: actorRecord(actor),
      changes: [
        {
          entityKind: "issueAttachment",
          entityId: ready.id,
          changeKind: "upsert",
          teamIds: issue.teamIds,
          versionDocId: ready._id,
          payload: await encodeIssueAttachment(ctx, actor.company, ready),
        },
      ],
    });
    return { status: "ready" as const };
  },
});

export const finalizeUpload = action({
  args: { companyId: domainIdArg, attachmentId: domainIdArg },
  returns: v.object({ status: v.union(v.literal("ready"), v.literal("already-ready")) }),
  handler: async (ctx, args) => {
    const candidate = await ctx.runQuery(functions.finalizeCandidate, args);
    if (candidate.state === "ready") return { status: "already-ready" as const };
    const verified = await client().verifyUpload(candidate.key);
    if (
      verified.key !== candidate.key ||
      verified.byteSize !== candidate.byteSize ||
      verified.checksum !== candidate.checksum ||
      (verified.mimeType !== null && verified.mimeType !== candidate.mimeType)
    )
      throw backendError(
        "attachment-upload-mismatch",
        "The stored attachment bytes do not match the prepared metadata.",
      );
    return await ctx.runMutation(functions.commitFinalize, {
      companyId: args.companyId,
      attachmentId: args.attachmentId,
      key: verified.key,
      url: verified.url,
      byteSize: verified.byteSize,
      checksum: verified.checksum,
    });
  },
});

export const urls = query({
  args: { companyId: domainIdArg, issueId: domainIdArg, attachmentIds: v.array(domainIdArg) },
  returns: v.array(attachmentUrl),
  handler: async (ctx, args) => {
    const actor = await requireCompanyActor(ctx, args.companyId);
    const issue = await ctx.db
      .query("issues")
      .withIndex("by_company_and_domain_id", (q) =>
        q.eq("companyId", actor.company._id).eq("id", args.issueId),
      )
      .unique();
    if (issue === null || issue.deletedAt !== null)
      throw backendError("entity-not-found", `No issue ${args.issueId}.`);
    requireRecordPermission(actor, "issues.read", issue.teamIds);
    if (args.attachmentIds.length > 8)
      throw backendError("invalid-arguments", "Resolve at most eight attachment URLs.");
    const results: Array<{
      attachmentId: string;
      fileName: string;
      mimeType: string;
      byteSize: number;
      url: string;
    }> = [];
    for (const attachmentId of args.attachmentIds) {
      const row = await ctx.db
        .query("issueAttachments")
        .withIndex("by_company_and_domain_id", (q) =>
          q.eq("companyId", actor.company._id).eq("id", attachmentId),
        )
        .unique();
      if (row === null || row.deletedAt !== null || row.issueId !== issue.id) continue;
      const url =
        row.state === "ready" && row.uploadthingFileUrl !== undefined
          ? row.uploadthingFileUrl
          : row.state === "finalized" && row.storageId !== null
            ? await ctx.storage.getUrl(row.storageId)
            : null;
      if (url === null) continue;
      results.push({
        attachmentId: row.id,
        fileName: row.fileName,
        mimeType: row.mimeType,
        byteSize: row.byteSize,
        url,
      });
    }
    return results;
  },
});

const deletionTarget = v.object({
  docId: v.id("issueAttachments"),
  key: v.union(v.string(), v.null()),
});

export const purgeDeletedRows = internalMutation({
  args: { targets: v.array(deletionTarget) },
  returns: v.null(),
  handler: async (ctx, args) => {
    for (const target of args.targets) {
      const row = await ctx.db.get(target.docId);
      if (row !== null && row.deletedAt !== null) await ctx.db.delete(row._id);
    }
    return null;
  },
});

export const deleteUploadThingFiles = internalAction({
  args: { targets: v.array(deletionTarget) },
  returns: v.null(),
  handler: async (ctx, args) => {
    await client().deleteFiles(
      args.targets.flatMap((target) => (target.key === null ? [] : [target.key])),
    );
    await ctx.runMutation(functions.purgeDeletedRows, { targets: args.targets });
    return null;
  },
});

export const claimExpiredPending = internalMutation({
  args: { cutoff: v.number() },
  returns: v.array(deletionTarget),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("issueAttachments")
      .withIndex("by_state_and_created_at", (q) =>
        q.eq("state", "pending").lt("createdAt", args.cutoff),
      )
      .take(GC_BATCH_SIZE);
    const claimed: Array<{ docId: Id<"issueAttachments">; key: string | null }> = [];
    for (const row of rows) {
      await ctx.db.patch(row._id, { deletedAt: Date.now(), updatedAt: Date.now() });
      claimed.push({ docId: row._id, key: row.uploadthingFileKey ?? null });
    }
    return claimed;
  },
});

export const gcPending = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx: ActionCtx) => {
    const targets = await ctx.runMutation(functions.claimExpiredPending, {
      cutoff: Date.now() - ISSUE_ATTACHMENT_PENDING_TTL_MS,
    });
    if (targets.length > 0) await ctx.runAction(functions.deleteUploadThingFiles, { targets });
    return null;
  },
});
