import {
  $createLineBreakNode,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $isTextNode,
  createEditor,
  IS_BOLD,
  IS_CODE,
  IS_ITALIC,
  IS_STRIKETHROUGH,
  type TextNode,
} from "lexical";
import { describe, expect, it } from "vite-plus/test";

import {
  MARKDOWN_CODE_BLOCK,
  MARKDOWN_SYNTAX,
  parseComposerMarkdown,
  registerComposerMarkdown,
} from "./composerMarkdown";

const MARK_NAMES: ReadonlyArray<[number, string]> = [
  [IS_BOLD, "bold"],
  [IS_ITALIC, "italic"],
  [IS_STRIKETHROUGH, "strike"],
  [IS_CODE, "code"],
  [MARKDOWN_CODE_BLOCK, "block"],
  [MARKDOWN_SYNTAX, "syntax"],
];

function describeMark(mark: number): string {
  return MARK_NAMES.filter(([bit]) => mark & bit)
    .map(([, name]) => name)
    .join("+");
}

/** Renders each line as runs of equally marked text, e.g. `**:syntax`. */
function runs(prompt: string): string[][] {
  const lines = prompt.split("\n");
  return parseComposerMarkdown(lines).map((marks, lineIndex) => {
    const line = lines[lineIndex] ?? "";
    const result: string[] = [];
    let start = 0;
    for (let index = 1; index <= line.length; index += 1) {
      if (index === line.length || marks[index] !== marks[start]) {
        const name = describeMark(marks[start] ?? 0);
        result.push(name ? `${line.slice(start, index)}:${name}` : line.slice(start, index));
        start = index;
      }
    }
    return result;
  });
}

describe("parseComposerMarkdown", () => {
  it("marks inline emphasis and mutes its delimiters", () => {
    expect(runs("**A decision:** yes")).toEqual([
      ["**:syntax", "A decision::bold", "**:syntax", " yes"],
    ]);
    expect(runs("an *em* and ~~gone~~")).toEqual([
      [
        "an ",
        "*:syntax",
        "em:italic",
        "*:syntax",
        " and ",
        "~~:syntax",
        "gone:strike",
        "~~:syntax",
      ],
    ]);
    expect(runs("***both***")).toEqual([
      ["*:syntax", "**:italic+syntax", "both:bold+italic", "**:italic+syntax", "*:syntax"],
    ]);
  });

  it("leaves arithmetic, list bullets, and snake_case alone", () => {
    expect(runs("2 * 3 * 4")).toEqual([["2 * 3 * 4"]]);
    expect(runs("* item")).toEqual([["* item"]]);
    expect(runs("rename some_long_name")).toEqual([["rename some_long_name"]]);
  });

  it("keeps emphasis out of inline code", () => {
    expect(runs("run `a*b*c` now")).toEqual([
      ["run ", "`:syntax", "a*b*c:code", "`:syntax", " now"],
    ]);
  });

  it("bolds headings", () => {
    expect(runs("## Next steps")).toEqual([["## :syntax", "Next steps:bold"]]);
  });

  it("treats backslash-escaped delimiters as literal text", () => {
    expect(runs("\\*lit\\* and \\`x\\` but \\\\*em*")).toEqual([
      [
        "\\:syntax",
        "*lit",
        "\\:syntax",
        "* and ",
        "\\:syntax",
        "`x",
        "\\:syntax",
        "` but ",
        "\\:syntax",
        "\\",
        "*:syntax",
        "em:italic",
        "*:syntax",
      ],
    ]);
  });

  it("carries emphasis across soft line breaks but not into a new block", () => {
    expect(runs("*first\nsecond*")).toEqual([
      ["*:syntax", "first:italic"],
      ["second:italic", "*:syntax"],
    ]);
    expect(runs("*a\n\nb*")).toEqual([["*a"], [], ["b*"]]);
    expect(runs("- *a\n- b*")).toEqual([["- *a"], ["- b*"]]);
  });

  it("reads a backtick line with backticks after the marker as inline code, not a fence", () => {
    expect(runs("```code```\nnext *em*")).toEqual([
      ["```:syntax", "code:code", "```:syntax"],
      ["next ", "*:syntax", "em:italic", "*:syntax"],
    ]);
  });

  it("follows markdown's flanking rules for emphasis delimiters", () => {
    expect(runs("2*(3+4)*5")).toEqual([["2*(3+4)*5"]]);
  });

  it("carries emphasis across quoted lines and mutes every quote prefix", () => {
    expect(runs("> *first\n> second*")).toEqual([
      ["> *:syntax", "first:italic"],
      ["> :syntax", "second:italic", "*:syntax"],
    ]);
  });

  it("mutes a heading's closing hashes", () => {
    expect(runs("## Next steps ##")).toEqual([["## :syntax", "Next steps:bold", " ##:syntax"]]);
  });

  it("stops emphasis at a thematic break", () => {
    expect(runs("*first\n***\nsecond*")).toEqual([["*first"], ["***:syntax"], ["second*"]]);
  });

  it("recognizes a fenced block that starts after a list marker", () => {
    expect(runs("- ```ts\n  const v = 1;\n  ```")).toEqual([
      ["- ", "```ts:block+syntax"],
      ["  const v = 1;:block"],
      ["  ```:block+syntax"],
    ]);
  });

  it("renders fenced code blocks monospace without inline emphasis", () => {
    expect(runs("```ts\nconst a = *b*;\n```\n*after*")).toEqual([
      ["```ts:block+syntax"],
      ["const a = *b*;:block"],
      ["```:block+syntax"],
      ["*:syntax", "after:italic", "*:syntax"],
    ]);
  });
});

function createComposer(lines: ReadonlyArray<string>) {
  const editor = createEditor();
  registerComposerMarkdown(editor);
  editor.update(
    () => {
      const paragraph = $createParagraphNode();
      lines.forEach((line, index) => {
        if (index > 0) paragraph.append($createLineBreakNode());
        paragraph.append($createTextNode(line));
      });
      $getRoot().append(paragraph);
    },
    { discrete: true },
  );
  return editor;
}

function readTextNodes(editor: ReturnType<typeof createEditor>) {
  return editor.getEditorState().read(() => ({
    text: $getRoot().getTextContent(),
    nodes: $getRoot()
      .getAllTextNodes()
      .map((node) => [node.getTextContent(), node.getFormat(), node.getStyle() !== ""] as const),
  }));
}

describe("registerComposerMarkdown", () => {
  it("formats text nodes in place without changing the prompt", () => {
    const editor = createComposer(["**Bold** plain", "`code`"]);

    const { text, nodes } = readTextNodes(editor);
    expect(text).toBe("**Bold** plain\n`code`");
    expect(nodes).toEqual([
      ["**", 0, true],
      ["Bold", IS_BOLD, false],
      ["**", 0, true],
      [" plain", 0, false],
      ["`", 0, true],
      ["code", IS_CODE, false],
      ["`", 0, true],
    ]);
  });

  it("formats text typed into an existing node", () => {
    const editor = createComposer(["Bold** plain"]);

    editor.update(
      () => {
        $getRoot().getAllTextNodes()[0]?.setTextContent("**Bold** plain");
      },
      { discrete: true },
    );

    expect(readTextNodes(editor).nodes).toEqual([
      ["**", 0, true],
      ["Bold", IS_BOLD, false],
      ["**", 0, true],
      [" plain", 0, false],
    ]);
  });

  it("leaves a plain keystroke touching only its text node so history merges typing", () => {
    const editor = createComposer(["**Bold** plain"]);
    const touched: string[][] = [];
    editor.registerUpdateListener(({ dirtyElements, dirtyLeaves }) => {
      const elements = [...dirtyElements].filter(
        ([key, intentional]) => intentional && key !== "root",
      );
      touched.push([...dirtyLeaves, ...elements.map(([key]) => key)]);
    });

    editor.update(
      () => {
        const plain = $getRoot().getAllTextNodes().at(-1);
        plain?.setTextContent(`${plain.getTextContent()}s`);
      },
      { discrete: true },
    );

    expect(touched).toHaveLength(1);
    expect(touched[0]).toHaveLength(1);
  });

  it("leaves very long prompts plain, clearing styling once they grow past the limit", () => {
    const editor = createComposer(["**Bold** plain"]);

    editor.update(
      () => {
        const plain = $getRoot().getAllTextNodes().at(-1);
        plain?.setTextContent(`${plain.getTextContent()}${"x".repeat(20_000)}`);
      },
      { discrete: true },
    );

    const { text, nodes } = readTextNodes(editor);
    expect(text).toBe(`**Bold** plain${"x".repeat(20_000)}`);
    expect(nodes).toEqual([[text, 0, false]]);
  });

  it("leaves delimiter-dense prompts plain even under the length limit", () => {
    const prompt = "**a** ".repeat(1_000);
    const editor = createComposer([prompt]);

    expect(readTextNodes(editor).nodes).toEqual([[prompt, 0, false]]);
  });

  it("clears the formatting once a delimiter is deleted", () => {
    const editor = createComposer(["**Bold** plain"]);

    editor.update(
      () => {
        const closing = $getRoot()
          .getAllTextNodes()
          .findLast(
            (node): node is TextNode => $isTextNode(node) && node.getTextContent() === "**",
          );
        closing?.remove();
      },
      { discrete: true },
    );

    expect(readTextNodes(editor)).toEqual({
      text: "**Bold plain",
      nodes: [["**Bold plain", 0, false]],
    });
  });
});
