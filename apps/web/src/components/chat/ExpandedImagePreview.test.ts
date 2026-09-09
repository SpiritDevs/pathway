import { describe, expect, it } from "vite-plus/test";
import { buildExpandedImagePreview } from "./ExpandedImagePreview";

describe("snapshot image preview", () => {
  it("retains metadata when opening a capture from composer or history", () => {
    const source = {
      kind: "snap-shot" as const,
      capturedAt: "2026-09-01T00:00:00.000Z",
      appName: "Editor",
      windowTitle: "main.ts",
      accessibleText: "Save",
    };
    const preview = buildExpandedImagePreview(
      [
        { id: "ordinary", name: "image.png", previewUrl: "blob:ordinary" },
        { id: "capture", name: "window.png", previewUrl: "blob:capture", source },
      ],
      "capture",
    );
    expect(preview?.index).toBe(1);
    expect(preview?.images[1]?.source).toBe(source);
    expect(preview?.images[0]).not.toHaveProperty("source");
  });
});
