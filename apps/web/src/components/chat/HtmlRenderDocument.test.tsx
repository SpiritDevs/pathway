import {
  htmlRenderTheme,
  htmlRenderThemeFragment,
  htmlRenderThemeMessage,
} from "@spiritdevs/shared/htmlRender";
import {
  Pathway_CODE_DARK_THEME_COLORS,
  Pathway_CODE_LIGHT_THEME_COLORS,
} from "@spiritdevs/shared/themePalettes";
import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const theme = htmlRenderTheme(Pathway_CODE_DARK_THEME_COLORS, "dark");
let activeTheme = theme;
vi.mock("~/hooks/useHtmlRenderTheme", () => ({ useHtmlRenderTheme: () => activeTheme }));
const openExternal = vi.fn(async (_url: string) => {});
vi.mock("~/localApi", () => ({ readLocalApi: () => ({ shell: { openExternal } }) }));
vi.mock("../ui/toast", () => ({ toastManager: { add: vi.fn() }, stackedThreadToast: vi.fn() }));

const { HtmlRenderDocument, openHtmlRenderUrl } = await import("./HtmlRenderDocument");
let renderer: ReactTestRenderer | undefined;
const host = new EventTarget();
const frame = { contentWindow: { postMessage: vi.fn() } };
const focus: { activeElement: unknown } = { activeElement: null };
const activation: { userActivation?: { isActive: boolean } } = {};
beforeEach(() => {
  activeTheme = theme;
  openExternal.mockClear();
  frame.contentWindow.postMessage.mockClear();
  focus.activeElement = frame;
  activation.userActivation = { isActive: true };
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", host);
  vi.stubGlobal("document", focus);
  vi.stubGlobal("navigator", activation);
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

async function mount(props: Partial<Parameters<typeof HtmlRenderDocument>[0]> = {}) {
  await act(async () => {
    renderer = create(
      <HtmlRenderDocument src="https://environment.example/Chart.html" title="Chart" {...props} />,
      {
        createNodeMock: () => frame,
      },
    );
  });
}

function post(data: unknown, source: unknown = frame.contentWindow) {
  const event = new Event("message");
  Object.defineProperties(event, { data: { value: data }, source: { value: source } });
  host.dispatchEvent(event);
}
const link = (url = "https://example.com/chart") => ({
  jsonrpc: "2.0",
  id: 1,
  method: "ui/open-link",
  params: { url },
});

describe("HtmlRenderDocument", () => {
  it("limits every external-open path to http(s), including opening the render itself", () => {
    openHtmlRenderUrl("javascript:alert(1)");
    openHtmlRenderUrl("file:///etc/passwd");
    openHtmlRenderUrl("not a URL");
    expect(openExternal).not.toHaveBeenCalled();
    openHtmlRenderUrl("https://environment.example/Chart.html");
    expect(openExternal).toHaveBeenCalledExactlyOnceWith("https://environment.example/Chart.html");
  });
  it("frames the page sandboxed, without a referrer, themed from its first paint", () => {
    const markup = renderToStaticMarkup(
      <HtmlRenderDocument
        src="https://environment.example/api/assets/token/Chart.html#stale"
        title="Chart"
      />,
    );

    expect(markup).toContain('sandbox="allow-scripts allow-forms"');
    expect(markup).not.toContain("allow-same-origin");
    expect(markup).not.toContain("allow-popups");
    expect(markup).toContain('referrerPolicy="no-referrer"');
    expect(markup).toContain('loading="lazy"');
    expect(markup).toContain(
      `src="https://environment.example/api/assets/token/Chart.html${htmlRenderThemeFragment(theme)}"`,
    );
  });

  it("opens only a valid link from the focused frame during user activation and replies to it", async () => {
    await mount();
    post(link());
    expect(openExternal).toHaveBeenCalledExactlyOnceWith("https://example.com/chart");
    expect(frame.contentWindow.postMessage).toHaveBeenLastCalledWith(
      { jsonrpc: "2.0", id: 1, result: {} },
      "*",
    );
  });

  it("rejects other sources, malformed messages, unsafe schemes, and missing focus or activation", async () => {
    await mount();
    post(link(), {});
    post({ ...link(), method: "other" });
    post({ ...link(), id: null });
    post(link("javascript:alert(1)"));
    post(link("file:///etc/passwd"));
    focus.activeElement = null;
    post(link());
    focus.activeElement = frame;
    activation.userActivation = { isActive: false };
    post(link());
    delete activation.userActivation;
    post(link());
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("listens for valid heights before load and removes both message listeners on unmount", async () => {
    const onContentHeight = vi.fn();
    await mount({ onContentHeight });
    const size = (height: unknown) => ({
      jsonrpc: "2.0",
      method: "ui/notifications/size-changed",
      params: { height },
    });
    post(size(412), {});
    post(size(-1));
    post(size(Infinity));
    post(size("412"));
    post(size(412));
    expect(onContentHeight).toHaveBeenCalledExactlyOnceWith(412);
    await act(async () => renderer?.unmount());
    post(size(500));
    post(link());
    expect(onContentHeight).toHaveBeenCalledTimes(1);
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("keeps the first src during theme updates and posts the latest theme again after load", async () => {
    const onLoad = vi.fn();
    await mount({ onLoad });
    const src = renderer!.root.findByType("iframe").props.src;
    activeTheme = htmlRenderTheme(Pathway_CODE_LIGHT_THEME_COLORS, "light");
    await act(async () =>
      renderer!.update(
        <HtmlRenderDocument
          src="https://environment.example/new-token/Chart.html"
          title="Chart"
          onLoad={onLoad}
        />,
      ),
    );
    expect(renderer!.root.findByType("iframe").props.src).toBe(src);
    expect(frame.contentWindow.postMessage).toHaveBeenLastCalledWith(
      htmlRenderThemeMessage(activeTheme),
      "*",
    );
    frame.contentWindow.postMessage.mockClear();
    await act(async () => renderer!.root.findByType("iframe").props.onLoad());
    expect(onLoad).toHaveBeenCalledTimes(1);
    expect(frame.contentWindow.postMessage).toHaveBeenLastCalledWith(
      htmlRenderThemeMessage(activeTheme),
      "*",
    );
  });
  it("puts the page on the surface hosting the frame, not the palette canvas", async () => {
    let surface = "#181818";
    vi.stubGlobal("getComputedStyle", () => ({ getPropertyValue: () => ` ${surface}` }));
    const onSurface = (background: string) => ({
      ...activeTheme,
      variables: { ...activeTheme.variables, "--background": background },
    });
    await mount();
    expect(renderer!.root.findByType("iframe").props.src).toBe(
      `https://environment.example/Chart.html${htmlRenderThemeFragment(onSurface("#181818"))}`,
    );
    expect(frame.contentWindow.postMessage).toHaveBeenLastCalledWith(
      htmlRenderThemeMessage(onSurface("#181818")),
      "*",
    );

    // A theme change repaints the host first, then reaches the frame.
    surface = "#fdf7fd";
    activeTheme = htmlRenderTheme(Pathway_CODE_LIGHT_THEME_COLORS, "light");
    const src = renderer!.root.findByType("iframe").props.src;
    await act(async () =>
      renderer!.update(
        <HtmlRenderDocument src="https://environment.example/Chart.html" title="Chart" />,
      ),
    );
    expect(renderer!.root.findByType("iframe").props.src).toBe(src);
    expect(frame.contentWindow.postMessage).toHaveBeenLastCalledWith(
      htmlRenderThemeMessage(onSurface("#fdf7fd")),
      "*",
    );
  });
});
