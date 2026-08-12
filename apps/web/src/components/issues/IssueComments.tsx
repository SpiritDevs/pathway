/**
 * The comment thread at the bottom of the detail sheet.
 *
 * **Composer:** a textarea, not the Lexical `ComposerPromptEditor`. That editor is inseparable from
 * chat drafts — its props are a draft cursor, a terminal-context list, a skill list, and an
 * `onChange` reporting mention adjacency, and its plugins read `ComposerTerminalContextActions`
 * from context (`ComposerPromptEditor.tsx:879`). None of that has a meaning on an issue. So:
 * Cmd/Ctrl+Enter submits, and images arrive by paste or drop.
 *
 * **Attachments:** an image pasted or dropped on the composer is compressed to the wire cap the
 * same way the chat composer's is, read to a base64 data URL, and handed to
 * `issues.uploadCommentAttachment`, which answers with the id the comment will carry. The bytes go
 * to the attachment store, not into the comment, so what a posted comment holds is a list of ids
 * and the assets route resolves them — exactly as it already did for an id minted elsewhere.
 *
 * @module components/issues/IssueComments
 */
import type {
  ChatAttachmentId,
  EnvironmentId,
  IssueComment,
  IssueCommentId,
  IssueId,
} from "@t3tools/contracts";
import { ImagePlusIcon, PencilIcon, Trash2Icon } from "lucide-react";
import { useMemo, useState } from "react";

import { useAssetUrls } from "~/assets/assetUrls";
import { useClientSettings } from "~/hooks/useSettings";
import { cn } from "~/lib/utils";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { formatChatTimestampTooltip, formatRelativeTimeLabel } from "~/timestampFormat";
import ChatMarkdown from "../ChatMarkdown";
import { PROVIDER_CLIENT_DEFINITIONS } from "../settings/providerDriverMeta";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { Textarea } from "../ui/textarea";
import { IssueAssigneeGlyph, IssueSlackGlyph } from "./IssueGlyphs";
import { issueCommentAttachmentIds, issueCommentComposerState } from "./issueCommentAttachments";
import { canEditIssueComment, issueActorLabel, type IssueEventNaming } from "./issueDetail.logic";
import {
  PendingIssueImageAttachment,
  useIssueImageAttachmentDrafts,
} from "./useIssueImageAttachmentDrafts";

const PROVIDER_LABELS: ReadonlyMap<string, string> = new Map(
  PROVIDER_CLIENT_DEFINITIONS.map((definition) => [definition.value, definition.label]),
);

const COMMENT_NAMING: IssueEventNaming = { providerLabels: PROVIDER_LABELS };

/**
 * Images only, which is all the store accepts. A signed URL is minted per attachment, so this is
 * mounted only when there is something to fetch.
 */
function CommentAttachments({
  environmentId,
  attachmentIds,
}: {
  environmentId: EnvironmentId;
  attachmentIds: ReadonlyArray<string>;
}) {
  const resources = useMemo(
    () => attachmentIds.map((attachmentId) => ({ _tag: "attachment" as const, attachmentId })),
    [attachmentIds],
  );
  const urls = useAssetUrls(environmentId, resources);

  return (
    <div className="mt-1.5 flex flex-wrap gap-2">
      {attachmentIds.map((attachmentId, index) => {
        const url = urls[index] ?? null;
        return url === null ? null : (
          <img
            alt="Comment attachment"
            className="max-h-40 rounded-lg border border-border/60"
            key={attachmentId}
            src={url}
          />
        );
      })}
    </div>
  );
}

function CommentRow({
  comment,
  environmentId,
  onEdit,
  onDelete,
}: {
  comment: IssueComment;
  environmentId: EnvironmentId | null;
  onEdit: (comment: IssueComment, body: string) => void;
  onDelete: (commentId: IssueCommentId) => void;
}) {
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(comment.body);
  const editable = canEditIssueComment(comment);

  const save = () => {
    setEditing(false);
    onEdit(comment, draft);
  };

  return (
    <li className="group/comment flex items-start gap-2">
      {/* A Slack reply is attributed in its body ("**Corey:** …") because there is no account for
          the person who wrote it, so the avatar says where it came from rather than who. */}
      {comment.author.kind === "system" && comment.author.source === "slack" ? (
        <span
          aria-label="From Slack"
          className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-foreground/70"
          role="img"
        >
          <IssueSlackGlyph className="size-3" />
        </span>
      ) : (
        <IssueAssigneeGlyph
          assignee={comment.author.kind === "system" ? null : comment.author}
          className="mt-0.5 size-5 shrink-0"
        />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="text-[13px] font-medium text-foreground">
            {issueActorLabel(comment.author, COMMENT_NAMING)}
          </span>
          <time
            className="text-[11px] text-muted-foreground/70"
            dateTime={comment.createdAt}
            title={formatChatTimestampTooltip(comment.createdAt, timestampFormat)}
          >
            {formatRelativeTimeLabel(comment.createdAt)}
          </time>
          {comment.editedAt === null ? null : (
            <span className="text-[11px] text-muted-foreground/70">(edited)</span>
          )}
          {!editable || editing ? null : (
            <span className="ms-auto flex items-center opacity-0 group-hover/comment:opacity-100 focus-within:opacity-100">
              <Button
                aria-label="Edit comment"
                className="text-muted-foreground"
                onClick={() => {
                  setDraft(comment.body);
                  setEditing(true);
                }}
                size="icon-xs"
                variant="ghost"
              >
                <PencilIcon />
              </Button>
              <Button
                aria-label="Delete comment"
                className="text-muted-foreground hover:text-destructive-foreground"
                onClick={() => onDelete(comment.id)}
                size="icon-xs"
                variant="ghost"
              >
                <Trash2Icon />
              </Button>
            </span>
          )}
        </div>

        {editing ? (
          <div className="mt-1 flex flex-col gap-1.5">
            <Textarea
              aria-label="Edit comment"
              autoFocus
              className="min-h-20"
              onChange={(event) => setDraft(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  setEditing(false);
                  return;
                }
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  save();
                }
              }}
              value={draft}
            />
            <div className="flex items-center gap-2">
              <Button onClick={save} size="xs">
                Save
              </Button>
              <Button onClick={() => setEditing(false)} size="xs" variant="outline">
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <>
            <ChatMarkdown className="text-[13px]" cwd={undefined} text={comment.body} />
            {comment.attachmentIds.length === 0 || environmentId === null ? null : (
              <CommentAttachments
                attachmentIds={comment.attachmentIds}
                environmentId={environmentId}
              />
            )}
          </>
        )}
      </div>
    </li>
  );
}

export function IssueComments({
  comments,
  isPending,
  issueId,
  onCreate,
  onEdit,
  onDelete,
}: {
  /** Already chronological — the state layer sorts the read and its live patches together. */
  comments: ReadonlyArray<IssueComment>;
  isPending: boolean;
  /** The owner of anything uploaded here: its id is baked into the attachment id. */
  issueId: IssueId;
  onCreate: (body: string, attachmentIds: ReadonlyArray<ChatAttachmentId>) => void;
  onEdit: (comment: IssueComment, body: string) => void;
  onDelete: (commentId: IssueCommentId) => void;
}) {
  const environmentId = usePrimaryEnvironmentId();
  // No draft persistence: the sheet's body is keyed on the issue id, so walking the list with `j`
  // discards a half-written comment rather than carrying it to the next issue. Staged images go
  // with it — they are already in the store, and an orphan there costs a file, not a row.
  const [draft, setDraft] = useState("");
  const [isDropTarget, setIsDropTarget] = useState(false);
  const { attachments, addFiles, removeAttachment, clearAttachments } =
    useIssueImageAttachmentDrafts(issueId);
  const composer = issueCommentComposerState({ draft, attachments });

  const clearComposer = () => {
    clearAttachments();
    setDraft("");
  };

  const submit = () => {
    if (!composer.canSubmit || composer.body === null) return;
    const attachmentIds = issueCommentAttachmentIds(attachments);
    const body = composer.body;
    clearComposer();
    onCreate(body, attachmentIds);
  };

  return (
    <section className="flex flex-col gap-2 border-t border-border/50 pt-3">
      <h3 className="text-xs font-medium text-muted-foreground">Comments</h3>

      {comments.length === 0 ? (
        isPending ? (
          <Spinner className="size-3.5 text-muted-foreground" />
        ) : null
      ) : (
        <ol className="flex flex-col gap-3">
          {comments.map((comment) => (
            <CommentRow
              comment={comment}
              environmentId={environmentId}
              key={comment.id}
              onDelete={onDelete}
              onEdit={onEdit}
            />
          ))}
        </ol>
      )}

      {/* The drop target is the whole composer, not the textarea: a dropped screenshot rarely
          lands inside a 4rem box, and the ring is what says where it will go. */}
      <div
        className={cn(
          "flex flex-col gap-1.5 rounded-lg",
          isDropTarget && "outline-2 outline-offset-2 outline-ring",
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
        {attachments.length === 0 ? null : (
          <ul className="flex flex-wrap gap-2">
            {attachments.map((attachment) => (
              <PendingIssueImageAttachment
                attachment={attachment}
                key={attachment.draftId}
                onRemove={removeAttachment}
              />
            ))}
          </ul>
        )}
        <Textarea
          aria-label="New comment"
          className="min-h-16"
          onChange={(event) => setDraft(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return;
            event.preventDefault();
            submit();
          }}
          onPaste={(event) => {
            const files = [...event.clipboardData.files];
            if (files.length === 0) return;
            // The clipboard carries a screenshot as a file with no text alternative, so nothing
            // is lost by taking the paste over — a copied file path still arrives as text.
            event.preventDefault();
            addFiles(files);
          }}
          placeholder="Leave a comment… (⌘↵ to send, paste or drop an image to attach)"
          value={draft}
        />
        {composer.showActions ? (
          <div className="flex items-center gap-2">
            <Button disabled={!composer.canSubmit} onClick={submit} size="xs">
              Comment
            </Button>
            <Button onClick={clearComposer} size="xs" variant="outline">
              Discard
            </Button>
            {composer.hint === null ? null : (
              <span className="flex items-center gap-1 text-[11px] text-muted-foreground/70">
                <ImagePlusIcon className="size-3" />
                {composer.hint}
              </span>
            )}
          </div>
        ) : null}
      </div>
    </section>
  );
}
