import type { ComposerAttachment, ComposerFileAttachment } from "../../composerDraftStore";

export function findMatchingFileMarker(
  attachments: ReadonlyArray<ComposerAttachment>,
  incoming: ComposerFileAttachment,
  consumedMarkerIds: ReadonlySet<string> = new Set(),
): ComposerFileAttachment | undefined {
  return attachments.find(
    (current): current is ComposerFileAttachment =>
      current.type === "file" &&
      current.file === null &&
      !consumedMarkerIds.has(current.id) &&
      current.name === incoming.name &&
      current.mimeType === incoming.mimeType &&
      current.sizeBytes === incoming.sizeBytes,
  );
}

export function shouldConvertPastedTextToAttachment(input: {
  readonly currentPromptLength: number;
  readonly selectedTextLength: number;
  readonly pastedTextLength: number;
  readonly maxInputChars: number;
  readonly remainingAttachmentSlots: number;
  readonly pastedFileCount: number;
}): boolean {
  if (
    input.pastedTextLength === 0 ||
    input.remainingAttachmentSlots <= Math.max(0, input.pastedFileCount)
  ) {
    return false;
  }
  const selectedTextLength = Math.max(
    0,
    Math.min(input.currentPromptLength, input.selectedTextLength),
  );
  return (
    input.currentPromptLength - selectedTextLength + input.pastedTextLength > input.maxInputChars
  );
}

export function createPastedTextAttachmentFile(text: string, uniqueId: string): File {
  const suffix = uniqueId.replace(/[^a-z0-9]+/gi, "").slice(0, 8) || "content";
  return new File([text], `pasted-text-${suffix}.txt`, { type: "text/plain" });
}

export function normalizeComposerAttachmentName(name: string, type: "image" | "file"): string {
  return name.trim() || type;
}

export function shouldHandleComposerAttachmentPaste(input: {
  readonly files: ReadonlyArray<File>;
  readonly plainText: string;
}): boolean {
  if (input.files.length === 0) return false;
  if (input.files.some((file) => file.type.toLowerCase().startsWith("image/"))) return true;
  return true;
}
