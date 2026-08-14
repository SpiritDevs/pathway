import { ProviderDriverKind } from "@spiritdevs/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { describe, expect, it } from "vite-plus/test";

import {
  ISSUE_AGENT_MENTION_PROTOCOL,
  issueAgentMentionLabel,
  renderIssueAgentMentionAnchor,
} from "./IssueAgentMentionPill";

// The same two gates `ChatMarkdown` opens for the scheme. Both matter, and separately: the
// sanitizer drops an unlisted protocol's href, and react-markdown's default url transform drops it
// again afterwards — so a pipeline missing either one renders a bare, hrefless link.
const SANITIZE_SCHEMA = {
  ...defaultSchema,
  protocols: {
    ...defaultSchema.protocols,
    href: [...(defaultSchema.protocols?.href ?? []), "file", ISSUE_AGENT_MENTION_PROTOCOL],
  },
} satisfies Parameters<typeof rehypeSanitize>[0];

const urlTransform = (href: string) =>
  href.startsWith("mention:agent:") ? href : defaultUrlTransform(href);

/** Mirrors `ChatMarkdown`'s anchor component: the mention check runs before anything href-keyed. */
const components: Components = {
  a: ({ node: _node, href, children, ...props }) =>
    renderIssueAgentMentionAnchor(href, children, props.className) ?? (
      <a href={href} {...props}>
        {children}
      </a>
    ),
};

function renderMarkdown(markdown: string, transform: (href: string) => string = urlTransform) {
  return renderToStaticMarkup(
    <ReactMarkdown
      components={components}
      rehypePlugins={[rehypeRaw, [rehypeSanitize, SANITIZE_SCHEMA]]}
      remarkPlugins={[remarkGfm]}
      urlTransform={transform}
    >
      {markdown}
    </ReactMarkdown>,
  );
}

describe("agent mention pill through the markdown pipeline", () => {
  it("renders a persisted mention as a pill rather than a link", () => {
    const html = renderMarkdown("Thanks [@Claude](mention:agent:claudeAgent), see above.");

    expect(html).toContain('data-mention-provider="claudeAgent"');
    expect(html).toContain('data-markdown-copy="@Claude"');
    expect(html).toContain("@Claude");
    expect(html).not.toContain("<a");
    expect(html).toContain("Thanks ");
    expect(html).toContain(", see above.");
  });

  it("labels the pill from the configured provider, not the words that were typed", () => {
    // The body carries whatever somebody wrote; the client names the agent it actually knows.
    expect(renderMarkdown("[@claude 2](mention:agent:claudeAgent)")).toContain("@Claude");
  });

  it("needs the url transform bypass: the default one empties the href", () => {
    const html = renderMarkdown("[@Claude](mention:agent:claudeAgent)", defaultUrlTransform);

    expect(html).not.toContain("data-mention-provider");
    expect(html).toContain("@Claude");
  });

  it("leaves ordinary links alone", () => {
    const html = renderMarkdown("See [the docs](https://example.com/claude).");

    expect(html).toContain('href="https://example.com/claude"');
    expect(html).not.toContain("data-mention-provider");
  });

  it("leaves the mention syntax inside code as code", () => {
    const html = renderMarkdown("Write `[@Claude](mention:agent:claudeAgent)` to mention it.");

    expect(html).toContain("<code>");
    expect(html).not.toContain("data-mention-provider");
  });
});

describe("renderIssueAgentMentionAnchor", () => {
  it("declines every href that is not a mention", () => {
    expect(renderIssueAgentMentionAnchor(undefined, "x")).toBeNull();
    expect(renderIssueAgentMentionAnchor("https://example.com", "x")).toBeNull();
    expect(renderIssueAgentMentionAnchor("mention:agent:", "x")).toBeNull();
    expect(renderIssueAgentMentionAnchor("mention:issue:ISS-30", "x")).toBeNull();
  });
});

describe("issueAgentMentionLabel", () => {
  it("prefers the provider's own label", () => {
    expect(issueAgentMentionLabel(ProviderDriverKind.make("claudeAgent"), "@whatever")).toBe(
      "Claude",
    );
  });

  it("falls back to the written words for a provider this client does not know", () => {
    const unknown = ProviderDriverKind.make("someFutureAgent");

    expect(issueAgentMentionLabel(unknown, "@Future Agent")).toBe("Future Agent");
    expect(issueAgentMentionLabel(unknown, "  ")).toBe("someFutureAgent");
  });
});
