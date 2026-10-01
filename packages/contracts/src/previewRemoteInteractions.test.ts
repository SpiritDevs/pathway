import { describe, expect, it } from "vite-plus/test";
import { Schema } from "effect";
import { PreviewRemoteInteractionCommand } from "./previewRemoteInteractions.ts";
const decode = Schema.decodeUnknownSync(PreviewRemoteInteractionCommand);
const target = { threadId: "thread", tabId: "tab" };
describe("remote interaction contracts", () => {
  it("accepts composition, fractional wheel deltas and attachment references", () => {
    for (const command of [
      {
        action: "composition",
        phase: "update",
        text: "日本語",
        selectionStart: 0,
        selectionEnd: 3,
      },
      { action: "wheel", x: 1.5, y: 2.5, deltaX: 0.25, deltaY: -5.5 },
      {
        action: "fileChooserRespond",
        chooserId: "chooser",
        files: [{ attachmentId: "pending-upload", name: "file.txt", mimeType: "text/plain" }],
      },
      { action: "selectChoose", selectId: "popup", indices: null },
    ])
      expect(decode({ ...target, ...command })).toMatchObject(command);
  });
  it("rejects oversized text, file batches, invalid modifiers and nonfinite deltas", () => {
    for (const command of [
      { action: "clipboardWrite", text: "x".repeat(64001) },
      {
        action: "fileChooserRespond",
        chooserId: "chooser",
        files: Array.from({ length: 21 }, () => ({
          attachmentId: "id",
          name: "file",
          mimeType: "text/plain",
        })),
      },
      { action: "wheel", x: 0, y: 0, deltaX: Infinity, deltaY: 0 },
      { action: "wheel", x: 0, y: 0, deltaX: 0, deltaY: 0, modifiers: 16 },
    ])
      expect(() => decode({ ...target, ...command })).toThrow();
  });
});
