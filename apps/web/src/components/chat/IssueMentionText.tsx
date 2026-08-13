import { Link } from "@tanstack/react-router";
import { findIssueKeyMentions, type Issue } from "@t3tools/contracts";
import { Children, cloneElement, isValidElement, type ReactNode } from "react";

/** Key → issue, narrowed to the keys one message mentions. Only keys present here become links. */
export type IssueMentionIndex = ReadonlyMap<string, Pick<Issue, "key" | "title">>;

export interface IssueMentionContext {
  readonly issuesByKey: IssueMentionIndex;
  /**
   * While a message is still arriving its last key is half-typed, and a link that appears,
   * disappears, and reappears as characters land reads as a glitch. Linkify finished text only.
   */
  readonly isStreaming: boolean;
}

const EMPTY_ISSUE_MENTION_INDEX: IssueMentionIndex = new Map();

/**
 * Everything a message's mentions render from, as one string. The caller memoises its index on
 * this, so an issue write that touches no key the message mentions changes neither the index's
 * identity nor the markdown components built from it, and the message is not re-parsed.
 */
export function issueMentionSignature(
  candidateKeys: ReadonlyArray<string>,
  issuesByKey: IssueMentionIndex,
): string {
  const resolved: Array<readonly [string, string]> = [];
  for (const key of candidateKeys) {
    const issue = issuesByKey.get(key);
    if (issue !== undefined) resolved.push([issue.key, issue.title]);
  }
  return JSON.stringify(resolved);
}

/** The index a signature describes. `issueMentionSignature` round-trips through this. */
export function parseIssueMentionSignature(signature: string): IssueMentionIndex {
  const resolved = JSON.parse(signature) as ReadonlyArray<readonly [string, string]>;
  if (resolved.length === 0) return EMPTY_ISSUE_MENTION_INDEX;
  return new Map(resolved.map(([key, title]) => [key, { key, title }]));
}

/**
 * One mention, rendered as prose rather than a chip: it stands in for the key the author typed.
 *
 * A router `Link` rather than a hand-built anchor, so the href is whatever this client's history
 * makes it — the desktop app runs on hash history, where `/issues?issue=KEY` is a dead URL — and so
 * Cmd/Ctrl/Shift and middle clicks still open a tab instead of being swallowed. `data-markdown-copy`
 * gives the copy handler the raw key back, so copying rendered chat text yields what was written.
 */
export function IssueMentionLink(props: { readonly issueKey: string; readonly title: string }) {
  const issueKey = props.issueKey;
  return (
    <Link
      to="/issues"
      search={{ issue: issueKey }}
      aria-label={
        props.title.length > 0 ? `Issue ${issueKey}: ${props.title}` : `Issue ${issueKey}`
      }
      data-markdown-copy={issueKey}
    >
      {issueKey}
    </Link>
  );
}

/**
 * One markdown text node split into the plain text around its mentions and a link per mention.
 * Returns null when no candidate in the text names an issue the tracker knows: the key was quoted,
 * not referenced, and the caller passes the original string along untouched.
 */
function spliceIssueMentions(
  text: string,
  issuesByKey: IssueMentionIndex,
): Array<ReactNode> | null {
  let nodes: Array<ReactNode> | null = null;
  let cursor = 0;

  for (const mention of findIssueKeyMentions(text)) {
    const issue = issuesByKey.get(mention.key);
    if (issue === undefined) continue;
    nodes ??= [];
    if (mention.index > cursor) nodes.push(text.slice(cursor, mention.index));
    nodes.push(
      <IssueMentionLink
        key={`${mention.index}:${mention.key}`}
        issueKey={issue.key}
        title={issue.title}
      />,
    );
    cursor = mention.index + mention.key.length;
  }

  if (nodes === null) return null;
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

/**
 * Links the issue mentions in already-rendered markdown children.
 *
 * A matched string is spliced into plain strings and links rather than replaced by one wrapper
 * element, so `renderSkillInlineMarkdownChildren`, which runs afterwards, still sees real strings to
 * scan for `$skill` tokens. Code and links are refused: a key inside `code` or an existing anchor is
 * quoted, not written as a reference.
 */
export function renderIssueMentionMarkdownChildren(
  children: ReactNode,
  ctx: IssueMentionContext,
): ReactNode {
  const issuesByKey = ctx.issuesByKey;
  if (ctx.isStreaming || issuesByKey.size === 0) return children;
  return Children.map(children, (child) => {
    if (typeof child === "string") {
      return spliceIssueMentions(child, issuesByKey) ?? child;
    }
    if (!isValidElement<{ children?: ReactNode; node?: { tagName?: string } }>(child)) {
      return child;
    }
    // Custom react-markdown components replace the intrinsic type, so also
    // check the hast node they carry.
    const markdownTagName = typeof child.type === "string" ? child.type : child.props.node?.tagName;
    if (markdownTagName === "code" || markdownTagName === "a") {
      return child;
    }
    if (!("children" in child.props)) {
      return child;
    }
    return cloneElement(
      child,
      undefined,
      renderIssueMentionMarkdownChildren(child.props.children, ctx),
    );
  });
}
