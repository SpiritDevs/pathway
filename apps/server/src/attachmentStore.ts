// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type {
  ChatAttachment,
  ChatFileAttachment,
  ChatImageAttachment,
} from "@spiritdevs/contracts";

import {
  normalizeAttachmentRelativePath,
  resolveAttachmentRelativePath,
} from "./attachmentPaths.ts";
import {
  inferFileExtension,
  inferImageExtension,
  SAFE_FILE_EXTENSIONS,
  SAFE_IMAGE_FILE_EXTENSIONS,
} from "./imageMime.ts";

const SAFE_VIDEO_FILE_EXTENSIONS = [".mp4", ".webm"] as const;
const ATTACHMENT_FILENAME_EXTENSIONS = [
  ...SAFE_IMAGE_FILE_EXTENSIONS,
  ...SAFE_FILE_EXTENSIONS,
  ...SAFE_VIDEO_FILE_EXTENSIONS,
  ".bin",
];
const ATTACHMENT_ID_THREAD_SEGMENT_MAX_CHARS = 80;
const ATTACHMENT_ID_THREAD_SEGMENT_PATTERN = "[a-z0-9_]+(?:-[a-z0-9_]+)*";
const ATTACHMENT_ID_UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const ATTACHMENT_ID_FILE_EXTENSION_PATTERN = "[a-z0-9]{1,10}";
const ATTACHMENT_ID_PATTERN = new RegExp(
  `^(${ATTACHMENT_ID_THREAD_SEGMENT_PATTERN})-(${ATTACHMENT_ID_UUID_PATTERN})(?:-(${ATTACHMENT_ID_FILE_EXTENSION_PATTERN}))?$`,
  "i",
);

export const PENDING_ATTACHMENT_THREAD_SEGMENT = "pending";
export const PENDING_ATTACHMENT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const PARTIAL_UPLOAD_MAX_AGE_MS = 60 * 60 * 1000;

/**
 * Issue comments share the attachment store with threads (decision 0006), and one flat directory
 * means one namespace. This prefix is what keeps the two apart: thread attachment cleanup sweeps
 * every file whose id parses as its own thread segment, so an issue attachment that parsed as a
 * thread's would be deleted the next time that thread was pruned.
 */
const ATTACHMENT_ID_ISSUE_PREFIX = "iss_";
const ATTACHMENT_ID_ISSUE_PATTERN = new RegExp(
  `^${ATTACHMENT_ID_ISSUE_PREFIX}(${ATTACHMENT_ID_THREAD_SEGMENT_PATTERN})-(${ATTACHMENT_ID_UUID_PATTERN})$`,
  "i",
);

function toSafeAttachmentSegment(ownerId: string): string | null {
  const segment = ownerId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, ATTACHMENT_ID_THREAD_SEGMENT_MAX_CHARS)
    .replace(/[-_]+$/g, "");
  if (segment.length === 0) {
    return null;
  }
  return segment;
}

export function toSafeThreadAttachmentSegment(threadId: string): string | null {
  const segment = toSafeAttachmentSegment(threadId);
  // A thread cannot borrow the issue namespace, or its attachments would be invisible to its own
  // cleanup and visible to an issue's. Thread ids are uuids, so this refuses nothing real.
  if (segment === null || segment.startsWith(ATTACHMENT_ID_ISSUE_PREFIX)) {
    return null;
  }
  return segment === PENDING_ATTACHMENT_THREAD_SEGMENT ? "_pending" : segment;
}

export function toSafeIssueAttachmentSegment(issueId: string): string | null {
  return toSafeAttachmentSegment(issueId);
}

function attachmentIdExtensionSuffix(extension: string | undefined): string {
  if (!extension) return "";
  const normalized = extension.replace(/^\./, "").toLowerCase();
  return new RegExp(`^${ATTACHMENT_ID_FILE_EXTENSION_PATTERN}$`).test(normalized)
    ? `-${normalized}`
    : "-bin";
}

export function createPendingAttachmentId(extension?: string): string {
  return `${PENDING_ATTACHMENT_THREAD_SEGMENT}-${NodeCrypto.randomUUID()}${attachmentIdExtensionSuffix(extension)}`;
}

export function createAttachmentId(threadId: string, extension?: string): string | null {
  const threadSegment = toSafeThreadAttachmentSegment(threadId);
  if (!threadSegment) {
    return null;
  }
  return `${threadSegment}-${NodeCrypto.randomUUID()}${attachmentIdExtensionSuffix(extension)}`;
}

/** The issue-namespaced twin of {@link createAttachmentId}, stored in the same flat directory. */
export function createIssueAttachmentId(issueId: string): string | null {
  const issueSegment = toSafeIssueAttachmentSegment(issueId);
  if (!issueSegment) {
    return null;
  }
  return `${ATTACHMENT_ID_ISSUE_PREFIX}${issueSegment}-${NodeCrypto.randomUUID()}`;
}

export function createDeterministicAttachmentId(
  threadId: string,
  stableKey: string,
): string | null {
  const threadSegment = toSafeThreadAttachmentSegment(threadId);
  if (!threadSegment) return null;
  const hash = NodeCrypto.createHash("sha256")
    .update(JSON.stringify([threadId, stableKey]))
    .digest("hex")
    .slice(0, 32);
  const uuid = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20)}`;
  return `${threadSegment}-${uuid}`;
}

function normalizeAttachmentId(attachmentId: string): string | null {
  const normalizedId = normalizeAttachmentRelativePath(attachmentId);
  if (!normalizedId || normalizedId.includes("/") || normalizedId.includes(".")) {
    return null;
  }
  return normalizedId;
}

export function parseThreadSegmentFromAttachmentId(attachmentId: string): string | null {
  const normalizedId = normalizeAttachmentId(attachmentId);
  if (normalizedId === null || ATTACHMENT_ID_ISSUE_PATTERN.test(normalizedId)) {
    return null;
  }
  const match = normalizedId.match(ATTACHMENT_ID_PATTERN);
  if (!match) {
    return null;
  }
  return match[1]?.toLowerCase() ?? null;
}

export function parseAttachmentUuid(attachmentId: string): string | null {
  const normalizedId = normalizeAttachmentId(attachmentId);
  return normalizedId?.match(ATTACHMENT_ID_PATTERN)?.[2]?.toLowerCase() ?? null;
}

export function parseAttachmentFileExtension(attachmentId: string): string | null {
  const normalizedId = normalizeAttachmentId(attachmentId);
  return normalizedId?.match(ATTACHMENT_ID_PATTERN)?.[3]?.toLowerCase() ?? null;
}

export function parseIssueSegmentFromAttachmentId(attachmentId: string): string | null {
  const normalizedId = normalizeAttachmentId(attachmentId);
  if (normalizedId === null) {
    return null;
  }
  const match = normalizedId.match(ATTACHMENT_ID_ISSUE_PATTERN);
  if (!match) {
    return null;
  }
  return match[1]?.toLowerCase() ?? null;
}

export function attachmentRelativePath(
  attachment: ChatImageAttachment | ChatFileAttachment,
): string;
export function attachmentRelativePath(attachment: ChatAttachment): string | null;
export function attachmentRelativePath(attachment: ChatAttachment): string | null {
  switch (attachment.type) {
    case "image": {
      const extension = inferImageExtension({
        mimeType: attachment.mimeType,
        fileName: attachment.name,
      });
      return `${attachment.id}${extension}`;
    }
    case "file": {
      const extension = inferFileExtension({
        mimeType: attachment.mimeType,
        fileName: attachment.name,
      });
      return `${attachment.id}${extension}`;
    }
    default:
      return null;
  }
}

export function resolveAttachmentPath(input: {
  readonly attachmentsDir: string;
  readonly attachment: ChatAttachment;
}): string | null {
  const relativePath = attachmentRelativePath(input.attachment);
  if (relativePath === null) return null;
  return resolveAttachmentRelativePath({
    attachmentsDir: input.attachmentsDir,
    relativePath,
  });
}

/** Evidence videos belong only to issue comments; chat attachments use the generic resolver above. */
export function resolveIssueEvidenceAttachmentPath(input: {
  readonly attachmentsDir: string;
  readonly attachmentId: string;
  readonly mimeType: string;
}): string | null {
  if (parseIssueSegmentFromAttachmentId(input.attachmentId) === null) return null;
  const mimeType = input.mimeType.trim().toLowerCase().split(";", 1)[0];
  const extension = mimeType === "video/mp4" ? ".mp4" : mimeType === "video/webm" ? ".webm" : null;
  return extension === null
    ? null
    : resolveAttachmentRelativePath({
        attachmentsDir: input.attachmentsDir,
        relativePath: `${input.attachmentId}${extension}`,
      });
}

export function resolveAttachmentPathById(input: {
  readonly attachmentsDir: string;
  readonly attachmentId: string;
}): string | null {
  const normalizedId = normalizeAttachmentRelativePath(input.attachmentId);
  if (!normalizedId || normalizedId.includes("/") || normalizedId.includes(".")) {
    return null;
  }
  const encodedExtension = parseAttachmentFileExtension(normalizedId);
  if (encodedExtension) {
    const filePath = resolveAttachmentRelativePath({
      attachmentsDir: input.attachmentsDir,
      relativePath: `${normalizedId}.${encodedExtension}`,
    });
    return filePath && NodeFS.existsSync(filePath) ? filePath : null;
  }
  for (const extension of ATTACHMENT_FILENAME_EXTENSIONS) {
    const maybePath = resolveAttachmentRelativePath({
      attachmentsDir: input.attachmentsDir,
      relativePath: `${normalizedId}${extension}`,
    });
    if (maybePath && NodeFS.existsSync(maybePath)) {
      return maybePath;
    }
  }
  return null;
}

export type AttachmentClaimPlan =
  | {
      readonly ok: true;
      readonly finalId: string;
      readonly currentPath: string;
      readonly finalPath: string;
    }
  | { readonly ok: false; readonly reason: string };

export function planAttachmentClaim(input: {
  readonly attachmentsDir: string;
  readonly threadId: string;
  readonly attachmentId: string;
}): AttachmentClaimPlan {
  const uuid = parseAttachmentUuid(input.attachmentId);
  const requestedSegment = parseThreadSegmentFromAttachmentId(input.attachmentId);
  if (!uuid || !requestedSegment) return { ok: false, reason: "invalid attachment id" };
  if (!toSafeThreadAttachmentSegment(input.threadId)) {
    return { ok: false, reason: "invalid thread id" };
  }
  if (requestedSegment !== PENDING_ATTACHMENT_THREAD_SEGMENT) {
    return { ok: false, reason: "attachment must be a pending upload" };
  }
  const currentPath = resolveAttachmentPathById({
    attachmentsDir: input.attachmentsDir,
    attachmentId: input.attachmentId,
  });
  if (!currentPath) return { ok: false, reason: "attachment not found (removed or expired)" };
  const extension = parseAttachmentFileExtension(input.attachmentId) ?? undefined;
  const threadSegment = toSafeThreadAttachmentSegment(input.threadId);
  if (!threadSegment) return { ok: false, reason: "failed to create attachment id" };
  // Stable across retries: a failed dispatch may copy again, but it never
  // accumulates another final file for the same pending upload and thread.
  const finalId = `${threadSegment}-${uuid}${attachmentIdExtensionSuffix(extension)}`;
  const finalPath = resolveAttachmentRelativePath({
    attachmentsDir: input.attachmentsDir,
    relativePath: `${finalId}${NodePath.extname(currentPath)}`,
  });
  return finalPath
    ? { ok: true, finalId, currentPath, finalPath }
    : { ok: false, reason: "failed to resolve attachment path" };
}

export function sweepStalePendingAttachments(input: {
  readonly attachmentsDir: string;
  readonly nowMs: number;
}): { readonly deleted: number } {
  let entries: string[];
  try {
    entries = NodeFS.readdirSync(input.attachmentsDir);
  } catch {
    return { deleted: 0 };
  }
  let deleted = 0;
  for (const entry of entries) {
    const isPartial = entry.endsWith(".part");
    if (!isPartial) {
      const attachmentId = parseAttachmentIdFromRelativePath(entry);
      if (
        !attachmentId ||
        parseThreadSegmentFromAttachmentId(attachmentId) !== PENDING_ATTACHMENT_THREAD_SEGMENT
      ) {
        continue;
      }
    }
    const resolved = resolveAttachmentRelativePath({
      attachmentsDir: input.attachmentsDir,
      relativePath: entry,
    });
    if (!resolved) continue;
    try {
      const maxAgeMs = isPartial ? PARTIAL_UPLOAD_MAX_AGE_MS : PENDING_ATTACHMENT_MAX_AGE_MS;
      if (input.nowMs - NodeFS.statSync(resolved).mtimeMs > maxAgeMs) {
        NodeFS.unlinkSync(resolved);
        deleted += 1;
      }
    } catch {
      continue;
    }
  }
  return { deleted };
}

export function parseAttachmentIdFromRelativePath(relativePath: string): string | null {
  const normalized = normalizeAttachmentRelativePath(relativePath);
  if (!normalized || normalized.includes("/")) {
    return null;
  }
  const extensionIndex = normalized.lastIndexOf(".");
  if (extensionIndex <= 0) {
    return null;
  }
  const id = normalized.slice(0, extensionIndex);
  return id.length > 0 && !id.includes(".") ? id : null;
}
