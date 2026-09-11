import { EnvironmentId } from "@spiritdevs/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { verify } = vi.hoisted(() => ({ verify: vi.fn() }));
vi.mock("@spiritdevs/client-runtime/state/attachments", () => ({
  verifyPersistedAttachmentUpload: verify,
  deletePendingAttachmentUpload: vi.fn(),
  runAttachmentUploadCycle: vi.fn(),
}));
vi.mock("../composerDraftStore", () => ({ useComposerDraftStore: {} }));
vi.mock("../rpc/atomRegistry", () => ({ appAtomRegistry: {} }));
vi.mock("../state/assets", () => ({ assetEnvironment: { createUrl: vi.fn() } }));
vi.mock("../state/attachments", () => ({ attachmentEnvironment: {} }));
vi.mock("../state/session", () => ({ readPreparedConnection: vi.fn() }));

import {
  readAttachmentUpload,
  useAttachmentUploadStore,
  verifyReadyAttachmentUpload,
} from "./attachmentUploadQueue";

const environmentId = EnvironmentId.make("environment-1");
const ready = { status: "ready" as const, environmentId, attachmentId: "pending-old" };
const input = { id: "file-1", environmentId };

beforeEach(() => {
  verify.mockReset();
  useAttachmentUploadStore.setState({ uploadsByAttachmentId: { "file-1": ready } });
});

describe("verifyReadyAttachmentUpload", () => {
  it("rechecks a cached upload on every send attempt", async () => {
    verify.mockResolvedValue({ status: "verified" });
    expect(await verifyReadyAttachmentUpload(input)).toEqual(ready);
    expect(await verifyReadyAttachmentUpload(input)).toEqual(ready);
    expect(verify).toHaveBeenCalledTimes(2);
    expect(verify).toHaveBeenCalledWith(
      expect.objectContaining({
        environmentId,
        attachmentId: "pending-old",
      }),
    );
  });

  it("invalidates a swept upload so the caller reuploads its retained bytes", async () => {
    verify.mockResolvedValue({ status: "missing" });
    expect(await verifyReadyAttachmentUpload(input)).toBeNull();
    expect(readAttachmentUpload(input.id)).toBeUndefined();
  });

  it("preserves the cached ID when an offline environment cannot verify it", async () => {
    verify.mockResolvedValue({ status: "failed", error: new Error("Disconnected") });
    await expect(verifyReadyAttachmentUpload(input)).rejects.toThrow("Retry when reconnected");
    expect(readAttachmentUpload(input.id)).toEqual(ready);
  });

  it("never uses an upload belonging to another environment", async () => {
    expect(
      await verifyReadyAttachmentUpload({
        ...input,
        environmentId: EnvironmentId.make("environment-2"),
      }),
    ).toBeNull();
    expect(verify).not.toHaveBeenCalled();
    expect(readAttachmentUpload(input.id)).toEqual(ready);
  });

  it("does not invalidate a replacement upload that completed during verification", async () => {
    const replacement = { ...ready, attachmentId: "pending-new" };
    verify.mockImplementation(async () => {
      useAttachmentUploadStore.setState({ uploadsByAttachmentId: { "file-1": replacement } });
      return { status: "missing" };
    });
    expect(await verifyReadyAttachmentUpload(input)).toBeNull();
    expect(readAttachmentUpload(input.id)).toEqual(replacement);
  });
});
