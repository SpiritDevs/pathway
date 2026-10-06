import {
  HtmlPreviewMetadata,
  HtmlRenderResult,
  OrchestratorMcpFailure,
} from "@spiritdevs/contracts";
import {
  HTML_RENDER_COLUMN_WIDTH,
  HTML_RENDER_LAYOUT_GUIDE,
  HTML_RENDER_MAX_HEIGHT,
  HTML_RENDER_MAX_TITLE_LENGTH,
  HTML_RENDER_MIN_HEIGHT,
  HTML_RENDER_THEME_GUIDE,
} from "@spiritdevs/shared/htmlRender";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import { HtmlRender } from "../../../htmlRender/HtmlRender.ts";
import { ThreadManagementService } from "../../../orchestration-v2/ThreadManagementService.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";

const Html = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512_000)).annotate({
  description: "One complete, self-contained HTML document.",
});
const PAGE_RULES =
  'Write one self-contained document with inline <style> and <script>. Supported local images at absolute paths (src="/abs/image.png", CSS url(/abs/image.webp), or a quoted JavaScript string) are inlined automatically. Relative local files and local scripts/styles are not loaded. Remote http(s) resources load as-is; previews allow public network resources outside the provider network sandbox.';
const dependencies = [McpInvocationContext, ThreadManagementService, HtmlRender];

export const HtmlPreviewResult = Schema.Struct({
  ...HtmlPreviewMetadata.fields,
  screenshot: Schema.Struct({
    ...HtmlPreviewMetadata.fields.screenshot.fields,
    data: Schema.String,
  }),
});

export const HtmlPreviewTool = Tool.make("html_preview", {
  description: `Render an HTML page in Pathway's isolated headless Chromium and return a PNG screenshot, contentHeight (the height the page needs at this width), and bounded console output including uncaught exceptions. Use console.log to report checks, and iterate before html_render. Chromium must already be installed and able to run its OS sandbox; missing Chromium returns installation guidance. ${PAGE_RULES} ${HTML_RENDER_LAYOUT_GUIDE} ${HTML_RENDER_THEME_GUIDE}`,
  parameters: Schema.Struct({
    html: Html,
    width: Schema.optional(
      Schema.Int.annotate({
        description: `Viewport width in CSS pixels, clamped to 240–1600. Defaults to ${HTML_RENDER_COLUMN_WIDTH}; use about 390 to check phones.`,
      }),
    ),
    appearance: Schema.optional(
      Schema.Literals(["dark", "light"]).annotate({
        description: "Theme to preview. Defaults to dark.",
      }),
    ),
  }),
  success: HtmlPreviewResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Preview HTML")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

export const HtmlRenderTool = Tool.make("html_render", {
  description: `Show a finished HTML page (chart, table, diagram, collage, mockup) inline in this thread, above your final text reply; call it before writing that reply. The reader sees the page, so add only what it does not already say. Preview with html_preview first. Pathway fits the frame to the page's height at each reader's width. A height below the page's contentHeight caps the frame there, and the rest scrolls inside it. Publishing still works without Chromium, with no height measurements. ${PAGE_RULES} ${HTML_RENDER_LAYOUT_GUIDE} ${HTML_RENDER_THEME_GUIDE}`,
  parameters: Schema.Struct({
    html: Html,
    title: Schema.String.check(
      Schema.isMinLength(1),
      Schema.isMaxLength(HTML_RENDER_MAX_TITLE_LENGTH),
    ).annotate({
      description: "Short name for the page; whitespace is trimmed.",
    }),
    height: Schema.Int.annotate({
      description: `The frame height in CSS pixels, clamped to ${HTML_RENDER_MIN_HEIGHT}–${HTML_RENDER_MAX_HEIGHT}. Use html_preview's contentHeight, or less to make long content scroll inside the frame.`,
    }),
  }),
  success: HtmlRenderResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Render HTML")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const HtmlPreviewToolkit = Toolkit.make(HtmlPreviewTool);
export const HtmlRenderToolkit = Toolkit.make(HtmlRenderTool);
export const HtmlToolkit = Toolkit.make(HtmlPreviewTool, HtmlRenderTool);
