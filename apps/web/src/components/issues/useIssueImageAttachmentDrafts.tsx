import type { IssueId } from "@t3tools/contracts";
import { ISSUE_COMMENT_ATTACHMENT_MAX_BYTES } from "@t3tools/contracts";
import { XIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { compressImageToByteLimit } from "~/lib/imageCompression";
import { randomUUID } from "~/lib/utils";
import { useUploadIssueCommentAttachment } from "~/state/issues";
import { readFileAsDataUrl } from "../ChatView.logic";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  issueCommentAttachmentDataUrlRejection,
  issueCommentAttachmentIntake,
  issueCommentAttachmentTooLargeMessage,
  type IssueCommentAttachmentDraft,
} from "./issueCommentAttachments";
import { reportIssueWriteFailure } from "./issueWriteFeedback";

/** One staged image, shared by the top-level attachment shelf and the comment composer. */
export function PendingIssueImageAttachment({
  attachment,
  onRemove,
}: {
  attachment: IssueCommentAttachmentDraft;
  onRemove: (draftId: string) => void;
}) {
  return (
    <li className="relative shrink-0">
      <img
        alt={attachment.name}
        className="size-16 rounded-md border border-border/60 object-cover"
        src={attachment.previewUrl}
      />
      {attachment.status === "uploading" ? (
        <span className="absolute inset-0 grid place-items-center rounded-md bg-background/60">
          <Spinner className="size-3.5 text-muted-foreground" />
        </span>
      ) : null}
      <Button
        aria-label={`Remove ${attachment.name}`}
        className="absolute -end-1.5 -top-1.5 rounded-full border border-border/60 bg-background"
        onClick={() => onRemove(attachment.draftId)}
        size="icon-xs"
        variant="ghost"
      >
        <XIcon />
      </Button>
    </li>
  );
}

export interface IssueImageAttachmentDraftController {
  readonly attachments: ReadonlyArray<IssueCommentAttachmentDraft>;
  readonly addFiles: (files: ReadonlyArray<File>) => void;
  readonly removeAttachment: (draftId: string) => void;
  readonly clearAttachments: () => void;
}

/**
 * Uploads issue-owned images and owns their local previews until a comment claims their ids.
 * Keeping this in one hook means the description shelf and comment composer share compression,
 * limits, error handling, cleanup, and the same remote-safe attachment namespace.
 */
export function useIssueImageAttachmentDrafts(
  issueId: IssueId,
): IssueImageAttachmentDraftController {
  const [attachments, setAttachments] = useState<ReadonlyArray<IssueCommentAttachmentDraft>>([]);
  const uploadAttachment = useUploadIssueCommentAttachment();
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;

  useEffect(
    () => () => {
      for (const attachment of attachmentsRef.current) {
        URL.revokeObjectURL(attachment.previewUrl);
      }
    },
    [],
  );

  const removeAttachment = useCallback((draftId: string) => {
    const removed = attachmentsRef.current.find((attachment) => attachment.draftId === draftId);
    if (removed !== undefined) URL.revokeObjectURL(removed.previewUrl);
    setAttachments((current) => current.filter((attachment) => attachment.draftId !== draftId));
  }, []);

  const clearAttachments = useCallback(() => {
    for (const attachment of attachmentsRef.current) {
      URL.revokeObjectURL(attachment.previewUrl);
    }
    setAttachments([]);
  }, []);

  const reportRejection = useCallback((description: string) => {
    toastManager.add(
      stackedThreadToast({ type: "error", title: "Image not attached", description }),
    );
  }, []);

  const uploadFile = useCallback(
    async (file: File) => {
      const draftId = randomUUID();
      const previewUrl = URL.createObjectURL(file);
      const name = file.name.trim().length === 0 ? "Pasted image" : file.name;
      setAttachments((current) => [...current, { draftId, name, previewUrl, status: "uploading" }]);

      // The draft may not have rendered yet, so failure cleans up from this closure rather than
      // asking `removeAttachment` to find a row React has not committed.
      const discard = () => {
        URL.revokeObjectURL(previewUrl);
        setAttachments((current) => current.filter((attachment) => attachment.draftId !== draftId));
      };
      const fail = (description: string) => {
        discard();
        reportRejection(description);
      };

      const compressed = await compressImageToByteLimit(file, ISSUE_COMMENT_ATTACHMENT_MAX_BYTES);
      if (!compressed.ok) {
        fail(
          compressed.reason === "too-large"
            ? issueCommentAttachmentTooLargeMessage(name)
            : `${name} could not be read as an image.`,
        );
        return;
      }
      const dataUrl = await readFileAsDataUrl(compressed.file).catch(() => null);
      if (dataUrl === null) {
        fail(`${name} could not be read as an image.`);
        return;
      }
      const rejection = issueCommentAttachmentDataUrlRejection({ name, dataUrl });
      if (rejection !== null) {
        fail(rejection);
        return;
      }

      const result = await uploadAttachment({ issueId, dataUrl });
      if (result._tag !== "Success") {
        discard();
        reportIssueWriteFailure("Failed to attach the image", result);
        return;
      }
      const { attachmentId } = result.value;
      setAttachments((current) =>
        current.map((attachment) =>
          attachment.draftId === draftId
            ? { ...attachment, status: "uploaded", attachmentId }
            : attachment,
        ),
      );
    },
    [issueId, reportRejection, uploadAttachment],
  );

  const addFiles = useCallback(
    (files: ReadonlyArray<File>) => {
      const intake = issueCommentAttachmentIntake({ files, currentCount: attachments.length });
      if (intake.rejection !== null) reportRejection(intake.rejection);
      for (const file of intake.accepted) void uploadFile(file);
    },
    [attachments.length, reportRejection, uploadFile],
  );

  return { attachments, addFiles, removeAttachment, clearAttachments } as const;
}
