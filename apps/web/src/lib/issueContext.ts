export interface IssueContextSelection {
  readonly id: string;
  readonly key: string;
  readonly title: string;
  readonly url: string;
}

export type IssueContextDraft = IssueContextSelection;

export interface ExtractedIssueContexts {
  readonly promptText: string;
  readonly contexts: IssueContextSelection[];
}

const TRAILING_ISSUE_CONTEXT_BLOCK_PATTERN =
  /\n*<issue_context>\n([\s\S]*?)\n<\/issue_context>\s*$/;
const ISSUE_TAG_PATTERN = /<issue\b([^>]*)\/>/g;
const ISSUE_ATTRIBUTE_PATTERN = /([a-zA-Z][a-zA-Z0-9_-]*)="([^"]*)"/g;

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function unescapeAttribute(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

function parseAttributes(raw: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const match of raw.matchAll(ISSUE_ATTRIBUTE_PATTERN)) {
    attributes[match[1]!] = unescapeAttribute(match[2] ?? "");
  }
  return attributes;
}

export function normalizeIssueContext(
  context: IssueContextSelection,
): IssueContextSelection | null {
  const id = context.id.trim();
  const key = context.key.trim();
  const title = context.title.trim();
  const url = context.url.trim();
  if (id.length === 0 || key.length === 0 || title.length === 0 || url.length === 0) {
    return null;
  }
  return { id, key, title, url };
}

export function normalizeIssueContexts(
  contexts: ReadonlyArray<IssueContextSelection>,
): IssueContextSelection[] {
  const ids = new Set<string>();
  const normalized: IssueContextSelection[] = [];
  for (const context of contexts) {
    const next = normalizeIssueContext(context);
    if (next === null || ids.has(next.id)) continue;
    ids.add(next.id);
    normalized.push(next);
  }
  return normalized;
}

export function buildIssueContextBlock(rawContexts: ReadonlyArray<IssueContextSelection>): string {
  const contexts = normalizeIssueContexts(rawContexts);
  if (contexts.length === 0) return "";
  const keys = contexts.map((context) => context.key).join(", ");
  const issueTags = contexts.map(
    (context) =>
      `<issue id="${escapeAttribute(context.id)}" key="${escapeAttribute(context.key)}" title="${escapeAttribute(context.title)}" url="${escapeAttribute(context.url)}" />`,
  );
  return [
    "<issue_context>",
    ...issueTags,
    "",
    `I want to talk through ${keys} before deciding what to do. Start by reading each issue with Pathway MCP's \`issues_get\` tool and link this thread to each one with \`issues_link_thread\`. Use each issue's own project as its context, even when the selection spans several projects; treat an issue without a project as a global question. Answer my questions and help me compare, clarify, and investigate the selected issues. Do not begin implementation unless I explicitly ask. As we reach useful conclusions, keep the tickets current with Pathway MCP's \`issues_update\` and \`issues_comment\` tools. Use only the Pathway MCP issue tools for these issues; do not use Linear or another external issue tracker.`,
    "</issue_context>",
  ].join("\n");
}

export function appendIssueContextsToPrompt(
  prompt: string,
  contexts: ReadonlyArray<IssueContextSelection>,
): string {
  const block = buildIssueContextBlock(contexts);
  if (block.length === 0) return prompt;
  const trimmedPrompt = prompt.trim();
  return trimmedPrompt.length > 0 ? `${trimmedPrompt}\n\n${block}` : block;
}

export function extractTrailingIssueContexts(prompt: string): ExtractedIssueContexts {
  const match = TRAILING_ISSUE_CONTEXT_BLOCK_PATTERN.exec(prompt);
  if (!match) return { promptText: prompt, contexts: [] };
  const contexts: IssueContextSelection[] = [];
  for (const issueMatch of (match[1] ?? "").matchAll(ISSUE_TAG_PATTERN)) {
    const attributes = parseAttributes(issueMatch[1] ?? "");
    const context = normalizeIssueContext({
      id: attributes.id ?? "",
      key: attributes.key ?? "",
      title: attributes.title ?? "",
      url: attributes.url ?? "",
    });
    if (context !== null) contexts.push(context);
  }
  return {
    promptText: prompt.slice(0, match.index).replace(/\n+$/, ""),
    contexts: normalizeIssueContexts(contexts),
  };
}
