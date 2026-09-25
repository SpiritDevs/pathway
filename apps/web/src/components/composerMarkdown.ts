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

// Emphasis matching is quadratic on a line full of unmatched delimiters. A line
// this long is pasted data, not prose, so it stays plain.
const MAX_INLINE_LINE_LENGTH = 2_000;
// Styling splits text into many nodes, and the composer's cursor math walks
// every node on each keystroke. A prompt this long is mostly pasted material,
// so it stays plain rather than slowing down typing.
const MAX_STYLED_PROMPT_LENGTH = 20_000;

const FENCE_OPEN_PATTERN = /^ {0,3}(`{3,}|~{3,})/;
const FENCE_CLOSE_PATTERN = /^ {0,3}(`{3,}|~{3,})\s*$/;
const HEADING_PATTERN = /^ {0,3}#{1,6}[ \t]+/;
const MARKDOWN_CHARACTER_PATTERN = /[*_~`#]/;
// Placeholder for text the editor may not restyle, such as masked delimiters.
const MASK = "\u0001";

// Ordered so `**` claims its delimiters before `*` can.
const EMPHASIS_RULES: ReadonlyArray<{ pattern: RegExp; delimiter: number; mark: number }> = [
  { pattern: /~~(?=[^\s~])(.*?[^\s~])~~/g, delimiter: 2, mark: IS_STRIKETHROUGH },
  { pattern: /\*\*(?=[^\s*])(.*?[^\s*])\*\*/g, delimiter: 2, mark: IS_BOLD },
  {
    pattern: /(?<![\p{L}\p{N}_])__(?=[^\s_])(.*?[^\s_])__(?![\p{L}\p{N}_])/gu,
    delimiter: 2,
    mark: IS_BOLD,
  },
  { pattern: /\*(?=[^\s*])(.*?[^\s*])\*/g, delimiter: 1, mark: IS_ITALIC },
  {
    pattern: /(?<![\p{L}\p{N}_])_(?=[^\s_])(.*?[^\s_])_(?![\p{L}\p{N}_])/gu,
    delimiter: 1,
    mark: IS_ITALIC,
  },
];

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

function markCodeSpans(line: string, offset: number, marks: Uint16Array, chars: string[]): void {
  const runLength = (from: number) => {
    let end = from;
    while (line[end] === "`") end += 1;
    return end - from;
  };
  let index = 0;
  while (index < line.length) {
    if (line[index] !== "`") {
      index += 1;
      continue;
    }
    const openLength = runLength(index);
    let close = index + openLength;
    while (close < line.length) {
      if (line[close] !== "`") {
        close += 1;
        continue;
      }
      const closeLength = runLength(close);
      if (closeLength === openLength) break;
      close += closeLength;
    }
    if (close >= line.length) {
      index += openLength;
      continue;
    }
    const end = close + openLength;
    addMark(marks, offset + index, offset + index + openLength, MARKDOWN_SYNTAX);
    addMark(marks, offset + index + openLength, offset + close, IS_CODE);
    addMark(marks, offset + close, offset + end, MARKDOWN_SYNTAX);
    chars.fill(MASK, index, end);
    index = end;
  }
}

function markInline(line: string, offset: number, marks: Uint16Array): void {
  const chars = line.split("");
  markCodeSpans(line, offset, marks, chars);
  for (const rule of EMPHASIS_RULES) {
    const matches = [...chars.join("").matchAll(rule.pattern)];
    for (const match of matches) {
      const from = match.index;
      const to = from + match[0].length;
      addMark(marks, offset + from, offset + from + rule.delimiter, MARKDOWN_SYNTAX);
      addMark(marks, offset + from + rule.delimiter, offset + to - rule.delimiter, rule.mark);
      addMark(marks, offset + to - rule.delimiter, offset + to, MARKDOWN_SYNTAX);
      chars.fill(MASK, from, from + rule.delimiter);
      chars.fill(MASK, to - rule.delimiter, to);
    }
  }
}

/**
 * Marks each character of a markdown prompt with the Lexical text format and
 * markdown role it should render with. Lines are the prompt split on newlines;
 * the text itself is never changed, so the prompt stays plain markdown.
 */
export function parseComposerMarkdown(lines: ReadonlyArray<string>): Uint16Array[] {
  let fence: { char: string; length: number } | null = null;
  return lines.map((line) => {
    const marks = new Uint16Array(line.length);
    if (fence) {
      const close = FENCE_CLOSE_PATTERN.exec(line)?.[1];
      if (close && close[0] === fence.char && close.length >= fence.length) {
        fence = null;
        marks.fill(MARKDOWN_SYNTAX | MARKDOWN_CODE_BLOCK);
      } else {
        marks.fill(MARKDOWN_CODE_BLOCK);
      }
      return marks;
    }
    const open = FENCE_OPEN_PATTERN.exec(line)?.[1];
    if (open) {
      fence = { char: open[0] ?? "`", length: open.length };
      marks.fill(MARKDOWN_SYNTAX | MARKDOWN_CODE_BLOCK);
      return marks;
    }
    if (line.length > MAX_INLINE_LINE_LENGTH) return marks;
    const heading = HEADING_PATTERN.exec(line)?.[0].length ?? 0;
    if (heading > 0) {
      marks.fill(MARKDOWN_SYNTAX, 0, heading);
      marks.fill(IS_BOLD, heading);
    }
    markInline(line.slice(heading), heading, marks);
    return marks;
  });
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
  const tooLong =
    lines.reduce((total, value) => total + value.length, 0) > MAX_STYLED_PROMPT_LENGTH;
  if (
    !hasStyledText &&
    (tooLong || !lines.some((value) => MARKDOWN_CHARACTER_PATTERN.test(value)))
  ) {
    return;
  }

  // Past the limit, unmarked lines clear styling left from when it was shorter.
  const marks = tooLong
    ? lines.map((value) => new Uint16Array(value.length))
    : parseComposerMarkdown(lines);
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
