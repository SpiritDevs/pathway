import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { prepareDirectTurnAttachments, shouldSendTurnToEnvironment } from "./threadTurnDelivery";

const connectedThread = {
  connected: true,
  hasThreadProjection: true,
  bootstrap: undefined,
  pendingCloudMessages: false,
};

describe("thread turn delivery", () => {
  it("sends connected thread follow-ups to the normal environment queue", () => {
    expect(shouldSendTurnToEnvironment(connectedThread)).toBe(true);
  });
  it("retains durable delivery when the environment is disconnected", () => {
    expect(shouldSendTurnToEnvironment({ ...connectedThread, connected: false })).toBe(false);
  });
  it("keeps a new or not-yet-hydrated thread durable", () => {
    expect(shouldSendTurnToEnvironment({ ...connectedThread, hasThreadProjection: false })).toBe(
      false,
    );
  });
  it("keeps initial workspace preparation durable", () => {
    expect(
      shouldSendTurnToEnvironment({ ...connectedThread, bootstrap: { runSetupScript: true } }),
    ).toBe(false);
  });
  it("does not let a connected follow-up overtake saved offline messages", () => {
    expect(shouldSendTurnToEnvironment({ ...connectedThread, pendingCloudMessages: true })).toBe(
      false,
    );
  });
});

describe("direct follow-up attachments", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("preserves file bytes when switching from cloud storage to environment delivery", async () => {
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
    const [attachment] = await prepareDirectTurnAttachments([
      {
        metadata: {
          type: "file",
          id: "file",
          name: "notes.txt",
          mimeType: "text/plain",
          sizeBytes: 5,
        },
        blob: new Blob(["notes"], { type: "text/plain" }),
      },
    ]);
    expect(attachment).toMatchObject({
      type: "file",
      name: "notes.txt",
      dataUrl: "data:text/plain;base64,bm90ZXM=",
    });
  });

  it("rejects unreadable attachments instead of dispatching an empty message", async () => {
    class Reader extends EventTarget {
      error = new Error("Attachment unavailable");
      readAsDataURL() {
        this.dispatchEvent(new Event("error"));
      }
    }
    vi.stubGlobal("FileReader", Reader);
    await expect(
      prepareDirectTurnAttachments([
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
      ]),
    ).rejects.toThrow("Attachment unavailable");
  });
});
