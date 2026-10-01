import type { ComponentProps, ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import { visitElements } from "../../test/reactElementTree";
import type { PromptStashEntry } from "../../promptStashStore";
import { Command, CommandInput, CommandItem } from "../ui/command";
import { ComposerAddMenu } from "./ComposerAddMenu";

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
    onPathQueryChange: vi.fn(),
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
function search(tree: ReactElement, query: string) {
  const command = visitElements(tree, (element) => element.type === Command)!;
  (command.props.onValueChange as (value: string) => void)(query);
}
function escape(tree: ReactElement, key = "Escape") {
  const event = { key, preventDefault: vi.fn(), stopPropagation: vi.fn() };
  const handler = (tree.props as { onKeyDown: (keyboardEvent: typeof event) => void }).onKeyDown;
  handler(event);
  return event;
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
    expect(visitElements(tree, (element) => element.type === CommandInput)?.props.placeholder).toBe(
      "Search stashed prompts",
    );
  });

  it("opens when empty and offers stashing without allowing an empty save", () => {
    const { openStash } = setup({ stashEntries: [], stashDisabled: true });
    const tree = openStash();
    expect(row(tree, "stash-current").props.disabled).toBe(true);
    expect(visitElements(tree, (element) => element.type === "p")?.props.children).toContain(
      "Nothing stashed yet",
    );
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

  it("searches full prompts and shows an empty result", () => {
    const { openStash, render } = setup({
      stashEntries: [saved("long", `${"intro ".repeat(30)}needle`)],
    });
    search(openStash(), "needle");
    expect(row(render(), "long")).toBeTruthy();
    search(render(), "absent");
    expect(
      visitElements(render(), (element) => element.props.role === "status")?.props.children,
    ).toBe("No matching stashed prompts.");
  });

  it("Escape returns to Add, clears search, then closes with editor focus", () => {
    const { props, openStash, render } = setup();
    search(openStash(), "older");
    escape(render());
    expect(row(render(), "stash")).toBeTruthy();
    expect(visitElements(render(), (element) => element.type === Command)?.props.value).toBe("");
    expect(props.onClose).not.toHaveBeenCalled();
    escape(render());
    expect(props.onClose).toHaveBeenCalledWith(true);
  });

  it("Back returns to Add and remounts the search for focus and keyboard highlighting", () => {
    const { openStash, render } = setup();
    const tree = openStash();
    expect(visitElements(tree, (element) => element.type === Command)?.key).toBe("stash");
    activate(visitElements(tree, (element) => element.props["aria-label"] === "Back")!);
    expect(row(render(), "attachments")).toBeTruthy();
    expect(visitElements(render(), (element) => element.type === Command)?.key).toBe("main");
  });

  it("prevents Enter from submitting the surrounding composer form", () => {
    expect(escape(setup().openStash(), "Enter").preventDefault).toHaveBeenCalledOnce();
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

  it("lets the delete button handle Enter without activating the restore row", () => {
    const { openStash } = setup();
    const button = visitElements(
      row(openStash(), "older"),
      (element) => element.props["aria-label"] === "Delete stashed prompt",
    )!;
    const event = { key: "Enter", stopPropagation: vi.fn(), preventDefault: vi.fn() };
    const handler = button.props.onKeyDown as (keyboardEvent: typeof event) => void;
    handler(event);
    expect(event.stopPropagation).toHaveBeenCalledOnce();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });
});
