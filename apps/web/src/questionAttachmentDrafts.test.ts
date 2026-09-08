import { beforeEach, expect, it, vi } from "vite-plus/test";
import { ChatAttachmentId, EnvironmentId } from "@spiritdevs/contracts";

vi.mock("./lib/attachmentUploadQueue", () => ({ uploadStandaloneFileAttachment: vi.fn() }));
vi.mock("./lib/imageCompression", () => ({
  compressImageToByteLimit: vi.fn(async (file: File) => ({ ok: true, file })),
}));
vi.mock("./rpc/atomRegistry", () => ({ appAtomRegistry: {} }));
vi.mock("./state/assets", () => ({ assetEnvironment: { createUrl: vi.fn() } }));
vi.mock("./state/attachments", () => ({ attachmentEnvironment: { remove: {} } }));
vi.mock("@spiritdevs/client-runtime/state/attachments", () => ({
  deletePendingAttachmentUpload: vi.fn(),
  verifyPersistedAttachmentUpload: vi.fn(),
}));
import { verifyPersistedAttachmentUpload } from "@spiritdevs/client-runtime/state/attachments";
import { uploadStandaloneFileAttachment } from "./lib/attachmentUploadQueue";
import {
  addQuestionAttachments,
  readyQuestionAttachments,
  revalidateQuestionAttachments,
  removeQuestionAttachment,
  retryQuestionAttachment,
  useQuestionAttachmentDrafts,
} from "./questionAttachmentDrafts";

const environmentId = EnvironmentId.make("environment");
const attachment = {
  type: "image" as const,
  id: ChatAttachmentId.make("pending-00000000-0000-4000-8000-000000000001-png"),
  name: "image.png",
  mimeType: "image/png",
  sizeBytes: 3,
};
const storage = useQuestionAttachmentDrafts.persist.getOptions().storage;
beforeEach(() => {
  useQuestionAttachmentDrafts.persist.setOptions({ storage });
  useQuestionAttachmentDrafts.setState({ byRequest: {} });
  vi.clearAllMocks();
});

it("blocks submission until every question upload finishes and groups receipts by question", async () => {
  let finish!: (value: typeof attachment) => void;
  vi.mocked(uploadStandaloneFileAttachment).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = addQuestionAttachments({
    environmentId,
    key: "request",
    questionId: "first",
    files: [new File(["png"], "image.png", { type: "image/png" })],
    maxFileBytes: null,
  });
  expect(
    readyQuestionAttachments(useQuestionAttachmentDrafts.getState().byRequest.request!),
  ).toBeNull();
  await vi.waitFor(() => expect(finish).toBeDefined());
  finish(attachment);
  await pending;
  expect(
    readyQuestionAttachments(useQuestionAttachmentDrafts.getState().byRequest.request!),
  ).toEqual({ first: [attachment] });
});

it("retains failed uploads for retry without moving them into another question", async () => {
  vi.mocked(uploadStandaloneFileAttachment)
    .mockRejectedValueOnce(new Error("Offline"))
    .mockResolvedValueOnce(attachment);
  await addQuestionAttachments({
    environmentId,
    key: "request",
    questionId: "second",
    files: [new File(["png"], "image.png", { type: "image/png" })],
    maxFileBytes: null,
  });
  const draft = useQuestionAttachmentDrafts.getState().byRequest.request![0]!;
  expect(draft.status).toBe("failed");
  expect(readyQuestionAttachments([draft])).toBeNull();
  await retryQuestionAttachment(environmentId, "request", draft.id);
  expect(
    readyQuestionAttachments(useQuestionAttachmentDrafts.getState().byRequest.request!),
  ).toEqual({ second: [attachment] });
  removeQuestionAttachment(environmentId, "request", draft.id);
  expect(
    readyQuestionAttachments(useQuestionAttachmentDrafts.getState().byRequest.request!),
  ).toEqual({});
});

it("does not resurrect an attachment removed during its upload", async () => {
  let finish!: (value: typeof attachment) => void;
  vi.mocked(uploadStandaloneFileAttachment).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = addQuestionAttachments({
    environmentId,
    key: "request",
    questionId: "first",
    files: [new File(["png"], "image.png", { type: "image/png" })],
    maxFileBytes: null,
  });
  await vi.waitFor(() => expect(finish).toBeDefined());
  removeQuestionAttachment(
    environmentId,
    "request",
    useQuestionAttachmentDrafts.getState().byRequest.request![0]!.id,
  );
  finish(attachment);
  await pending;
  expect(useQuestionAttachmentDrafts.getState().byRequest.request).toEqual([]);
});

for (const status of ["verified", "missing"] as const) {
  it(`checks hydrated receipts before allowing submission: ${status}`, async () => {
    useQuestionAttachmentDrafts.persist.setOptions({
      storage: {
        getItem: () => ({
          state: {
            byRequest: {
              request: [
                {
                  id: "restored",
                  questionId: "first",
                  name: "image.png",
                  status: "ready",
                  attachment,
                },
              ],
            },
          },
          version: 0,
        }),
        setItem: () => {},
        removeItem: () => {},
      },
    });
    await useQuestionAttachmentDrafts.persist.rehydrate();
    expect(
      readyQuestionAttachments(useQuestionAttachmentDrafts.getState().byRequest.request!),
    ).toBeNull();
    vi.mocked(verifyPersistedAttachmentUpload).mockResolvedValueOnce({ status });
    await revalidateQuestionAttachments(environmentId, "request");
    expect(verifyPersistedAttachmentUpload).toHaveBeenCalledWith(
      expect.objectContaining({ environmentId, attachmentId: attachment.id }),
    );
    const draft = useQuestionAttachmentDrafts.getState().byRequest.request![0]!;
    expect(draft.status).toBe(status === "verified" ? "ready" : "failed");
    if (status === "missing") {
      expect(draft.error).toContain("expired");
      expect(readyQuestionAttachments([draft])).toBeNull();
    }
  });
}

it("retries receipt verification after reconnecting without needing browser file bytes", async () => {
  useQuestionAttachmentDrafts.setState({
    byRequest: {
      request: [
        {
          id: "restored",
          questionId: "first",
          name: "image.png",
          status: "unverified",
          attachment,
        },
      ],
    },
  });
  vi.mocked(verifyPersistedAttachmentUpload)
    .mockResolvedValueOnce({ status: "failed", error: new Error("Offline") })
    .mockResolvedValueOnce({ status: "verified" });
  await revalidateQuestionAttachments(environmentId, "request");
  expect(useQuestionAttachmentDrafts.getState().byRequest.request![0]!.status).toBe("failed");
  await retryQuestionAttachment(environmentId, "request", "restored");
  expect(
    readyQuestionAttachments(useQuestionAttachmentDrafts.getState().byRequest.request!),
  ).toEqual({ first: [attachment] });
});
