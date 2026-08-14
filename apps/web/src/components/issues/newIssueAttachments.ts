/**
 * Attachment rules for the new-issue composer.
 *
 * Files stay local until the issue exists because the attachment namespace includes the issue id.
 * These helpers keep the intake and wire-size decisions testable while the component owns preview
 * URLs, compression, and RPC calls.
 *
 * @module components/issues/newIssueAttachments
 */
import {
  ISSUE_COMMENT_ATTACHMENT_MAX_BYTES,
  ISSUE_COMMENT_ATTACHMENT_MAX_DATA_URL_CHARS,
  ISSUE_COMMENT_MAX_ATTACHMENTS,
  type IssueComment,
} from "@t3tools/contracts";

export interface NewIssueAttachmentCandidate {
  readonly type: string;
}

const NEW_ISSUE_ATTACHMENT_RECORD_PREFIX = "<!-- pathway:new-issue-attachments -->\n";

export interface NewIssueAttachmentIntakeResult<F> {
  readonly accepted: ReadonlyArray<F>;
  readonly rejection: string | null;
}

/** Takes images up to the shared issue-comment limit and explains anything it skipped. */
export function newIssueAttachmentIntake<F extends NewIssueAttachmentCandidate>(input: {
  readonly files: ReadonlyArray<F>;
  readonly currentCount: number;
}): NewIssueAttachmentIntakeResult<F> {
  const { files, currentCount } = input;
  if (files.length === 0) return { accepted: [], rejection: null };

  const images = files.filter((file) => file.type.startsWith("image/"));
  if (images.length === 0) {
    return { accepted: [], rejection: "Only images can be attached to an issue." };
  }

  const remaining = Math.max(0, ISSUE_COMMENT_MAX_ATTACHMENTS - currentCount);
  if (remaining === 0) {
    return {
      accepted: [],
      rejection: `An issue can start with at most ${ISSUE_COMMENT_MAX_ATTACHMENTS} images.`,
    };
  }

  const accepted = images.slice(0, remaining);
  const droppedForCap = images.length - accepted.length;
  if (droppedForCap > 0) {
    return {
      accepted,
      rejection: `An issue can start with at most ${ISSUE_COMMENT_MAX_ATTACHMENTS} images, so ${droppedForCap} ${droppedForCap === 1 ? "was" : "were"} not attached.`,
    };
  }

  const droppedForType = files.length - images.length;
  return {
    accepted,
    rejection:
      droppedForType === 0
        ? null
        : `Only images can be attached to an issue, so ${droppedForType} ${droppedForType === 1 ? "file was" : "files were"} skipped.`,
  };
}

function formatAttachmentByteLimit(bytes: number): string {
  const megabytes = bytes / (1024 * 1024);
  return `${Number.isInteger(megabytes) ? megabytes : megabytes.toFixed(1)} MB`;
}

export function newIssueAttachmentTooLargeMessage(name: string): string {
  const label = name.trim().length === 0 ? "That image" : name.trim();
  return `${label} is larger than the ${formatAttachmentByteLimit(ISSUE_COMMENT_ATTACHMENT_MAX_BYTES)} limit for an issue image.`;
}

export function newIssueAttachmentDataUrlRejection(input: {
  readonly name: string;
  readonly dataUrl: string;
}): string | null {
  return input.dataUrl.length > ISSUE_COMMENT_ATTACHMENT_MAX_DATA_URL_CHARS
    ? newIssueAttachmentTooLargeMessage(input.name)
    : null;
}

/** The metadata comment that owns images added before the issue had an id. */
export function newIssueAttachmentComment(count: number): string {
  const description =
    count === 1
      ? "Attached an image when creating this issue."
      : `Attached ${count} images when creating this issue.`;
  return `${NEW_ISSUE_ATTACHMENT_RECORD_PREFIX}${description}`;
}

/**
 * Creation-time images need a comment row to keep their attachment ids durable, but that row is
 * attachment metadata rather than part of the discussion. The reserved marker distinguishes it
 * from an ordinary comment that happens to use the same visible words and attachment count.
 */
export function isNewIssueAttachmentRecord(
  comment: Pick<IssueComment, "attachmentIds" | "body">,
): boolean {
  return (
    comment.attachmentIds.length > 0 &&
    comment.body === newIssueAttachmentComment(comment.attachmentIds.length)
  );
}
