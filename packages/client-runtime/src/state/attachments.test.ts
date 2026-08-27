import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  type AttachmentCreateUploadUrlInput,
  type AttachmentCreateUploadUrlResult,
  type AttachmentDeleteInput,
} from "@spiritdevs/contracts";
import { AsyncResult, type AtomRegistry } from "effect/unstable/reactivity";

import type { AtomCommand } from "./runtime.ts";
import {
  clampFileAttachmentUploadBytes,
  fileAttachmentTooLargeMessage,
  runAttachmentUploadCycle,
} from "./attachments.ts";

const environmentId = EnvironmentId.make("environment-1");
const registry = {} as AtomRegistry.AtomRegistry;

type CreateCommand = AtomCommand<
  { readonly environmentId: EnvironmentId; readonly input: AttachmentCreateUploadUrlInput },
  AttachmentCreateUploadUrlResult,
  never
>;
type RemoveCommand = AtomCommand<
  { readonly environmentId: EnvironmentId; readonly input: AttachmentDeleteInput },
  unknown,
  never
>;

function createCommand(attachmentId: string): CreateCommand {
  return {
    label: "test:create-upload-url",
    run: async () =>
      AsyncResult.success({
        attachmentId,
        relativeUrl: `/api/attachments/upload/${attachmentId}`,
        expiresAt: 1,
      }),
  };
}

describe("runAttachmentUploadCycle", () => {
  it("mints, transfers, and reports the pending attachment id", async () => {
    const transferred: string[] = [];
    const remove: RemoveCommand = {
      label: "test:remove",
      run: async () => AsyncResult.success(undefined),
    };
    const result = await runAttachmentUploadCycle({
      registry,
      createUploadUrl: createCommand("pending-1"),
      remove,
      environmentId,
      upload: {
        type: "file",
        name: "report.pdf",
        mimeType: "application/pdf",
        sizeBytes: 3,
      },
      resolveUploadUrl: (relativeUrl) => `https://environment.test${relativeUrl}`,
      transport: (url) => {
        transferred.push(url);
        return { done: Promise.resolve(), abort: () => {} };
      },
    });
    expect(result).toEqual({ status: "uploaded", attachmentId: "pending-1" });
    expect(transferred).toEqual(["https://environment.test/api/attachments/upload/pending-1"]);
  });

  it("deletes a newly minted upload when cancellation wins", async () => {
    const removed: string[] = [];
    const remove: RemoveCommand = {
      label: "test:remove",
      run: async (_registry, input) => {
        removed.push(input.input.attachmentId);
        return AsyncResult.success(undefined);
      },
    };
    const result = await runAttachmentUploadCycle({
      registry,
      createUploadUrl: createCommand("pending-cancelled"),
      remove,
      environmentId,
      upload: {
        type: "file",
        name: "report.pdf",
        mimeType: "application/pdf",
        sizeBytes: 3,
      },
      resolveUploadUrl: () => "https://environment.test/upload",
      transport: () => {
        throw new Error("transport must not start");
      },
      onMinted: () => "cancel",
    });
    expect(result).toEqual({ status: "cancelled", attachmentId: "pending-cancelled" });
    expect(removed).toEqual(["pending-cancelled"]);
  });
});

describe("file attachment limits", () => {
  it("clamps advertised limits and formats validation copy", () => {
    expect(clampFileAttachmentUploadBytes(PROVIDER_SEND_TURN_MAX_FILE_BYTES * 2)).toBe(
      PROVIDER_SEND_TURN_MAX_FILE_BYTES,
    );
    expect(fileAttachmentTooLargeMessage("big.zip", 50 * 1024 * 1024)).toBe(
      "'big.zip' exceeds the 50 MB attachment limit.",
    );
  });
});
