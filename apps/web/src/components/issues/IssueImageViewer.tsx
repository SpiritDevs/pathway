import type { ChatAttachmentId, EnvironmentId } from "@t3tools/contracts";
import { MessagesSquareIcon } from "lucide-react";
import { useMemo } from "react";

import { useAssetUrls } from "~/assets/assetUrls";
import { ImageLightbox, type ImageLightboxAction } from "../media/ImageLightbox";
import { isIssueVideoAttachmentUrl } from "./issueCommentAttachments";

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
  environmentId,
  selectedAttachmentId,
  startThreadDisabled,
  onClose,
  onComment,
  onStartThread,
}: {
  attachmentIds: ReadonlyArray<ChatAttachmentId>;
  environmentId: EnvironmentId;
  selectedAttachmentId: ChatAttachmentId;
  startThreadDisabled: boolean;
  onClose: () => void;
  onComment: (body: string, attachmentId: ChatAttachmentId) => void;
  onStartThread: (src: string) => void;
}) {
  const resources = useMemo(
    () => attachmentIds.map((attachmentId) => ({ _tag: "attachment" as const, attachmentId })),
    [attachmentIds],
  );
  const urls = useAssetUrls(environmentId, resources);
  const ready = urls.every((url) => url !== null);

  // Videos play inline on the issue rather than in the image viewer, so they are skipped
  // here — which also means positions are resolved against the filtered list.
  const images = useMemo(
    () =>
      attachmentIds.flatMap((attachmentId, position) => {
        const src = urls[position] ?? null;
        if (src === null || isIssueVideoAttachmentUrl(src)) return [];
        return [{ attachmentId, src, name: issueAttachmentDisplayName(position + 1) }];
      }),
    [attachmentIds, urls],
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
    />
  );
}
