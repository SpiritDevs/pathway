import { describe, expect, it } from "vite-plus/test";
import * as NodeVM from "node:vm";

import {
  HTML_RENDER_MAX_HEIGHT,
  htmlRenderFromToolItem,
  htmlRenderFrameHeight,
  htmlRenderReferencesEqual,
  htmlRenderTheme,
  htmlRenderThemeFragment,
  injectHtmlRenderBootstrap,
  htmlRenderThemeMessage,
  readHtmlRenderContentHeight,
  readHtmlRenderLinkRequest,
  readHtmlRenderReference,
  htmlRenderFileName,
  htmlRenderResult,
  HTML_RENDER_DEFAULT_FONTS,
  HTML_RENDER_MEASURE_FONTS,
} from "./htmlRender.ts";
import {
  Pathway_CODE_DARK_THEME_COLORS,
  Pathway_CODE_LIGHT_THEME_COLORS,
} from "./themePalettes.ts";

const reference = { attachmentId: "thread-abc-123.html", title: "Chart", height: 420 };

describe("injectHtmlRenderBootstrap", () => {
  it("puts the theme ahead of the page's own head content", () => {
    const html =
      "<!doctype html><html><head><style>:root{--background:red}</style></head><body>x</body></html>";
    const injected = injectHtmlRenderBootstrap(html);
    const themeAt = injected.indexOf('<style id="pathway-theme">');
    expect(themeAt).toBeGreaterThan(injected.indexOf("<head>"));
    expect(themeAt).toBeLessThan(injected.indexOf(":root{--background:red}"));
    expect(injected).toContain('<meta charset="utf-8">');
    expect(injected).toContain('name="viewport"');
  });

  it("wraps fragments without a head and keeps existing meta tags", () => {
    const fragment =
      '<meta charset="utf-8"><meta name="viewport" content="width=device-width"><p>hi</p>';
    const injected = injectHtmlRenderBootstrap(fragment);
    expect(injected.startsWith("<!doctype html><head>")).toBe(true);
    expect(injected.match(/charset/g)).toHaveLength(1);
    expect(injected.match(/name="viewport"/g)).toHaveLength(1);
    expect(injected.endsWith("<p>hi</p>")).toBe(true);
  });

  it.each(["textarea", "title", "xmp", "iframe", "noembed", "noframes", "noscript", "plaintext"])(
    "keeps the bootstrap outside %s content",
    (tag) => {
      const fragment = `<${tag}><head><meta name="viewport"></head></${tag}>`;
      const injected = injectHtmlRenderBootstrap(fragment);
      expect(injected.startsWith("<!doctype html><head>")).toBe(true);
      expect(injected.indexOf('<style id="pathway-theme">')).toBeLessThan(
        injected.indexOf(`<${tag}>`),
      );
      expect(injected).toContain('<meta name="viewport" content="width=device-width');
      expect(injected.endsWith(fragment)).toBe(true);
    },
  );

  it.each([
    '<template><head><meta name="viewport"></head></template>',
    '<template><template>inner</template><head><meta name="viewport"></head></template>',
  ])("keeps the bootstrap outside inert template content: %s", (fragment) => {
    const injected = injectHtmlRenderBootstrap(fragment);
    expect(injected.startsWith("<!doctype html><head>")).toBe(true);
    expect(injected.indexOf('<style id="pathway-theme">')).toBeLessThan(
      injected.indexOf("<template>"),
    );
    expect(injected).toContain('<meta name="viewport" content="width=device-width');
    expect(injected.endsWith(fragment)).toBe(true);
  });

  it("ignores tags written inside comments and scripts", () => {
    const html =
      '<!-- copy <head> and <meta name="viewport"> here --><html><head>' +
      "<script>const tag = '<meta name=\"viewport\">';</script></head><body>x</body></html>";
    const injected = injectHtmlRenderBootstrap(html);
    expect(injected.indexOf('<style id="pathway-theme">')).toBeGreaterThan(
      injected.indexOf("<html><head>"),
    );
    expect(injected).toContain('<meta name="viewport" content="width=device-width');
  });

  it.each([
    '<div data-copy="<head><meta name=viewport>">x</div>',
    '<template data-copy=">"><template>inner</template><head></head></template>',
    "<!-- unclosed <head>",
    "<script>unclosed <head>",
    "<template><head>",
    '<div data-copy="unclosed <head>',
    '<head data-copy="unclosed >',
    '<html data-copy="unclosed >',
  ])("keeps the bootstrap outside inert or quoted markup: %s", (fragment) => {
    expect(injectHtmlRenderBootstrap(fragment).startsWith("<!doctype html><head>")).toBe(true);
    expect(injectHtmlRenderBootstrap(fragment).endsWith(fragment)).toBe(true);
  });

  it("places the bootstrap after a quoted head tag and preserves document structure", () => {
    const prefix = '<!doctype html><HTML data-copy="<head>"><HEAD data-copy=">">';
    const html = `${prefix}<meta charset="utf-8"><meta name='viewport'><title>Chart</title></HEAD><body>x</body></HTML>`;
    const injected = injectHtmlRenderBootstrap(html);
    expect(injected.startsWith(`${prefix}<style id="pathway-theme">`)).toBe(true);
    expect(injected.match(/<meta charset=/g)).toHaveLength(1);
    expect(injected.match(/<meta name='viewport'/g)).toHaveLength(1);
  });

  it("creates a head after an html tag or doctype when absent", () => {
    expect(injectHtmlRenderBootstrap('<html lang="en"><body>x</body></html>')).toMatch(
      /^<html lang="en"><head>/,
    );
    expect(injectHtmlRenderBootstrap("<!doctype html><p>x</p>")).toMatch(/^<!doctype html><head>/);
  });
});

describe("readHtmlRenderLinkRequest", () => {
  it("accepts only http(s) URLs in an MCP Apps ui/open-link request", () => {
    const link = (url: unknown) => ({
      jsonrpc: "2.0",
      id: 1,
      method: "ui/open-link",
      params: { url },
    });
    expect(readHtmlRenderLinkRequest(link("https://example.com/a"))).toEqual({
      id: 1,
      url: "https://example.com/a",
    });
    expect(readHtmlRenderLinkRequest(link("javascript:alert(1)"))).toBeUndefined();
    expect(readHtmlRenderLinkRequest(link("file:///etc/passwd"))).toBeUndefined();
    expect(readHtmlRenderLinkRequest(link("https://"))).toBeUndefined();
    expect(
      readHtmlRenderLinkRequest({ ...link("https://example.com"), id: Number.NaN }),
    ).toBeUndefined();
    expect(
      readHtmlRenderLinkRequest({
        jsonrpc: "2.0",
        method: "ui/open-link",
        params: { url: "https://example.com" },
      }),
    ).toBeUndefined();
    expect(
      readHtmlRenderLinkRequest({ type: "t3-html-render-link", url: "https://example.com" }),
    ).toBeUndefined();
  });
});

describe("readHtmlRenderContentHeight", () => {
  it("reads only the height of an MCP Apps size-changed notification", () => {
    const notification = (params: unknown) => ({
      jsonrpc: "2.0",
      method: "ui/notifications/size-changed",
      params,
    });
    expect(readHtmlRenderContentHeight(notification({ height: 412 }))).toBe(412);
    expect(readHtmlRenderContentHeight(notification({ height: "412" }))).toBe(undefined);
    expect(readHtmlRenderContentHeight(notification({ height: 0 }))).toBe(undefined);
    expect(readHtmlRenderContentHeight(notification({ height: Number.NaN }))).toBeUndefined();
    expect(
      readHtmlRenderContentHeight(notification({ height: Number.POSITIVE_INFINITY })),
    ).toBeUndefined();
    expect(readHtmlRenderContentHeight({ ...notification({ height: 412 }), method: "x" })).toBe(
      undefined,
    );
  });
});

describe("htmlRenderThemeMessage", () => {
  it("is an MCP Apps host-context-changed notification carrying the theme variables", () => {
    const theme = htmlRenderTheme(Pathway_CODE_DARK_THEME_COLORS, "dark");
    expect(htmlRenderThemeMessage(theme)).toEqual({
      jsonrpc: "2.0",
      method: "ui/notifications/host-context-changed",
      params: { theme: "dark", styles: { variables: theme.variables } },
    });
  });
});

describe("htmlRenderTheme", () => {
  it("exposes the brand accent as --accent and keeps the fragment decodable", () => {
    const theme = htmlRenderTheme(Pathway_CODE_LIGHT_THEME_COLORS, "light");
    expect(theme.variables["--accent"]).toBe(Pathway_CODE_LIGHT_THEME_COLORS.accent);
    expect(theme.variables["--chart-1"]).toBe(Pathway_CODE_LIGHT_THEME_COLORS.accent);
    expect(theme.variables["--chart-6"]).toBeDefined();
    const fragment = htmlRenderThemeFragment(theme);
    expect(JSON.parse(decodeURIComponent(fragment.slice("#pathway-theme=".length)))).toEqual(theme);
    expect(fragment).not.toContain("&");
    expect(htmlRenderTheme(Pathway_CODE_DARK_THEME_COLORS, "dark").variables["--background"]).toBe(
      Pathway_CODE_DARK_THEME_COLORS.canvas,
    );
  });
});

describe("readHtmlRenderReference", () => {
  it("clamps height and rejects malformed references", () => {
    expect(readHtmlRenderReference({ ...reference, height: 99_999 })?.height).toBe(2000);
    expect(readHtmlRenderReference({ ...reference, title: "  " })?.title).toBe("HTML");
    expect(readHtmlRenderReference({ ...reference, attachmentId: 4 })).toBeUndefined();
    expect(readHtmlRenderReference({ ...reference, height: Number.NaN })).toBeUndefined();
    expect(
      readHtmlRenderReference({ ...reference, attachmentId: "x".repeat(257) }),
    ).toBeUndefined();
    expect(readHtmlRenderReference({ ...reference, title: "x".repeat(250) })?.title).toHaveLength(
      200,
    );
    for (const heights of [
      [[728, 0]],
      [[728, -1]],
      [[728, Number.POSITIVE_INFINITY]],
      [[728.5, 200]],
      [
        [728, 200],
        [728, 201],
      ],
      Array.from({ length: 25 }, (_, index) => [index + 1, 200]),
    ]) {
      expect(readHtmlRenderReference({ ...reference, heights })?.heights).toBeUndefined();
    }
    expect(
      readHtmlRenderReference({
        ...reference,
        heights: [
          [320, 12],
          [728, 6000],
        ],
      })?.heights,
    ).toEqual([
      [320, 80],
      [728, 2000],
    ]);
  });
});

describe("HTML filenames and bridge results", () => {
  it("uses bounded portable filenames and safe fallback names", () => {
    expect(htmlRenderFileName('  A/B\\C:*?"<>|\u0000  Chart  ')).toBe("A B C Chart.html");
    expect(htmlRenderFileName("   ")).toBe("Page.html");
    expect(htmlRenderFileName("x".repeat(200))).toHaveLength(125);
    expect(htmlRenderResult("pathway-link-1")).toEqual({
      jsonrpc: "2.0",
      id: "pathway-link-1",
      result: {},
    });
    expect(HTML_RENDER_DEFAULT_FONTS.mono).not.toContain("ui-monospace");
    expect(HTML_RENDER_MEASURE_FONTS.sans).toContain("Liberation Sans");
  });
});

function bootstrapHarness(topLevel = false, hash = "") {
  const style = { textContent: "" };
  const posted: unknown[] = [];
  const historyCalls: unknown[][] = [];
  const windowEvents = new Map<string, (event: unknown) => void>();
  const documentEvents = new Map<string, (event?: unknown) => void>();
  const observed: unknown[] = [];
  let resize = () => {};
  class ResizeObserver {
    constructor(callback: () => void) {
      resize = callback;
    }
    observe(element: unknown) {
      observed.push(element);
    }
  }
  const parent = { postMessage: (message: unknown) => posted.push(message) };
  const window = {
    parent: parent as unknown,
    ResizeObserver,
    addEventListener: (name: string, callback: (event: unknown) => void) =>
      windowEvents.set(name, callback),
  };
  if (topLevel) window.parent = window;
  const root = {
    scrollHeight: 412,
    clientHeight: 400,
    getBoundingClientRect: () => ({ height: 400 }),
  };
  const document = {
    getElementById: (id: string) => (id === "pathway-theme" ? style : null),
    baseURI: "https://environment.example/page.html",
    documentElement: root,
    body: {},
    addEventListener: (name: string, callback: (event?: unknown) => void) =>
      documentEvents.set(name, callback),
  };
  const script = injectHtmlRenderBootstrap("<p>x</p>").match(/<script>([\s\S]*?)<\/script>/)![1]!;
  NodeVM.runInNewContext(script, {
    document,
    window,
    ResizeObserver,
    URL,
    location: {
      hash,
      pathname: "/page.html",
      search: "?token=x",
      href: "https://environment.example/page.html?token=x",
    },
    history: { state: null, replaceState: (...args: unknown[]) => historyCalls.push(args) },
  });
  return {
    style,
    posted,
    historyCalls,
    windowEvents,
    documentEvents,
    observed,
    root,
    parent,
    resize: () => resize(),
  };
}

describe("injected bootstrap behavior", () => {
  it("applies the initial fragment theme, removes it, and validates live CSS values", () => {
    const theme = htmlRenderTheme(Pathway_CODE_LIGHT_THEME_COLORS, "light");
    const harness = bootstrapHarness(false, htmlRenderThemeFragment(theme));
    expect(harness.style.textContent).toContain(":root{color-scheme:light;");
    expect(harness.style.textContent).toContain(`--background:${theme.variables["--background"]};`);
    expect(harness.historyCalls[0]).toEqual([null, "", "/page.html?token=x"]);
    const incoming = {
      appearance: "dark" as const,
      variables: {
        "--background": "oklch(0.1 0 0)",
        "--bad": "</style><script>alert(1)</script>",
        "--other": "red;background:blue",
        color: "red",
        "--font-sans": '"Quoted Font", sans-serif',
      },
    };
    harness.windowEvents.get("message")!({
      source: harness.parent,
      data: htmlRenderThemeMessage(incoming),
    });
    expect(harness.style.textContent).toContain("--background:oklch(0.1 0 0);");
    expect(harness.style.textContent).toContain('--font-sans:"Quoted Font", sans-serif;');
    expect(harness.style.textContent).not.toMatch(/--bad:|--other:|alert\(1\)|background:blue/);
    const before = harness.style.textContent;
    harness.windowEvents.get("message")!({ source: {}, data: htmlRenderThemeMessage(theme) });
    expect(harness.style.textContent).toBe(before);
  });

  it("ignores malformed fragment and theme messages", () => {
    const harness = bootstrapHarness(false, "#pathway-theme=%broken");
    for (const data of [
      {},
      { type: "pathway-html-render-theme", theme: {} },
      {
        jsonrpc: "2.0",
        method: "ui/notifications/host-context-changed",
        params: { theme: "invalid", styles: { variables: {} } },
      },
    ]) {
      harness.windowEvents.get("message")!({ source: harness.parent, data });
    }
    expect(harness.style.textContent).toBe("");
  });

  it("reports measured content height only on change, with no continuous animation loop", () => {
    const harness = bootstrapHarness();
    harness.documentEvents.get("DOMContentLoaded")!();
    harness.resize();
    harness.windowEvents.get("load")!({});
    expect(harness.posted).toEqual([
      { jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height: 412 } },
    ]);
    harness.root.scrollHeight = 400;
    harness.root.getBoundingClientRect = () => ({ height: 399.5 });
    harness.resize();
    expect(harness.posted[1]).toEqual({
      jsonrpc: "2.0",
      method: "ui/notifications/size-changed",
      params: { height: 400 },
    });
    expect(harness.observed).toHaveLength(2);
    expect(bootstrapHarness(true).observed).toHaveLength(0);
  });

  it("bridges only trusted external http links, including shadow-DOM composed paths", () => {
    const harness = bootstrapHarness();
    const click = harness.documentEvents.get("click")!;
    let prevented = 0;
    const link = (href: string) => ({ matches: () => true, getAttribute: () => href });
    const event = (href: string, isTrusted = true) => ({
      isTrusted,
      composedPath: () => [{}, link(href)],
      preventDefault: () => prevented++,
    });
    click(event("https://example.com/a", false));
    click(event("javascript:alert(1)"));
    click(event("https://environment.example/page.html?token=x#anchor"));
    expect(harness.posted).toEqual([]);
    click(event("https://example.com/a"));
    expect(prevented).toBe(1);
    expect(harness.posted).toEqual([
      {
        jsonrpc: "2.0",
        id: "pathway-link-1",
        method: "ui/open-link",
        params: { url: "https://example.com/a" },
      },
    ]);
  });

  it("opens trusted top-level links in a new window for the native host", () => {
    const harness = bootstrapHarness(true);
    const attrs = new Map<string, string>();
    const link = {
      matches: () => true,
      getAttribute: () => "https://example.com",
      setAttribute: (name: string, value: string) => attrs.set(name, value),
    };
    harness.documentEvents.get("click")!({ isTrusted: true, composedPath: () => [link] });
    expect(attrs.get("target")).toBe("_blank");
    expect(attrs.get("rel")).toBe("noopener");
    expect(harness.posted).toEqual([]);
  });
});

describe("htmlRenderFromToolItem", () => {
  const result = { htmlRender: reference, message: "Rendered above your reply." };

  it("reads only normalized completed own-tool results", () => {
    for (const toolName of [
      "pathway.html_render",
      "mcp__pathway__html_render",
      "pathway_html_render",
      "html_render",
      "pathway_code/html_render",
    ]) {
      expect(
        htmlRenderFromToolItem({
          type: "dynamic_tool",
          status: "completed",
          toolName,
          output: result,
        }),
      ).toEqual(reference);
    }
  });

  it("ignores other tools, unnormalized envelopes, errors, and stale failed outputs", () => {
    const item = {
      type: "dynamic_tool",
      status: "completed",
      toolName: "pathway.html_render",
      output: result,
    };
    for (const change of [
      { type: "command_execution" },
      { status: "running" },
      { status: "failed" },
      { status: "cancelled" },
      { toolName: "pathway.html_preview" },
      { toolName: "mcp__other__html_render" },
      { output: { ...result, isError: true } },
      { output: { htmlRender: {} } },
      { output: JSON.stringify(result) },
      { output: { structuredContent: result } },
      { output: [{ type: "text", text: JSON.stringify(result) }] },
    ]) {
      expect(htmlRenderFromToolItem({ ...item, ...change })).toBeUndefined();
    }
  });
});

describe("htmlRenderFrameHeight", () => {
  const measured = readHtmlRenderReference({
    ...reference,
    height: 1500,
    heights: [
      [728, 1403],
      [390, 1290],
      [1000, 1660],
    ],
  })!;

  it("takes the taller neighbor between measured widths and holds the ends", () => {
    expect(measured.heights?.map(([width]) => width)).toEqual([390, 728, 1000]);
    expect(htmlRenderFrameHeight(measured, 728)).toBe(1403);
    expect(htmlRenderFrameHeight(measured, 559)).toBe(1403);
    expect(htmlRenderFrameHeight(measured, 320)).toBe(1290);
  });

  it("takes the taller layout when a breakpoint falls between measured widths", () => {
    // 900px tall below a 600px media query, 450px above it.
    const responsive = readHtmlRenderReference({
      ...reference,
      height: 2000,
      heights: [
        [520, 900],
        [640, 450],
      ],
    })!;
    expect(htmlRenderFrameHeight(responsive, 590)).toBe(900);
    expect(htmlRenderFrameHeight(responsive, 640)).toBe(450);
  });

  it("fits a page the client lays out taller than the server measured", () => {
    // The agent passed contentHeight at the column width, so the page should never scroll.
    const fitted = { ...measured, height: 1403 };
    expect(htmlRenderFrameHeight(fitted, 728, 1415)).toBe(1415);
    expect(htmlRenderFrameHeight(fitted, 1400)).toBe(1660);
    expect(htmlRenderFrameHeight(fitted, 728, 5000)).toBe(HTML_RENDER_MAX_HEIGHT);
  });

  it("keeps the agent's height when it asked for a scrolling frame or the page is unmeasured", () => {
    const scrolling = { ...measured, height: 600 };
    expect(htmlRenderFrameHeight(scrolling, 728, 1415)).toBe(600);
    expect(htmlRenderFrameHeight(scrolling, 1400)).toBe(600);
    expect(htmlRenderFrameHeight(reference, 728)).toBe(reference.height);
    expect(htmlRenderFrameHeight(reference, 728, 900)).toBe(reference.height);
    expect(htmlRenderFrameHeight(reference, 728, 300)).toBe(300);
  });

  it("drops a malformed table and compares tables by value", () => {
    expect(readHtmlRenderReference({ ...reference, heights: [[728, "x"]] })?.heights).toBe(
      undefined,
    );
    const copy = readHtmlRenderReference(JSON.parse(JSON.stringify(measured)))!;
    expect(htmlRenderReferencesEqual(measured, copy)).toBe(true);
    expect(htmlRenderReferencesEqual(measured, { ...copy, heights: [[390, 1290]] })).toBe(false);
  });
});
