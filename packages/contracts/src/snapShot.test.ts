import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ChatAttachment, PersistChatAttachmentsInput } from "./chatAttachment.ts";
import { DesktopSnapShot, DesktopSnapShotEvent } from "./ipc.ts";
import { SnapShotAccessibility, SnapShotSource } from "./snapShot.ts";

const decodePersistChatAttachmentsInput = Schema.decodeUnknownSync(PersistChatAttachmentsInput);
const decodeChatAttachment = Schema.decodeUnknownSync(ChatAttachment);
const decodeDesktopSnapShot = Schema.decodeUnknownSync(DesktopSnapShot);
const decodeSnapShotSource = Schema.decodeUnknownSync(SnapShotSource);
const decodeSnapShotAccessibility = Schema.decodeUnknownSync(SnapShotAccessibility);
const decodeDesktopSnapShotEvent = Schema.decodeUnknownSync(DesktopSnapShotEvent);

const source = {
  kind: "snap-shot",
  capturedAt: "2026-09-09T03:00:00.000Z",
  appName: "Editor",
  windowTitle: "main.ts",
  appIdentifier: "com.example.editor",
  accessibleText: "const answer = 42;",
  appIconDataUrl: "data:image/png;base64,iVBORw==",
  accessibility: {
    format: "element-tree",
    coordinateSpace: "captured-image",
    imageSize: { width: 800, height: 600 },
    truncated: false,
    root: {
      role: "window",
      bounds: { x: 0, y: 0, width: 800, height: 600 },
      children: [{ role: "text", value: "const answer = 42;", bounds: null, children: [] }],
    },
  },
} as const;

describe("SnapShot metadata", () => {
  it("survives upload, pending receipt claiming, persistence and a plain IPC clone", () => {
    const image = {
      type: "image",
      name: "editor.png",
      mimeType: "image/png",
      sizeBytes: 4,
      source,
    };
    const input = decodePersistChatAttachmentsInput({
      threadId: "thread-1",
      messageId: "message-1",
      attachments: [
        { ...image, dataUrl: "data:image/png;base64,AAAA" },
        { ...image, id: "pending-00000000-0000-4000-8000-000000000001-png" },
      ],
    });
    for (const attachment of input.attachments) {
      expect(attachment).toHaveProperty("source", source);
    }
    const persisted = decodeChatAttachment({ ...image, id: "image-1" });
    expect(persisted).toHaveProperty("source", source);
    const captured = decodeDesktopSnapShot(
      structuredClone({
        ...image,
        id: "00000000-0000-4000-8000-000000000001",
        dataUrl: "data:image/png;base64,AAAA",
      }),
    );
    expect(captured.source).toEqual(source);
  });

  it("accepts screenshot-only captures and pre-feature attachments", () => {
    expect(
      decodeSnapShotSource({
        kind: "snap-shot",
        capturedAt: source.capturedAt,
        appName: "Desktop",
        windowTitle: "",
      }).accessibility,
    ).toBeUndefined();
    expect(
      decodeChatAttachment({
        type: "image",
        id: "old",
        name: "old.png",
        mimeType: "image/png",
        sizeBytes: 1,
      }),
    ).not.toHaveProperty("source");
  });

  it("rejects oversized accessibility text, trees, icons and malformed capture ids", () => {
    const decodeSource = decodeSnapShotSource;
    expect(() => decodeSource({ ...source, accessibleText: "x".repeat(32_001) })).toThrow();
    expect(() =>
      decodeSource({ ...source, appIconDataUrl: "https://example.com/icon.png" }),
    ).toThrow();
    expect(() =>
      decodeSnapShotAccessibility({
        ...source.accessibility,
        root: {
          role: "window",
          bounds: null,
          children: Array.from({ length: 10 }, () => ({
            role: "text",
            value: "x".repeat(8_000),
            bounds: null,
            children: [],
          })),
        },
      }),
    ).toThrow();
    expect(() =>
      decodeDesktopSnapShotEvent({
        type: "ready",
        id: "../../file",
      }),
    ).toThrow();
  });
});

it("preserves screen capture metadata and negative display origins without adding window context", () => {
  const screen = decodeSnapShotSource({
    kind: "snap-shot",
    capturedAt: source.capturedAt,
    captureType: "region",
    captureBounds: { x: -1920, y: -200, width: 200, height: 100 },
    appName: "Screen region",
    windowTitle: "",
  });
  expect(screen.captureBounds?.x).toBe(-1920);
  expect(screen.captureType).toBe("region");
  expect(screen.accessibility).toBeUndefined();
  expect(
    decodeDesktopSnapShotEvent({ type: "cancelled", id: "00000000-0000-4000-8000-000000000001" })
      .type,
  ).toBe("cancelled");
});
