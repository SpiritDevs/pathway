import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { InlineRightPanelPresence } from "./InlineRightPanelPresence";

describe("InlineRightPanelPresence", () => {
  it("uses its fixed panel width by default", () => {
    const html = renderToStaticMarkup(
      <InlineRightPanelPresence open>
        <div>Panel</div>
      </InlineRightPanelPresence>,
    );

    expect(html).toContain("shrink-0");
  });
});
