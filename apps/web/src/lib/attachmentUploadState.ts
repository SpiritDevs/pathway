import type { EnvironmentId } from "@spiritdevs/contracts";

export type ReadyAttachmentUpload = {
  readonly status: "ready";
  readonly environmentId: EnvironmentId;
  readonly attachmentId: string;
};

export type AttachmentUploadState =
  | {
      readonly status: "uploading";
      readonly environmentId: EnvironmentId;
      readonly progress: number;
    }
  | ReadyAttachmentUpload
  | {
      readonly status: "failed";
      readonly environmentId: EnvironmentId;
      readonly reason: string;
      readonly attachmentId?: string;
    };

export function attachmentUploadBlockReason(input: {
  readonly fileIds: ReadonlyArray<string>;
  readonly uploadsByAttachmentId: Readonly<Record<string, AttachmentUploadState>>;
  readonly environmentId: EnvironmentId;
}): string | null {
  let pending = 0;
  let failed = 0;
  for (const fileId of input.fileIds) {
    const upload = input.uploadsByAttachmentId[fileId];
    if (upload?.status === "failed" && upload.environmentId === input.environmentId) failed += 1;
    else if (upload?.status !== "ready" || upload.environmentId !== input.environmentId)
      pending += 1;
  }
  if (failed > 0) {
    return failed === 1
      ? "Retry or remove the failed attachment"
      : "Retry or remove the failed attachments";
  }
  if (pending > 0) {
    return pending === 1 ? "Attachment still uploading" : "Attachments still uploading";
  }
  return null;
}

export function formatAttachmentUploadProgress(progress: number): string {
  const bounded = Math.max(0, Math.min(1, Number.isFinite(progress) ? progress : 0));
  return `${Math.floor(bounded * 100)}%`;
}
