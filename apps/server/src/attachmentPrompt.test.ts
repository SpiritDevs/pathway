// @effect-diagnostics nodeBuiltinImport:off -- the fixture verifies real attachment paths.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { appendFileAttachmentPromptText } from "./attachmentPrompt.ts";

describe("appendFileAttachmentPromptText", () => {
  it("adds file paths without duplicating native image attachments", () => {
    const attachmentsDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pathway-prompt-"));
    try {
      const text = appendFileAttachmentPromptText({
        text: "Review these",
        attachmentsDir,
        attachments: [
          {
            type: "file",
            id: "thread-1-00000000-0000-4000-8000-000000000001",
            name: "unsafe[report].json",
            mimeType: "application/json",
            sizeBytes: 2,
          },
          {
            type: "image",
            id: "thread-1-00000000-0000-4000-8000-000000000002",
            name: "screen.png",
            mimeType: "image/png",
            sizeBytes: 4,
          },
        ],
      });

      expect(text).toContain("Review these");
      expect(text).toContain("unsafe report .json");
      expect(text).toContain(".json");
      expect(text).toContain("Read it from disk when needed.");
      expect(text).not.toContain("screen.png");
    } finally {
      NodeFS.rmSync(attachmentsDir, { recursive: true, force: true });
    }
  });
});
