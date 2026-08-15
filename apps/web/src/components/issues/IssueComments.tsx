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
  IssueCommentAgentMentionInput,
  IssueCommentAgentRun,
  IssueCommentId,
  IssueId,
  ModelSelection,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { ChevronRightIcon, ImagePlusIcon, PencilIcon, Trash2Icon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useAssetUrls } from "~/assets/assetUrls";
import { useClientSettings } from "~/hooks/useSettings";
import { cn } from "~/lib/utils";
import type { ProviderInstanceEntry } from "~/providerInstances";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { formatChatTimestampTooltip, formatRelativeTimeLabel } from "~/timestampFormat";
import ChatMarkdown from "../ChatMarkdown";
import type { ModelEsque } from "../chat/providerIconUtils";
import { PROVIDER_CLIENT_DEFINITIONS } from "../settings/providerDriverMeta";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Spinner } from "../ui/spinner";
import { Textarea } from "../ui/textarea";
import { IssueAssigneeGlyph, IssueSlackGlyph } from "./IssueGlyphs";
import {
  issueCommentAgentRunPresentation,
  hasIssueCommentAgentRunDetails,
  type IssueCommentAgentRunTone,
} from "./issueCommentAgentRun.logic";
import {
  isIssueVideoAttachmentUrl,
  issueCommentAttachmentIds,
  issueCommentComposerState,
} from "./issueCommentAttachments";
import {
  issueCommentMentionAgents,
  IssueCommentInlineMentionPicker,
  IssueCommentMentionChip,
  IssueCommentMentionPicker,
} from "./IssueCommentMentionControls";
import {
  filterIssueCommentMentionAgents,
  findIssueCommentMentionQuery,
  issueCommentMentionBody,
  removeIssueCommentMentionQuery,
  resolveIssueCommentMention,
} from "./issueCommentMention.logic";
import { canEditIssueComment, issueActorLabel, type IssueEventNaming } from "./issueDetail.logic";
import { resolveIssueStartWorkModelSelection } from "./issueStartWork.logic";
import {
  PendingIssueImageAttachment,
  useIssueImageAttachmentDrafts,
} from "./useIssueImageAttachmentDrafts";

const PROVIDER_LABELS: ReadonlyMap<string, string> = new Map(
  PROVIDER_CLIENT_DEFINITIONS.map((definition) => [definition.value, definition.label]),
);

const COMMENT_NAMING: IssueEventNaming = { providerLabels: PROVIDER_LABELS };

const EMPTY_INSTANCE_ENTRIES: ReadonlyArray<ProviderInstanceEntry> = [];
const EMPTY_MODEL_OPTIONS: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>> = new Map();

const RUN_TONE_CLASS: Readonly<Record<IssueCommentAgentRunTone, string>> = {
  pending: "text-muted-foreground",
  active: "text-primary",
  done: "text-muted-foreground",
  failed: "text-destructive-foreground",
  canceled: "text-muted-foreground",
};

/**
 * The mention run under the comment that started it. Everything here is republished state: cancel
 * and retry send and wait, because the run's next state arrives on the stream like its first did.
 */
function CommentAgentRun({
  run,
  onCancel,
  onRetry,
}: {
  run: IssueCommentAgentRun;
  onCancel: () => void;
  onRetry: () => void;
}) {
  const presentation = issueCommentAgentRunPresentation(run);

  return (
    <div className="mt-1.5 flex flex-col gap-1 rounded-md border border-border/60 bg-muted/20 px-2 py-1.5">
      <div className="flex items-center gap-1.5 text-[11px]">
        <span className={cn("flex items-center gap-1.5", RUN_TONE_CLASS[presentation.tone])}>
          {presentation.isActive ? (
            <span
              aria-hidden
              className="size-1.5 shrink-0 animate-pulse rounded-full bg-current motion-reduce:animate-none"
            />
          ) : null}
          {presentation.label}
        </span>
        {presentation.durationLabel === null ? null : (
          <span className="text-muted-foreground/70">· {presentation.durationLabel}</span>
        )}
        {presentation.canCancel ? (
          <Button className="ms-auto" onClick={onCancel} size="xs" variant="ghost">
            Cancel
          </Button>
        ) : presentation.canRetry ? (
          <Button className="ms-auto" onClick={onRetry} size="xs" variant="ghost">
            Retry
          </Button>
        ) : null}
      </div>

      {presentation.errorText === null ? null : (
        <p className="text-[11px] text-destructive-foreground">{presentation.errorText}</p>
      )}

      {/* Collapsed by default: the log is evidence, not the answer — the answer arrives as its
          own comment. */}
      {hasIssueCommentAgentRunDetails(run) ? (
        <Collapsible>
          <CollapsibleTrigger className="group flex items-center gap-1 text-[11px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
            <ChevronRightIcon className="size-3 transition-transform duration-200 group-data-panel-open:rotate-90 motion-reduce:transition-none" />
            Execution details
          </CollapsibleTrigger>
          <CollapsiblePanel>
            <pre className="mt-1 max-h-56 overflow-auto rounded-md border border-border/60 bg-muted/24 p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words text-foreground/80">
              {run.transcript}
            </pre>
          </CollapsiblePanel>
        </Collapsible>
      ) : null}
    </div>
  );
}

/** A signed URL is minted per attachment, so this mounts only when there is something to fetch. */
function CommentAttachments({
  environmentId,
  attachmentIds,
  onOpenImage,
}: {
  environmentId: EnvironmentId;
  attachmentIds: ReadonlyArray<ChatAttachmentId>;
  onOpenImage: (attachmentId: ChatAttachmentId) => void;
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
        if (url === null) return null;
        return isIssueVideoAttachmentUrl(url) ? (
          <video
            aria-label="Comment video attachment"
            className="max-h-64 max-w-full rounded-lg border border-border/60"
            controls
            key={attachmentId}
            playsInline
            preload="metadata"
            src={url}
          />
        ) : (
          <button
            aria-label="Open comment attachment"
            className="cursor-zoom-in rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring"
            key={attachmentId}
            onClick={() => onOpenImage(attachmentId)}
            type="button"
          >
            <img
              alt="Comment attachment"
              className="max-h-40 rounded-lg border border-border/60 transition-opacity hover:opacity-80"
              src={url}
            />
          </button>
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
  onCancelAgentRun,
  onOpenImage,
  onRetryAgentRun,
}: {
  comment: IssueComment;
  environmentId: EnvironmentId | null;
  onEdit: (comment: IssueComment, body: string) => void;
  onDelete: (commentId: IssueCommentId) => void;
  onCancelAgentRun: (commentId: IssueCommentId) => void;
  onOpenImage: (attachmentId: ChatAttachmentId) => void;
  onRetryAgentRun: (commentId: IssueCommentId) => void;
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
                onOpenImage={onOpenImage}
              />
            )}
            {comment.agentRun == null ? null : (
              <CommentAgentRun
                onCancel={() => onCancelAgentRun(comment.id)}
                onRetry={() => onRetryAgentRun(comment.id)}
                run={comment.agentRun}
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
  onCancelAgentRun,
  onOpenImage,
  onRetryAgentRun,
  instanceEntries = EMPTY_INSTANCE_ENTRIES,
  modelOptionsByInstance = EMPTY_MODEL_OPTIONS,
}: {
  /** Already chronological — the state layer sorts the read and its live patches together. */
  comments: ReadonlyArray<IssueComment>;
  isPending: boolean;
  /** The owner of anything uploaded here: its id is baked into the attachment id. */
  issueId: IssueId;
  onCreate: (
    body: string,
    attachmentIds: ReadonlyArray<ChatAttachmentId>,
    /** Present only when the composer is submitting a mention: one comment, one run. */
    agentMention?: IssueCommentAgentMentionInput,
  ) => void;
  onEdit: (comment: IssueComment, body: string) => void;
  onDelete: (commentId: IssueCommentId) => void;
  onCancelAgentRun: (commentId: IssueCommentId) => void;
  /** Opens the shared image viewer on a comment's image instead of a browser tab. */
  onOpenImage: (attachmentId: ChatAttachmentId) => void;
  onRetryAgentRun: (commentId: IssueCommentId) => void;
  /** Every configured instance, not just the assignee's: a mention may name anybody. */
  instanceEntries?: ReadonlyArray<ProviderInstanceEntry>;
  modelOptionsByInstance?: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>;
}) {
  const environmentId = usePrimaryEnvironmentId();
  // No draft persistence: the sheet's body is keyed on the issue id, so walking the list with `j`
  // discards a half-written comment rather than carrying it to the next issue. Staged images go
  // with it — they are already in the store, and an orphan there costs a file, not a row.
  const [draft, setDraft] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [draftCaret, setDraftCaret] = useState(0);
  const [inlineMentionActiveIndex, setInlineMentionActiveIndex] = useState(0);
  const [dismissedInlineMentionQuery, setDismissedInlineMentionQuery] = useState<string | null>(
    null,
  );
  const [isDropTarget, setIsDropTarget] = useState(false);
  // The picker's choice, and the token a dismissed chip came from. Neither touches the draft: the
  // words stay as written, and the rewrite happens once, on the body, at submit.
  const [pickedInstanceId, setPickedInstanceId] = useState<ProviderInstanceId | null>(null);
  const [dismissedRaw, setDismissedRaw] = useState<string | null>(null);
  const [mentionSelection, setMentionSelection] = useState<ModelSelection | null>(null);
  const { attachments, addFiles, removeAttachment, clearAttachments } =
    useIssueImageAttachmentDrafts(issueId);
  const composer = issueCommentComposerState({ draft, attachments });

  const mentionAgents = useMemo(
    () => issueCommentMentionAgents(instanceEntries),
    [instanceEntries],
  );
  const mention = resolveIssueCommentMention({
    text: draft,
    agents: mentionAgents,
    pickedInstanceId,
    dismissedRaw,
  });
  const inlineMentionQuery =
    mention === null ? findIssueCommentMentionQuery(draft, draftCaret) : null;
  const inlineMentionQueryKey =
    inlineMentionQuery === null
      ? null
      : `${inlineMentionQuery.index}:${inlineMentionQuery.length}:${inlineMentionQuery.value}`;
  const inlineMentionAgents =
    inlineMentionQuery === null
      ? []
      : filterIssueCommentMentionAgents(mentionAgents, inlineMentionQuery.value);
  const isInlineMentionPickerOpen =
    inlineMentionQuery !== null && inlineMentionQueryKey !== dismissedInlineMentionQuery;
  const mentionInstanceId = mention?.agent.instanceId ?? null;
  const defaultSelectionFor = useCallback(
    (instanceId: ProviderInstanceId): ModelSelection | null => {
      const entry = instanceEntries.find((candidate) => candidate.instanceId === instanceId);
      if (entry === undefined) return null;
      return resolveIssueStartWorkModelSelection({
        provider: entry.driverKind,
        projectDefault: null,
        instanceEntries: [entry],
        modelOptionsByInstance,
      });
    },
    [instanceEntries, modelOptionsByInstance],
  );
  // The configuration follows the agent: naming somebody else starts from *their* defaults rather
  // than carrying the last one's effort onto a model that may not have the option at all.
  useEffect(() => {
    if (mentionInstanceId === null) {
      setMentionSelection(null);
      return;
    }
    setMentionSelection((current) =>
      current !== null && current.instanceId === mentionInstanceId
        ? current
        : defaultSelectionFor(mentionInstanceId),
    );
  }, [defaultSelectionFor, mentionInstanceId]);
  useEffect(() => {
    setInlineMentionActiveIndex(0);
  }, [inlineMentionQueryKey]);

  const pickInlineMention = (instanceId: ProviderInstanceId) => {
    if (inlineMentionQuery === null) return;
    const next = removeIssueCommentMentionQuery(draft, inlineMentionQuery);
    setDraft(next.text);
    setDraftCaret(next.caret);
    setDismissedInlineMentionQuery(null);
    setDismissedRaw(null);
    setPickedInstanceId(instanceId);
    window.requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(next.caret, next.caret);
    });
  };

  const clearComposer = () => {
    clearAttachments();
    setDraft("");
    setDraftCaret(0);
    setDismissedInlineMentionQuery(null);
    setPickedInstanceId(null);
    setDismissedRaw(null);
    setMentionSelection(null);
  };

  const submit = () => {
    if (!composer.canSubmit || composer.body === null) return;
    const attachmentIds = issueCommentAttachmentIds(attachments);
    // Resolved against the *body*, not the draft: the body is trimmed on its way here and the
    // offsets that drive the rewrite have to belong to the string being rewritten.
    const submitted = resolveIssueCommentMention({
      text: composer.body,
      agents: mentionAgents,
      pickedInstanceId,
      dismissedRaw,
    });
    const selection = mentionSelection;
    const body =
      submitted === null || selection === null
        ? composer.body
        : issueCommentMentionBody(composer.body, submitted);
    clearComposer();
    if (submitted === null || selection === null) {
      onCreate(body, attachmentIds);
      return;
    }
    onCreate(body, attachmentIds, { modelSelection: selection });
  };

  return (
    <section className="flex flex-col gap-2 pb-10">
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
              onCancelAgentRun={onCancelAgentRun}
              onDelete={onDelete}
              onEdit={onEdit}
              onOpenImage={onOpenImage}
              onRetryAgentRun={onRetryAgentRun}
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
        <div className="relative">
          <Textarea
            aria-activedescendant={
              isInlineMentionPickerOpen && inlineMentionAgents.length > 0
                ? `issue-comment-agent-${inlineMentionActiveIndex}`
                : undefined
            }
            aria-controls={isInlineMentionPickerOpen ? "issue-comment-agent-picker" : undefined}
            aria-expanded={isInlineMentionPickerOpen}
            aria-label="New comment"
            aria-haspopup="listbox"
            className="min-h-16"
            onChange={(event) => {
              setDraft(event.currentTarget.value);
              setDraftCaret(event.currentTarget.selectionStart);
            }}
            onKeyDown={(event) => {
              if (isInlineMentionPickerOpen && !(event.metaKey || event.ctrlKey)) {
                if (event.key === "ArrowDown" && inlineMentionAgents.length > 0) {
                  event.preventDefault();
                  setInlineMentionActiveIndex(
                    (current) => (current + 1) % inlineMentionAgents.length,
                  );
                  return;
                }
                if (event.key === "ArrowUp" && inlineMentionAgents.length > 0) {
                  event.preventDefault();
                  setInlineMentionActiveIndex(
                    (current) =>
                      (current - 1 + inlineMentionAgents.length) % inlineMentionAgents.length,
                  );
                  return;
                }
                if (event.key === "Enter" && inlineMentionAgents.length > 0) {
                  event.preventDefault();
                  pickInlineMention(
                    inlineMentionAgents[
                      Math.min(inlineMentionActiveIndex, inlineMentionAgents.length - 1)
                    ]!.instanceId,
                  );
                  return;
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  setDismissedInlineMentionQuery(inlineMentionQueryKey);
                  return;
                }
              }
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
            onSelect={(event) => setDraftCaret(event.currentTarget.selectionStart)}
            placeholder="Leave a comment… (⌘↵ to send, paste or drop an image to attach)"
            ref={textareaRef}
            value={draft}
          />
          {isInlineMentionPickerOpen ? (
            <IssueCommentInlineMentionPicker
              activeIndex={Math.min(
                inlineMentionActiveIndex,
                Math.max(0, inlineMentionAgents.length - 1),
              )}
              agents={inlineMentionAgents}
              entries={instanceEntries}
              onPick={pickInlineMention}
            />
          ) : null}
        </div>
        {/* The mention row sits between the text and the actions, and is always here when there is
            anybody to mention: adding the agent first and writing afterwards is the common order. */}
        {mentionAgents.length === 0 ? null : (
          <div className="flex flex-wrap items-center gap-1.5">
            <IssueCommentMentionPicker
              agents={mentionAgents}
              entries={instanceEntries}
              onPick={(instanceId) => {
                setDismissedRaw(null);
                setPickedInstanceId(instanceId);
              }}
            />
            {mention === null ? (
              <span className="text-[11px] text-muted-foreground/70">
                Mention an agent to have it reply to this comment.
              </span>
            ) : (
              <IssueCommentMentionChip
                agent={mention.agent}
                entries={instanceEntries}
                modelOptionsByInstance={modelOptionsByInstance}
                modelSelection={mentionSelection}
                onModelSelectionChange={(selection) => {
                  setMentionSelection(selection);
                  setPickedInstanceId(selection.instanceId);
                }}
                onRemove={() => {
                  // Both halves, or the typed token would put the chip straight back.
                  setPickedInstanceId(null);
                  setDismissedRaw(mention.typed?.raw ?? null);
                }}
              />
            )}
          </div>
        )}
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
