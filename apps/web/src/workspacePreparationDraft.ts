import type {
  OrchestrationV2AppThread,
  OrchestrationV2WorkspacePreparation,
} from "@spiritdevs/contracts";
import type { ScopedProjectRef } from "@spiritdevs/contracts";
import {
  useComposerDraftStore,
  type ComposerAttachment,
  type ComposerThreadTarget,
} from "./composerDraftStore";
import { newDraftId, newThreadId } from "./lib/utils";

/** Restore only after the server has cleaned up and cancelled the provisional thread. */
export function restoreWorkspacePreparationDraft(input: {
  source: ComposerThreadTarget;
  projectRef: ScopedProjectRef;
  logicalProjectKey: string;
  thread: Pick<
    OrchestrationV2AppThread,
    "runtimeMode" | "interactionMode" | "locations" | "modelSelection"
  >;
  preparation: OrchestrationV2WorkspacePreparation | undefined;
  text: string;
  attachments: ComposerAttachment[];
}) {
  const store = useComposerDraftStore.getState();
  const draftId = newDraftId();
  store.setLogicalProjectDraftThreadId(input.logicalProjectKey, input.projectRef, draftId, {
    threadId: newThreadId(),
    createdAt: new Date().toISOString(),
    runtimeMode: input.thread.runtimeMode,
    interactionMode: input.thread.interactionMode,
    ...(input.thread.locations ? { locations: input.thread.locations } : {}),
    startFromOrigin: input.preparation?.startFromOrigin ?? false,
    branch: input.preparation?.baseRef ?? null,
    worktreePath: null,
    envMode: "worktree",
  });
  store.moveComposerContent(input.source, draftId);
  const pending = store.getComposerDraft(draftId)?.prompt ?? "";
  store.setPrompt(draftId, pending ? `${input.text}\n\n${pending}` : input.text);
  store.addImages(draftId, input.attachments);
  store.setModelSelection(draftId, input.thread.modelSelection, { replaceOptions: true });
  return draftId;
}
