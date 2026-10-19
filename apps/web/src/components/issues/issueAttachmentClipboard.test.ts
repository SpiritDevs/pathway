import { describe, expect, it } from "vite-plus/test";

import { issueClipboardImageFiles } from "./issueAttachmentClipboard";

describe("issueClipboardImageFiles", () => {
  it("takes one image representation from each clipboard item", async () => {
    const files = await issueClipboardImageFiles([
      {
        types: ["text/html", "image/png"],
        getType: async (type) => new Blob(["png"], { type }),
      },
      {
        types: ["image/jpeg"],
        getType: async (type) => new Blob(["jpeg"], { type }),
      },
    ]);

    expect(files.map((file) => ({ name: file.name, type: file.type }))).toEqual([
      { name: "Clipboard image.png", type: "image/png" },
      { name: "Clipboard image 2.jpg", type: "image/jpeg" },
    ]);
  });

  it("ignores clipboard items with no image representation", async () => {
    const files = await issueClipboardImageFiles([
      {
        types: ["text/plain"],
        getType: async (type) => new Blob(["text"], { type }),
      },
    ]);

    expect(files).toEqual([]);
  });
});
