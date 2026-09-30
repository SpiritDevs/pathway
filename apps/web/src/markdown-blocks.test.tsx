import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { describe, expect, it } from "vite-plus/test";

import { splitMarkdownBlocks } from "./markdown-blocks";
import { remarkGithubAlerts } from "./markdown-github-alerts";
import { remarkNormalizeListItemIndentation } from "./markdown-list-indentation";

function render(markdown: string): string {
  return renderToStaticMarkup(
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkGithubAlerts, remarkNormalizeListItemIndentation]}
      rehypePlugins={[rehypeRaw, rehypeSanitize]}
      skipHtml={false}
    >
      {markdown}
    </ReactMarkdown>,
  );
}

function renderBlocks(markdown: string): string {
  return splitMarkdownBlocks(markdown).map(render).join("");
}

const normalizeWhitespace = (html: string) => html.replace(/>\s+</g, "><").trim();

const SAMPLES: Record<string, string> = {
  paragraphs: "First paragraph with `code`.\n\nSecond **bold** paragraph.\n\n## Heading\n\nTail.",
  fencedCodeWithBlankLines:
    "Intro\n\n```ts\nconst a = 1;\n\nconst b = 2;\n\n\nexport {};\n```\n\nAfter the fence.",
  longerClosingFence: "````md\n```\n\nnested\n```\n\n````\n\nAfter.",
  tildeFence: "~~~\nline\n\nline\n~~~\n\nAfter.",
  looseList: "- one\n\n- two\n\n- three\n\nParagraph after the list.",
  orderedLooseList: "1. one\n\n2. two\n\n10. ten\n\nDone.",
  listContinuation:
    "1. Step one\n\n   More about step one.\n\n   ```sh\n   echo hi\n\n   echo bye\n   ```\n\n2. Step two",
  blockquotes: "> [!NOTE]\n> Useful.\n\n> quote\n\nText",
  table: "| a | b |\n| - | - |\n| 1 | 2 |\n\nAfter table.",
  details:
    "<details>\n<summary>More</summary>\n\nHidden **content**.\n\n- item\n\n</details>\n\nVisible.",
  htmlComment: "<!--\n\nhidden\n\n-->\n\nShown.",
  referenceLinks: "See [the docs][docs].\n\nMore text.\n\n[docs]: https://example.com",
  footnotes: "A claim.[^1]\n\nMore.\n\n[^1]: Source.",
  genericsInCode: "Use `Vec<T>` here.\n\nAnd `Option<U>` there.\n\nEnd.",
  thematicBreak: "Above\n\n---\n\nBelow",
  leadingBlankLines: "\n\n\nStart\n\nNext",
  taskList: "- [ ] todo\n- [x] done\n\nAfter.",
};

describe("splitMarkdownBlocks", () => {
  it.each(Object.entries(SAMPLES))("renders %s the same split as whole", (_name, markdown) => {
    expect(normalizeWhitespace(renderBlocks(markdown))).toBe(normalizeWhitespace(render(markdown)));
  });

  it("round-trips the source text exactly", () => {
    for (const markdown of Object.values(SAMPLES)) {
      expect(splitMarkdownBlocks(markdown).join("")).toBe(markdown);
    }
  });

  it("splits between paragraphs but not inside fences, lists, or open HTML", () => {
    expect(splitMarkdownBlocks(SAMPLES.paragraphs!)).toHaveLength(4);
    expect(splitMarkdownBlocks(SAMPLES.fencedCodeWithBlankLines!)).toEqual([
      "Intro\n\n",
      "```ts\nconst a = 1;\n\nconst b = 2;\n\n\nexport {};\n```\n\n",
      "After the fence.",
    ]);
    expect(splitMarkdownBlocks(SAMPLES.looseList!)).toHaveLength(2);
    expect(splitMarkdownBlocks(SAMPLES.details!)).toHaveLength(2);
    expect(splitMarkdownBlocks(SAMPLES.referenceLinks!)).toHaveLength(1);
  });

  it("keeps settled blocks byte-identical while the tail streams", () => {
    const message = Array.from(
      { length: 40 },
      (_, index) => `Paragraph ${index} with **bold** and \`code\`.\n\n`,
    ).join("");
    const before = splitMarkdownBlocks(message);
    const after = splitMarkdownBlocks(`${message}Streaming tail`);
    expect(after.slice(0, before.length - 1)).toEqual(before.slice(0, -1));
    expect(after.at(-1)).toBe("Streaming tail");
  });

  it("re-parses only the tail while a long message streams", () => {
    const paragraph =
      "Some prose with **emphasis**, `inline code`, and a [link](https://example.com).\n\n";
    const code = "```ts\nexport function example() {\n  return 42;\n}\n```\n\n";
    const message = Array.from({ length: 60 }, (_, index) =>
      index % 4 === 0 ? code : paragraph,
    ).join("");
    const deltas: string[] = [];
    for (let end = 40; end <= message.length; end += 40) deltas.push(message.slice(0, end));

    // Model ChatMarkdown's per-block memo: a block renders only when its text changed.
    let wholeChars = 0;
    let blockChars = 0;
    let previousBlocks: string[] = [];
    const startedAt = performance.now();
    for (const text of deltas) {
      const blocks = splitMarkdownBlocks(text);
      blocks.forEach((block, index) => {
        if (previousBlocks[index] !== block) {
          blockChars += block.length;
          render(block);
        }
      });
      previousBlocks = blocks;
    }
    const blockMs = performance.now() - startedAt;
    const wholeStartedAt = performance.now();
    for (const text of deltas) {
      wholeChars += text.length;
      render(text);
    }
    const wholeMs = performance.now() - wholeStartedAt;
    console.info(
      `[markdown-blocks] ${deltas.length} deltas over ${message.length} chars: whole ${wholeMs.toFixed(0)}ms / ${wholeChars} chars parsed, blocks ${blockMs.toFixed(0)}ms / ${blockChars} chars parsed`,
    );
    expect(blockChars * 20).toBeLessThan(wholeChars);
  });
});
