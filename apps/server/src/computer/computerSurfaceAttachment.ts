import {
  ChatAttachmentId,
  type ChatImageAttachment,
  type ComputerSurfaceHandBackInput,
} from "@spiritdevs/contracts";
import { Effect, FileSystem, Path } from "effect";
import { attachmentRelativePath, createDeterministicAttachmentId } from "../attachmentStore.ts";
import { ServerConfig } from "../config.ts";
import type { ComputerManager } from "./ComputerManager.ts";
import { encodeComputerSurface } from "./ComputerSurfaceStream.ts";
import { ComputerBackendError } from "./computerErrors.ts";

/** A thread-owned chat attachment, ready for the normal thread message dispatch. */
export const saveComputerSurfaceAttachment = Effect.fn("saveComputerSurfaceAttachment")(function* (
  manager: ComputerManager,
  input: ComputerSurfaceHandBackInput,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig;
  const id = createDeterministicAttachmentId(input.threadId, `${input.messageId}:computer-surface`);
  if (!id) return yield* new ComputerBackendError({ message: "Invalid attachment thread id." });
  const capture = yield* manager.captureSurface();
  const frame = yield* encodeComputerSurface(Buffer.from(capture.bytesBase64, "base64"), {
    maxWidth: 1536,
    maxHeight: 1536,
    quality: 80,
  });
  const attachment: ChatImageAttachment = {
    type: "image",
    id: ChatAttachmentId.make(id),
    name: "computer-screen.jpg",
    mimeType: "image/jpeg",
    sizeBytes: frame.jpeg.byteLength,
  };
  const file = path.join(config.attachmentsDir, attachmentRelativePath(attachment));
  yield* fs.makeDirectory(config.attachmentsDir, { recursive: true });
  yield* fs.writeFile(file, frame.jpeg, { mode: 0o600 });
  return attachment;
});
