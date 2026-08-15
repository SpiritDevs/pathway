import type { ChatAttachmentId, EnvironmentId, IssueId } from "@spiritdevs/contracts";
import { MessagesSquareIcon } from "lucide-react";
import { useMemo } from "react";

import type { ReplicaIssueAttachmentCloud } from "~/cloud/issueAttachmentClient";
import { ImageLightbox, type ImageLightboxAction } from "../media/ImageLightbox";
import { isIssueVideoAttachmentUrl } from "./issueCommentAttachments";
import { useIssueAttachmentUrls } from "./useIssueAttachmentUrls";

export function issueAttachmentDisplayName(position: number): string {
  return `Issue attachment ${position}`;
}

/**
 * The issue-side gallery: every image on the issue in one viewer, opened on whichever
 * thumbnail was clicked, with the two things people want from an attachment — a new
 * thread about it, or a comment on it.
 */
export function IssueImageViewer({
  attachmentIds,
  cloud,
  environmentId,
  issueId,
  selectedAttachmentId,
  startThreadDisabled,
  onClose,
  onComment,
  onStartThread,
}: {
  attachmentIds: ReadonlyArray<ChatAttachmentId>;
  cloud: ReplicaIssueAttachmentCloud | null;
  environmentId: EnvironmentId | null;
  issueId: IssueId;
  selectedAttachmentId: ChatAttachmentId;
  startThreadDisabled: boolean;
  onClose: () => void;
  onComment: (body: string, attachmentId: ChatAttachmentId) => void;
  onStartThread: (src: string) => void;
}) {
  const { attachments, refresh } = useIssueAttachmentUrls({
    attachmentIds,
    cloud,
    environmentId,
    issueId,
  });
  const ready = attachments.every((attachment) => attachment !== null);

  // Videos play inline on the issue rather than in the image viewer, so they are skipped
  // here — which also means positions are resolved against the filtered list.
  const images = useMemo(
    () =>
      attachmentIds.flatMap((attachmentId, position) => {
        const attachment = attachments[position] ?? null;
        if (
          attachment === null ||
          attachment.mimeType?.startsWith("video/") === true ||
          isIssueVideoAttachmentUrl(attachment.url)
        )
          return [];
        return [
          {
            attachmentId,
            src: attachment.url,
            name: attachment.fileName ?? issueAttachmentDisplayName(position + 1),
          },
        ];
      }),
    [attachmentIds, attachments],
  );

  const index = images.findIndex((image) => image.attachmentId === selectedAttachmentId);

  const actions = useMemo<ReadonlyArray<ImageLightboxAction>>(
    () => [
      {
        id: "start-thread",
        label: "Start thread with image",
        icon: MessagesSquareIcon,
        disabled: startThreadDisabled,
        onSelect: (image) => {
          onStartThread(image.src);
          onClose();
        },
      },
    ],
    [onClose, onStartThread, startThreadDisabled],
  );

  // Mounting before every URL resolves would open the viewer on the wrong image.
  if (!ready || index < 0) return null;

  return (
    <ImageLightbox
      actions={actions}
      comment={{
        placeholder: "Comment on this image…",
        onSubmit: (body, _image, shownIndex) => {
          const shown = images[shownIndex];
          if (shown === undefined) return;
          onComment(body, shown.attachmentId);
        },
      }}
      images={images}
      initialIndex={index}
      onClose={onClose}
      onImageError={(failedImage) => {
        const failedIndex = attachments.findIndex(
          (attachment) => attachment?.url === failedImage.src,
        );
        if (failedIndex >= 0) refresh(failedIndex);
      }}
    />
  );
}
