import { EnvironmentId } from "@spiritdevs/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { verify, remove, savedEntries, drafts } = vi.hoisted(() => ({
  verify: vi.fn(),
  remove: vi.fn(),
  savedEntries: {
    entries: [] as Array<{
      attachments: Array<{ type: "file"; environmentId: string; attachmentId: string }>;
    }>,
  },
  drafts: {
    draftsByThreadKey: {} as Record<
      string,
      {
        images: Array<{
          type: "file";
          id: string;
          uploadEnvironmentId: string;
          uploadedAttachmentId: string;
        }>;
      }
    >,
  },
}));
vi.mock("@spiritdevs/client-runtime/state/attachments", () => ({
  verifyPersistedAttachmentUpload: verify,
  deletePendingAttachmentUpload: remove,
  runAttachmentUploadCycle: vi.fn(),
}));
vi.mock("../composerDraftStore", () => ({ useComposerDraftStore: { getState: () => drafts } }));
vi.mock("../promptStashStore", () => ({ usePromptStashStore: { getState: () => savedEntries } }));
vi.mock("../rpc/atomRegistry", () => ({ appAtomRegistry: {} }));
vi.mock("../state/assets", () => ({ assetEnvironment: { createUrl: vi.fn() } }));
vi.mock("../state/attachments", () => ({ attachmentEnvironment: {} }));
vi.mock("../state/session", () => ({ readPreparedConnection: vi.fn() }));

import {
  readAttachmentUpload,
  useAttachmentUploadStore,
  verifyReadyAttachmentUpload,
  releaseDraftAttachment,
  releasePersistedAttachmentUpload,
} from "./attachmentUploadQueue";

const environmentId = EnvironmentId.make("environment-1");
const ready = { status: "ready" as const, environmentId, attachmentId: "pending-old" };
const input = { id: "file-1", environmentId };

beforeEach(() => {
  verify.mockReset();
  remove.mockReset();
  savedEntries.entries = [];
  drafts.draftsByThreadKey = {};
  useAttachmentUploadStore.setState({ uploadsByAttachmentId: { "file-1": ready } });
});

describe("saved attachment ownership", () => {
  it("keeps an upload referenced by a saved prompt when its restored draft removes it", () => {
    savedEntries.entries = [
      { attachments: [{ type: "file", environmentId, attachmentId: "pending-old" }] },
    ];
    releaseDraftAttachment({
      type: "file",
      id: "file-1",
      name: "report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 10,
      previewUrl: "",
      file: null,
      uploadEnvironmentId: environmentId,
      uploadedAttachmentId: "pending-old",
    });
    expect(remove).not.toHaveBeenCalled();
    expect(readAttachmentUpload("file-1")).toBeUndefined();
  });

  it("keeps an upload in a restored draft when its saved prompt is deleted", () => {
    drafts.draftsByThreadKey = {
      thread: {
        images: [
          {
            type: "file",
            id: "restored-file",
            uploadEnvironmentId: environmentId,
            uploadedAttachmentId: "pending-old",
          },
        ],
      },
    };
    releasePersistedAttachmentUpload({ environmentId, attachmentId: "pending-old" });
    expect(remove).not.toHaveBeenCalled();
  });

  it("releases an upload after its last saved or draft reference is removed", () => {
    releasePersistedAttachmentUpload({ environmentId, attachmentId: "pending-old" });
    expect(remove).toHaveBeenCalledWith(
      expect.objectContaining({ environmentId, attachmentId: "pending-old" }),
    );
  });

  it("keeps another restored draft's upload when one draft removes its copy", () => {
    const file = {
      type: "file" as const,
      id: "file-1",
      name: "report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 10,
      previewUrl: "",
      file: null,
      uploadEnvironmentId: environmentId,
      uploadedAttachmentId: "pending-old",
    };
    drafts.draftsByThreadKey = {
      first: { images: [file] },
      second: { images: [{ ...file, id: "file-2" }] },
    };
    releaseDraftAttachment(file);
    expect(remove).not.toHaveBeenCalled();
  });

  it("releases the final draft's copy without counting itself as another owner", () => {
    const file = {
      type: "file" as const,
      id: "file-1",
      name: "report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 10,
      previewUrl: "",
      file: null,
      uploadEnvironmentId: environmentId,
      uploadedAttachmentId: "pending-old",
    };
    drafts.draftsByThreadKey = { first: { images: [file] } };
    releaseDraftAttachment(file);
    expect(remove).toHaveBeenCalled();
  });

  it("does not retain unrelated uploads from another environment", () => {
    savedEntries.entries = [
      {
        attachments: [
          { type: "file", environmentId: "environment-2", attachmentId: "pending-old" },
        ],
      },
    ];
    releasePersistedAttachmentUpload({ environmentId, attachmentId: "pending-old" });
    expect(remove).toHaveBeenCalledOnce();
  });
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
