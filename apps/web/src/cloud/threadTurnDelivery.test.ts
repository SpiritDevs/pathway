import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { prepareDirectTurnAttachments, shouldSendTurnToEnvironment } from "./threadTurnDelivery";

const connectedThread = {
  connected: true,
  pendingCloudMessages: false,
};

describe("thread turn delivery", () => {
  it.each([undefined, "auto", "queue"] as const)(
    "keeps cross-provider follow-ups durable with dispatch mode %s",
    (dispatchMode) => {
      expect(
        shouldSendTurnToEnvironment({
          ...connectedThread,
          activeProviderInstanceId: "codex",
          requestedProviderInstanceId: "claude",
          dispatchMode,
        }),
      ).toBe(false);
    },
  );
  it.each([undefined, "auto", "queue"] as const)(
    "keeps the normal same-provider queue with dispatch mode %s",
    (dispatchMode) => {
      expect(
        shouldSendTurnToEnvironment({
          ...connectedThread,
          activeProviderInstanceId: "codex",
          requestedProviderInstanceId: "codex",
          dispatchMode,
        }),
      ).toBe(true);
    },
  );
  it.each(["steer", "restart"] as const)(
    "preserves explicit %s intent instead of silently deferring it",
    (dispatchMode) => {
      expect(
        shouldSendTurnToEnvironment({
          ...connectedThread,
          activeProviderInstanceId: "codex",
          requestedProviderInstanceId: "claude",
          dispatchMode,
        }),
      ).toBe(true);
    },
  );
  it("allows provider changes once no run is active", () => {
    expect(
      shouldSendTurnToEnvironment({
        ...connectedThread,
        requestedProviderInstanceId: "claude",
        dispatchMode: "queue",
      }),
    ).toBe(true);
  });
  it("sends connected thread follow-ups to the normal environment queue", () => {
    expect(shouldSendTurnToEnvironment(connectedThread)).toBe(true);
  });
  it("retains durable delivery when the environment is disconnected", () => {
    expect(shouldSendTurnToEnvironment({ ...connectedThread, connected: false })).toBe(false);
  });
  it("does not let a connected follow-up overtake saved offline messages", () => {
    expect(shouldSendTurnToEnvironment({ ...connectedThread, pendingCloudMessages: true })).toBe(
      false,
    );
  });
});

describe("direct follow-up attachments", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("preserves image bytes on the inline image transport", async () => {
    class Reader extends EventTarget {
      result: string | null = null;
      readAsDataURL(blob: Blob) {
        void blob.arrayBuffer().then((bytes) => {
          this.result = `data:${blob.type};base64,${Buffer.from(bytes).toString("base64")}`;
          this.dispatchEvent(new Event("load"));
        });
      }
    }
    vi.stubGlobal("FileReader", Reader);
    const uploadFile = vi.fn();
    const [attachment] = await prepareDirectTurnAttachments(
      [
        {
          metadata: {
            type: "image",
            id: "file",
            name: "notes.txt",
            mimeType: "text/plain",
            sizeBytes: 5,
          },
          blob: new Blob(["notes"], { type: "text/plain" }),
        },
      ],
      uploadFile,
    );
    expect(uploadFile).not.toHaveBeenCalled();
    expect(attachment).toMatchObject({
      type: "image",
      name: "notes.txt",
      dataUrl: "data:text/plain;base64,bm90ZXM=",
    });
  });

  it("keeps a 20 MB file on binary upload and dispatches only its pending ID", async () => {
    vi.stubGlobal(
      "FileReader",
      vi.fn(() => {
        throw new Error("File must not become base64");
      }),
    );
    const metadata = {
      type: "file" as const,
      id: "composer-file",
      name: "large.bin",
      mimeType: "application/octet-stream",
      sizeBytes: 20 * 1024 * 1024,
    };
    const blob = new Blob([new Uint8Array(metadata.sizeBytes)]);
    const pending = { ...metadata, id: "pending-00000000-0000-4000-8000-000000000001-bin" };
    const uploadFile = vi.fn(async () => pending);
    const attachments = await prepareDirectTurnAttachments([{ metadata, blob }], uploadFile);
    expect(uploadFile).toHaveBeenCalledExactlyOnceWith({ metadata, blob });
    expect(attachments).toEqual([pending]);
    expect(attachments[0]).not.toHaveProperty("dataUrl");
  });

  it("propagates a failed binary upload instead of sending without the file", async () => {
    await expect(
      prepareDirectTurnAttachments(
        [
          {
            metadata: {
              type: "file",
              id: "file",
              name: "notes.txt",
              mimeType: "text/plain",
              sizeBytes: 5,
            },
            blob: new Blob(["notes"]),
          },
        ],
        async () => {
          throw new Error("Attachment unavailable");
        },
      ),
    ).rejects.toThrow("Attachment unavailable");
  });
});
