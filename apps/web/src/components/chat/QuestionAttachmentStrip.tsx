import type { EnvironmentId } from "@spiritdevs/contracts";
import { FileIcon, XIcon } from "lucide-react";
import { useAssetUrl } from "../../assets/assetUrls";
import { type QuestionAttachmentDraft } from "../../questionAttachmentDrafts";
import { Button } from "../ui/button";

function UploadedQuestionImage({
  environmentId,
  attachment,
}: {
  environmentId: EnvironmentId;
  attachment: NonNullable<QuestionAttachmentDraft["attachment"]>;
}) {
  const url = useAssetUrl(environmentId, { _tag: "attachment", attachmentId: attachment.id });
  return url ? (
    <a href={url} target="_blank" rel="noreferrer" aria-label={`Preview ${attachment.name}`}>
      <img src={url} alt={attachment.name} className="size-12 rounded object-cover" />
    </a>
  ) : (
    <FileIcon className="size-5" />
  );
}

export function QuestionAttachmentStrip({
  environmentId,
  drafts,
  disabled,
  onRemove,
  onRetry,
}: {
  environmentId: EnvironmentId;
  drafts: readonly QuestionAttachmentDraft[];
  disabled: boolean;
  onRemove: (id: string) => void;
  onRetry: (id: string) => void;
}) {
  return (
    <div className="mb-3 flex flex-wrap gap-2" aria-label="Answer attachments">
      {drafts.map((draft) => (
        <div
          key={draft.id}
          className="flex max-w-full items-center gap-2 rounded-lg border bg-background/70 p-2"
        >
          {draft.attachment?.type === "image" ? (
            <UploadedQuestionImage environmentId={environmentId} attachment={draft.attachment} />
          ) : (
            <FileIcon className="size-5 shrink-0" />
          )}
          <div className="min-w-0">
            <p className="max-w-48 truncate text-xs">{draft.name}</p>
            <p className="max-w-64 text-xs text-muted-foreground" role="status">
              {draft.status === "uploading"
                ? "Uploading…"
                : draft.status === "failed"
                  ? draft.error
                  : "Ready"}
            </p>
            {draft.status === "failed" ? (
              <button
                type="button"
                disabled={disabled}
                onClick={() => onRetry(draft.id)}
                className="text-xs text-primary"
              >
                Retry
              </button>
            ) : null}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            disabled={disabled}
            onClick={() => onRemove(draft.id)}
            aria-label={`Remove ${draft.name}`}
          >
            <XIcon />
          </Button>
        </div>
      ))}
    </div>
  );
}
