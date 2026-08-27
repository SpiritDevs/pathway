import { describe, expect, it } from "vite-plus/test";

import {
  createPastedTextAttachmentFile,
  findMatchingFileMarker,
  normalizeComposerAttachmentName,
  shouldConvertPastedTextToAttachment,
  shouldHandleComposerAttachmentPaste,
} from "./composerAttachmentFiles";

describe("composer attachment files", () => {
  it("finds reattach markers only within the captured draft snapshot", () => {
    const originMarker = {
      type: "file" as const,
      id: "origin-marker",
      name: "report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 6,
      previewUrl: "",
      file: null,
    };
    const navigationMarker = { ...originMarker, id: "navigation-marker" };
    const incoming = {
      ...originMarker,
      id: "incoming",
      file: new File(["report"], "report.pdf", { type: "application/pdf" }),
    };

    expect(findMatchingFileMarker([originMarker], incoming)?.id).toBe("origin-marker");
    expect(findMatchingFileMarker([navigationMarker], incoming)?.id).toBe("navigation-marker");
    expect(
      findMatchingFileMarker([originMarker, navigationMarker], incoming, new Set([originMarker.id]))
        ?.id,
    ).toBe("navigation-marker");
  });

  it("converts text only when the resulting prompt would exceed the send limit", () => {
    const maxInputChars = 120_000;

    expect(
      shouldConvertPastedTextToAttachment({
        currentPromptLength: 100_000,
        selectedTextLength: 0,
        pastedTextLength: 20_001,
        maxInputChars,
        remainingAttachmentSlots: 1,
        pastedFileCount: 0,
      }),
    ).toBe(true);
    expect(
      shouldConvertPastedTextToAttachment({
        currentPromptLength: 100_000,
        selectedTextLength: 10_000,
        pastedTextLength: 20_001,
        maxInputChars,
        remainingAttachmentSlots: 1,
        pastedFileCount: 0,
      }),
    ).toBe(false);
    expect(
      shouldConvertPastedTextToAttachment({
        currentPromptLength: 100_000,
        selectedTextLength: 0,
        pastedTextLength: 20_000,
        maxInputChars,
        remainingAttachmentSlots: 1,
        pastedFileCount: 0,
      }),
    ).toBe(false);
    expect(
      shouldConvertPastedTextToAttachment({
        currentPromptLength: 100_000,
        selectedTextLength: 0,
        pastedTextLength: 20_001,
        maxInputChars,
        remainingAttachmentSlots: 0,
        pastedFileCount: 0,
      }),
    ).toBe(false);
  });

  it("reserves attachment slots for files accompanying oversized pasted text", () => {
    const input = {
      currentPromptLength: 120_000,
      selectedTextLength: 0,
      pastedTextLength: 1,
      maxInputChars: 120_000,
      pastedFileCount: 1,
    };

    expect(shouldConvertPastedTextToAttachment({ ...input, remainingAttachmentSlots: 2 })).toBe(
      true,
    );
    expect(shouldConvertPastedTextToAttachment({ ...input, remainingAttachmentSlots: 1 })).toBe(
      false,
    );
  });

  it("normalizes attachment names before they enter the contract payload", () => {
    expect(normalizeComposerAttachmentName(" report.txt ", "file")).toBe("report.txt");
    expect(normalizeComposerAttachmentName("   ", "file")).toBe("file");
    expect(normalizeComposerAttachmentName("   ", "image")).toBe("image");
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
        }),
      ).toBe(true);
    }
  });

  it("ingests generic files even when the clipboard also carries text", () => {
    const file = new File(["clipboard"], "clipboard.rtf", { type: "application/rtf" });

    expect(
      shouldHandleComposerAttachmentPaste({
        files: [file],
        plainText: "Copied text",
      }),
    ).toBe(true);
  });

  it("still handles image pastes that include clipboard text", () => {
    const file = new File(["image"], "capture.png", { type: "image/png" });

    expect(
      shouldHandleComposerAttachmentPaste({
        files: [file],
        plainText: "Image caption",
      }),
    ).toBe(true);
  });

  it("claims explicit file pastes so the composer can report validation errors", () => {
    const file = new File(["report"], "report.pdf", { type: "application/pdf" });
    expect(shouldHandleComposerAttachmentPaste({ files: [file], plainText: "" })).toBe(true);
  });
});
