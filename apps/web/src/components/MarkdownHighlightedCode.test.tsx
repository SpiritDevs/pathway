import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({ get: vi.fn<() => string | null>(() => null), request: vi.fn() }));
vi.mock("../lib/markdownHighlighting", () => ({
  markdownHighlightKey: (code: string, language: string, theme: string) =>
    `${code}:${language}:${theme}`,
  markdownHighlights: mocks,
}));
import { MarkdownHighlightedCode, MarkdownPlainCode } from "./ChatMarkdown";

afterEach(() => {
  vi.clearAllMocks();
  mocks.get.mockReturnValue(null);
});

it("reserves Shiki's line boxes, including empty and trailing lines, in plain code", () => {
  const html = renderToStaticMarkup(
    <MarkdownPlainCode className="language-ts" code={"first\r\n\nlast\n"} />,
  );
  expect(html).toBe(
    '<code class="language-ts"><span class="line">first</span>\n<span class="line"></span>\n<span class="line">last</span>\n<span class="line"></span></code>',
  );
});

it("uses cached HTML immediately without scheduling more work", async () => {
  mocks.get.mockReturnValue("<pre>cached</pre>");
  let root!: ReactTestRenderer;
  await act(async () => {
    root = create(
      <MarkdownHighlightedCode
        className="language-ts"
        code="cached"
        themeName="pierre-dark"
        fallback={<pre>plain</pre>}
      />,
    );
  });
  expect(root.root.findByType("div").props.dangerouslySetInnerHTML.__html).toBe(
    "<pre>cached</pre>",
  );
  expect(mocks.request).not.toHaveBeenCalled();
  await act(async () => root.unmount());
});

it("swaps code when another block fills the cache between render and its effect", async () => {
  function Fallback() {
    mocks.get.mockReturnValue("<pre>shared highlight</pre>");
    return <pre>plain</pre>;
  }
  mocks.request.mockReturnValue({
    result: Promise.resolve("<pre>shared highlight</pre>"),
    cancel: vi.fn(),
  });
  let root!: ReactTestRenderer;
  await act(async () => {
    root = create(
      <MarkdownHighlightedCode
        className="language-ts"
        code="shared"
        themeName="pierre-dark"
        fallback={<Fallback />}
      />,
    );
  });
  expect(root.root.findByType("div").props.dangerouslySetInnerHTML.__html).toBe(
    "<pre>shared highlight</pre>",
  );
  await act(async () => root.unmount());
});

it("renders plain code immediately and ignores a stale highlight after the code or theme changes", async () => {
  const results: Array<(html: string) => void> = [];
  const cancel = vi.fn();
  mocks.request.mockImplementation(() => ({
    result: new Promise<string>((resolve) => results.push(resolve)),
    cancel,
  }));
  let root!: ReactTestRenderer;
  await act(async () => {
    root = create(
      <MarkdownHighlightedCode
        className="language-ts"
        code="first\n"
        themeName="pierre-dark"
        fallback={
          <pre>
            <code>first{"\n"}</code>
          </pre>
        }
      />,
    );
  });
  expect(root.root.findByType("pre").findByType("code").children.join("")).toBe("first\n");
  await act(async () => {
    root.update(
      <MarkdownHighlightedCode
        className="language-ts"
        code="second\n"
        themeName="pierre-light"
        fallback={
          <pre>
            <code>second{"\n"}</code>
          </pre>
        }
      />,
    );
  });
  expect(cancel).toHaveBeenCalledTimes(1);
  await act(async () => {
    results[0]!("old HTML");
  });
  expect(root.root.findByType("pre").findByType("code").children.join("")).toBe("second\n");
  await act(async () => {
    results[1]!("new HTML");
  });
  expect(root.root.findByType("div").props.dangerouslySetInnerHTML).toEqual({ __html: "new HTML" });
  await act(async () => {
    root.unmount();
  });
  expect(cancel).toHaveBeenCalledTimes(2);
});
