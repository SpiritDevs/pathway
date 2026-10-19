import { $convertFromMarkdownString, $convertToMarkdownString } from "@lexical/markdown";
import { $createParagraphNode, $createTextNode, $getRoot, createEditor } from "lexical";
import { describe, expect, it } from "vite-plus/test";

import {
  $applyIssueDescriptionCommand,
  filterIssueDescriptionCommands,
  ISSUE_DESCRIPTION_NODES,
  ISSUE_DESCRIPTION_TRANSFORMERS,
} from "./issueDescriptionEditor.logic";

function makeEditor() {
  return createEditor({ nodes: [...ISSUE_DESCRIPTION_NODES] });
}

function markdownFromEditor(editor: ReturnType<typeof makeEditor>): string {
  return editor
    .getEditorState()
    .read(() => $convertToMarkdownString(ISSUE_DESCRIPTION_TRANSFORMERS));
}

describe("issue description editor", () => {
  it("filters slash commands by names and aliases", () => {
    expect(filterIssueDescriptionCommands("h2").map((command) => command.id)).toEqual([
      "heading-2",
    ]);
    expect(filterIssueDescriptionCommands("todo").map((command) => command.id)).toEqual([
      "check-list",
    ]);
    expect(filterIssueDescriptionCommands("/")).toHaveLength(9);
  });

  it("round-trips the supported Markdown blocks", () => {
    const editor = makeEditor();
    const markdown = [
      "# Scope",
      "",
      "- first",
      "- second",
      "",
      "- [x] shipped",
      "",
      "> Keep this visible",
      "",
      "```ts",
      "const ready = true;",
      "```",
    ].join("\n");

    editor.update(() => $convertFromMarkdownString(markdown, ISSUE_DESCRIPTION_TRANSFORMERS), {
      discrete: true,
    });

    const serialized = markdownFromEditor(editor);
    expect(serialized).toContain("# Scope");
    expect(serialized).toContain("- first\n- second");
    expect(serialized).toContain("- [x] shipped");
    expect(serialized).toContain("> Keep this visible");
    expect(serialized).toContain("```ts\nconst ready = true;\n```");
  });

  it("turns the active paragraph into the selected command block", () => {
    const editor = makeEditor();

    editor.update(
      () => {
        const paragraph = $createParagraphNode().append($createTextNode("Details"));
        $getRoot().append(paragraph);
        paragraph.selectEnd();
        expect($applyIssueDescriptionCommand("heading-2")).toBe(true);
      },
      { discrete: true },
    );

    expect(markdownFromEditor(editor)).toBe("## Details");
  });

  it("creates a Markdown checklist from the slash command", () => {
    const editor = makeEditor();

    editor.update(
      () => {
        const paragraph = $createParagraphNode().append($createTextNode("Verify the fix"));
        $getRoot().append(paragraph);
        paragraph.selectEnd();
        expect($applyIssueDescriptionCommand("check-list")).toBe(true);
      },
      { discrete: true },
    );

    expect(markdownFromEditor(editor)).toBe("- [ ] Verify the fix");
  });
});
