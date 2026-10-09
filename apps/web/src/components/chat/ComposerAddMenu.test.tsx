import type { ComponentProps, ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import { visitElements } from "../../test/reactElementTree";
import type { PromptStashEntry } from "../../promptStashStore";
import { Command, CommandItem } from "../ui/command";
import { ComposerAddMenu, resolveAddMenuKey } from "./ComposerAddMenu";

vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useEffect: () => {},
    useLayoutEffect: () => {},
    useRef: reactHookHarness.useRef,
    useState: reactHookHarness.useState,
  };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

function saved(id: string, prompt = `Prompt ${id}`): PromptStashEntry {
  return { id, prompt, createdAt: "2026-10-01T00:00:00Z", attachments: [], droppedImageNames: [] };
}

function setup(overrides: Partial<ComponentProps<typeof ComposerAddMenu>> = {}) {
  const props: ComponentProps<typeof ComposerAddMenu> = {
    search: "",
    view: "main",
    onViewChange: vi.fn((view) => {
      props.view = view;
    }),
    attachmentDisabled: false,
    actions: [],
    skills: [],
    skillsLoading: false,
    skillsError: null,
    onSelectSkill: vi.fn(),
    stashEntries: [saved("newest"), saved("older")],
    stashShortcut: "⌘S",
    stashDisabled: false,
    stashRestoreDisabled: false,
    onStash: vi.fn(),
    onRestoreStash: vi.fn(),
    onDeleteStash: vi.fn(),
    onAttachFiles: vi.fn(),
    paths: [],
    pathsLoading: false,
    pathsError: null,
    canBrowsePaths: true,
    onAttachPath: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
  const render = () => {
    hooks.beginRender();
    return ComposerAddMenu(props);
  };
  const openStash = () => {
    activate(row(render(), "stash"));
    return render();
  };
  return { props, render, openStash };
}

function row(tree: ReactElement, value: string) {
  const found = visitElements(
    tree,
    (element) => element.type === CommandItem && element.props.value === value,
  );
  if (!found) throw new Error(`Missing menu row ${value}`);
  return found;
}
function activate(element: ReactElement<Record<string, unknown>>) {
  (element.props.onClick as () => void)();
}

beforeEach(() => hooks.reset());

describe("Stash prompts submenu", () => {
  it("opens from Add and lists every prompt in stored order", () => {
    const { openStash } = setup();
    const tree = openStash();
    expect(row(tree, "newest")).toBeTruthy();
    expect(row(tree, "older")).toBeTruthy();
    const values: unknown[] = [];
    visitElements(tree, (element) => {
      if (element.type === CommandItem) values.push(element.props.value);
      return false;
    });
    expect(values).toEqual(["stash-current", "newest", "older"]);
  });

  it("replaces the submenu with a direct stash action until something is stashed", () => {
    const { props, render } = setup({ stashEntries: [] });
    expect(() => row(render(), "stash")).toThrow();
    activate(row(render(), "stash-current"));
    expect(props.onStash).toHaveBeenCalledOnce();
  });

  it("hides stashing entirely when nothing is stashed and the draft is empty", () => {
    const { render } = setup({ stashEntries: [], stashDisabled: true });
    expect(() => row(render(), "stash")).toThrow();
    expect(() => row(render(), "stash-current")).toThrow();
  });

  it("returns to Add after deleting the last stashed prompt", () => {
    const { props, openStash, render } = setup({ stashEntries: [saved("only")] });
    const button = visitElements(
      row(openStash(), "only"),
      (element) => element.props["aria-label"] === "Delete stashed prompt",
    )!;
    (button.props.onClick as (event: { stopPropagation: () => void }) => void)({
      stopPropagation: vi.fn(),
    });
    expect(props.onDeleteStash).toHaveBeenCalledOnce();
    expect(row(render(), "attachments")).toBeTruthy();
  });

  it("restores the selected prompt and closes without deleting it", () => {
    const { props, openStash } = setup();
    activate(row(openStash(), "older"));
    expect(props.onRestoreStash).toHaveBeenCalledWith(props.stashEntries[1]);
    expect(props.onDeleteStash).not.toHaveBeenCalled();
    expect(props.onClose).toHaveBeenCalledWith(false);
    expect(props.stashEntries).toHaveLength(2);
  });

  it("stashes the current draft from its own action", () => {
    const { props, openStash } = setup();
    activate(row(openStash(), "stash-current"));
    expect(props.onStash).toHaveBeenCalledOnce();
    expect(props.onRestoreStash).not.toHaveBeenCalled();
    expect(props.onClose).toHaveBeenCalledWith(false);
  });

  it("searches full prompts with the composer's search and shows an empty result", () => {
    const { openStash, props, render } = setup({
      stashEntries: [saved("long", `${"intro ".repeat(30)}needle`)],
    });
    openStash();
    props.search = "needle";
    expect(row(render(), "long")).toBeTruthy();
    props.search = "absent";
    expect(
      visitElements(render(), (element) => element.props.role === "status")?.props.children,
    ).toBe("No matching stashed prompts.");
  });

  it("Back returns to Add and remounts the list for keyboard highlighting", () => {
    const { openStash, props, render } = setup();
    const tree = openStash();
    expect(visitElements(tree, (element) => element.type === Command)?.key).toBe("stash");
    activate(visitElements(tree, (element) => element.props["aria-label"] === "Back")!);
    expect(props.onViewChange).toHaveBeenLastCalledWith("main");
    expect(row(render(), "attachments")).toBeTruthy();
    expect(visitElements(render(), (element) => element.type === Command)?.key).toBe("main");
  });

  it("disables restore while attachments are saving or a question is active", () => {
    const { openStash, props, render } = setup({
      stashEntries: [{ ...saved("pending"), pendingImageCount: 1 }, saved("ready")],
    });
    const tree = openStash();
    expect(row(tree, "pending").props.disabled).toBe(true);
    expect(row(tree, "ready").props.disabled).toBe(false);
    props.stashRestoreDisabled = true;
    expect(row(render(), "ready").props.disabled).toBe(true);
  });

  it("deletes explicitly without restoring or closing the submenu", () => {
    const { props, openStash } = setup();
    const item = row(openStash(), "older");
    const button = visitElements(
      item,
      (element) => element.props["aria-label"] === "Delete stashed prompt",
    )!;
    const stopPropagation = vi.fn();
    (button.props.onClick as (event: { stopPropagation: () => void }) => void)({ stopPropagation });
    expect(stopPropagation).toHaveBeenCalledOnce();
    expect(props.onDeleteStash).toHaveBeenCalledWith(props.stashEntries[1]);
    expect(props.onRestoreStash).not.toHaveBeenCalled();
    expect(props.onClose).not.toHaveBeenCalled();
  });
});

describe("resolveAddMenuKey", () => {
  const rows = ["attachments", "stash", "goal"];
  const key = (pressed: string, overrides: Partial<Parameters<typeof resolveAddMenuKey>[0]> = {}) =>
    resolveAddMenuKey({
      key: pressed,
      shiftKey: false,
      view: "main",
      rows,
      activeRow: "stash",
      ...overrides,
    });

  it("moves the highlight through the rows and wraps at the ends", () => {
    expect(key("ArrowDown")).toEqual({ type: "highlight", row: "goal" });
    expect(key("ArrowUp")).toEqual({ type: "highlight", row: "attachments" });
    expect(key("ArrowDown", { activeRow: "goal" })).toEqual({
      type: "highlight",
      row: "attachments",
    });
    expect(key("ArrowUp", { activeRow: "attachments" })).toEqual({
      type: "highlight",
      row: "goal",
    });
    expect(key("ArrowDown", { rows: [] })).toBeNull();
  });

  it("picks the highlighted row on Enter or Tab instead of submitting the prompt", () => {
    expect(key("Enter")).toEqual({ type: "pick", row: "stash" });
    expect(key("Tab", { activeRow: null })).toEqual({ type: "pick", row: "attachments" });
    expect(key("Enter", { shiftKey: true })).toBeNull();
  });

  it("Escape steps back to Add, then closes", () => {
    expect(key("Escape", { view: "stash" })).toEqual({ type: "back" });
    expect(key("Escape")).toEqual({ type: "close" });
  });

  it("leaves typing to the composer", () => {
    expect(key("a")).toBeNull();
    expect(key("Backspace")).toBeNull();
  });
});
