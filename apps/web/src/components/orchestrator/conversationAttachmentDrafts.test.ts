import { describe, expect, it } from "vite-plus/test";
import { conversationFileMetadata } from "./conversationAttachmentDrafts";

describe("orchestrator compose attachment constraints", () => {
  it("uses normal-thread image/file metadata and handles missing MIME types", () => {
    expect(conversationFileMetadata(new File(["notes"], "notes.txt"), "draft-id")).toEqual({
      id: "draft-id",
      type: "file",
      name: "notes.txt",
      mimeType: "application/octet-stream",
      sizeBytes: 5,
    });
    expect(
      conversationFileMetadata(new File(["image"], "photo.png", { type: "image/png" })).type,
    ).toBe("image");
  });
  it("rejects oversized images and files before upload", () => {
    const image = new File([], "large.png", { type: "image/png" });
    Object.defineProperty(image, "size", { value: 10 * 1024 * 1024 + 1 });
    expect(() => conversationFileMetadata(image)).toThrow("10 MB");
    const file = new File([], "large.zip", { type: "application/zip" });
    Object.defineProperty(file, "size", { value: 50 * 1024 * 1024 + 1 });
    expect(() => conversationFileMetadata(file)).toThrow("50 MB");
  });
});
