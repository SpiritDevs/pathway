export function shouldConvertPastedTextToAttachment(input: {
  readonly currentPromptLength: number;
  readonly selectedTextLength: number;
  readonly pastedTextLength: number;
  readonly maxInputChars: number;
}): boolean {
  if (input.pastedTextLength === 0) return false;
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

export function shouldHandleComposerAttachmentPaste(input: {
  readonly files: ReadonlyArray<File>;
  readonly plainText: string;
  readonly maxFileBytes: number;
  readonly remainingAttachmentSlots: number;
}): boolean {
  if (input.remainingAttachmentSlots <= 0) return false;
  if (input.files.some((file) => file.type.toLowerCase().startsWith("image/"))) return true;
  if (input.plainText.length > 0) return false;

  return input.files.some((file) => file.size <= input.maxFileBytes);
}
