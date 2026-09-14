import { useEffect, useRef, useState } from "react";
import { DownloadIcon, FileTextIcon, XIcon } from "lucide-react";
import type { OrchestratorAttachment } from "@spiritdevs/contracts/aiOrchestrator";
import { formatAttachmentSizeLabel } from "../../lib/attachmentSize";
import { formatAttachmentUploadProgress } from "../../lib/attachmentUploadState";
import { ImageLightbox } from "../media/ImageLightbox";
import { Button } from "../ui/button";
import { useOrchestrators } from "./OrchestratorContext";
import { type ConversationAttachmentDraft } from "./conversationAttachmentDrafts";

export function ConversationAttachmentDrafts({
  drafts,
  disabled,
  remove,
  retry,
}: {
  drafts: readonly ConversationAttachmentDraft[];
  disabled: boolean;
  remove: (id: string) => void;
  retry: (id: string) => void;
}) {
  const [preview, setPreview] = useState<{ src: string; name: string }>();
  return (
    <>
      <div aria-label="Message attachments" className="flex flex-wrap gap-2 px-3 pt-3">
        {drafts.map((draft) => (
          <div
            key={draft.attachment.id}
            className="relative flex min-h-16 max-w-full items-center gap-2 rounded-lg border border-border/80 bg-background p-2 pr-8"
          >
            {draft.previewUrl ? (
              <button
                type="button"
                aria-label={`Preview ${draft.attachment.name}`}
                onClick={() => setPreview({ src: draft.previewUrl!, name: draft.attachment.name })}
              >
                <img
                  src={draft.previewUrl}
                  alt={draft.attachment.name}
                  className="size-12 rounded object-cover"
                />
              </button>
            ) : (
              <FileTextIcon className="size-5 shrink-0 text-muted-foreground" />
            )}
            <div className="min-w-0">
              <p className="max-w-40 truncate text-xs">{draft.attachment.name}</p>
              <p role="status" className="max-w-48 text-[10px] text-muted-foreground">
                {draft.status === "uploading"
                  ? `Uploading ${formatAttachmentUploadProgress(draft.progress)}`
                  : draft.status === "failed"
                    ? draft.error
                    : formatAttachmentSizeLabel(draft.attachment.sizeBytes)}
              </p>
              {draft.status === "failed" && (
                <button
                  type="button"
                  disabled={disabled}
                  aria-label={`Retry ${draft.attachment.name}`}
                  onClick={() => retry(draft.attachment.id)}
                  className="text-xs text-primary underline"
                >
                  Retry
                </button>
              )}
            </div>
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              disabled={disabled}
              className="absolute top-1 right-1 rounded-full"
              aria-label={`Remove ${draft.attachment.name}`}
              onClick={() => {
                setPreview(undefined);
                remove(draft.attachment.id);
              }}
            >
              <XIcon />
            </Button>
          </div>
        ))}
      </div>
      {preview && <ImageLightbox images={[preview]} onClose={() => setPreview(undefined)} />}
    </>
  );
}

export function ConversationMessageAttachment({
  attachment,
}: {
  attachment: OrchestratorAttachment;
}) {
  const { client, accountID, downloadAttachment } = useOrchestrators();
  const [preview, setPreview] = useState(false);
  const element = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!element.current) return;
    const observer = new IntersectionObserver(
      (entries) => setVisible(entries.some((entry) => entry.isIntersecting)),
      { rootMargin: "200px" },
    );
    observer.observe(element.current);
    return () => observer.disconnect();
  }, []);
  const [url, setUrl] = useState<string>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const shouldLoad = attachment.type === "image" ? visible || preview : attempt > 0;
  useEffect(() => {
    setUrl(undefined);
    setError(undefined);
    setLoading(false);
    if (!client || !shouldLoad) return;
    let objectUrl: string | undefined;
    const controller = new AbortController();
    setLoading(true);
    void (async () => {
      const blob = await downloadAttachment(attachment.id, controller.signal);
      if (controller.signal.aborted) return;
      objectUrl = URL.createObjectURL(
        new Blob([blob], {
          type: attachment.type === "image" ? attachment.mimeType : "application/octet-stream",
        }),
      );
      setUrl(objectUrl);
      if (attachment.type === "file") {
        const link = document.createElement("a");
        link.href = objectUrl;
        link.download = attachment.name;
        link.click();
      }
    })()
      .catch((cause: unknown) => {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : "Download failed.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [
    client,
    accountID,
    attachment.id,
    attachment.type,
    attachment.mimeType,
    attachment.name,
    attempt,
    shouldLoad,
    downloadAttachment,
  ]);
  return (
    <div
      ref={element}
      className="my-2 max-w-full rounded-lg border bg-background p-2 text-foreground"
    >
      <div
        className={
          attachment.type === "image"
            ? "flex h-52 w-80 max-w-full items-center justify-center"
            : undefined
        }
      >
        {attachment.type === "image" && url ? (
          <button
            type="button"
            aria-label={`Preview ${attachment.name}`}
            onClick={() => setPreview(true)}
          >
            <img
              src={url}
              alt={attachment.name}
              loading="lazy"
              className="max-h-52 max-w-full rounded object-contain"
            />
          </button>
        ) : (
          <Button
            type="button"
            variant="ghost"
            className="max-w-full justify-start"
            disabled={loading}
            onClick={() => setAttempt((value) => value + 1)}
            aria-label={`Download ${attachment.name}`}
          >
            <FileTextIcon />
            <span className="truncate">{attachment.name}</span>
            <DownloadIcon />
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground" role="status">
        {loading ? "Loading attachment…" : formatAttachmentSizeLabel(attachment.sizeBytes)}
      </p>
      {error && (
        <div role="alert" className="text-xs text-destructive">
          {error}{" "}
          <button
            type="button"
            className="underline"
            onClick={() => setAttempt((value) => value + 1)}
          >
            Retry
          </button>
        </div>
      )}
      {preview && url && (
        <ImageLightbox
          images={[{ src: url, name: attachment.name }]}
          onClose={() => setPreview(false)}
        />
      )}
    </div>
  );
}
