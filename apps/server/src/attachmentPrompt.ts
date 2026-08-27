import type { ChatAttachment } from "@spiritdevs/contracts";

import { resolveAttachmentPath } from "./attachmentStore.ts";

function sanitizePromptFileName(name: string): string {
  // eslint-disable-next-line no-control-regex
  return name.replace(/[\u0000-\u001f\u007f()[\]]+/gu, " ").trim();
}

/** Adds durable paths for non-image files so providers can inspect them with filesystem tools. */
export function appendFileAttachmentPromptText(input: {
  readonly text: string;
  readonly attachmentsDir: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
}): string {
  const lines = input.attachments.flatMap((attachment) => {
    if (attachment.type !== "file") return [];
    const attachmentPath = resolveAttachmentPath({
      attachmentsDir: input.attachmentsDir,
      attachment,
    });
    if (attachmentPath === null) return [];
    const name = sanitizePromptFileName(attachment.name);
    return [
      `[Attached file "${name}" (${attachment.mimeType}) is saved at: ${attachmentPath}. Read it from disk when needed.]`,
    ];
  });
  if (lines.length === 0) return input.text;
  return [input.text, lines.join("\n")].filter((part) => part.length > 0).join("\n\n");
}
