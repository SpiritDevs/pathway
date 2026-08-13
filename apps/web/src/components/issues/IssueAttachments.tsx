import type { ChatAttachmentId, EnvironmentId, IssueComment, IssueId } from "@t3tools/contracts";
import { ImagePlusIcon, ImagesIcon } from "lucide-react";
import { useMemo, useRef, useState } from "react";

import { useAssetUrls } from "~/assets/assetUrls";
import { cn } from "~/lib/utils";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { Button } from "../ui/button";
import {
  issueAttachmentComment,
  issueAttachmentIds,
  issueCommentAttachmentIds,
  isIssueVideoAttachmentUrl,
} from "./issueCommentAttachments";
import {
  PendingIssueImageAttachment,
  useIssueImageAttachmentDrafts,
} from "./useIssueImageAttachmentDrafts";

function AttachmentGallery({
  attachmentIds,
  environmentId,
}: {
  attachmentIds: ReadonlyArray<ChatAttachmentId>;
  environmentId: EnvironmentId;
}) {
  const resources = useMemo(
    () => attachmentIds.map((attachmentId) => ({ _tag: "attachment" as const, attachmentId })),
    [attachmentIds],
  );
  const urls = useAssetUrls(environmentId, resources);

  return (
    <ul className="flex min-w-0 gap-2 overflow-x-auto pb-1">
      {attachmentIds.map((attachmentId, index) => {
        const url = urls[index] ?? null;
        if (url === null) return null;
        return (
          <li className="shrink-0" key={attachmentId}>
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
              <a
                aria-label={`Open attachment ${index + 1}`}
                className="block rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
                href={url}
                rel="noreferrer"
                target="_blank"
              >
                <img
                  alt={`Issue attachment ${index + 1}`}
                  className="h-16 w-20 rounded-md border border-border/60 object-cover transition-opacity hover:opacity-80"
                  src={url}
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
  comments,
  issueId,
  onCreateComment,
}: {
  comments: ReadonlyArray<IssueComment>;
  issueId: IssueId;
  onCreateComment: (body: string, attachmentIds: ReadonlyArray<ChatAttachmentId>) => void;
}) {
  const environmentId = usePrimaryEnvironmentId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [isDropTarget, setIsDropTarget] = useState(false);
  const { attachments, addFiles, removeAttachment, clearAttachments } =
    useIssueImageAttachmentDrafts(issueId);
  const storedAttachmentIds = useMemo(() => issueAttachmentIds(comments), [comments]);
  const pendingIds = issueCommentAttachmentIds(attachments);
  const uploading = attachments.some((attachment) => attachment.status === "uploading");

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
        <Button
          className="ms-auto text-muted-foreground"
          onClick={() => inputRef.current?.click()}
          size="xs"
          variant="ghost"
        >
          <ImagePlusIcon />
          Add images
        </Button>
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

      {storedAttachmentIds.length === 0 || environmentId === null ? null : (
        <AttachmentGallery attachmentIds={storedAttachmentIds} environmentId={environmentId} />
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
