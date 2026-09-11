import type { StartThreadTurnInput } from "@spiritdevs/client-runtime/operations";
import type { ChatAttachment, UploadChatAttachment } from "@spiritdevs/contracts";

/** Existing connected threads use the environment's editable run queue. */
export function shouldSendTurnToEnvironment(input: {
  connected: boolean;
  hasThreadProjection: boolean;
  bootstrap: StartThreadTurnInput["bootstrap"];
  pendingCloudMessages: boolean;
}): boolean {
  return (
    input.connected && input.hasThreadProjection && !input.bootstrap && !input.pendingCloudMessages
  );
}

export async function prepareDirectTurnAttachments(
  files: ReadonlyArray<{ metadata: ChatAttachment; blob: Blob }>,
): Promise<UploadChatAttachment[]> {
  return Promise.all(
    files.map(async ({ metadata, blob }) => {
      if (metadata.type !== "image" && metadata.type !== "file")
        throw new Error(`Attach ${metadata.name} again before sending.`);
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.addEventListener("load", () => {
          if (typeof reader.result === "string") resolve(reader.result);
          else reject(new Error("Could not read attachment data."));
        });
        reader.addEventListener("error", () =>
          reject(reader.error ?? new Error("Could not read attachment data.")),
        );
        reader.readAsDataURL(blob);
      });
      return {
        ...metadata,
        type: metadata.type === "image" ? ("image" as const) : ("file" as const),
        dataUrl,
      };
    }),
  );
}
