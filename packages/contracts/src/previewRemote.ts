import { Schema } from "effect";
import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { PreviewTabId, PreviewViewportSize } from "./preview.ts";

const target = { threadId: ThreadId, tabId: PreviewTabId };
const text = Schema.String.check(Schema.isMaxLength(64_000));
export const PreviewRemoteCommand = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("selectHost"),
    threadId: ThreadId,
    host: Schema.Literals(["environment", "automatic"]),
  }),
  Schema.Struct({ action: Schema.Literal("list"), threadId: ThreadId }),
  Schema.Struct({
    action: Schema.Literal("open"),
    threadId: ThreadId,
    url: Schema.optional(Schema.String.check(Schema.isMaxLength(2048))),
  }),
  Schema.Struct({
    action: Schema.Literal("navigate"),
    ...target,
    url: Schema.String.check(Schema.isMaxLength(2048)),
  }),
  Schema.Struct({
    action: Schema.Literals([
      "close",
      "back",
      "forward",
      "reload",
      "screenshot",
      "recordingStart",
      "recordingStop",
    ]),
    ...target,
  }),
  Schema.Struct({ action: Schema.Literal("click"), ...target, x: Schema.Finite, y: Schema.Finite }),
  Schema.Struct({ action: Schema.Literal("type"), ...target, text }),
  Schema.Struct({
    action: Schema.Literal("autofill"),
    ...target,
    origin: Schema.String.check(Schema.isMaxLength(2048)),
    username: text,
    password: text,
  }),
  Schema.Struct({
    action: Schema.Literal("press"),
    ...target,
    key: Schema.String.check(Schema.isMaxLength(128)),
  }),
  Schema.Struct({
    action: Schema.Literal("scroll"),
    ...target,
    deltaX: Schema.Finite,
    deltaY: Schema.Finite,
  }),
  Schema.Struct({ action: Schema.Literal("resize"), ...target, ...PreviewViewportSize.fields }),
]);
export type PreviewRemoteCommand = typeof PreviewRemoteCommand.Type;

export const PreviewRemoteTab = Schema.Struct({
  tabId: PreviewTabId,
  url: Schema.String,
  title: Schema.String,
  openerTabId: Schema.NullOr(PreviewTabId),
  recording: Schema.Boolean,
});
export type PreviewRemoteTab = typeof PreviewRemoteTab.Type;

export const PreviewRemoteArtifact = Schema.Struct({
  id: TrimmedNonEmptyString,
  path: Schema.String,
  mimeType: Schema.String,
  sizeBytes: Schema.Number,
  /** Environment-relative authenticated artifact URL. */
  url: Schema.String,
});
export type PreviewRemoteArtifact = typeof PreviewRemoteArtifact.Type;

export const PreviewRemoteResult = Schema.Struct({
  tabs: Schema.Array(PreviewRemoteTab),
  host: Schema.optional(Schema.Literals(["environment", "automatic"])),
  selectedTabId: Schema.NullOr(PreviewTabId),
  artifact: Schema.optional(PreviewRemoteArtifact),
  artifacts: Schema.optional(Schema.Array(PreviewRemoteArtifact)),
});
export type PreviewRemoteResult = typeof PreviewRemoteResult.Type;

export const PreviewRemoteFrameInput = Schema.Struct({
  threadId: ThreadId,
  tabId: Schema.optional(PreviewTabId),
});
export const PreviewRemoteFrame = Schema.Struct({
  tabId: PreviewTabId,
  mimeType: Schema.Literal("image/jpeg"),
  data: Schema.String,
  width: Schema.Number,
  height: Schema.Number,
  sequence: Schema.Number,
  tabs: Schema.optional(Schema.Array(PreviewRemoteTab)),
  metadataRevision: Schema.optional(Schema.Number),
});
export type PreviewRemoteFrame = typeof PreviewRemoteFrame.Type;

export class PreviewRemoteError extends Schema.TaggedErrorClass<PreviewRemoteError>()(
  "PreviewRemoteError",
  { detail: Schema.String },
) {
  override get message() {
    return this.detail;
  }
}
