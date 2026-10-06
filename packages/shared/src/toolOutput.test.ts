import { describe, expect, it } from "vite-plus/test";

import { compactHtmlToolProjection, readToolOutput } from "./toolOutput.ts";

const reference = {
  attachmentId: "thread-uuid-html",
  title: "Chart",
  height: 480,
  heights: [
    [320, 620],
    [728, 480],
  ],
};
const result = { htmlRender: reference, message: "Rendered above your reply." };

describe("readToolOutput", () => {
  it("reads each native envelope without accepting arbitrary nesting", () => {
    for (const output of [
      result,
      JSON.stringify(result),
      { structuredContent: result },
      { content: [{ type: "text", text: JSON.stringify(result) }] },
      [{ type: "text", text: JSON.stringify(result) }],
      { content: [{ type: "text", text: { text: JSON.stringify(result) } }] },
    ]) {
      expect(readToolOutput(output)).toEqual({ data: result, isError: false });
    }
    expect(readToolOutput({ unrelated: result }).data).toBeUndefined();
    expect(readToolOutput("broken JSON").data).toBeUndefined();
  });

  it("retains outer, nested, and mirrored error flags", () => {
    for (const output of [
      { isError: true, structuredContent: result },
      { structuredContent: { ...result, isError: true } },
      {
        structuredContent: result,
        content: [{ type: "text", text: JSON.stringify({ isError: true }) }],
      },
      { is_error: true, content: [{ text: { text: JSON.stringify(result) } }] },
      { ...result, error: "Publish failed" },
    ])
      expect(readToolOutput(output).isError).toBe(true);
    expect(readToolOutput({ ...result, error: false }).isError).toBe(false);
    expect(
      compactHtmlToolProjection({
        toolName: "html_render",
        input: {},
        output: { isError: true, content: [{ text: "Publish failed" }] },
      }).output,
    ).toEqual({ isError: true, message: "Publish failed" });
  });

  it("bounds bytes, depth, blocks, total nodes, and cycles", () => {
    expect(
      readToolOutput(JSON.stringify({ ...result, padding: "x".repeat(16_384) })).data,
    ).toBeUndefined();
    expect(
      readToolOutput(JSON.stringify({ ...result, padding: "😀".repeat(5000) })).data,
    ).toBeUndefined();
    let nested: unknown = result;
    for (let depth = 0; depth < 8; depth++) nested = { structuredContent: nested };
    expect(readToolOutput(nested).data).toBeUndefined();
    expect(
      readToolOutput({
        content: [
          ...Array.from({ length: 32 }, () => ({ type: "image", data: "big" })),
          { text: JSON.stringify(result) },
        ],
      }).data,
    ).toBeUndefined();
    const cyclic: { structuredContent?: unknown } = {};
    cyclic.structuredContent = cyclic;
    expect(readToolOutput(cyclic).data).toBeUndefined();
    const hiddenError = {
      structuredContent: {
        structuredContent: {
          structuredContent: {
            structuredContent: { structuredContent: { structuredContent: { isError: true } } },
          },
        },
      },
    };
    expect(readToolOutput({ ...hiddenError, ...result }).isError).toBe(true);
    expect(
      readToolOutput({ structuredContent: result, content: Array.from({ length: 33 }, () => ({})) })
        .data,
    ).toBeUndefined();
  });
});

describe("compactHtmlToolProjection", () => {
  it("normalizes own identities and bounds inputs and publish results", () => {
    for (const toolName of [
      "pathway.html_render",
      "html_render",
      "pathway_html_render",
      "mcp__pathway__html_render",
    ]) {
      expect(
        compactHtmlToolProjection({
          toolName,
          input: { html: "<p>😀</p>", title: "Chart", height: 480, raw: "secret" },
          output: { structuredContent: result },
        }),
      ).toEqual({
        toolName: "pathway.html_render",
        input: { title: "Chart", height: 480, htmlBytes: 11 },
        output: result,
      });
    }
  });

  it("compacts JSON inputs and omits outputs for running calls", () => {
    expect(
      compactHtmlToolProjection({
        toolName: "html_preview",
        input: JSON.stringify({ html: "hi", width: 728, appearance: "dark" }),
      }),
    ).toEqual({
      toolName: "pathway.html_preview",
      input: { htmlBytes: 2, width: 728, appearance: "dark" },
    });
    expect(compactHtmlToolProjection({ toolName: "html_render", input: "broken" }).input).toEqual(
      {},
    );
  });

  it("strips all image/base64 and unknown metadata from preview projection", () => {
    const data = {
      width: 728,
      contentHeight: 500,
      capturedHeight: 500,
      consoleMessages: [{ level: "log", text: "loaded" }],
      missingImages: ["/missing.png"],
      screenshot: { mimeType: "image/png", width: 728, height: 500, data: "PNG_BASE64" },
      image: "PNG_BASE64",
      html: "RAW_HTML",
    };
    const projection = compactHtmlToolProjection({
      toolName: "pathway_html_preview",
      input: { html: "RAW_HTML", width: 728 },
      output: { structuredContent: data, content: [{ type: "image", data: "PNG_BASE64" }] },
    });
    expect(projection.output).toEqual({
      width: 728,
      contentHeight: 500,
      capturedHeight: 500,
      consoleMessages: [{ level: "log", text: "loaded" }],
      missingImages: ["/missing.png"],
      screenshot: { mimeType: "image/png", width: 728, height: 500 },
    });
    expect(JSON.stringify(projection)).not.toMatch(/PNG_BASE64|RAW_HTML/);
  });

  it("does not promote malformed or error results to successful renders", () => {
    for (const output of [
      { isError: true, structuredContent: result },
      { structuredContent: { htmlRender: {} } },
      "bad JSON",
    ]) {
      expect(
        compactHtmlToolProjection({ toolName: "html_render", input: {}, output }).output,
      ).toMatchObject({ isError: true });
    }
  });

  it("leaves every unrelated tool projection intact", () => {
    for (const toolName of [
      "mcp__other__html_render",
      "other_html_render",
      "pathway_other_html_render",
      "pathway.create_threads",
      null,
    ]) {
      const projection = { toolName, input: { html: "keep" }, output: result };
      expect(compactHtmlToolProjection(projection)).toBe(projection);
    }
  });

  it("keeps serialized metadata within 8 KiB even with escaped or multibyte text", () => {
    const render = compactHtmlToolProjection({
      toolName: "html_render",
      input: {},
      output: { ...result, message: '😀"\\'.repeat(10_000) },
    });
    expect(new TextEncoder().encode(JSON.stringify(render.output)).byteLength).toBeLessThanOrEqual(
      8192,
    );
    const preview = compactHtmlToolProjection({
      toolName: "html_preview",
      input: {},
      output: {
        width: 728,
        contentHeight: 500,
        capturedHeight: 500,
        consoleMessages: Array.from({ length: 50 }, () => ({
          level: "log",
          text: '😀"\\'.repeat(500),
        })),
        missingImages: Array.from({ length: 100 }, () => "\\".repeat(500)),
      },
    });
    expect(new TextEncoder().encode(JSON.stringify(preview.output)).byteLength).toBeLessThanOrEqual(
      8192,
    );
  });
});
