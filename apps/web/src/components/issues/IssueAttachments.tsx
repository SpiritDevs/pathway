import type { ChatAttachmentId, EnvironmentId, IssueComment, IssueId } from "@spiritdevs/contracts";
import {
  ChevronDownIcon,
  ClipboardPasteIcon,
  FileImageIcon,
  ImagePlusIcon,
  ImagesIcon,
} from "lucide-react";
import { useMemo, useRef, useState } from "react";

import type { ReplicaIssueAttachmentCloud } from "~/cloud/issueAttachmentClient";
import { cn } from "~/lib/utils";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { issueClipboardImageFiles } from "./issueAttachmentClipboard";
import {
  issueAttachmentComment,
  issueAttachmentIds,
  issueCommentAttachmentIds,
  isIssueVideoAttachmentUrl,
} from "./issueCommentAttachments";
import { PendingIssueImageAttachment } from "./useIssueImageAttachmentDrafts";
import type { IssueImageAttachmentDraftController } from "./useIssueImageAttachmentDrafts";
import { useIssueAttachmentUrls } from "./useIssueAttachmentUrls";

function AttachmentGallery({
  attachmentIds,
  cloud,
  environmentId,
  issueId,
}: {
  attachmentIds: ReadonlyArray<ChatAttachmentId>;
  cloud: ReplicaIssueAttachmentCloud | null;
  environmentId: EnvironmentId | null;
  issueId: IssueId;
}) {
  const resolved = useIssueAttachmentUrls({ attachmentIds, cloud, environmentId, issueId });

  return (
    <ul className="flex min-w-0 gap-2 overflow-x-auto pb-1">
      {attachmentIds.map((attachmentId, index) => {
        const attachment = resolved[index] ?? null;
        if (attachment === null) return null;
        return (
          <li className="shrink-0" key={attachmentId}>
            {attachment.mimeType?.startsWith("video/") === true ||
            isIssueVideoAttachmentUrl(attachment.url) ? (
              <video
                aria-label={`Issue recording ${index + 1}`}
                className="h-16 w-28 rounded-md border border-border/60 object-cover"
                controls
                playsInline
                preload="metadata"
                src={attachment.url}
              />
            ) : (
              <a
                aria-label={`Open attachment ${index + 1}`}
                className="block rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
                href={attachment.url}
                rel="noreferrer"
                target="_blank"
              >
                <img
                  alt={`Issue attachment ${index + 1}`}
                  className="h-16 w-20 rounded-md border border-border/60 object-cover transition-opacity hover:opacity-80"
                  src={attachment.url}
                />
              </a>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function IssueAttachments({
  cloud,
  comments,
  onCreateComment,
  drafts,
  issueId,
}: {
  cloud: ReplicaIssueAttachmentCloud | null;
  comments: ReadonlyArray<IssueComment>;
  onCreateComment: (body: string, attachmentIds: ReadonlyArray<ChatAttachmentId>) => void;
  drafts: IssueImageAttachmentDraftController;
  issueId: IssueId;
}) {
  const environmentId = usePrimaryEnvironmentId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [isDropTarget, setIsDropTarget] = useState(false);
  const { attachments, addFiles, removeAttachment, clearAttachments } = drafts;
  const storedAttachmentIds = useMemo(() => issueAttachmentIds(comments), [comments]);
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
        {storedAttachmentIds.length === 0 ? null : (
          <span className="text-[10px] tabular-nums text-muted-foreground/70">
            {storedAttachmentIds.length}
          </span>
        )}
        <Menu>
          <MenuTrigger
            render={
              <Button
                className="ms-auto text-muted-foreground"
                disabled={cloud !== null && !cloud.isOnline}
                size="xs"
                variant="ghost"
              >
                <ImagePlusIcon />
                {cloud !== null && !cloud.isOnline ? "Attachments offline" : "Add images"}
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

      {storedAttachmentIds.length === 0 || (cloud === null && environmentId === null) ? null : (
        <AttachmentGallery
          attachmentIds={storedAttachmentIds}
          cloud={cloud}
          environmentId={environmentId}
          issueId={issueId}
        />
      )}

      {cloud !== null && !cloud.isOnline ? (
        <p className="text-[11px] text-muted-foreground/70">
          Connect to add attachments. Text comments still queue offline.
        </p>
      ) : null}

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
