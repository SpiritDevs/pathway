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

// Emphasis matching is quadratic on text full of unmatched delimiters. A
// paragraph longer than this is parsed line by line, and a line this long is
// pasted data, not prose, so it stays plain.
const MAX_INLINE_LENGTH = 2_000;
// Styling splits text into a node per formatted run, and the composer's cursor
// math walks every node on each keystroke. A prompt past either limit is mostly
// pasted material, so it stays plain rather than slowing down typing.
const MAX_STYLED_PROMPT_LENGTH = 20_000;
const MAX_STYLED_RUNS = 2_000;

const FENCE_OPEN_PATTERN = /^ {0,3}(`{3,}|~{3,})/;
const FENCE_CLOSE_PATTERN = /^ {0,3}(`{3,}|~{3,})\s*$/;
const HEADING_PATTERN = /^ {0,3}#{1,6}[ \t]+/;
// A list item or quote starts a new block, so emphasis cannot span into it.
const BLOCK_START_PATTERN = /^ {0,3}(?:[-*+]|\d{1,9}[.)])[ \t]|^ {0,3}>/;
const ESCAPABLE_PATTERN = /[!-/:-@[-`{-~]/;
const MARKDOWN_CHARACTER_PATTERN = /[*_~`#]/;
// Placeholder for text the editor may not restyle, such as masked delimiters.
const MASK = "\u0001";

// Ordered so `**` claims its delimiters before `*` can.
const EMPHASIS_RULES: ReadonlyArray<{ pattern: RegExp; delimiter: number; mark: number }> = [
  { pattern: /~~(?=[^\s~])(.*?[^\s~])~~/gs, delimiter: 2, mark: IS_STRIKETHROUGH },
  { pattern: /\*\*(?=[^\s*])(.*?[^\s*])\*\*/gs, delimiter: 2, mark: IS_BOLD },
  {
    pattern: /(?<![\p{L}\p{N}_])__(?=[^\s_])(.*?[^\s_])__(?![\p{L}\p{N}_])/gsu,
    delimiter: 2,
    mark: IS_BOLD,
  },
  { pattern: /\*(?=[^\s*])(.*?[^\s*])\*/gs, delimiter: 1, mark: IS_ITALIC },
  {
    pattern: /(?<![\p{L}\p{N}_])_(?=[^\s_])(.*?[^\s_])_(?![\p{L}\p{N}_])/gsu,
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

/** Marks code spans and backslash escapes, masking both from emphasis. */
function markCodeSpansAndEscapes(text: string, marks: Uint16Array, chars: string[]): void {
  const runLength = (from: number) => {
    let end = from;
    while (text[end] === "`") end += 1;
    return end - from;
  };
  let index = 0;
  while (index < text.length) {
    if (text[index] === "\\" && ESCAPABLE_PATTERN.test(text[index + 1] ?? "")) {
      // The rendered message hides the backslash and shows the next character literally.
      addMark(marks, index, index + 1, MARKDOWN_SYNTAX);
      chars[index + 1] = MASK;
      index += 2;
      continue;
    }
    if (text[index] !== "`") {
      index += 1;
      continue;
    }
    // Escapes do not apply inside a code span, so the closer is found verbatim.
    const openLength = runLength(index);
    let close = index + openLength;
    while (close < text.length) {
      if (text[close] !== "`") {
        close += 1;
        continue;
      }
      const closeLength = runLength(close);
      if (closeLength === openLength) break;
      close += closeLength;
    }
    if (close >= text.length) {
      index += openLength;
      continue;
    }
    const end = close + openLength;
    addMark(marks, index, index + openLength, MARKDOWN_SYNTAX);
    addMark(marks, index + openLength, close, IS_CODE);
    addMark(marks, close, end, MARKDOWN_SYNTAX);
    chars.fill(MASK, index, end);
    index = end;
  }
}

function inlineMarks(text: string): Uint16Array {
  const marks = new Uint16Array(text.length);
  if (text.length > MAX_INLINE_LENGTH) return marks;
  const chars = text.split("");
  markCodeSpansAndEscapes(text, marks, chars);
  for (const rule of EMPHASIS_RULES) {
    const matches = [...chars.join("").matchAll(rule.pattern)];
    for (const match of matches) {
      const from = match.index;
      const to = from + match[0].length;
      addMark(marks, from, from + rule.delimiter, MARKDOWN_SYNTAX);
      addMark(marks, from + rule.delimiter, to - rule.delimiter, rule.mark);
      addMark(marks, to - rule.delimiter, to, MARKDOWN_SYNTAX);
      chars.fill(MASK, from, from + rule.delimiter);
      chars.fill(MASK, to - rule.delimiter, to);
    }
  }
  return marks;
}

function openingFence(line: string): { char: string; length: number } | null {
  const match = FENCE_OPEN_PATTERN.exec(line);
  const marker = match?.[1];
  if (!match || !marker) return null;
  // A backtick in the info string makes the line inline code, not a fence.
  if (marker[0] === "`" && line.slice(match[0].length).includes("`")) return null;
  return { char: marker[0] ?? "`", length: marker.length };
}

/**
 * Marks each character of a markdown prompt with the Lexical text format and
 * markdown role it should render with. Lines are the prompt split on newlines;
 * the text itself is never changed, so the prompt stays plain markdown.
 */
export function parseComposerMarkdown(lines: ReadonlyArray<string>): Uint16Array[] {
  const marks = lines.map((line) => new Uint16Array(line.length));
  let fence: { char: string; length: number } | null = null;
  // Consecutive prose lines form one block, so emphasis can span soft line breaks.
  let block: number[] = [];
  const flushBlock = () => {
    const text = block.map((index) => lines[index] ?? "").join("\n");
    // Past the inline limit, fall back to parsing each line on its own.
    const blockMarks = text.length <= MAX_INLINE_LENGTH ? inlineMarks(text) : null;
    let offset = 0;
    for (const index of block) {
      const line = lines[index] ?? "";
      marks[index]?.set(blockMarks?.subarray(offset, offset + line.length) ?? inlineMarks(line));
      offset += line.length + 1;
    }
    block = [];
  };

  lines.forEach((line, index) => {
    const lineMarks = marks[index];
    if (!lineMarks) return;
    if (fence) {
      const close = FENCE_CLOSE_PATTERN.exec(line)?.[1];
      if (close && close[0] === fence.char && close.length >= fence.length) {
        fence = null;
        lineMarks.fill(MARKDOWN_SYNTAX | MARKDOWN_CODE_BLOCK);
      } else {
        lineMarks.fill(MARKDOWN_CODE_BLOCK);
      }
      return;
    }
    const open = openingFence(line);
    const heading = HEADING_PATTERN.exec(line)?.[0].length ?? 0;
    if (open || heading > 0 || line.trim() === "" || BLOCK_START_PATTERN.test(line)) {
      flushBlock();
    }
    if (open) {
      fence = open;
      lineMarks.fill(MARKDOWN_SYNTAX | MARKDOWN_CODE_BLOCK);
    } else if (heading > 0) {
      lineMarks.fill(MARKDOWN_SYNTAX, 0, heading);
      lineMarks.fill(IS_BOLD, heading);
      inlineMarks(line.slice(heading)).forEach((mark, offset) => {
        lineMarks[heading + offset] = (lineMarks[heading + offset] ?? 0) | mark;
      });
    } else if (line.trim() !== "") {
      block.push(index);
    }
  });
  flushBlock();
  return marks;
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
  const tooLong =
    lines.reduce((total, value) => total + value.length, 0) > MAX_STYLED_PROMPT_LENGTH;
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
