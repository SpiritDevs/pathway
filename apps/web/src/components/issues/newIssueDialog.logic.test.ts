import { describe, expect, it } from "vite-plus/test";

import { canResizeNewIssueDialog } from "./newIssueDialog.logic";

describe("new issue dialog sizing", () => {
  it("offers resizing when the compact dialog is shorter than the 90% viewport cap", () => {
    expect(canResizeNewIssueDialog({ dialogHeight: 260, viewportHeight: 1_000 })).toBe(true);
  });

  it("hides resizing when content has already grown the dialog to its cap", () => {
    expect(canResizeNewIssueDialog({ dialogHeight: 900, viewportHeight: 1_000 })).toBe(false);
  });

  it("ignores sub-pixel differences at the cap", () => {
    expect(canResizeNewIssueDialog({ dialogHeight: 899.5, viewportHeight: 1_000 })).toBe(false);
  });
});
