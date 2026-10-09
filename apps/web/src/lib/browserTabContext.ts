/** The Pathway browser tab the user is looking at while writing a message. */
export interface BrowserTabContext {
  readonly tabId: string;
  readonly url: string;
  readonly title: string;
}

export interface ExtractedBrowserTabContext {
  readonly promptText: string;
  readonly context: BrowserTabContext | null;
}

const TRAILING_BROWSER_TAB_BLOCK_PATTERN = /\n*<browser_tab>\n([\s\S]*?)\n<\/browser_tab>\s*$/;

function field(body: string, name: string): string {
  return new RegExp(`^${name}: (.*)$`, "m").exec(body)?.[1]?.trim() ?? "";
}

/** Tells the agent which tab "this page" means and how to read it. */
export function buildBrowserTabContextBlock(context: BrowserTabContext): string {
  return [
    "<browser_tab>",
    'The user wrote this while viewing a Pathway browser tab; "this page" or "this site" means this tab.',
    `Tab id: ${context.tabId}`,
    `Title: ${context.title.replace(/\s+/g, " ").trim()}`,
    `URL: ${context.url}`,
    "Read or act on it with the Pathway preview tools (start with preview_snapshot) using this tabId, not another browser.",
    "</browser_tab>",
  ].join("\n");
}

/** Appended after every other context block, so it is stripped first. */
export function appendBrowserTabContextToPrompt(
  prompt: string,
  context: BrowserTabContext | null,
): string {
  if (!context) return prompt;
  const block = buildBrowserTabContextBlock(context);
  const trimmed = prompt.trim();
  return trimmed ? `${trimmed}\n\n${block}` : block;
}

export function extractTrailingBrowserTabContext(prompt: string): ExtractedBrowserTabContext {
  const match = TRAILING_BROWSER_TAB_BLOCK_PATTERN.exec(prompt);
  if (!match) return { promptText: prompt, context: null };
  const body = match[1] ?? "";
  const url = field(body, "URL");
  return {
    promptText: prompt.slice(0, match.index).replace(/\n+$/, ""),
    context: { tabId: field(body, "Tab id"), url, title: field(body, "Title") || url },
  };
}
