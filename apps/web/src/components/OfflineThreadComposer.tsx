import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { CONVERSATIONS_FOCUS_ID } from "@spiritdevs/client-runtime/state/focuses";
import { activeFocusIdAtom } from "../cloud/focusReadModel";
import { threadQueueAccountAtom } from "../cloud/threadQueueState";
import { useEffect, useState } from "react";
import { ChatAttachmentId, ProviderInstanceId, type ScopedThreadRef } from "@spiritdevs/contracts";
import { type DraftId, useComposerDraftStore } from "../composerDraftStore";
import {
  queueThreadTurn,
  subscribeQueueDestinations,
  type ThreadQueueDestination,
} from "../cloud/threadQueue";
import { newMessageId } from "../lib/utils";
import { Button } from "./ui/button";
import { appendTerminalContextsToPrompt } from "../lib/terminalContext";
import { appendElementContextsToPrompt } from "../lib/elementContext";
import { appendIssueContextsToPrompt } from "../lib/issueContext";
import { appendPreviewAnnotationPrompt } from "../lib/previewAnnotation";
import { appendReviewCommentsToPrompt } from "../reviewCommentContext";
import { useThreadShell } from "../state/entities";

/** Cold clients can save a first turn using registered cloud destination metadata. */
export function OfflineThreadComposer(
  props: { draftId: DraftId; threadRef?: never } | { threadRef: ScopedThreadRef; draftId?: never },
) {
  const target = props.draftId ?? props.threadRef;
  const draft = useComposerDraftStore((state) =>
    props.draftId ? state.getDraftSession(props.draftId) : null,
  );
  const thread = useThreadShell(props.threadRef ?? null);
  const session =
    draft ??
    (thread
      ? { ...thread, threadId: thread.id, envMode: "local" as const, startFromOrigin: false }
      : null);
  const composer = useComposerDraftStore((state) => state.getComposerDraft(target));
  const account = useAtomValue(threadQueueAccountAtom);
  const setActiveFocusId = useAtomSet(activeFocusIdAtom);
  const [destinations, setDestinations] = useState<readonly ThreadQueueDestination[]>([]);
  const [modelKey, setModelKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => subscribeQueueDestinations(undefined, setDestinations), [account]);
  if (!session) return null;
  const destination = destinations.find((item) => item.environmentId === session.environmentId);
  const project = destination?.projects.find((item) => item.localProjectId === session.projectId);
  const models =
    destination?.providers
      .filter((provider) => provider.enabled)
      .flatMap((provider) =>
        provider.modelIds.map((model) => ({
          key: `${provider.instanceId}:${model}`,
          instanceId: provider.instanceId,
          model,
          label: `${provider.displayName ?? provider.driver} · ${model}`,
        })),
      ) ?? [];
  const selected = models.find((model) => model.key === modelKey);
  const submit = async () => {
    if (!selected || !composer || (!composer.prompt.trim() && composer.images.length === 0)) return;
    setBusy(true);
    setError(null);
    try {
      const attachments = composer.images.map((file) => {
        if (!file.file) throw new Error(`Attach ${file.name} again before sending.`);
        return {
          metadata: {
            id: file.id,
            type: file.type,
            name: file.name,
            mimeType: file.mimeType,
            sizeBytes: file.sizeBytes,
          },
          blob: file.file,
        };
      });
      const modelSelection = {
        instanceId: ProviderInstanceId.make(selected.instanceId),
        model: selected.model,
      };
      const messageId = newMessageId();
      const withContexts = appendElementContextsToPrompt(
        appendTerminalContextsToPrompt(composer.prompt, composer.terminalContexts),
        composer.elementContexts,
      );
      const withAnnotations = composer.previewAnnotations.reduce(
        (text, annotation) => appendPreviewAnnotationPrompt(text, annotation),
        withContexts,
      );
      const messageText = appendIssueContextsToPrompt(
        appendReviewCommentsToPrompt(withAnnotations, composer.reviewComments),
        composer.issueContexts,
      );
      const title =
        composer.prompt.trim().slice(0, 160) || composer.images[0]?.name || "New thread";
      await queueThreadTurn({
        environmentId: session.environmentId,
        durableAttachments: attachments,
        input: {
          threadId: session.threadId,
          message: {
            messageId,
            role: "user",
            text: messageText || "Please review the attached files.",
            attachments: [],
          },
          modelSelection,
          runtimeMode: session.runtimeMode,
          interactionMode: session.interactionMode,
          ...(draft
            ? {
                bootstrap: {
                  createThread: {
                    projectId: session.projectId,
                    ...(session.conversationCompanyId
                      ? { conversationCompanyId: session.conversationCompanyId }
                      : {}),
                    title,
                    modelSelection,
                    runtimeMode: session.runtimeMode,
                    interactionMode: session.interactionMode,
                    locations: session.locations ?? ["agents"],
                    branch: session.branch,
                    worktreePath: session.worktreePath,
                    createdAt: session.createdAt,
                  },
                  ...(session.envMode === "worktree" && session.branch && project
                    ? {
                        prepareWorktree: {
                          projectCwd: project.workspaceRoot,
                          baseBranch: session.branch,
                          startFromOrigin: session.startFromOrigin,
                        },
                      }
                    : {}),
                },
              }
            : {}),
        },
      });
      if (
        draft &&
        (session.projectId === null ||
          session.projectId === `conversations:${session.conversationCompanyId}`)
      )
        setActiveFocusId(CONVERSATIONS_FOCUS_ID);
      const store = useComposerDraftStore.getState();
      if (props.draftId)
        store.setDraftPendingSend(props.draftId, {
          messageId,
          text: composer.prompt,
          title,
          createdAt: new Date().toISOString(),
        });
      store.clearComposerContent(target);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save this message.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      className="mx-auto flex w-full max-w-3xl flex-col gap-5 overflow-y-auto px-6 py-10"
    >
      <h1 className="text-xl font-semibold">{thread?.title ?? "Start a queued thread"}</h1>
      <p className="text-sm text-muted-foreground">
        {destination?.label ?? "This environment"} is disconnected. Save your message to the cloud;
        it will run when the environment reconnects, even if you close the app.
      </p>
      {project ? (
        <p className="text-sm">
          {project.title} · {project.workspaceRoot}
        </p>
      ) : null}
      <textarea
        aria-label="Message"
        className="min-h-40 rounded-lg border bg-background p-3"
        placeholder="What would you like the agent to do?"
        value={composer?.prompt ?? ""}
        onChange={(event) => useComposerDraftStore.getState().setPrompt(target, event.target.value)}
      />
      <select
        aria-label="Model"
        className="rounded-lg border bg-background p-2"
        value={modelKey}
        onChange={(event) => setModelKey(event.target.value)}
      >
        <option value="">Choose a registered model</option>
        {models.map((model) => (
          <option key={model.key} value={model.key}>
            {model.label}
          </option>
        ))}
      </select>
      <label className="text-sm">
        Attach files
        <input
          type="file"
          multiple
          className="mt-2 block w-full"
          onChange={(event) => {
            const files = [...(event.target.files ?? [])];
            useComposerDraftStore.getState().addImages(
              target,
              files.map((file) => {
                const fields = {
                  id: ChatAttachmentId.make(`draft-${newMessageId()}`),
                  file,
                  name: file.name,
                  mimeType: file.type || "application/octet-stream",
                  sizeBytes: file.size,
                  previewUrl: URL.createObjectURL(file),
                };
                return file.type.startsWith("image/")
                  ? { ...fields, type: "image" as const }
                  : { ...fields, type: "file" as const };
              }),
            );
            event.target.value = "";
          }}
        />
      </label>
      {composer?.images.map((file) => (
        <div key={file.id} className="flex items-center gap-2 text-sm">
          <span className="truncate">{file.name}</span>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => useComposerDraftStore.getState().removeImage(target, file.id)}
          >
            Remove
          </Button>
        </div>
      ))}
      <Button
        type="submit"
        disabled={
          busy ||
          !selected ||
          !composer ||
          (!composer.prompt.trim() && composer.images.length === 0)
        }
      >
        {busy ? "Saving…" : "Queue message"}
      </Button>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </form>
  );
}
