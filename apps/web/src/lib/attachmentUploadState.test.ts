import { EnvironmentId } from "@spiritdevs/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  attachmentUploadBlockReason,
  formatAttachmentUploadProgress,
} from "./attachmentUploadState";

const environmentId = EnvironmentId.make("environment-1");

describe("attachmentUploadBlockReason", () => {
  it("allows ready files from the active environment", () => {
    expect(
      attachmentUploadBlockReason({
        fileIds: ["file-1"],
        environmentId,
        uploadsByAttachmentId: {
          "file-1": { status: "ready", environmentId, attachmentId: "pending-1" },
        },
      }),
    ).toBeNull();
  });

  it("blocks pending, failed, and cross-environment uploads", () => {
    expect(
      attachmentUploadBlockReason({
        fileIds: ["file-1", "file-2"],
        environmentId,
        uploadsByAttachmentId: {
          "file-1": { status: "uploading", environmentId, progress: 0.5 },
        },
      }),
    ).toBe("Attachments still uploading");
    expect(
      attachmentUploadBlockReason({
        fileIds: ["file-1"],
        environmentId,
        uploadsByAttachmentId: {
          "file-1": { status: "failed", environmentId, reason: "Upload failed" },
        },
      }),
    ).toBe("Retry or remove the failed attachment");
    expect(
      attachmentUploadBlockReason({
        fileIds: ["file-1"],
        environmentId,
        uploadsByAttachmentId: {
          "file-1": {
            status: "ready",
            environmentId: EnvironmentId.make("environment-2"),
            attachmentId: "pending-1",
          },
        },
      }),
    ).toBe("Attachment still uploading");
  });
});

describe("formatAttachmentUploadProgress", () => {
  it("formats bounded percentages", () => {
    expect(formatAttachmentUploadProgress(0.429)).toBe("42%");
    expect(formatAttachmentUploadProgress(2)).toBe("100%");
    expect(formatAttachmentUploadProgress(Number.NaN)).toBe("0%");
  });
});
