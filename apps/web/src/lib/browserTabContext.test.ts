import { describe, expect, it } from "vite-plus/test";

import {
  appendBrowserTabContextToPrompt,
  extractTrailingBrowserTabContext,
} from "./browserTabContext";
import { appendIssueContextsToPrompt, extractTrailingIssueContexts } from "./issueContext";

const tab = { tabId: "tab-1", url: "https://www.theverge.com/", title: "The  Verge\n" };

describe("browser tab context", () => {
  it("round-trips the tab after the prompt", () => {
    const text = appendBrowserTabContextToPrompt("whats on this page?", tab);
    expect(text).toContain("Tab id: tab-1");
    expect(extractTrailingBrowserTabContext(text)).toEqual({
      promptText: "whats on this page?",
      context: { tabId: "tab-1", url: "https://www.theverge.com/", title: "The Verge" },
    });
  });

  it("leaves the prompt alone without a tab", () => {
    expect(appendBrowserTabContextToPrompt("hi", null)).toBe("hi");
    expect(extractTrailingBrowserTabContext("hi")).toEqual({ promptText: "hi", context: null });
  });

  it("strips first so earlier context blocks still parse", () => {
    const withIssue = appendIssueContextsToPrompt("fix it", [
      { id: "i1", key: "PW-1", title: "Bug", url: "https://example.com/i1" },
    ]);
    const extracted = extractTrailingBrowserTabContext(
      appendBrowserTabContextToPrompt(withIssue, tab),
    );
    expect(extractTrailingIssueContexts(extracted.promptText).contexts).toHaveLength(1);
  });
});
