import {
  type EnvironmentId,
  type PendingChatAttachment,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
} from "@spiritdevs/contracts";
import {
  verifyPersistedAttachmentUpload,
  deletePendingAttachmentUpload,
} from "@spiritdevs/client-runtime/state/attachments";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { compressImageToByteLimit } from "./lib/imageCompression";
import { uploadStandaloneFileAttachment } from "./lib/attachmentUploadQueue";
import { createMemoryStorage } from "./lib/storage";
import { appAtomRegistry } from "./rpc/atomRegistry";
import { attachmentEnvironment } from "./state/attachments";
import { assetEnvironment } from "./state/assets";
import { randomUUID } from "./lib/utils";

export interface QuestionAttachmentDraft {
  id: string;
  questionId: string;
  name: string;
  status: "uploading" | "ready" | "failed" | "unverified";
  attachment?: PendingChatAttachment;
  error?: string;
}
export const EMPTY_QUESTION_ATTACHMENTS: QuestionAttachmentDraft[] = [];
export const questionAttachmentDraftKey = (
  environmentId: EnvironmentId,
  threadId: string,
  requestId: string,
) => JSON.stringify([environmentId, threadId, requestId]);

/** Only upload receipts are stored locally. Image bytes use the existing HTTP upload path. */
export const useQuestionAttachmentDrafts = create(
  persist(() => ({ byRequest: {} as Record<string, QuestionAttachmentDraft[]> }), {
    name: "pathway:question-attachments:v1",
    storage: createJSONStorage(() =>
      typeof localStorage === "undefined" ? createMemoryStorage() : localStorage,
    ),
    merge: (persisted, current) => {
      const restored = (persisted as Partial<typeof current> | undefined)?.byRequest ?? {};
      return {
        ...current,
        byRequest: Object.fromEntries(
          Object.entries(restored).map(([key, drafts]) => [
            key,
            drafts.map((draft) =>
              draft.status === "ready" ? { ...draft, status: "unverified" as const } : draft,
            ),
          ]),
        ),
      };
    },
    partialize: (state) => ({
      byRequest: Object.fromEntries(
        Object.entries(state.byRequest).map(([key, drafts]) => [
          key,
          drafts.map((draft) =>
            draft.status === "uploading"
              ? {
                  ...draft,
                  status: "failed" as const,
                  error: "Upload was interrupted. Attach the file again.",
                }
              : draft,
          ),
        ]),
      ),
    }),
  }),
);

const files = new Map<string, File>();
function updateDraft(key: string, id: string, update: Partial<QuestionAttachmentDraft>) {
  useQuestionAttachmentDrafts.setState((state) => ({
    byRequest: {
      ...state.byRequest,
      [key]: (state.byRequest[key] ?? []).map((draft) =>
        draft.id === id ? { ...draft, ...update } : draft,
      ),
    },
  }));
}
function deleteUpload(environmentId: EnvironmentId, attachmentId: string) {
  deletePendingAttachmentUpload({
    registry: appAtomRegistry,
    remove: attachmentEnvironment.remove,
    environmentId,
    attachmentId,
  });
}

export async function retryQuestionAttachment(
  environmentId: EnvironmentId,
  key: string,
  id: string,
) {
  const draft = useQuestionAttachmentDrafts
    .getState()
    .byRequest[key]?.find((entry) => entry.id === id);
  const file = files.get(id);
  if (!draft || draft.status === "uploading") return;
  if (!file && draft.attachment) {
    updateDraft(key, id, { status: "uploading" });
    const verification = await verifyPersistedAttachmentUpload({
      registry: appAtomRegistry,
      createAssetUrl: assetEnvironment.createUrl,
      environmentId,
      attachmentId: draft.attachment.id,
    });
    if (
      !useQuestionAttachmentDrafts
        .getState()
        .byRequest[key]?.some(
          (entry) => entry.id === id && entry.attachment?.id === draft.attachment?.id,
        )
    )
      return;
    updateDraft(
      key,
      id,
      verification.status === "verified"
        ? { status: "ready" }
        : {
            status: "failed",
            error:
              verification.status === "missing"
                ? "Uploaded file expired. Attach it again."
                : "Uploaded file could not be verified. Retry when reconnected.",
          },
    );
    return;
  }
  if (!file) {
    updateDraft(key, id, {
      status: "failed",
      error: "Attach this file again to retry the upload.",
    });
    return;
  }
  updateDraft(key, id, { status: "uploading" });
  try {
    const attachment = await uploadStandaloneFileAttachment({
      environmentId,
      type: file.type.startsWith("image/") ? "image" : "file",
      file,
      name: draft.name,
      mimeType: file.type || "application/octet-stream",
      sizeBytes: file.size,
    });
    if (!useQuestionAttachmentDrafts.getState().byRequest[key]?.some((entry) => entry.id === id)) {
      deleteUpload(environmentId, attachment.id);
      return;
    }
    updateDraft(key, id, { status: "ready", attachment });
    files.delete(id);
  } catch (error) {
    updateDraft(key, id, {
      status: "failed",
      error:
        error instanceof Error ? error.message : "Upload failed. Retry or remove the attachment.",
    });
  }
}

export async function revalidateQuestionAttachments(environmentId: EnvironmentId, key: string) {
  const restored = useQuestionAttachmentDrafts.getState().byRequest[key] ?? [];
  await Promise.all(
    restored
      .filter((draft) => draft.status === "unverified")
      .map((draft) => retryQuestionAttachment(environmentId, key, draft.id)),
  );
}

export async function addQuestionAttachments(input: {
  environmentId: EnvironmentId;
  key: string;
  questionId: string;
  files: readonly File[];
  maxFileBytes: number | null;
}) {
  const current = useQuestionAttachmentDrafts.getState().byRequest[input.key] ?? [];
  const room = PROVIDER_SEND_TURN_MAX_ATTACHMENTS - current.length;
  const accepted = input.files.slice(0, Math.max(0, room));
  const drafts = accepted.map((file) => ({
    id: randomUUID(),
    questionId: input.questionId,
    name: (file.name.trim() || "Image.png").slice(0, 255),
    status: "uploading" as const,
  }));
  // Reserve slots before compression or uploads so rapid pastes cannot overfill the answer.
  useQuestionAttachmentDrafts.setState((state) => ({
    byRequest: { ...state.byRequest, [input.key]: [...current, ...drafts] },
  }));
  for (const [index, draft] of drafts.entries()) {
    let file = accepted[index];
    if (!file) continue;
    try {
      if (file.size === 0) throw new Error("Empty files cannot be attached.");
      if (file.type.startsWith("image/")) {
        const compressed = await compressImageToByteLimit(file, PROVIDER_SEND_TURN_MAX_IMAGE_BYTES);
        if (!compressed.ok)
          throw new Error("This image could not be prepared. Choose a smaller image.");
        file = compressed.file;
      } else if (input.maxFileBytes === null || file.size > input.maxFileBytes) {
        throw new Error("This file exceeds the environment's upload limit.");
      }
      if (
        !useQuestionAttachmentDrafts
          .getState()
          .byRequest[input.key]?.some((entry) => entry.id === draft.id)
      )
        continue;
      files.set(draft.id, file);
      updateDraft(input.key, draft.id, { status: "failed" });
      await retryQuestionAttachment(input.environmentId, input.key, draft.id);
    } catch (error) {
      updateDraft(input.key, draft.id, {
        status: "failed",
        error: error instanceof Error ? error.message : "The file could not be prepared.",
      });
    }
  }
  return input.files.length > room
    ? `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} files across these answers.`
    : null;
}

export function removeQuestionAttachment(environmentId: EnvironmentId, key: string, id: string) {
  const draft = useQuestionAttachmentDrafts
    .getState()
    .byRequest[key]?.find((entry) => entry.id === id);
  useQuestionAttachmentDrafts.setState((state) => ({
    byRequest: {
      ...state.byRequest,
      [key]: (state.byRequest[key] ?? []).filter((entry) => entry.id !== id),
    },
  }));
  files.delete(id);
  if (draft?.attachment) deleteUpload(environmentId, draft.attachment.id);
}

export function clearQuestionAttachments(environmentId: EnvironmentId, key: string) {
  for (const draft of useQuestionAttachmentDrafts.getState().byRequest[key] ?? []) {
    files.delete(draft.id);
    if (draft.attachment) deleteUpload(environmentId, draft.attachment.id);
  }
  useQuestionAttachmentDrafts.setState((state) => {
    const byRequest = { ...state.byRequest };
    delete byRequest[key];
    return { byRequest };
  });
}

export function readyQuestionAttachments(
  drafts: readonly QuestionAttachmentDraft[],
): Record<string, PendingChatAttachment[]> | null {
  if (drafts.some((draft) => draft.status !== "ready" || !draft.attachment)) return null;
  const entries = new Map<string, PendingChatAttachment[]>();
  for (const draft of drafts) {
    if (draft.attachment)
      entries.set(draft.questionId, [...(entries.get(draft.questionId) ?? []), draft.attachment]);
  }
  return Object.fromEntries(entries);
}
