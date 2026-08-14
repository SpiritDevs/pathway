/**
 * The rules behind the comment composer's image intake.
 *
 * Stage 2 shipped comments that *render* attachments with no way to mint one. The
 * `issues.uploadCommentAttachment` RPC closed that, and this module holds the decisions the
 * composer makes around it so they can be tested without a clipboard. The async half — compress,
 * read, upload — stays in the component: all three are effects with no branching worth pinning.
 *
 * Two bounds are enforced here rather than left to the server: how many images one comment holds
 * ({@link ISSUE_COMMENT_MAX_ATTACHMENTS}) and how large one payload may be
 * ({@link ISSUE_COMMENT_ATTACHMENT_MAX_DATA_URL_CHARS}). Both are the schema's own numbers, so a
 * refusal here says the same thing the socket would have said, only before spending the upload.
 *
 * @module components/issues/issueCommentAttachments
 */
import {
  ISSUE_COMMENT_ATTACHMENT_MAX_BYTES,
  ISSUE_COMMENT_ATTACHMENT_MAX_DATA_URL_CHARS,
  ISSUE_COMMENT_MAX_ATTACHMENTS,
  type ChatAttachmentId,
  type IssueComment,
  type IssueCommentId,
} from "@t3tools/contracts";

import { issueCommentCreateBody } from "./issueDetail.logic";

/** The slice of a `File` the intake rules read, so a test does not have to build one. */
export interface IssueCommentAttachmentCandidate {
  readonly type: string;
}

/**
 * One image in the composer, before the comment exists.
 *
 * `previewUrl` is an object URL over the *original* file: it renders immediately and costs nothing,
 * where the data URL only exists once the reader has run and would hold a second copy of the bytes
 * in the DOM. The owner revokes it.
 */
export type IssueCommentAttachmentDraft = {
  readonly draftId: string;
  readonly name: string;
  readonly previewUrl: string;
} & (
  | { readonly status: "uploading" }
  | { readonly status: "uploaded"; readonly attachmentId: ChatAttachmentId }
);

export interface IssueCommentAttachmentIntakeResult<F> {
  /** The files worth uploading, already cut to the remaining slots. */
  readonly accepted: ReadonlyArray<F>;
  /** What to say about everything that did not make it, or null when nothing was dropped. */
  readonly rejection: string | null;
}

/**
 * Which of a paste's or a drop's files the composer takes.
 *
 * Non-images are dropped because the store only accepts images, and the surplus past the per-
 * comment cap is dropped rather than refusing the whole gesture: pasting nine screenshots should
 * attach eight and say so, not attach none.
 */
export function issueCommentAttachmentIntake<F extends IssueCommentAttachmentCandidate>(input: {
  readonly files: ReadonlyArray<F>;
  readonly currentCount: number;
}): IssueCommentAttachmentIntakeResult<F> {
  const { currentCount, files } = input;
  if (files.length === 0) {
    return { accepted: [], rejection: null };
  }
  const images = files.filter((file) => file.type.startsWith("image/"));
  if (images.length === 0) {
    return { accepted: [], rejection: "Only images can be attached to a comment." };
  }
  const remaining = Math.max(0, ISSUE_COMMENT_MAX_ATTACHMENTS - currentCount);
  if (remaining === 0) {
    return {
      accepted: [],
      rejection: `A comment holds at most ${ISSUE_COMMENT_MAX_ATTACHMENTS} images.`,
    };
  }
  const accepted = images.slice(0, remaining);
  const droppedForCap = images.length - accepted.length;
  if (droppedForCap > 0) {
    return {
      accepted,
      rejection: `A comment holds at most ${ISSUE_COMMENT_MAX_ATTACHMENTS} images, so ${droppedForCap} ${droppedForCap === 1 ? "was" : "were"} not attached.`,
    };
  }
  const droppedForType = files.length - images.length;
  return {
    accepted,
    rejection:
      droppedForType === 0
        ? null
        : `Only images can be attached to a comment, so ${droppedForType} ${droppedForType === 1 ? "file was" : "files were"} skipped.`,
  };
}

/** Megabytes, for a sentence rather than a table. `10485760` reads as `10 MB`. */
function formatAttachmentByteLimit(bytes: number): string {
  const megabytes = bytes / (1024 * 1024);
  return `${Number.isInteger(megabytes) ? megabytes : megabytes.toFixed(1)} MB`;
}

/** What an image that cannot be shrunk under the cap says. */
export function issueCommentAttachmentTooLargeMessage(name: string): string {
  const label = name.trim().length === 0 ? "That image" : name.trim();
  return `${label} is larger than the ${formatAttachmentByteLimit(ISSUE_COMMENT_ATTACHMENT_MAX_BYTES)} limit for a comment image.`;
}

/**
 * The last guard before the socket: the encoded payload against the schema's own character bound.
 *
 * Compression targets decoded bytes, so this can only fire on a pathological encoding — but the
 * schema check that would otherwise catch it happens after the upload has been sent, and a refusal
 * with a filename in it beats a wire error.
 */
export function issueCommentAttachmentDataUrlRejection(input: {
  readonly name: string;
  readonly dataUrl: string;
}): string | null {
  return input.dataUrl.length > ISSUE_COMMENT_ATTACHMENT_MAX_DATA_URL_CHARS
    ? issueCommentAttachmentTooLargeMessage(input.name)
    : null;
}

/** The uploaded ids, in composer order. An upload still running contributes nothing. */
export function issueCommentAttachmentIds(
  attachments: ReadonlyArray<IssueCommentAttachmentDraft>,
): ReadonlyArray<ChatAttachmentId> {
  return attachments.flatMap((attachment) =>
    attachment.status === "uploaded" ? [attachment.attachmentId] : [],
  );
}

/** Every image on an issue, in comment order and without duplicate ids. */
export function issueAttachmentIds(
  comments: ReadonlyArray<IssueComment>,
): ReadonlyArray<ChatAttachmentId> {
  const seen = new Set<ChatAttachmentId>();
  const attachmentIds: ChatAttachmentId[] = [];
  for (const comment of comments) {
    for (const attachmentId of comment.attachmentIds) {
      if (seen.has(attachmentId)) continue;
      seen.add(attachmentId);
      attachmentIds.push(attachmentId);
    }
  }
  return attachmentIds;
}

export interface IssueAttachmentReference {
  readonly attachmentId: ChatAttachmentId;
  readonly commentId: IssueCommentId;
}

/** Every visible image plus the comment that owns its removable reference. */
export function issueAttachmentReferences(
  comments: ReadonlyArray<IssueComment>,
): ReadonlyArray<IssueAttachmentReference> {
  const seen = new Set<ChatAttachmentId>();
  const attachments: IssueAttachmentReference[] = [];
  for (const comment of comments) {
    for (const attachmentId of comment.attachmentIds) {
      if (seen.has(attachmentId)) continue;
      seen.add(attachmentId);
      attachments.push({ attachmentId, commentId: comment.id });
    }
  }
  return attachments;
}

/** Video evidence stays reviewable on the issue but cannot ride on an image-only provider turn. */
export function isIssueVideoAttachmentUrl(url: string): boolean {
  try {
    return /\.(?:mp4|webm)$/i.test(decodeURIComponent(new URL(url).pathname));
  } catch {
    return false;
  }
}

/** The visible Activity comment that owns images added from the description attachment shelf. */
export function issueAttachmentComment(count: number): string {
  return count === 1 ? "Added an image to this issue." : `Added ${count} images to this issue.`;
}

export interface IssueCommentComposerState {
  /** The trimmed body, or null when there is nothing written. */
  readonly body: string | null;
  readonly isUploading: boolean;
  readonly canSubmit: boolean;
  /** Why the button is inert, when it is. */
  readonly hint: string | null;
  /** Whether the Comment/Discard row is worth showing at all. */
  readonly showActions: boolean;
}

/**
 * Whether the composer can post, and what to say when it cannot.
 *
 * A body is required even with images attached, matching the chat composer (`ChatView.tsx:5630`
 * refuses an empty prompt however many images ride along) and matching the contract, whose
 * `IssueCommentCreateInput.body` is non-empty. An upload still in flight blocks the post rather
 * than being silently dropped from it.
 */
export function issueCommentComposerState(input: {
  readonly draft: string;
  readonly attachments: ReadonlyArray<{ readonly status: IssueCommentAttachmentDraft["status"] }>;
}): IssueCommentComposerState {
  const body = issueCommentCreateBody(input.draft);
  const isUploading = input.attachments.some((attachment) => attachment.status === "uploading");
  return {
    body,
    isUploading,
    canSubmit: body !== null && !isUploading,
    hint: isUploading
      ? "Waiting for the image to finish uploading…"
      : body === null && input.attachments.length > 0
        ? "Add a message to post these images."
        : null,
    showActions: input.draft.trim().length > 0 || input.attachments.length > 0,
  };
}
