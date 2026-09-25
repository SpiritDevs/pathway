import type { Nodes } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmStrikethroughFromMarkdown } from "mdast-util-gfm-strikethrough";
import { gfmStrikethrough } from "micromark-extension-gfm-strikethrough";
import {
  $isLineBreakNode,
  $isParagraphNode,
  $isTextNode,
  IS_BOLD,
  IS_CODE,
  IS_ITALIC,
  IS_STRIKETHROUGH,
  RootNode,
  type ParagraphNode,
  type TextNode,
  type EditorThemeClasses,
  type LexicalEditor,
} from "lexical";

/** Markdown punctuation such as `**`, `#`, or a code fence, rendered muted. */
export const MARKDOWN_SYNTAX = 1 << 8;
/** Every line of a fenced code block, rendered monospace. */
export const MARKDOWN_CODE_BLOCK = 1 << 9;

const TEXT_FORMAT_MASK = IS_BOLD | IS_ITALIC | IS_STRIKETHROUGH | IS_CODE;

// Parsing runs on every keystroke and styling splits text into a node per
// formatted run, which the composer's cursor math walks each keystroke too. A
// prompt past either limit is mostly pasted material, so it stays plain rather
// than slowing down typing.
const MAX_STYLED_PROMPT_LENGTH = 10_000;
const MAX_STYLED_RUNS = 2_000;

const MARKDOWN_CHARACTER_PATTERN = /[*_~`#>=-]/;
const ESCAPE_PATTERN = /\\[!-/:-@[-`{-~]/g;
const FENCE_OPEN_PATTERN = /^[`~]{3}/;
const FENCE_CLOSE_PATTERN = /^\s*[`~]{3,}\s*$/;
const QUOTE_PREFIX_PATTERN = /^[ \t]*(?:>[ \t]?)+/;

// The same micromark parser and strikethrough extension the chat renderer uses
// (react-markdown with remark-gfm), so the preview agrees with the sent message.
const PARSE_OPTIONS = {
  extensions: [gfmStrikethrough()],
  mdastExtensions: [gfmStrikethroughFromMarkdown()],
};

const INLINE_FORMATS = {
  delete: IS_STRIKETHROUGH,
  emphasis: IS_ITALIC,
  heading: IS_BOLD,
  strong: IS_BOLD,
} as const;

export const COMPOSER_MARKDOWN_THEME: EditorThemeClasses = {
  text: {
    bold: "font-semibold",
    code: "rounded-sm bg-muted px-0.5 font-mono text-[0.92em]",
    italic: "italic",
    strikethrough: "line-through",
  },
};

function addMark(marks: Uint16Array, from: number, to: number, mark: number): void {
  for (let index = from; index < to; index += 1) {
    marks[index] = (marks[index] ?? 0) | mark;
  }
}

function lineEnd(text: string, from: number, limit: number): number {
  const end = text.indexOf("\n", from);
  return end === -1 || end > limit ? limit : end;
}

function markNode(node: Nodes, text: string, marks: Uint16Array): void {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start === undefined || end === undefined) return;

  switch (node.type) {
    case "delete":
    case "emphasis":
    case "heading":
    case "strong": {
      // Whatever sits outside the children is the delimiter, including a
      // heading's `#` prefix, closing hashes, or setext underline.
      const contentStart = node.children[0]?.position?.start.offset ?? end;
      const contentEnd = node.children.at(-1)?.position?.end.offset ?? end;
      addMark(marks, start, contentStart, MARKDOWN_SYNTAX);
      addMark(marks, contentStart, contentEnd, INLINE_FORMATS[node.type]);
      addMark(marks, contentEnd, end, MARKDOWN_SYNTAX);
      break;
    }
    case "inlineCode": {
      let ticks = 0;
      while (text[start + ticks] === "`") ticks += 1;
      addMark(marks, start, start + ticks, MARKDOWN_SYNTAX);
      addMark(marks, start + ticks, end - ticks, IS_CODE);
      addMark(marks, end - ticks, end, MARKDOWN_SYNTAX);
      return;
    }
    case "code": {
      addMark(marks, start, end, MARKDOWN_CODE_BLOCK);
      // Indented code has no fence lines to mute.
      if (!FENCE_OPEN_PATTERN.test(text.slice(start, start + 3))) return;
      addMark(marks, start, lineEnd(text, start, end), MARKDOWN_SYNTAX);
      const lastLineStart = text.lastIndexOf("\n", end - 1) + 1;
      if (lastLineStart > start && FENCE_CLOSE_PATTERN.test(text.slice(lastLineStart, end))) {
        addMark(marks, lastLineStart, end, MARKDOWN_SYNTAX);
      }
      return;
    }
    case "thematicBreak":
      addMark(marks, start, end, MARKDOWN_SYNTAX);
      return;
    case "text":
      // The rendered message hides an escaping backslash.
      for (const match of text.slice(start, end).matchAll(ESCAPE_PATTERN)) {
        addMark(marks, start + match.index, start + match.index + 1, MARKDOWN_SYNTAX);
      }
      return;
  }

  if ("children" in node) {
    for (const child of node.children) markNode(child, text, marks);
  }

  if (node.type === "blockquote") {
    // Emphasis spanning quoted lines also covers the next line's `>` prefix;
    // those prefixes are plain syntax.
    let from = start;
    while (from < end) {
      const to = lineEnd(text, from, end);
      const prefix = QUOTE_PREFIX_PATTERN.exec(text.slice(from, to))?.[0].length ?? 0;
      marks.fill(MARKDOWN_SYNTAX, from, from + prefix);
      from = to + 1;
    }
  }
}

/**
 * Marks each character of a markdown prompt with the Lexical text format and
 * markdown role it should render with. Lines are the prompt split on newlines;
 * the text itself is never changed, so the prompt stays plain markdown.
 */
export function parseComposerMarkdown(lines: ReadonlyArray<string>): Uint16Array[] {
  const text = lines.join("\n");
  const marks = new Uint16Array(text.length);
  markNode(fromMarkdown(text, PARSE_OPTIONS), text, marks);
  let offset = 0;
  return lines.map((line) => {
    const lineMarks = marks.slice(offset, offset + line.length);
    offset += line.length + 1;
    return lineMarks;
  });
}

function countRuns(marks: ReadonlyArray<Uint16Array>): number {
  let runs = 0;
  for (const lineMarks of marks) {
    for (let index = 1; index < lineMarks.length; index += 1) {
      if (lineMarks[index] !== lineMarks[index - 1]) runs += 1;
    }
  }
  return runs;
}

function styleForMark(mark: number): string {
  const declarations: string[] = [];
  if (mark & MARKDOWN_CODE_BLOCK) declarations.push("font-family: var(--font-mono)");
  if (mark & MARKDOWN_SYNTAX) declarations.push("color: var(--muted-foreground)");
  return declarations.join("; ");
}

function $applyMarks(node: TextNode, marks: Uint16Array, start: number): void {
  const text = node.getTextContent();
  const splitOffsets: number[] = [];
  for (let index = 1; index < text.length; index += 1) {
    if (marks[start + index] !== marks[start + index - 1]) splitOffsets.push(index);
  }
  const parts = splitOffsets.length > 0 ? node.splitText(...splitOffsets) : [node];
  let offset = start;
  for (const part of parts) {
    const mark = marks[offset] ?? 0;
    const format = mark & TEXT_FORMAT_MASK;
    const style = styleForMark(mark);
    // Only write on change: a write re-dirties the node and reruns the transform.
    if (part.getFormat() !== format) part.setFormat(format);
    if (part.getStyle() !== style) part.setStyle(style);
    offset += part.getTextContentSize();
  }
}

function $styleParagraphMarkdown(paragraph: ParagraphNode): void {
  const lines: string[] = [];
  const textNodes: Array<{ node: TextNode; line: number; start: number }> = [];
  let line = "";
  let hasStyledText = false;
  for (const child of paragraph.getChildren()) {
    if ($isLineBreakNode(child)) {
      lines.push(line);
      line = "";
    } else if ($isTextNode(child) && child.isSimpleText()) {
      textNodes.push({ node: child, line: lines.length, start: line.length });
      hasStyledText ||= child.getFormat() !== 0 || child.getStyle() !== "";
      line += child.getTextContent();
    } else {
      // Chips and tabs count as one opaque character so emphasis can span them.
      line += "\uFFFC";
    }
  }
  lines.push(line);
  // Lines are joined by newlines, which count toward the prompt's length.
  const length = lines.reduce((total, value) => total + value.length + 1, -1);
  const tooLong = length > MAX_STYLED_PROMPT_LENGTH;
  if (
    !hasStyledText &&
    (tooLong || !lines.some((value) => MARKDOWN_CHARACTER_PATTERN.test(value)))
  ) {
    return;
  }

  // Past a limit, unmarked lines clear styling left from when it was smaller.
  const parsed = tooLong ? null : parseComposerMarkdown(lines);
  const marks =
    parsed && countRuns(parsed) <= MAX_STYLED_RUNS
      ? parsed
      : lines.map((value) => new Uint16Array(value.length));
  for (const { node, line: lineIndex, start } of textNodes) {
    const lineMarks = marks[lineIndex];
    if (lineMarks) $applyMarks(node, lineMarks, start);
  }
}

/**
 * Renders markdown in a plain-text composer as it is typed: formats text nodes
 * in place and leaves the text, and so the prompt, untouched.
 */
export function registerComposerMarkdown(editor: LexicalEditor): () => void {
  // Root transforms run once after any change, and history ignores the root.
  // Marking the paragraph dirty instead would make history treat every
  // keystroke as a structural change and stop merging typing into one undo.
  return editor.registerNodeTransform(RootNode, (root) => {
    // Splitting the node an IME is composing into cancels the composition.
    if (editor.isComposing()) return;
    for (const child of root.getChildren()) {
      if ($isParagraphNode(child)) $styleParagraphMarkdown(child);
    }
  });
}
