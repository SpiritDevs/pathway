import {
  SelectableMarkdownText as PathwaySelectableMarkdownText,
  type SelectableMarkdownTextProps,
} from "@spiritdevs/mobile-markdown-text/renderer";

import { highlightCodeSnippet } from "../features/review/shikiReviewHighlighter";

type MobileSelectableMarkdownTextProps = Omit<SelectableMarkdownTextProps, "highlightCode">;

export type {
  NativeMarkdownTextStyle,
  SelectableMarkdownSkill,
} from "@spiritdevs/mobile-markdown-text/types";

export function hasNativeSelectableMarkdownText(): boolean {
  return true;
}

export function SelectableMarkdownText(props: MobileSelectableMarkdownTextProps) {
  return <PathwaySelectableMarkdownText {...props} highlightCode={highlightCodeSnippet} />;
}
