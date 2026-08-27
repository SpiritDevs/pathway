import { describe, expect, it } from "vite-plus/test";

import {
  createPastedTextAttachmentFile,
  shouldConvertPastedTextToAttachment,
  shouldHandleComposerAttachmentPaste,
} from "./composerAttachmentFiles";

describe("composer attachment files", () => {
  it("converts text only when the resulting prompt would exceed the send limit", () => {
    const maxInputChars = 120_000;

    expect(
      shouldConvertPastedTextToAttachment({
        currentPromptLength: 100_000,
        selectedTextLength: 0,
        pastedTextLength: 20_001,
        maxInputChars,
      }),
    ).toBe(true);
    expect(
      shouldConvertPastedTextToAttachment({
        currentPromptLength: 100_000,
        selectedTextLength: 10_000,
        pastedTextLength: 20_001,
        maxInputChars,
      }),
    ).toBe(false);
    expect(
      shouldConvertPastedTextToAttachment({
        currentPromptLength: 100_000,
        selectedTextLength: 0,
        pastedTextLength: 20_000,
        maxInputChars,
      }),
    ).toBe(false);
  });

  it("creates a uniquely named plain-text file without changing its contents", async () => {
    const file = createPastedTextAttachmentFile("large pasted body", "12345678-abcd");

    expect(file.name).toBe("pasted-text-12345678.txt");
    expect(file.type).toBe("text/plain");
    expect(await file.text()).toBe("large pasted body");
  });

  it("handles file-only pastes for common non-image formats", () => {
    for (const file of [
      new File(["{}"], "data.json", { type: "application/json" }),
      new File(["<main></main>"], "page.html", { type: "text/html" }),
      new File(["pdf"], "report.pdf", { type: "application/pdf" }),
    ]) {
      expect(
        shouldHandleComposerAttachmentPaste({
          files: [file],
          plainText: "",
          maxFileBytes: 10 * 1024 * 1024,
          remainingAttachmentSlots: 1,
        }),
      ).toBe(true);
    }
  });

  it("preserves text paste when an application also supplies a synthetic file", () => {
    const file = new File(["clipboard"], "clipboard.rtf", { type: "application/rtf" });

    expect(
      shouldHandleComposerAttachmentPaste({
        files: [file],
        plainText: "Copied text",
        maxFileBytes: 10 * 1024 * 1024,
        remainingAttachmentSlots: 1,
      }),
    ).toBe(false);
  });

  it("still handles image pastes that include clipboard text", () => {
    const file = new File(["image"], "capture.png", { type: "image/png" });

    expect(
      shouldHandleComposerAttachmentPaste({
        files: [file],
        plainText: "Image caption",
        maxFileBytes: 10 * 1024 * 1024,
        remainingAttachmentSlots: 1,
      }),
    ).toBe(true);
  });

  it("does not claim oversized files or a full composer", () => {
    const file = new File(["report"], "report.pdf", { type: "application/pdf" });
    const input = {
      files: [file],
      plainText: "",
      maxFileBytes: 1,
    };

    expect(shouldHandleComposerAttachmentPaste({ ...input, remainingAttachmentSlots: 1 })).toBe(
      false,
    );
    expect(shouldHandleComposerAttachmentPaste({ ...input, remainingAttachmentSlots: 0 })).toBe(
      false,
    );
  });
});
