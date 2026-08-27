import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  ChatAttachment,
  PersistChatAttachmentsInput,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  UploadChatAttachment,
} from "./chatAttachment.ts";

const decodeChatAttachment = Schema.decodeUnknownSync(ChatAttachment);
const decodeUploadChatAttachment = Schema.decodeUnknownSync(UploadChatAttachment);
const decodePersistChatAttachmentsInput = Schema.decodeUnknownSync(PersistChatAttachmentsInput);

describe("chat file attachments", () => {
  it("decodes stored and upload file variants", () => {
    expect(
      decodeChatAttachment({
        type: "file",
        id: "thread-1-00000000-0000-4000-8000-000000000001",
        name: "report.pdf",
        mimeType: "application/pdf",
        sizeBytes: 42,
      }).type,
    ).toBe("file");
    expect(
      decodeUploadChatAttachment({
        type: "file",
        name: "data.json",
        mimeType: "application/json",
        sizeBytes: 2,
        dataUrl: "data:application/json;base64,e30=",
      }).type,
    ).toBe("file");
  });

  it("rejects oversized files and malformed mime types", () => {
    expect(() =>
      decodeUploadChatAttachment({
        type: "file",
        name: "huge.zip",
        mimeType: "application/zip",
        sizeBytes: PROVIDER_SEND_TURN_MAX_FILE_BYTES + 1,
        dataUrl: "data:application/zip;base64,AA==",
      }),
    ).toThrow();
    expect(() =>
      decodeUploadChatAttachment({
        type: "file",
        name: "unknown",
        mimeType: "unknown",
        sizeBytes: 1,
        dataUrl: "data:unknown;base64,AA==",
      }),
    ).toThrow();
  });

  it("preserves unknown stored attachment kinds for forward compatibility", () => {
    expect(
      decodeChatAttachment({
        type: "archive",
        id: "thread-1-00000000-0000-4000-8000-000000000001",
        name: "bundle.tar",
        mimeType: "application/x-tar",
        sizeBytes: 42,
      }),
    ).toMatchObject({ type: "archive", name: "bundle.tar" });
  });

  it("accepts pending upload ids but rejects already-owned attachment ids", () => {
    const input = {
      threadId: "thread-1",
      messageId: "message-1",
      attachments: [
        {
          type: "file",
          id: "pending-00000000-0000-4000-8000-000000000001-json",
          name: "data.json",
          mimeType: "application/json",
          sizeBytes: 2,
        },
      ],
    };

    expect(decodePersistChatAttachmentsInput(input).attachments).toHaveLength(1);
    expect(() =>
      decodePersistChatAttachmentsInput({
        ...input,
        attachments: [
          {
            ...input.attachments[0],
            id: "another-thread-00000000-0000-4000-8000-000000000001-json",
          },
        ],
      }),
    ).toThrow();
  });
});
