import type {
  ChatAttachmentId,
  EnvironmentId,
  IssueComment,
  IssueCommentId,
} from "@t3tools/contracts";
import {
  ChevronDownIcon,
  ClipboardPasteIcon,
  FileImageIcon,
  ImagePlusIcon,
  ImagesIcon,
  XIcon,
} from "lucide-react";
import { useMemo, useRef, useState } from "react";

import { useAssetUrls } from "~/assets/assetUrls";
import { cn } from "~/lib/utils";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { issueClipboardImageFiles } from "./issueAttachmentClipboard";
import {
  issueAttachmentComment,
  issueAttachmentReferences,
  issueCommentAttachmentIds,
  isIssueVideoAttachmentUrl,
  type IssueAttachmentReference,
} from "./issueCommentAttachments";
import { PendingIssueImageAttachment } from "./useIssueImageAttachmentDrafts";
import type { IssueImageAttachmentDraftController } from "./useIssueImageAttachmentDrafts";

function AttachmentGallery({
  attachments,
  environmentId,
  onOpenImage,
  onRemoveAttachment,
}: {
  attachments: ReadonlyArray<IssueAttachmentReference>;
  environmentId: EnvironmentId;
  onOpenImage: (attachmentId: ChatAttachmentId) => void;
  onRemoveAttachment: (commentId: IssueCommentId, attachmentId: ChatAttachmentId) => void;
}) {
  const resources = useMemo(
    () => attachments.map(({ attachmentId }) => ({ _tag: "attachment" as const, attachmentId })),
    [attachments],
  );
  const urls = useAssetUrls(environmentId, resources);

  return (
    <ul className="flex min-w-0 gap-2 overflow-x-auto pb-1">
      {attachments.map(({ attachmentId, commentId }, index) => {
        const url = urls[index] ?? null;
        if (url === null) return null;
        return (
          <li className="group relative shrink-0" key={attachmentId}>
            {isIssueVideoAttachmentUrl(url) ? (
              <video
                aria-label={`Issue recording ${index + 1}`}
                className="h-16 w-28 rounded-md border border-border/60 object-cover"
                controls
                playsInline
                preload="metadata"
                src={url}
              />
            ) : (
              <button
                aria-label={`Open attachment ${index + 1}`}
                className="block cursor-zoom-in rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => onOpenImage(attachmentId)}
                type="button"
              >
                <img
                  alt={`Issue attachment ${index + 1}`}
                  className="h-16 w-20 rounded-md border border-border/60 object-cover transition-opacity hover:opacity-80"
                  src={url}
                />
              </button>
            )}
            <Button
              aria-label={`Remove issue attachment ${index + 1}`}
              className="absolute -end-1.5 -top-1.5 rounded-full border border-border/60 bg-background opacity-0 shadow-sm transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100 motion-reduce:transition-none"
              onClick={() => onRemoveAttachment(commentId, attachmentId)}
              size="icon-xs"
              title="Remove image"
              variant="ghost"
            >
              <XIcon />
            </Button>
          </li>
        );
      })}
    </ul>
  );
}

export function IssueAttachments({
  comments,
  onCreateComment,
  onOpenImage,
  onRemoveAttachment,
  drafts,
}: {
  comments: ReadonlyArray<IssueComment>;
  onCreateComment: (body: string, attachmentIds: ReadonlyArray<ChatAttachmentId>) => void;
  onOpenImage: (attachmentId: ChatAttachmentId) => void;
  onRemoveAttachment: (commentId: IssueCommentId, attachmentId: ChatAttachmentId) => void;
  drafts: IssueImageAttachmentDraftController;
}) {
  const environmentId = usePrimaryEnvironmentId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [isDropTarget, setIsDropTarget] = useState(false);
  const { attachments, addFiles, removeAttachment, clearAttachments } = drafts;
  const storedAttachments = useMemo(() => issueAttachmentReferences(comments), [comments]);
  const pendingIds = issueCommentAttachmentIds(attachments);
  const uploading = attachments.some((attachment) => attachment.status === "uploading");

  const addFromClipboard = async () => {
    if (navigator.clipboard?.read === undefined) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Clipboard unavailable",
          description: "This browser cannot read images directly from the clipboard.",
        }),
      );
      return;
    }

    try {
      const files = await issueClipboardImageFiles(await navigator.clipboard.read());
      if (files.length > 0) {
        addFiles(files);
        return;
      }
      toastManager.add({ type: "info", title: "No image in clipboard" });
    } catch (error) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not read clipboard",
          description:
            error instanceof Error ? error.message : "Clipboard access was not available.",
        }),
      );
    }
  };

  const attach = () => {
    if (pendingIds.length === 0 || uploading) return;
    const body = issueAttachmentComment(pendingIds.length);
    clearAttachments();
    onCreateComment(body, pendingIds);
  };

  return (
    <section
      aria-label="Issue attachments"
      className={cn(
        "flex flex-col gap-2 rounded-lg border border-transparent px-1.5 py-1 transition-colors",
        isDropTarget && "border-ring bg-accent/30",
      )}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setIsDropTarget(false);
      }}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        setIsDropTarget(true);
      }}
      onDrop={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        setIsDropTarget(false);
        addFiles([...event.dataTransfer.files]);
      }}
    >
      <div className="flex min-h-7 items-center gap-1.5 text-xs text-muted-foreground">
        <ImagesIcon className="size-3.5" />
        <span>Attachments</span>
        {storedAttachments.length === 0 ? null : (
          <span className="text-[10px] tabular-nums text-muted-foreground/70">
            {storedAttachments.length}
          </span>
        )}
        <Menu>
          <MenuTrigger
            render={
              <Button className="ms-auto text-muted-foreground" size="xs" variant="ghost">
                <ImagePlusIcon />
                Add images
                <ChevronDownIcon className="size-3" />
              </Button>
            }
          />
          <MenuPopup align="end" className="w-44">
            <MenuItem onClick={() => inputRef.current?.click()}>
              <FileImageIcon />
              From file
            </MenuItem>
            <MenuItem onClick={() => void addFromClipboard()}>
              <ClipboardPasteIcon />
              From clipboard
            </MenuItem>
          </MenuPopup>
        </Menu>
        <input
          accept="image/*"
          className="sr-only"
          multiple
          onChange={(event) => {
            addFiles([...(event.currentTarget.files ?? [])]);
            event.currentTarget.value = "";
          }}
          ref={inputRef}
          type="file"
        />
      </div>

      {storedAttachments.length === 0 || environmentId === null ? null : (
        <AttachmentGallery
          attachments={storedAttachments}
          environmentId={environmentId}
          onOpenImage={onOpenImage}
          onRemoveAttachment={onRemoveAttachment}
        />
      )}

      {attachments.length === 0 ? null : (
        <div className="flex flex-col gap-2 border-t border-border/50 pt-2">
          <ul className="flex gap-2 overflow-x-auto py-1">
            {attachments.map((attachment) => (
              <PendingIssueImageAttachment
                attachment={attachment}
                key={attachment.draftId}
                onRemove={removeAttachment}
              />
            ))}
          </ul>
          <div className="flex items-center gap-2">
            <Button disabled={uploading || pendingIds.length === 0} onClick={attach} size="xs">
              {uploading ? "Uploading…" : `Attach ${pendingIds.length}`}
            </Button>
            <Button onClick={clearAttachments} size="xs" variant="outline">
              Discard
            </Button>
            <span className="text-[11px] text-muted-foreground/70">
              Images also appear in Activity.
            </span>
          </div>
        </div>
      )}
    </section>
  );
}
