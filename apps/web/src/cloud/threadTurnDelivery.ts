import type { StartThreadTurnInput } from "@spiritdevs/client-runtime/operations";
import {
  AuthOrchestrationOperateScope,
  canUseComputer,
  type ChatAttachment,
  type ComputerAccessPolicy,
  type PendingChatAttachment,
  type UploadChatAttachment,
} from "@spiritdevs/contracts";
import { parseComputerInvocation } from "@spiritdevs/shared/computerInvocation";

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

/**
 * The turn as the cloud queue may carry it. The queue delivers with only
 * `orchestration:operate` (ADR 0041), so the chat setting's implicit Computer
 * intent rides along only where the environment's policy is known to admit
 * that. An explicit `/computer-use` stays: the user asked for it, and a refusal
 * is the right answer.
 */
export function cloudQueuedTurnInput(
  input: StartThreadTurnInput,
  policy: ComputerAccessPolicy | undefined,
): StartThreadTurnInput {
  if (input.enableComputerControl !== true) return input;
  if (policy !== undefined && canUseComputer(policy, [AuthOrchestrationOperateScope])) return input;
  const { enableComputerControl: _, computerControlGeneration, ...rest } = input;
  return parseComputerInvocation(input.message.text) && computerControlGeneration !== undefined
    ? { ...rest, computerControlGeneration }
    : rest;
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
