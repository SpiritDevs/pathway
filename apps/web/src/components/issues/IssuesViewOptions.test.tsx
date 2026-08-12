import { Children, isValidElement, type ReactNode } from "react";
import { describe, expect, it } from "vite-plus/test";

import { MenuGroup, MenuGroupLabel, MenuRadioGroup } from "../ui/menu";
import { IssuesViewOptions } from "./IssuesViewOptions";

function renderOptions(viewMode: "list" | "board") {
  return IssuesViewOptions({
    grouping: "status",
    sortMode: "manual",
    viewMode,
    onGrouping: () => {},
    onSortMode: () => {},
  });
}

function labelsOutsideGroup(node: ReactNode, insideGroup = false): number {
  if (!isValidElement<{ children?: ReactNode }>(node)) return 0;

  const nextInsideGroup = insideGroup || node.type === MenuGroup || node.type === MenuRadioGroup;
  let count = node.type === MenuGroupLabel && !insideGroup ? 1 : 0;
  Children.forEach(node.props.children, (child) => {
    count += labelsOutsideGroup(child, nextInsideGroup);
  });
  return count;
}

function textContent(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (!isValidElement<{ children?: ReactNode }>(node)) return "";

  let text = "";
  Children.forEach(node.props.children, (child) => {
    text += textContent(child);
  });
  return text;
}

describe("IssuesViewOptions", () => {
  it("keeps every Base UI group label inside a group", () => {
    expect(labelsOutsideGroup(renderOptions("list"))).toBe(0);
    expect(labelsOutsideGroup(renderOptions("board"))).toBe(0);
  });

  it("explains where manual order comes from", () => {
    expect(textContent(renderOptions("list"))).toContain(
      "Manual order follows the card positions set by dragging in board view.",
    );
    expect(textContent(renderOptions("board"))).toContain(
      "Drag cards to reorder them or move them between statuses.",
    );
  });
});
