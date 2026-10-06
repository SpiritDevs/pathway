import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

const MeasuredHeight = Schema.Tuple([
  Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10_000 })),
  Schema.Finite.check(Schema.isGreaterThan(0)),
]);

/** The attachment and layout metadata published by html_render. */
export const HtmlRenderReference = Schema.Struct({
  attachmentId: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  height: Schema.Int.check(Schema.isBetween({ minimum: 80, maximum: 2000 })),
  heights: Schema.optionalKey(
    Schema.Array(MeasuredHeight).check(
      Schema.isMaxLength(24),
      Schema.makeFilter(
        (heights) =>
          heights.every(([width], index) => index === 0 || width > heights[index - 1]![0]) ||
          "Measured widths must be strictly ascending.",
      ),
    ),
  ),
});
export type HtmlRenderReference = typeof HtmlRenderReference.Type;

export const HtmlRenderResult = Schema.Struct({
  htmlRender: HtmlRenderReference,
  message: Schema.String,
});
export type HtmlRenderResult = typeof HtmlRenderResult.Type;

/** Preview metadata excludes screenshot bytes, which travel in a separate MCP image block. */
export const HtmlPreviewMetadata = Schema.Struct({
  width: Schema.Int.check(Schema.isBetween({ minimum: 240, maximum: 1600 })),
  contentHeight: Schema.Finite.check(Schema.isGreaterThan(0)),
  capturedHeight: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 4000 })),
  consoleMessages: Schema.Array(
    Schema.Struct({
      level: Schema.Literals(["log", "info", "warning", "error"]),
      text: Schema.String,
    }),
  ),
  missingImages: Schema.optionalKey(Schema.Array(Schema.String)),
  screenshot: Schema.Struct({
    mimeType: Schema.Literal("image/png"),
    width: Schema.Int.check(Schema.isBetween({ minimum: 240, maximum: 1600 })),
    height: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 4000 })),
  }),
});
export type HtmlPreviewMetadata = typeof HtmlPreviewMetadata.Type;
