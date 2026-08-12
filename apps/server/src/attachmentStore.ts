// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";

import type { ChatAttachment } from "@t3tools/contracts";

import {
  normalizeAttachmentRelativePath,
  resolveAttachmentRelativePath,
} from "./attachmentPaths.ts";
import { inferImageExtension, SAFE_IMAGE_FILE_EXTENSIONS } from "./imageMime.ts";

const ATTACHMENT_FILENAME_EXTENSIONS = [...SAFE_IMAGE_FILE_EXTENSIONS, ".bin"];
const ATTACHMENT_ID_THREAD_SEGMENT_MAX_CHARS = 80;
const ATTACHMENT_ID_THREAD_SEGMENT_PATTERN = "[a-z0-9_]+(?:-[a-z0-9_]+)*";
const ATTACHMENT_ID_UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const ATTACHMENT_ID_PATTERN = new RegExp(
  `^(${ATTACHMENT_ID_THREAD_SEGMENT_PATTERN})-(${ATTACHMENT_ID_UUID_PATTERN})$`,
  "i",
);

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
  return segment;
}

export function toSafeIssueAttachmentSegment(issueId: string): string | null {
  return toSafeAttachmentSegment(issueId);
}

export function createAttachmentId(threadId: string): string | null {
  const threadSegment = toSafeThreadAttachmentSegment(threadId);
  if (!threadSegment) {
    return null;
  }
  return `${threadSegment}-${NodeCrypto.randomUUID()}`;
}

/** The issue-namespaced twin of {@link createAttachmentId}, stored in the same flat directory. */
export function createIssueAttachmentId(issueId: string): string | null {
  const issueSegment = toSafeIssueAttachmentSegment(issueId);
  if (!issueSegment) {
    return null;
  }
  return `${ATTACHMENT_ID_ISSUE_PREFIX}${issueSegment}-${NodeCrypto.randomUUID()}`;
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

export function attachmentRelativePath(attachment: ChatAttachment): string {
  switch (attachment.type) {
    case "image": {
      const extension = inferImageExtension({
        mimeType: attachment.mimeType,
        fileName: attachment.name,
      });
      return `${attachment.id}${extension}`;
    }
  }
}

export function resolveAttachmentPath(input: {
  readonly attachmentsDir: string;
  readonly attachment: ChatAttachment;
}): string | null {
  return resolveAttachmentRelativePath({
    attachmentsDir: input.attachmentsDir,
    relativePath: attachmentRelativePath(input.attachment),
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
