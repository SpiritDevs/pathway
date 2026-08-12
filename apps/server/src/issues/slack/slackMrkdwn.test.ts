import { describe, expect, it } from "@effect/vitest";

import {
  markdownToSlackMrkdwn,
  slackMrkdwnToMarkdown,
  slackTitleFromText,
  truncateForSlack,
} from "./slackMrkdwn.ts";

describe("slackMrkdwnToMarkdown", () => {
  it("widens Slack's single-delimiter emphasis to Markdown's", () => {
    expect(slackMrkdwnToMarkdown("*bold* and _italic_ and ~gone~")).toBe(
      "**bold** and *italic* and ~~gone~~",
    );
  });

  it("leaves arithmetic and snake_case alone, as Slack does", () => {
    expect(slackMrkdwnToMarkdown("2 * 3 * 4 in issue_tracker_service")).toBe(
      "2 * 3 * 4 in issue_tracker_service",
    );
  });

  it("turns Slack links into Markdown links and bare links into text", () => {
    expect(slackMrkdwnToMarkdown("see <https://example.com/x|the docs> now")).toBe(
      "see [the docs](https://example.com/x) now",
    );
    expect(slackMrkdwnToMarkdown("see <https://example.com/x>")).toBe("see https://example.com/x");
  });

  it("resolves mentions through the names it was handed, and keeps the id when it was not", () => {
    const userNames = new Map([["U123", "Ann Rivers"]]);
    expect(slackMrkdwnToMarkdown("<@U123> and <@U999> ping", { userNames })).toBe(
      "@Ann Rivers and @U999 ping",
    );
  });

  it("renders channels, broadcasts and user groups", () => {
    expect(slackMrkdwnToMarkdown("<#C1|support> <!here> <!subteam^S1|@design>")).toBe(
      "#support @here @design",
    );
  });

  it("unescapes Slack's three entities, and only those three", () => {
    expect(slackMrkdwnToMarkdown("a &amp; b &lt;c&gt; &quot;d&quot;")).toBe(
      "a & b <c> &quot;d&quot;",
    );
  });

  it("reads references before unescaping, so a quoted angle bracket stays one", () => {
    expect(slackMrkdwnToMarkdown("use &lt;https://example.com|label&gt; literally")).toBe(
      "use <https://example.com|label> literally",
    );
  });

  it("leaves code spans and fenced blocks exactly as they were", () => {
    const input = "before `*not bold*` after\n```\n_keep_ *this* <@U1>\n```\n*bold*";
    expect(slackMrkdwnToMarkdown(input)).toBe(
      "before `*not bold*` after\n```\n_keep_ *this* <@U1>\n```\n**bold**",
    );
  });

  it("unescapes entities inside code, because Slack escapes them there too", () => {
    expect(slackMrkdwnToMarkdown("`a &lt; b`")).toBe("`a < b`");
  });
});

describe("markdownToSlackMrkdwn", () => {
  it("narrows Markdown emphasis to Slack's", () => {
    expect(markdownToSlackMrkdwn("**bold** and *italic* and ~~gone~~")).toBe(
      "*bold* and _italic_ and ~gone~",
    );
  });

  it("turns Markdown links into Slack links and drops images to their alt text", () => {
    expect(markdownToSlackMrkdwn("[docs](https://example.com/x) ![shot](https://img/1.png)")).toBe(
      "<https://example.com/x|docs> shot",
    );
  });

  it("escapes the three entities before building its own angle brackets", () => {
    expect(markdownToSlackMrkdwn("a & b <c> [x](https://e/?a=1&b=2)")).toBe(
      "a &amp; b &lt;c&gt; <https://e/?a=1&amp;b=2|x>",
    );
  });

  it("renders headings as bold, since Slack has no heading", () => {
    expect(markdownToSlackMrkdwn("## Steps to reproduce\nopen the app")).toBe(
      "*Steps to reproduce*\nopen the app",
    );
  });

  it("leaves code alone but for the entities Slack requires escaped", () => {
    expect(markdownToSlackMrkdwn("```\nif (a **b**) {}\n```")).toBe("```\nif (a **b**) {}\n```");
  });
});

describe("slackTitleFromText", () => {
  it("takes the first line with anything on it", () => {
    expect(slackTitleFromText("\n\n  The build is red  \nmore detail here")).toBe(
      "The build is red",
    );
  });

  it("strips the bullet, quote or heading a first line opens with", () => {
    expect(slackTitleFromText("- login is broken")).toBe("login is broken");
    expect(slackTitleFromText("> login is broken")).toBe("login is broken");
    expect(slackTitleFromText("### login is broken")).toBe("login is broken");
  });

  it("cuts on a word boundary and marks the cut", () => {
    const title = slackTitleFromText(`${"word ".repeat(40)}end`, 40);
    expect(title.length).toBeLessThanOrEqual(40);
    expect(title.endsWith("…")).toBe(true);
    expect(title.includes("wor…")).toBe(false);
  });

  it("answers empty for a message with no text, leaving the fallback to the tracker", () => {
    expect(slackTitleFromText("   \n\n ")).toBe("");
  });
});

describe("truncateForSlack", () => {
  it("passes short text through untouched", () => {
    expect(truncateForSlack("short", 10)).toBe("short");
  });

  it("cuts long text and marks it", () => {
    expect(truncateForSlack("abcdefghij", 5)).toBe("abcd…");
  });
});
