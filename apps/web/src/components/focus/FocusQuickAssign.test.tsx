import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it } from "vite-plus/test";

import { MenuGroupLabel, MenuRadioGroup } from "../ui/menu";
import { FocusQuickAssignItems } from "./FocusQuickAssign";

describe("FocusQuickAssignItems", () => {
  it("keeps the group label inside the radio group that provides its context", () => {
    const tree = FocusQuickAssignItems({
      projectKeys: ["environment:project"],
      focuses: [],
      assignments: [],
      mutations: null,
    });

    expect(tree.type).toBe(MenuRadioGroup);
    const children = Children.toArray(
      (tree as ReactElement<{ children?: ReactNode }>).props.children,
    );
    expect(children.some((child) => isValidElement(child) && child.type === MenuGroupLabel)).toBe(
      true,
    );
  });
});
