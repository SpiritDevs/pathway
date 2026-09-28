import { Schema } from "effect";
import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { PreviewTabId } from "./preview.ts";

const text = Schema.String.check(Schema.isMaxLength(64_000));
const id = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
const index = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 64_000 }));
const target = { threadId: ThreadId, tabId: PreviewTabId };
export const PreviewRemoteInteractionCommand = Schema.Union([
  Schema.Struct({ action: Schema.Literal("clipboardRead"), ...target }),
  Schema.Struct({ action: Schema.Literal("clipboardWrite"), ...target, text }),
  Schema.Struct({
    action: Schema.Literal("dialogRespond"),
    ...target,
    dialogId: id,
    accept: Schema.Boolean,
    promptText: Schema.optional(text),
  }),
  Schema.Struct({
    action: Schema.Literal("fileChooserRespond"),
    ...target,
    chooserId: id,
    files: Schema.Array(
      Schema.Struct({
        attachmentId: id,
        name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(255)),
        mimeType: Schema.String.check(Schema.isMaxLength(100)),
      }),
    ).check(Schema.isMaxLength(20)),
  }),
  Schema.Struct({
    action: Schema.Literal("selectChoose"),
    ...target,
    selectId: id,
    indices: Schema.NullOr(Schema.Array(index).check(Schema.isMaxLength(1000))),
  }),
  Schema.Struct({
    action: Schema.Literal("composition"),
    ...target,
    phase: Schema.Literals(["update", "commit", "cancel"]),
    text,
    selectionStart: index,
    selectionEnd: index,
  }),
  Schema.Struct({
    action: Schema.Literal("pointerMove"),
    ...target,
    x: Schema.Finite,
    y: Schema.Finite,
  }),
  Schema.Struct({
    action: Schema.Literal("wheel"),
    ...target,
    x: Schema.Finite,
    y: Schema.Finite,
    deltaX: Schema.Finite,
    deltaY: Schema.Finite,
    modifiers: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 15 }))),
  }),
]);
export type PreviewRemoteInteractionCommand = typeof PreviewRemoteInteractionCommand.Type;
export const PreviewRemoteCursor = Schema.Literals([
  "default",
  "pointer",
  "text",
  "vertical-text",
  "crosshair",
  "move",
  "grab",
  "grabbing",
  "wait",
  "progress",
  "help",
  "not-allowed",
  "none",
  "context-menu",
  "cell",
  "alias",
  "copy",
  "no-drop",
  "all-scroll",
  "col-resize",
  "row-resize",
  "n-resize",
  "e-resize",
  "s-resize",
  "w-resize",
  "ne-resize",
  "nw-resize",
  "se-resize",
  "sw-resize",
  "ew-resize",
  "ns-resize",
  "nesw-resize",
  "nwse-resize",
  "zoom-in",
  "zoom-out",
]);
export const PreviewRemoteSelect = Schema.Struct({
  selectId: id,
  multiple: Schema.Boolean,
  options: Schema.Array(
    Schema.Struct({
      index,
      label: Schema.String.check(Schema.isMaxLength(1000)),
      value: Schema.String.check(Schema.isMaxLength(1000)),
      disabled: Schema.Boolean,
      selected: Schema.Boolean,
    }),
  ).check(Schema.isMaxLength(1000)),
});
export const PreviewRemoteDownload = Schema.Struct({
  downloadId: id,
  name: Schema.String,
  status: Schema.Literals(["downloading", "ready", "failed"]),
  attachmentId: Schema.optional(id),
  sizeBytes: Schema.optional(Schema.Number),
  url: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
});
export type PreviewRemoteDownload = typeof PreviewRemoteDownload.Type;
export const PreviewRemoteInteractionState = Schema.Struct({
  tabId: PreviewTabId,
  cursor: PreviewRemoteCursor,
  clipboard: Schema.NullOr(text),
  dialog: Schema.NullOr(
    Schema.Struct({
      dialogId: id,
      kind: Schema.Literals(["alert", "confirm", "prompt", "beforeunload"]),
      message: text,
      defaultValue: text,
    }),
  ),
  fileChooser: Schema.NullOr(Schema.Struct({ chooserId: id, multiple: Schema.Boolean })),
  select: Schema.NullOr(PreviewRemoteSelect),
  downloads: Schema.Array(PreviewRemoteDownload),
});
export type PreviewRemoteInteractionState = typeof PreviewRemoteInteractionState.Type;
/** A complete snapshot makes a sliding queue safe, including several pending tab dialogs. */
export const PreviewRemoteInteractionEvent = Schema.Struct({
  type: Schema.Literal("state"),
  tabs: Schema.Array(PreviewRemoteInteractionState),
});
export type PreviewRemoteInteractionEvent = typeof PreviewRemoteInteractionEvent.Type;
export const PreviewRemoteInteractionInput = Schema.Struct({ threadId: ThreadId });
