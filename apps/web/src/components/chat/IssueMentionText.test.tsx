import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { describe, expect, it, vi } from "vite-plus/test";

// The real Link needs a live router. This stand-in records where it was asked to go, which is the
// whole point of using it: modifier and middle clicks, and the href the current history spells, are
// the router's job rather than something this file hand-rolls.
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    search,
    children,
    ...props
  }: {
    readonly to: string;
    readonly search: { readonly issue?: string };
    readonly children: ReactNode;
  }) => (
    <a data-to={to} data-issue={search.issue} {...props}>
      {children}
    </a>
  ),
}));

import { Link } from "@tanstack/react-router";

import { renderSkillInlineMarkdownChildren } from "./SkillInlineText";
import {
  IssueMentionLink,
  issueMentionSignature,
  parseIssueMentionSignature,
  renderIssueMentionMarkdownChildren,
  type IssueMentionIndex,
} from "./IssueMentionText";
import { inlineChildrenComponents } from "./markdownInlineChildren";

const ISSUES: IssueMentionIndex = new Map([
  ["ISS-30", { key: "ISS-30", title: "Link issue mentions in chat" }],
  ["ISS-31", { key: "ISS-31", title: "Plural issues panel" }],
  ["PAT-9", { key: "PAT-9", title: "" }],
]);

const SKILLS = [{ name: "code-review", displayName: "Code Review" }];

function componentsFor(
  issuesByKey: IssueMentionIndex,
  isStreaming = false,
  skills: ReadonlyArray<{ name: string; displayName: string }> = [],
): Components {
  // Mirrors how ChatMarkdown composes the two passes, including the custom `a` and `code`
  // overrides: with components in play a child's type is a function, so the walkers have to read
  // the hast node to know what tag they are looking at.
  const render = (children: ReactNode) =>
    renderSkillInlineMarkdownChildren(
      renderIssueMentionMarkdownChildren(children, { issuesByKey, isStreaming }),
      skills,
    );
  return {
    ...inlineChildrenComponents(render),
    p: ({ node: _node, children, ...props }) => <p {...props}>{render(children)}</p>,
    li: ({ node: _node, children, ...props }) => <li {...props}>{render(children)}</li>,
    a: ({ node: _node, children, ...props }) => <a {...props}>{children}</a>,
    code: ({ node: _node, children, ...props }) => <code {...props}>{children}</code>,
  };
}

function renderMarkdown(
  markdown: string,
  issuesByKey: IssueMentionIndex = ISSUES,
  isStreaming = false,
  skills: ReadonlyArray<{ name: string; displayName: string }> = [],
): string {
  return renderToStaticMarkup(
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={componentsFor(issuesByKey, isStreaming, skills)}
    >
      {markdown}
    </ReactMarkdown>,
  );
}

/** The intrinsic path: no `a`/`code` overrides, so those children arrive as plain tag strings. */
function renderIntrinsicMarkdown(markdown: string): string {
  const render = (children: ReactNode) =>
    renderIssueMentionMarkdownChildren(children, { issuesByKey: ISSUES, isStreaming: false });
  return renderToStaticMarkup(
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        p: ({ node: _node, children, ...props }) => <p {...props}>{render(children)}</p>,
        li: ({ node: _node, children, ...props }) => <li {...props}>{render(children)}</li>,
      }}
    >
      {markdown}
    </ReactMarkdown>,
  );
}

describe("renderIssueMentionMarkdownChildren", () => {
  it("links a mention in a paragraph", () => {
    const html = renderMarkdown("Fixed by ISS-30 yesterday.");

    expect(html).toContain('data-issue="ISS-30"');
    expect(html).toContain(">ISS-30</a>");
    expect(html).toContain("Fixed by ");
    expect(html).toContain(" yesterday.");
  });

  it("links a mention inside a list item", () => {
    const html = renderMarkdown("- follow up on ISS-31");

    expect(html).toContain("<li>");
    expect(html).toContain('data-issue="ISS-31"');
  });

  it("links a mention in a heading", () => {
    const html = renderMarkdown("## ISS-30 is done");

    expect(html).toContain("<h2>");
    expect(html).toContain('data-issue="ISS-30"');
    expect(html).toContain(" is done");
  });

  it("links a mention in a table cell", () => {
    const html = renderMarkdown("| Issue | State |\n| --- | --- |\n| ISS-31 | shipped |");

    expect(html).toContain("<td>");
    expect(html).toContain('data-issue="ISS-31"');
    expect(html).toContain("shipped");
  });

  it("leaves an unknown key in a heading plain", () => {
    const html = renderMarkdown("## ISS-99 is done");

    expect(html).not.toContain("<a");
    expect(html).toContain("ISS-99");
  });

  it("leaves sentence punctuation outside the link", () => {
    const html = renderMarkdown("Fixed ISS-30.");

    expect(html).toContain(">ISS-30</a>");
    expect(html).not.toContain(">ISS-30.</a>");
    expect(html).toContain(".</p>");
  });

  it("links every mention, including a key that repeats", () => {
    const html = renderMarkdown("ISS-30 blocks ISS-31, so ISS-30 goes first.");

    expect(html.split('data-issue="ISS-30"')).toHaveLength(3);
    expect(html).toContain('data-issue="ISS-31"');
  });

  it("leaves a key the tracker does not know as plain text", () => {
    const html = renderMarkdown("Encoded as UTF-8, tracked in ISS-99.");

    expect(html).not.toContain("<a");
    expect(html).toContain("UTF-8");
    expect(html).toContain("ISS-99");
  });

  it("leaves inline code and fenced code alone", () => {
    expect(renderMarkdown("Run `git log ISS-30` first.")).not.toContain("<a");
    expect(renderMarkdown("```\nISS-30\n```")).not.toContain("<a");
    expect(renderIntrinsicMarkdown("Run `git log ISS-30` first.")).not.toContain("<a");
  });

  it("does not rewrite an existing markdown link", () => {
    const html = renderMarkdown("See [ISS-30](https://example.com/x).");

    expect(html).toContain('href="https://example.com/x"');
    expect(html).not.toContain('data-issue="ISS-30"');
    expect(renderIntrinsicMarkdown("See [ISS-30](https://example.com/x).")).not.toContain(
      'data-issue="ISS-30"',
    );
  });

  it("does not linkify a key inside an autolinked url", () => {
    const html = renderMarkdown("https://example.com/ISS-30");

    expect(html).not.toContain('data-issue="ISS-30"');
    expect(html).toContain('href="https://example.com/ISS-30"');
  });

  it("keeps the skill chip in a line that also mentions an issue", () => {
    const html = renderMarkdown("Run $code-review on ISS-30", ISSUES, false, SKILLS);

    expect(html).toContain("Code Review");
    expect(html).toContain('data-issue="ISS-30"');
  });

  it("leaves a still-streaming message as plain text", () => {
    const html = renderMarkdown("Fixed by ISS-30 yesterday.", ISSUES, true);

    expect(html).not.toContain("<a");
    expect(html).toContain("ISS-30");
  });

  it("returns children untouched when no key in the message resolved", () => {
    const children: ReactNode = "Fixed ISS-30.";

    expect(
      renderIssueMentionMarkdownChildren(children, { issuesByKey: new Map(), isStreaming: false }),
    ).toBe(children);
  });
});

describe("IssueMentionLink", () => {
  function renderLink(issueKey: string, title: string) {
    return IssueMentionLink({ issueKey, title }) as ReactElement<{
      readonly to: string;
      readonly search: { readonly issue: string };
      readonly onClick?: unknown;
      readonly "aria-label": string;
      readonly "data-markdown-copy": string;
    }>;
  }

  // Navigation is declared to the router rather than intercepted: an onClick that unconditionally
  // calls preventDefault swallows Cmd/Ctrl/Shift and middle clicks, and a hand-built href is wrong
  // wherever the app runs on hash history.
  it("declares the issue route to the router instead of intercepting the click", () => {
    const link = renderLink("ISS-30", "Link issue mentions in chat");

    expect(link.type).toBe(Link);
    expect(link.props.to).toBe("/issues");
    expect(link.props.search).toEqual({ issue: "ISS-30" });
    expect(link.props.onClick).toBeUndefined();
  });

  it("names the issue for screen readers and re-emits the raw key on copy", () => {
    const link = renderLink("ISS-30", "Link issue mentions in chat");

    expect(link.props["aria-label"]).toBe("Issue ISS-30: Link issue mentions in chat");
    expect(link.props["data-markdown-copy"]).toBe("ISS-30");
  });

  it("falls back to the key alone when the issue has no title", () => {
    expect(renderLink("PAT-9", "").props["aria-label"]).toBe("Issue PAT-9");
  });
});

describe("issueMentionSignature", () => {
  const store: IssueMentionIndex = new Map([
    ["ISS-30", { key: "ISS-30", title: "Link issue mentions in chat" }],
    ["ISS-31", { key: "ISS-31", title: "Plural issues panel" }],
    ["PAT-9", { key: "PAT-9", title: "Untouched by this message" }],
  ]);

  it("ignores issues the message does not mention", () => {
    const before = issueMentionSignature(["ISS-30"], store);
    const after = issueMentionSignature(
      ["ISS-30"],
      new Map([...store, ["PAT-9", { key: "PAT-9", title: "Renamed" }]]),
    );

    expect(after).toBe(before);
  });

  it("changes when a mentioned issue's title changes", () => {
    const before = issueMentionSignature(["ISS-30"], store);
    const after = issueMentionSignature(
      ["ISS-30"],
      new Map([...store, ["ISS-30", { key: "ISS-30", title: "Renamed" }]]),
    );

    expect(after).not.toBe(before);
  });

  it("changes when a mentioned key starts resolving", () => {
    expect(issueMentionSignature(["ISS-99"], store)).not.toBe(
      issueMentionSignature(
        ["ISS-99"],
        new Map([...store, ["ISS-99", { key: "ISS-99", title: "Filed later" }]]),
      ),
    );
  });

  it("round-trips into the index the renderer reads", () => {
    const index = parseIssueMentionSignature(issueMentionSignature(["ISS-30", "ISS-99"], store));

    expect([...index.keys()]).toEqual(["ISS-30"]);
    expect(index.get("ISS-30")).toEqual({
      key: "ISS-30",
      title: "Link issue mentions in chat",
    });
  });

  it("hands back one shared empty index when nothing resolved", () => {
    expect(parseIssueMentionSignature(issueMentionSignature(["ISS-99"], store))).toBe(
      parseIssueMentionSignature(issueMentionSignature([], store)),
    );
  });
});
