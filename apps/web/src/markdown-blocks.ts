const FENCE_OPEN_PATTERN = /^\s*(`{3,}|~{3,})/;
const FENCE_CLOSE_PATTERN = /^\s*(`{3,}|~{3,})\s*$/;
const LIST_MARKER_PATTERN = /^(?:[-+*]|\d{1,9}[.)])(?:[ \t]|$)/;
const DEFINITION_PATTERN = /^ {0,3}\[[^\]\n]+\]:/m;
const INLINE_CODE_PATTERN = /(`+)[^`]+?\1/g;
const HTML_OPEN_TAG_PATTERN = /<([A-Za-z][\w-]*)(?:\s[^<>]*)?>/g;
const HTML_CLOSE_TAG_PATTERN = /<\/[A-Za-z][\w-]*\s*>/g;
const VOID_HTML_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "source",
  "track",
  "wbr",
]);

/** Raw HTML a line opens minus what it closes, counting comments; inline code is ignored. */
function htmlDepthChange(line: string): number {
  if (!line.includes("<") && !line.includes("-->")) return 0;
  const text = line.replace(INLINE_CODE_PATTERN, "");
  let change = text.split("<!--").length - text.split("-->").length;
  for (const match of text.matchAll(HTML_OPEN_TAG_PATTERN)) {
    const tag = match[1]?.toLowerCase() ?? "";
    if (!VOID_HTML_TAGS.has(tag) && !match[0].endsWith("/>")) change += 1;
  }
  change -= text.match(HTML_CLOSE_TAG_PATTERN)?.length ?? 0;
  return change;
}

/**
 * Splits markdown into top-level chunks that render the same on their own as
 * they do in place, so a streaming message re-parses only its growing tail
 * instead of the whole text on every delta. A split lands only on a blank line
 * followed by an unindented, non-list line, outside fences and with any raw
 * HTML closed. Text with link or footnote definitions stays whole, since those
 * resolve document-wide.
 */
export function splitMarkdownBlocks(markdown: string): string[] {
  if (DEFINITION_PATTERN.test(markdown)) return [markdown];
  const blocks: string[] = [];
  let blockStart = 0;
  let fence: string | null = null;
  let htmlDepth = 0;
  let blockHasContent = false;
  let previousLineBlank = false;
  let lineStart = 0;
  while (lineStart < markdown.length) {
    const newline = markdown.indexOf("\n", lineStart);
    const lineEnd = newline === -1 ? markdown.length : newline;
    const line = markdown.slice(lineStart, lineEnd);
    const isBlank = line.trim().length === 0;
    if (fence !== null) {
      const closing = FENCE_CLOSE_PATTERN.exec(line)?.[1];
      if (closing && closing[0] === fence[0] && closing.length >= fence.length) fence = null;
    } else if (!isBlank) {
      if (
        previousLineBlank &&
        blockHasContent &&
        htmlDepth <= 0 &&
        line[0] !== " " &&
        line[0] !== "\t" &&
        !LIST_MARKER_PATTERN.test(line)
      ) {
        blocks.push(markdown.slice(blockStart, lineStart));
        blockStart = lineStart;
        htmlDepth = 0;
      }
      blockHasContent = true;
      const opening = FENCE_OPEN_PATTERN.exec(line)?.[1];
      const infoString = opening ? line.slice(line.indexOf(opening) + opening.length) : "";
      if (opening && !(opening[0] === "`" && infoString.includes("`"))) {
        fence = opening;
      } else {
        htmlDepth += htmlDepthChange(line);
      }
    }
    previousLineBlank = isBlank;
    lineStart = lineEnd + 1;
  }
  blocks.push(markdown.slice(blockStart));
  return blocks;
}
