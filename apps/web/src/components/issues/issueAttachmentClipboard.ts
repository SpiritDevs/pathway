/** The clipboard surface used here, kept structural so the conversion is testable without permissions. */
export interface IssueImageClipboardItem {
  readonly types: ReadonlyArray<string>;
  getType(type: string): Promise<Blob>;
}

const IMAGE_EXTENSION_BY_MIME_TYPE: Readonly<Record<string, string>> = {
  "image/avif": "avif",
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/svg+xml": "svg",
  "image/webp": "webp",
};

function clipboardImageName(mimeType: string, index: number): string {
  const extension = IMAGE_EXTENSION_BY_MIME_TYPE[mimeType] ?? "image";
  const suffix = index === 0 ? "" : ` ${index + 1}`;
  return `Clipboard image${suffix}.${extension}`;
}

/** Turns each clipboard item carrying an image representation into one uploadable file. */
export async function issueClipboardImageFiles(
  items: ReadonlyArray<IssueImageClipboardItem>,
): Promise<ReadonlyArray<File>> {
  const files: File[] = [];
  for (const item of items) {
    const mimeType = item.types.find((type) => type.startsWith("image/"));
    if (mimeType === undefined) continue;
    const blob = await item.getType(mimeType);
    files.push(
      new File([blob], clipboardImageName(mimeType, files.length), {
        type: mimeType,
        lastModified: Date.now(),
      }),
    );
  }
  return files;
}
