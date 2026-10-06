import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { AssetResource } from "./assets.ts";
import { HtmlPreviewMetadata, HtmlRenderReference, HtmlRenderResult } from "./htmlRender.ts";

const reference = { attachmentId: "thread-uuid-html", title: "Chart", height: 480 };
const decode = Schema.decodeUnknownSync(HtmlRenderReference);
const decodeResult = Schema.decodeUnknownSync(HtmlRenderResult);
const decodePreview = Schema.decodeUnknownSync(HtmlPreviewMetadata);

describe("HTML render contracts", () => {
  it("decodes the exact normalized JSON shape and numeric measurement tuples", () => {
    const result = {
      htmlRender: {
        ...reference,
        heights: [
          [320, 620],
          [728, 480],
        ],
      },
      message: "Rendered.",
    };
    expect(decodeResult(result)).toEqual(result);
    expect(decode(reference)).not.toHaveProperty("heights");
    expect(decode({ ...reference, title: " Chart " }).title).toBe("Chart");
  });

  it.each([
    { attachmentId: "" },
    { attachmentId: "x".repeat(257) },
    { title: " " },
    { title: "x".repeat(201) },
    { height: 79 },
    { height: 2001 },
    { height: 80.5 },
    { height: Number.NaN },
    { height: Number.POSITIVE_INFINITY },
    { heights: null },
    { heights: [[0, 100]] },
    { heights: [[10_001, 100]] },
    { heights: [[728.5, 100]] },
    { heights: [[728, 0]] },
    { heights: [[728, Number.NaN]] },
    { heights: [[728, Number.POSITIVE_INFINITY]] },
    { heights: [[728, "480"]] },
    { heights: [[728, 480, 12]] },
    { heights: [{ width: 728, height: 480 }] },
    {
      heights: [
        [728, 480],
        [320, 620],
      ],
    },
    {
      heights: [
        [728, 480],
        [728, 620],
      ],
    },
    { heights: Array.from({ length: 25 }, (_, index) => [index + 1, 100]) },
  ])("rejects invalid wire metadata: %j", (change) => {
    expect(() => decode({ ...reference, ...change })).toThrow();
  });

  it("permits positive measurements above the frame maximum for shared-reader clamping", () => {
    expect(decode({ ...reference, heights: [[320, 6000]] }).heights).toEqual([[320, 6000]]);
  });

  it("decodes preview metadata independently from image bytes", () => {
    const metadata = {
      width: 728,
      contentHeight: 510,
      capturedHeight: 510,
      consoleMessages: [{ level: "warning", text: "Missing font" }],
      missingImages: ["/missing.png"],
      screenshot: { mimeType: "image/png", width: 728, height: 510 },
    };
    expect(decodePreview(metadata)).toEqual(metadata);
    expect(() => decodePreview({ ...metadata, width: 1601 })).toThrow();
    expect(() => decodePreview({ ...metadata, contentHeight: 0 })).toThrow();
    expect(() =>
      decodePreview({
        ...metadata,
        screenshot: { ...metadata.screenshot, mimeType: "image/jpeg" },
      }),
    ).toThrow();
  });
});

describe("attachment disposition", () => {
  const decodeAsset = Schema.decodeUnknownSync(AssetResource);
  const resource = {
    _tag: "attachment",
    attachmentId: "thread-uuid-html",
    fileName: "Chart.html",
    mimeType: "text/html",
  };

  it("keeps disposition absent by default and accepts explicit inline or download", () => {
    expect(decodeAsset(resource)).toEqual(resource);
    for (const disposition of ["inline", "attachment"]) {
      expect(decodeAsset({ ...resource, disposition })).toEqual({ ...resource, disposition });
    }
  });

  it("rejects null and unknown dispositions", () => {
    for (const disposition of [null, "download", ""]) {
      expect(() => decodeAsset({ ...resource, disposition })).toThrow();
    }
  });
});
