import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ComposerPendingIssueContextChip } from "./ComposerPendingIssueContexts";

describe("ComposerPendingIssueContextChip", () => {
  it("shows a compact issue label with an accessible remove action", () => {
    const html = renderToStaticMarkup(
      <ComposerPendingIssueContextChip
        context={{
          id: "issue-1",
          key: "ISS-26",
          title: "Forward navigation doesn't re-enable",
          url: "pathway://app/issues?issue=ISS-26",
        }}
        onOpen={() => {}}
        onRemove={() => {}}
      />,
    );

    expect(html).toContain("ISS-26 Forward navigation doesn&#x27;t re-enable");
    expect(html).toContain('aria-label="Open ISS-26"');
    expect(html).toContain('aria-label="Remove ISS-26 from this discussion"');
    expect(html).not.toContain("issues_get");
  });
});
