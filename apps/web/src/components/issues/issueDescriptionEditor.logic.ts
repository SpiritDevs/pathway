import { CodeNode, $createCodeNode } from "@lexical/code";
import { LinkNode } from "@lexical/link";
import { $insertList, ListItemNode, ListNode } from "@lexical/list";
import { CHECK_LIST, TRANSFORMERS, type Transformer } from "@lexical/markdown";
import { HeadingNode, QuoteNode, $createHeadingNode, $createQuoteNode } from "@lexical/rich-text";
import { $setBlocksType } from "@lexical/selection";
import {
  $createParagraphNode,
  $getSelection,
  $isRangeSelection,
  type Klass,
  type LexicalNode,
} from "lexical";

export type IssueDescriptionCommandId =
  | "paragraph"
  | "heading-1"
  | "heading-2"
  | "heading-3"
  | "bulleted-list"
  | "numbered-list"
  | "check-list"
  | "code-block"
  | "blockquote";

export type IssueDescriptionCommandGroup = "text" | "lists" | "blocks";

export interface IssueDescriptionCommand {
  readonly id: IssueDescriptionCommandId;
  readonly group: IssueDescriptionCommandGroup;
  readonly label: string;
  readonly description: string;
  readonly hint: string;
  readonly searchTerms: ReadonlyArray<string>;
}

export const ISSUE_DESCRIPTION_COMMANDS: ReadonlyArray<IssueDescriptionCommand> = [
  {
    id: "paragraph",
    group: "text",
    label: "Text",
    description: "Plain paragraph",
    hint: "text",
    searchTerms: ["paragraph", "plain", "body"],
  },
  {
    id: "heading-1",
    group: "text",
    label: "Heading 1",
    description: "Large section heading",
    hint: "#",
    searchTerms: ["h1", "title"],
  },
  {
    id: "heading-2",
    group: "text",
    label: "Heading 2",
    description: "Medium section heading",
    hint: "##",
    searchTerms: ["h2", "subtitle"],
  },
  {
    id: "heading-3",
    group: "text",
    label: "Heading 3",
    description: "Small section heading",
    hint: "###",
    searchTerms: ["h3", "subheading"],
  },
  {
    id: "bulleted-list",
    group: "lists",
    label: "Bulleted list",
    description: "Create an unordered list",
    hint: "-",
    searchTerms: ["bullet", "unordered", "ul"],
  },
  {
    id: "numbered-list",
    group: "lists",
    label: "Numbered list",
    description: "Create an ordered list",
    hint: "1.",
    searchTerms: ["number", "ordered", "ol"],
  },
  {
    id: "check-list",
    group: "lists",
    label: "Checklist",
    description: "Track actionable items",
    hint: "[ ]",
    searchTerms: ["check", "task", "todo"],
  },
  {
    id: "code-block",
    group: "blocks",
    label: "Code block",
    description: "Add preformatted code",
    hint: "```",
    searchTerms: ["code", "pre", "snippet"],
  },
  {
    id: "blockquote",
    group: "blocks",
    label: "Blockquote",
    description: "Emphasize quoted text",
    hint: ">",
    searchTerms: ["quote", "citation"],
  },
];

export const ISSUE_DESCRIPTION_NODES: ReadonlyArray<Klass<LexicalNode>> = [
  CodeNode,
  HeadingNode,
  LinkNode,
  ListItemNode,
  ListNode,
  QuoteNode,
];

// Checklist syntax must run before the ordinary bullet-list transformer because both accept `-`.
export const ISSUE_DESCRIPTION_TRANSFORMERS: Array<Transformer> = [CHECK_LIST, ...TRANSFORMERS];

export function filterIssueDescriptionCommands(query: string): Array<IssueDescriptionCommand> {
  const normalized = query.trim().replace(/^\/+/, "").toLowerCase();
  if (normalized.length === 0) return [...ISSUE_DESCRIPTION_COMMANDS];

  return ISSUE_DESCRIPTION_COMMANDS.filter((command) =>
    [command.label, command.description, ...command.searchTerms].some((value) =>
      value.toLowerCase().includes(normalized),
    ),
  );
}

export function $applyIssueDescriptionCommand(id: IssueDescriptionCommandId): boolean {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) return false;

  switch (id) {
    case "paragraph":
      $setBlocksType(selection, $createParagraphNode);
      break;
    case "heading-1":
      $setBlocksType(selection, () => $createHeadingNode("h1"));
      break;
    case "heading-2":
      $setBlocksType(selection, () => $createHeadingNode("h2"));
      break;
    case "heading-3":
      $setBlocksType(selection, () => $createHeadingNode("h3"));
      break;
    case "bulleted-list":
      $insertList("bullet");
      break;
    case "numbered-list":
      $insertList("number");
      break;
    case "check-list":
      $insertList("check");
      break;
    case "code-block":
      $setBlocksType(selection, $createCodeNode);
      break;
    case "blockquote":
      $setBlocksType(selection, $createQuoteNode);
      break;
  }

  return true;
}
