import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { PreviewChromeRow, settledAddress } from "./PreviewChromeRow";

describe("PreviewChromeRow", () => {
  it("shows just the site while the address bar is not focused, with the full URL on hover", () => {
    const markup = renderToStaticMarkup(
      <PreviewChromeRow
        url="https://example.com/dashboard?mode=edit&tab=1#notes"
        loading={false}
        canGoBack={false}
        canGoForward={false}
        refreshDisabled={false}
        onBack={vi.fn()}
        onForward={vi.fn()}
        onRefresh={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );

    expect(markup).toContain('value="example.com"');
    expect(markup).toContain('title="https://example.com/dashboard?mode=edit&amp;tab=1#notes"');
  });

  it("drops www but keeps ports, and leaves non-web addresses whole", () => {
    expect(settledAddress("https://www.google.com/search?q=pathway")).toBe("google.com");
    expect(settledAddress("http://localhost:3000/dashboard")).toBe("localhost:3000");
    expect(settledAddress("file:///Users/me/index.html")).toBe("file:///Users/me/index.html");
    expect(settledAddress("")).toBe("");
  });
});
