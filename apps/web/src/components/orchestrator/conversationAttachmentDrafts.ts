import { useEffect, useRef, useState } from "react";
import type { ConvexClient } from "convex/browser";
import { makeFunctionReference } from "cyndrbase/server";
import * as Schema from "effect/Schema";
import { OrchestratorAttachment } from "@spiritdevs/contracts/aiOrchestrator";
import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
} from "@spiritdevs/contracts";
import { randomUUID } from "../../lib/utils";
import {
  compressImageToByteLimit,
  MAX_COMPRESSIBLE_SOURCE_BYTES,
} from "../../lib/imageCompression";
import { isHeicImage } from "../../lib/heicImage";
import { normalizeComposerAttachmentName } from "../chat/composerAttachmentFiles";

export interface ConversationAttachmentDraft {
  attachment: OrchestratorAttachment;
  file: File;
  previewUrl?: string;
  status: "preparing" | "uploading" | "ready" | "failed";
  progress: number;
  error?: string | undefined;
  storageId?: string;
}
const ref = <T extends "query" | "mutation">(kind: T, name: string) => {
  void kind;
  return makeFunctionReference<T>(`aiOrchestratorAttachments:${name}`);
};
const isAttachment = Schema.is(OrchestratorAttachment);

function sourceMetadata(file: File, id: string) {
  const type = file.type.toLowerCase().startsWith("image/")
    ? ("image" as const)
    : ("file" as const);
  return {
    id,
    type,
    name: normalizeComposerAttachmentName(file.name, type),
    mimeType: file.type.toLowerCase() || "application/octet-stream",
    sizeBytes: file.size,
  };
}

export function conversationFileMetadata(file: File, id = randomUUID()): OrchestratorAttachment {
  const metadata = sourceMetadata(file, id);
  if (!isAttachment(metadata))
    throw new Error(
      `${metadata.name}: images must be at most 10 MB and files at most 50 MB, with a name under 256 characters.`,
    );
  return metadata;
}

/** Normalize bytes before creating any upload metadata or preview URL. */
export async function prepareConversationFile(file: File, id: string) {
  if (file.type.toLowerCase().startsWith("image/") || (await isHeicImage(file))) {
    const result = await compressImageToByteLimit(file, PROVIDER_SEND_TURN_MAX_IMAGE_BYTES);
    if (!result.ok)
      throw new Error(
        result.reason === "unreadable"
          ? `${file.name}: this image could not be converted. Choose another image or export it as JPEG or PNG.`
          : `${file.name}: this image is too large to attach, even after conversion.`,
      );
    file = result.file;
  }
  return { file, attachment: conversationFileMetadata(file, id) };
}

/** Uses the normal thread cloud queue's direct storage protocol with compose progress. */
export async function uploadConversationFile(
  url: string,
  file: Blob,
  mimeType: string,
  signal: AbortSignal,
  progress: (fraction: number) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    const finish = () => signal.removeEventListener("abort", abort);
    xhr.open("POST", url);
    xhr.timeout = 5 * 60_000;
    xhr.setRequestHeader("Content-Type", mimeType);
    xhr.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) progress(event.loaded / event.total);
    });
    xhr.addEventListener("load", () => {
      finish();
      try {
        const value: unknown = JSON.parse(xhr.responseText);
        if (
          xhr.status < 200 ||
          xhr.status >= 300 ||
          typeof value !== "object" ||
          value === null ||
          !("storageId" in value) ||
          typeof value.storageId !== "string"
        )
          throw new Error(`Attachment upload failed (${xhr.status}).`);
        resolve(value.storageId);
      } catch (error) {
        reject(error);
      }
    });
    xhr.addEventListener("error", () => {
      finish();
      reject(new Error("Upload failed. Check your connection and retry."));
    });
    xhr.addEventListener("timeout", () => {
      finish();
      reject(new Error("Upload timed out. Retry the attachment."));
    });
    xhr.addEventListener("abort", () => {
      finish();
      reject(new Error("Upload cancelled."));
    });
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      finish();
      reject(new Error("Upload cancelled."));
      return;
    }
    xhr.send(file);
  });
}

export function useConversationAttachmentDrafts(client: ConvexClient | null, accountID: string) {
  const [drafts, setDrafts] = useState<Record<string, ConversationAttachmentDraft[]>>({});
  const current = useRef(drafts);
  const jobs = useRef(new Map<string, AbortController>());
  const queue = useRef<Array<() => Promise<void>>>([]);
  const active = useRef(0);
  const generation = useRef(0);
  function update(
    chatId: string,
    change: (rows: ConversationAttachmentDraft[]) => ConversationAttachmentDraft[],
  ) {
    current.current = { ...current.current, [chatId]: change(current.current[chatId] ?? []) };
    setDrafts(current.current);
  }
  useEffect(() => {
    generation.current++;
    jobs.current.clear();
    queue.current = [];
    current.current = {};
    setDrafts({});
    return () => {
      generation.current++;
      // Let in-flight POSTs report their storage IDs to their cleanup blocks.
      // Closing the process before the response remains a direct-upload protocol limitation.
      for (const [chatId, rows] of Object.entries(current.current)) {
        for (const row of rows) {
          if (row.previewUrl) URL.revokeObjectURL(row.previewUrl);
          if (row.storageId || !jobs.current.has(row.attachment.id))
            void client
              ?.mutation(ref("mutation", "discard"), {
                chatId,
                id: row.attachment.id,
                ...(row.storageId ? { storageId: row.storageId } : {}),
              })
              .catch(() => {});
        }
      }
    };
  }, [client, accountID]);
  const discard = (chatId: string, id: string, storageId?: string) =>
    void client
      ?.mutation(ref("mutation", "discard"), { chatId, id, ...(storageId ? { storageId } : {}) })
      .catch(() => {
        /* Pending uploads expire server-side. */
      });
  function pump() {
    while (active.current < 3 && queue.current.length) {
      active.current++;
      void queue.current.shift()!().finally(() => {
        active.current--;
        pump();
      });
    }
  }
  function start(chatId: string, targetId: string, draft: ConversationAttachmentDraft) {
    const epoch = generation.current;
    const id = draft.attachment.id;
    const controller = new AbortController();
    jobs.current.set(id, controller);
    const exists = () =>
      epoch === generation.current &&
      !controller.signal.aborted &&
      current.current[chatId]?.some((row) => row.attachment.id === id);
    const patch = (value: Partial<ConversationAttachmentDraft>) => {
      if (exists())
        update(chatId, (rows) =>
          rows.map((row) => (row.attachment.id === id ? { ...row, ...value } : row)),
        );
    };
    patch({ status: "preparing", progress: 0, error: undefined });
    queue.current.push(async () => {
      let storageId = draft.storageId;
      try {
        if (!client || !exists()) return;
        const normalized = await prepareConversationFile(draft.file, id);
        if (!exists()) return;
        const previewUrl =
          draft.previewUrl ??
          (normalized.attachment.type === "image"
            ? URL.createObjectURL(normalized.file)
            : undefined);
        patch({ ...normalized, ...(previewUrl ? { previewUrl } : {}), status: "uploading" });
        const prepared = (await client.mutation(ref("mutation", "prepare"), {
          chatId,
          targetId,
          attachment: normalized.attachment,
        })) as { ready: boolean; uploadUrl: string | null };
        if (!exists()) return;
        if (!prepared.ready) {
          if (!prepared.uploadUrl) throw new Error("No upload URL was returned.");
          storageId =
            storageId ??
            (await uploadConversationFile(
              prepared.uploadUrl,
              normalized.file,
              normalized.attachment.mimeType,
              controller.signal,
              (progress) => patch({ progress: Math.floor(progress * 20) / 20 }),
            ));
          patch({ storageId });
          if (!exists()) return;
          await client.mutation(ref("mutation", "finalize"), { chatId, id, storageId });
        }
        if (!exists()) return;
        patch({ status: "ready", progress: 1 });
      } catch (error) {
        patch({
          status: "failed",
          error: error instanceof Error ? error.message : "Upload failed. Retry the attachment.",
        });
      } finally {
        if (!exists()) discard(chatId, id, storageId);
        jobs.current.delete(id);
      }
    });
    pump();
  }
  return {
    drafts,
    add(chatId: string, targetId: string, files: readonly File[]) {
      if (!client) throw new Error("Sign in before attaching files.");
      const rows = current.current[chatId] ?? [];
      if (rows.length + files.length > PROVIDER_SEND_TURN_MAX_ATTACHMENTS)
        throw new Error(`Attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} files per message.`);
      for (const file of files) {
        if (file.size > MAX_COMPRESSIBLE_SOURCE_BYTES)
          throw new Error(`${file.name}: files must be at most 50 MB before conversion.`);
      }
      const added = files.map(
        (file): ConversationAttachmentDraft => ({
          attachment: sourceMetadata(file, randomUUID()),
          file,
          status: "preparing",
          progress: 0,
        }),
      );
      update(chatId, (existing) => [...existing, ...added]);
      added.forEach((row) => start(chatId, targetId, row));
    },
    remove(chatId: string, id: string) {
      const row = current.current[chatId]?.find((row) => row.attachment.id === id);
      const uploading = jobs.current.has(id);
      update(chatId, (rows) => rows.filter((row) => row.attachment.id !== id));
      if (row?.previewUrl) URL.revokeObjectURL(row.previewUrl);
      // Let an in-flight POST return its storage ID so its finally block can remove the blob.
      if (!uploading) discard(chatId, id, row?.storageId);
    },
    retry(chatId: string, targetId: string, id: string) {
      const row = current.current[chatId]?.find((row) => row.attachment.id === id);
      if (row?.status === "failed") start(chatId, targetId, row);
    },
    sent(chatId: string, ids: readonly string[]) {
      update(chatId, (rows) =>
        rows.filter((row) => {
          if (!ids.includes(row.attachment.id)) return true;
          if (row.previewUrl) URL.revokeObjectURL(row.previewUrl);
          return false;
        }),
      );
    },
  };
}

export async function fetchConversationAttachment(
  client: ConvexClient,
  id: string,
  token: string,
  signal?: AbortSignal,
): Promise<Blob> {
  const url = (await client.query(ref("query", "download"), { id })) as string;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw new Error("Attachment unavailable. Reconnect and retry.");
  return response.blob();
}
