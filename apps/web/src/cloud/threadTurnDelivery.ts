import type { StartThreadTurnInput } from "@spiritdevs/client-runtime/operations";
import type {
  ChatAttachment,
  PendingChatAttachment,
  UploadChatAttachment,
} from "@spiritdevs/contracts";

/** Connected environments launch work directly unless saved messages must be delivered first. */
export function shouldSendTurnToEnvironment(input: {
  connected: boolean;
  pendingCloudMessages: boolean;
  activeProviderInstanceId?: string | undefined;
  requestedProviderInstanceId?: string | undefined;
  dispatchMode?: StartThreadTurnInput["dispatchMode"];
}): boolean {
  return (
    input.connected &&
    !input.pendingCloudMessages &&
    !(
      input.activeProviderInstanceId !== undefined &&
      input.requestedProviderInstanceId !== undefined &&
      input.activeProviderInstanceId !== input.requestedProviderInstanceId &&
      (input.dispatchMode === undefined ||
        input.dispatchMode === "auto" ||
        input.dispatchMode === "queue")
    )
  );
}

export async function prepareDirectTurnAttachments(
  files: ReadonlyArray<{ metadata: ChatAttachment; blob: Blob | null }>,
  uploadFile: (file: {
    metadata: ChatAttachment;
    blob: Blob | null;
  }) => Promise<PendingChatAttachment>,
): Promise<ReadonlyArray<PendingChatAttachment | UploadChatAttachment>> {
  return Promise.all(
    files.map(async ({ metadata, blob }) => {
      if (metadata.type !== "image" && metadata.type !== "file")
        throw new Error(`Attach ${metadata.name} again before sending.`);
      if (metadata.type === "file") return uploadFile({ metadata, blob });
      if (blob === null) throw new Error(`Attach ${metadata.name} again before sending.`);
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
