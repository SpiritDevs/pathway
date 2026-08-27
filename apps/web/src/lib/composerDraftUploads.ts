import type { ScopedProjectRef, ScopedThreadRef } from "@spiritdevs/contracts";
import { scopedThreadKey } from "@spiritdevs/client-runtime/environment";

import { type DraftId, useComposerDraftStore } from "../composerDraftStore";
import { releaseDraftAttachments } from "./attachmentUploadQueue";

export function releaseComposerDraftUploads(target: ScopedThreadRef | DraftId): void {
  const draft = useComposerDraftStore.getState().getComposerDraft(target);
  if (draft) releaseDraftAttachments(draft.images);
}

export function releaseProjectDraftUploads(
  projectRef: ScopedProjectRef,
  projectThreadRefs: ReadonlyArray<ScopedThreadRef> = [],
): void {
  const store = useComposerDraftStore.getState();
  for (const [draftKey, session] of Object.entries(store.draftThreadsByThreadKey)) {
    if (
      session.environmentId === projectRef.environmentId &&
      session.projectId === projectRef.projectId
    ) {
      const draft = store.draftsByThreadKey[draftKey];
      if (draft) releaseDraftAttachments(draft.images);
    }
  }
  for (const threadRef of projectThreadRefs) {
    const draft = store.draftsByThreadKey[scopedThreadKey(threadRef)];
    if (draft) releaseDraftAttachments(draft.images);
  }
}
