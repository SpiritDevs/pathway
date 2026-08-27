import type { ChatFileAttachment, EnvironmentId } from "@spiritdevs/contracts";
import { resolveAssetUrl } from "@spiritdevs/client-runtime/state/assets";
import {
  deletePendingAttachmentUpload,
  runAttachmentUploadCycle,
  verifyPersistedAttachmentUpload,
  type PersistedAttachmentVerification,
} from "@spiritdevs/client-runtime/state/attachments";
import { create } from "zustand";

import {
  useComposerDraftStore,
  type ComposerAttachment,
  type ComposerFileAttachment,
  type ComposerThreadTarget,
} from "../composerDraftStore";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { assetEnvironment } from "../state/assets";
import { attachmentEnvironment } from "../state/attachments";
import { readPreparedConnection } from "../state/session";
import type { AttachmentUploadState } from "./attachmentUploadState";

const MAX_UPLOADS_PER_ENVIRONMENT = 3;
const UPLOAD_TIMEOUT_MS = 5 * 60_000;

interface AttachmentUploadStore {
  readonly uploadsByAttachmentId: Readonly<Record<string, AttachmentUploadState>>;
}

export const useAttachmentUploadStore = create<AttachmentUploadStore>(() => ({
  uploadsByAttachmentId: {},
}));

interface UploadJob {
  readonly file: ComposerFileAttachment;
  readonly environmentId: EnvironmentId;
  readonly draftTarget?: ComposerThreadTarget;
  readonly persistedAttachmentId?: string;
  readonly settled: Promise<void>;
  resolveSettled: () => void;
  mintedAttachmentId: string | null;
  cancelled: boolean;
  abort: (() => void) | null;
}

const jobsByAttachmentId = new Map<string, UploadJob>();
const queue: UploadJob[] = [];
const activeUploadsByEnvironment = new Map<EnvironmentId, number>();

function setUploadState(id: string, upload: AttachmentUploadState): void {
  useAttachmentUploadStore.setState((state) => ({
    uploadsByAttachmentId: { ...state.uploadsByAttachmentId, [id]: upload },
  }));
}

function clearUploadState(id: string): void {
  useAttachmentUploadStore.setState((state) => {
    if (!(id in state.uploadsByAttachmentId)) return state;
    const uploadsByAttachmentId = { ...state.uploadsByAttachmentId };
    delete uploadsByAttachmentId[id];
    return { uploadsByAttachmentId };
  });
}

export function readAttachmentUpload(id: string): AttachmentUploadState | undefined {
  return useAttachmentUploadStore.getState().uploadsByAttachmentId[id];
}

function removePending(environmentId: EnvironmentId, attachmentId: string): void {
  deletePendingAttachmentUpload({
    registry: appAtomRegistry,
    remove: attachmentEnvironment.remove,
    environmentId,
    attachmentId,
  });
}

function uploadBytes(input: {
  readonly url: string;
  readonly file: File;
  readonly onProgress: (progress: number) => void;
}) {
  const xhr = new XMLHttpRequest();
  const done = new Promise<void>((resolve, reject) => {
    xhr.open("POST", input.url, true);
    xhr.timeout = UPLOAD_TIMEOUT_MS;
    xhr.setRequestHeader("Content-Type", input.file.type || "application/octet-stream");
    xhr.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable && event.total > 0) input.onProgress(event.loaded / event.total);
    });
    xhr.addEventListener("load", () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`Upload rejected (${xhr.status})`));
    });
    xhr.addEventListener("error", () => reject(new Error("Upload failed")));
    xhr.addEventListener("timeout", () => reject(new Error("Upload timed out")));
    xhr.addEventListener("abort", () => reject(new Error("Upload cancelled")));
    xhr.send(input.file);
  });
  return { done, abort: () => xhr.abort() };
}

async function runUpload(job: UploadJob): Promise<void> {
  if (job.persistedAttachmentId !== undefined) {
    const verification = await verifyPersistedAttachmentUpload({
      registry: appAtomRegistry,
      createAssetUrl: assetEnvironment.createUrl,
      environmentId: job.environmentId,
      attachmentId: job.persistedAttachmentId,
    });
    if (job.cancelled) return;
    if (verification.status === "verified") {
      setUploadState(job.file.id, {
        status: "ready",
        environmentId: job.environmentId,
        attachmentId: job.persistedAttachmentId,
      });
      return;
    }
    if (job.file.file === null) {
      setUploadState(job.file.id, {
        status: "failed",
        environmentId: job.environmentId,
        reason:
          verification.status === "missing"
            ? "Uploaded file expired. Attach it again."
            : "Uploaded file could not be verified. Retry when reconnected.",
      });
      return;
    }
  }

  const file = job.file.file;
  if (file === null) {
    setUploadState(job.file.id, {
      status: "failed",
      environmentId: job.environmentId,
      reason: "Original file is no longer available",
    });
    return;
  }
  let lastStep = -1;
  const result = await runAttachmentUploadCycle({
    registry: appAtomRegistry,
    createUploadUrl: attachmentEnvironment.createUploadUrl,
    remove: attachmentEnvironment.remove,
    environmentId: job.environmentId,
    upload: {
      type: "file",
      name: job.file.name,
      mimeType: job.file.mimeType,
      sizeBytes: job.file.sizeBytes,
    },
    resolveUploadUrl: (relativeUrl) => {
      const connection = readPreparedConnection(job.environmentId);
      return connection ? resolveAssetUrl(connection.httpBaseUrl, relativeUrl) : null;
    },
    transport: (url) =>
      uploadBytes({
        url,
        file,
        onProgress: (progress) => {
          const step = Math.floor(progress * 20);
          if (step === lastStep || job.cancelled) return;
          lastStep = step;
          setUploadState(job.file.id, {
            status: "uploading",
            environmentId: job.environmentId,
            progress,
          });
        },
      }),
    onMinted: (attachmentId) => {
      if (job.cancelled) return "cancel";
      job.mintedAttachmentId = attachmentId;
      return "continue";
    },
    onTransferStart: (abort) => {
      job.abort = abort;
    },
  });
  job.abort = null;
  if (result.status === "cancelled" || job.cancelled) return;
  if (result.status === "uploaded") {
    setUploadState(job.file.id, {
      status: "ready",
      environmentId: job.environmentId,
      attachmentId: result.attachmentId,
    });
    if (job.draftTarget !== undefined) {
      useComposerDraftStore
        .getState()
        .setFileUpload(job.draftTarget, job.file.id, job.environmentId, result.attachmentId);
    }
    if (
      job.persistedAttachmentId !== undefined &&
      job.persistedAttachmentId !== result.attachmentId
    ) {
      removePending(job.environmentId, job.persistedAttachmentId);
    }
    if (
      job.file.uploadEnvironmentId !== undefined &&
      job.file.uploadedAttachmentId !== undefined &&
      job.file.uploadEnvironmentId !== job.environmentId
    ) {
      removePending(job.file.uploadEnvironmentId, job.file.uploadedAttachmentId);
    }
    return;
  }
  setUploadState(job.file.id, {
    status: "failed",
    environmentId: job.environmentId,
    reason:
      result.step === "mint"
        ? "Upload could not start"
        : result.step === "resolve-url"
          ? "Not connected"
          : result.error instanceof Error
            ? result.error.message
            : "Upload failed",
    ...(result.attachmentId ? { attachmentId: result.attachmentId } : {}),
  });
}

function pumpUploads(): void {
  for (let index = 0; index < queue.length; ) {
    const job = queue[index]!;
    const active = activeUploadsByEnvironment.get(job.environmentId) ?? 0;
    if (active >= MAX_UPLOADS_PER_ENVIRONMENT) {
      index += 1;
      continue;
    }
    queue.splice(index, 1);
    if (job.cancelled) continue;
    activeUploadsByEnvironment.set(job.environmentId, active + 1);
    void runUpload(job)
      .catch(() => {
        if (!job.cancelled) {
          setUploadState(job.file.id, {
            status: "failed",
            environmentId: job.environmentId,
            reason: "Upload failed",
          });
        }
      })
      .finally(() => {
        if (jobsByAttachmentId.get(job.file.id) === job) jobsByAttachmentId.delete(job.file.id);
        const remaining = (activeUploadsByEnvironment.get(job.environmentId) ?? 1) - 1;
        if (remaining > 0) activeUploadsByEnvironment.set(job.environmentId, remaining);
        else activeUploadsByEnvironment.delete(job.environmentId);
        job.resolveSettled();
        pumpUploads();
      });
  }
}

export function startAttachmentUpload(input: {
  readonly environmentId: EnvironmentId;
  readonly file: ComposerFileAttachment;
  readonly draftTarget?: ComposerThreadTarget;
}): void {
  const existing = readAttachmentUpload(input.file.id);
  if (existing?.status === "ready" && existing.environmentId === input.environmentId) {
    if (input.draftTarget !== undefined) {
      useComposerDraftStore
        .getState()
        .setFileUpload(
          input.draftTarget,
          input.file.id,
          input.environmentId,
          existing.attachmentId,
        );
    }
    return;
  }
  if (existing?.status === "failed" && existing.environmentId === input.environmentId) {
    return;
  }
  cancelAttachmentUpload(input.file.id);
  let resolveSettled = () => {};
  const settled = new Promise<void>((resolve) => {
    resolveSettled = resolve;
  });
  const job: UploadJob = {
    file: input.file,
    environmentId: input.environmentId,
    ...(input.draftTarget !== undefined ? { draftTarget: input.draftTarget } : {}),
    ...(input.file.uploadEnvironmentId === input.environmentId &&
    input.file.uploadedAttachmentId !== undefined
      ? { persistedAttachmentId: input.file.uploadedAttachmentId }
      : {}),
    settled,
    resolveSettled,
    mintedAttachmentId: null,
    cancelled: false,
    abort: null,
  };
  jobsByAttachmentId.set(input.file.id, job);
  queue.push(job);
  setUploadState(input.file.id, {
    status: "uploading",
    environmentId: input.environmentId,
    progress: 0,
  });
  pumpUploads();
}

export function cancelAttachmentUpload(id: string): void {
  const job = jobsByAttachmentId.get(id);
  if (!job) return;
  job.cancelled = true;
  jobsByAttachmentId.delete(id);
  const index = queue.indexOf(job);
  if (index !== -1) queue.splice(index, 1);
  job.abort?.();
  if (job.mintedAttachmentId) removePending(job.environmentId, job.mintedAttachmentId);
  job.resolveSettled();
}

export function releaseAttachmentUpload(id: string): void {
  const upload = readAttachmentUpload(id);
  cancelAttachmentUpload(id);
  if (upload?.status === "ready") removePending(upload.environmentId, upload.attachmentId);
  else if (upload?.status === "failed" && upload.attachmentId) {
    removePending(upload.environmentId, upload.attachmentId);
  }
  clearUploadState(id);
}

export function releaseDraftAttachment(file: ComposerFileAttachment): void {
  if (file.uploadEnvironmentId !== undefined && file.uploadedAttachmentId !== undefined) {
    removePending(file.uploadEnvironmentId, file.uploadedAttachmentId);
  }
  releaseAttachmentUpload(file.id);
}

export function releaseDraftAttachments(attachments: ReadonlyArray<ComposerAttachment>): void {
  for (const attachment of attachments) {
    if (attachment.type === "file") releaseDraftAttachment(attachment);
  }
}

export function releasePersistedAttachmentUpload(input: {
  readonly environmentId: EnvironmentId;
  readonly attachmentId: string;
}): void {
  removePending(input.environmentId, input.attachmentId);
}

export function retryAttachmentUpload(input: {
  readonly environmentId: EnvironmentId;
  readonly file: ComposerFileAttachment;
  readonly draftTarget?: ComposerThreadTarget;
}): void {
  const previous = readAttachmentUpload(input.file.id);
  cancelAttachmentUpload(input.file.id);
  if (previous?.status === "failed" && previous.attachmentId) {
    removePending(previous.environmentId, previous.attachmentId);
  }
  clearUploadState(input.file.id);
  startAttachmentUpload(input);
}

export async function awaitAttachmentUploads(ids: ReadonlyArray<string>): Promise<void> {
  await Promise.all(ids.map((id) => jobsByAttachmentId.get(id)?.settled));
}

export function getUploadedFileAttachments(input: {
  readonly environmentId: EnvironmentId;
  readonly files: ReadonlyArray<ComposerFileAttachment>;
}): ChatFileAttachment[] | null {
  const attachments: ChatFileAttachment[] = [];
  for (const file of input.files) {
    const upload = readAttachmentUpload(file.id);
    if (upload?.status !== "ready" || upload.environmentId !== input.environmentId) return null;
    attachments.push({
      type: "file",
      id: upload.attachmentId,
      name: file.name,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes,
    });
  }
  return attachments;
}

export function verifyStashedAttachmentUpload(input: {
  readonly environmentId: EnvironmentId;
  readonly attachmentId: string;
}): Promise<PersistedAttachmentVerification> {
  return verifyPersistedAttachmentUpload({
    registry: appAtomRegistry,
    createAssetUrl: assetEnvironment.createUrl,
    environmentId: input.environmentId,
    attachmentId: input.attachmentId,
  });
}
