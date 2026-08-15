import { describe, expect, it } from "vite-plus/test";

import {
  appendIssueContextsToPrompt,
  buildIssueContextBlock,
  extractTrailingIssueContexts,
  normalizeIssueContexts,
  type IssueContextSelection,
} from "./issueContext";

const ISSUE: IssueContextSelection = {
  id: "issue-1",
  key: "ISS-26",
  title: "Forward navigation doesn't re-enable",
  url: "pathway://app/issues?issue=ISS-26",
};

describe("issue composer context", () => {
  it("serializes issue references and keeps the user's prompt separate", () => {
    const prompt = appendIssueContextsToPrompt("Compare their root causes", [
      ISSUE,
      { ...ISSUE, id: "issue-2", key: "ISS-27", title: 'Modal <height> & "controls"' },
    ]);

    expect(prompt).toContain("Compare their root causes\n\n<issue_context>");
    expect(prompt).toContain('key="ISS-26"');
    expect(prompt).toContain('title="Modal &lt;height&gt; &amp; &quot;controls&quot;"');
    expect(prompt).toContain("reading each issue with Pathway MCP's `issues_get` tool");
    expect(prompt).toContain("Do not begin implementation unless I explicitly ask");

    expect(extractTrailingIssueContexts(prompt)).toEqual({
      promptText: "Compare their root causes",
      contexts: [
        ISSUE,
        { ...ISSUE, id: "issue-2", key: "ISS-27", title: 'Modal <height> & "controls"' },
      ],
    });
  });

  it("deduplicates invalid or repeated issue references", () => {
    expect(
      normalizeIssueContexts([
        ISSUE,
        { ...ISSUE, title: "Repeated title" },
        { ...ISSUE, id: "", key: "ISS-99" },
      ]),
    ).toEqual([ISSUE]);
    expect(buildIssueContextBlock([])).toBe("");
    expect(extractTrailingIssueContexts("Ordinary prompt")).toEqual({
      promptText: "Ordinary prompt",
      contexts: [],
    });
  });
});
