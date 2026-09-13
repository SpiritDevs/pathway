import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import { visitElements } from "../../test/reactElementTree";

const effects = vi.hoisted(() => [] as (() => void)[]);
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useCallback: reactHookHarness.useCallback,
    useState: reactHookHarness.useState,
    useRef: reactHookHarness.useRef,
    useEffect: (effect: () => void) => effects.push(effect),
  };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});
vi.mock("../../lib/utils", () => ({ randomUUID: () => "annotation-1" }));

import { SnapShotEditor, type SnapShotEditorProps } from "./SnapShotEditor";
import type { KeyboardEvent } from "react";

const onAction = vi.fn<SnapShotEditorProps["onAction"]>();
const onClose = vi.fn();
const context = {
  drawImage: vi.fn(),
  translate: vi.fn(),
  scale: vi.fn(),
  save: vi.fn(),
  restore: vi.fn(),
  beginPath: vi.fn(),
  strokeRect: vi.fn(),
};
const props: SnapShotEditorProps = {
  image: {
    id: "capture-1",
    name: "Window.jpg",
    dataUrl: "data:image/png;base64,original",
    source: {
      kind: "snap-shot",
      capturedAt: "2026-09-12T00:00:00.000Z",
      appName: "Editor",
      windowTitle: "Work",
    },
  },
  onAction,
  onClose,
};

function render() {
  hooks.beginRender();
  return SnapShotEditor(props);
}

function button(tree: ReturnType<typeof render>, label: string) {
  const element = visitElements(
    tree,
    (node) => node.props.label === label || node.props["aria-label"] === label,
  );
  if (!element) throw new Error(`Missing button: ${label}`);
  return element.props as { onClick: () => void; disabled?: boolean };
}

function mount() {
  render();
  for (const effect of effects.splice(0)) effect();
  return render();
}

function keyDown(tree: ReturnType<typeof render>, key: string, target: EventTarget | null = null) {
  const popup = visitElements(tree, (node) => node.props.className === "shot-editor");
  if (!popup) throw new Error("Missing editor dialog");
  const event = { key, target, preventDefault: vi.fn(), stopPropagation: vi.fn() };
  (popup.props as { onKeyDown: (event: KeyboardEvent) => void }).onKeyDown(
    event as unknown as KeyboardEvent,
  );
  return event;
}

beforeEach(() => {
  hooks.reset();
  effects.length = 0;
  vi.clearAllMocks();
  onAction.mockResolvedValue(undefined);
  vi.stubGlobal(
    "HTMLElement",
    class {
      closest() {
        return null;
      }
    },
  );
  vi.stubGlobal(
    "Image",
    class {
      naturalWidth = 1440;
      naturalHeight = 900;
      onLoad: (() => void) | undefined;
      addEventListener(event: string, callback: () => void) {
        if (event === "load") this.onLoad = callback;
      }
      set src(_value: string) {
        this.onLoad?.();
      }
    },
  );
  vi.stubGlobal("window", {
    document: {
      createElement: () => ({
        width: 0,
        height: 0,
        getContext: () => context,
        toDataURL: () => "data:image/png;base64,edited",
      }),
    },
  });
});

afterEach(() => vi.unstubAllGlobals());

it.each([
  ["Copy image and close (⌘/Ctrl+C)", "copy"],
  ["Save to chat and close (Enter)", "chat"],
  ["Download image and close (⌘/Ctrl+S)", "download"],
] as const)(
  "%s exports the PNG and lets the coordinator close after success",
  async (label, action) => {
    button(mount(), label).onClick();
    expect(onAction).toHaveBeenCalledExactlyOnceWith(action, {
      dataUrl: "data:image/png;base64,edited",
      name: "Window.png",
      source: props.image.source,
    });
    await onAction.mock.results[0]!.value;
    expect(onClose).not.toHaveBeenCalled();
  },
);

it("keeps the editor open with a useful error after a failed output", async () => {
  onAction.mockRejectedValueOnce(new Error("Clipboard is unavailable"));
  button(mount(), "Copy image and close (⌘/Ctrl+C)").onClick();
  await onAction.mock.results[0]!.value.catch(() => undefined);
  const tree = render();
  expect(visitElements(tree, (node) => node.props.role === "alert")).not.toBeNull();
  expect(button(tree, "Copy image and close (⌘/Ctrl+C)").disabled).toBe(false);
  expect(onClose).not.toHaveBeenCalled();
});

it("blocks duplicate output and close while saving, then permits cancellation", async () => {
  let finish: (() => void) | undefined;
  onAction.mockReturnValueOnce(
    new Promise<void>((resolve) => {
      finish = resolve;
    }),
  );
  button(mount(), "Save to chat and close (Enter)").onClick();
  const busyTree = render();
  expect(button(busyTree, "Close editor").disabled).toBe(true);
  button(busyTree, "Copy image and close (⌘/Ctrl+C)").onClick();
  (busyTree.props as { onOpenChange: (open: boolean) => void }).onOpenChange(false);
  expect(onAction).toHaveBeenCalledTimes(1);
  expect(onClose).not.toHaveBeenCalled();
  finish?.();
  await onAction.mock.results[0]!.value;
  const settled = render();
  expect(button(settled, "Close editor").disabled).toBe(false);
  (settled.props as { onOpenChange: (open: boolean) => void }).onOpenChange(false);
  expect(onClose).toHaveBeenCalledOnce();
});

it("keeps editor shortcuts from reaching chat and lets Escape cancel a tool before closing", () => {
  const event = keyDown(mount(), "r");
  expect(event.stopPropagation).toHaveBeenCalledOnce();
  expect(button(render(), "Rectangle (R)")).toBeDefined();
  keyDown(render(), "Escape");
  expect(onClose).not.toHaveBeenCalled();
  keyDown(render(), "Escape");
  expect(onClose).toHaveBeenCalledOnce();
});

it("preserves Enter on a focused toolbar button rather than saving to chat", () => {
  const target = new HTMLElement();
  vi.spyOn(target, "closest").mockImplementation((selector) =>
    selector === "button" ? target : null,
  );
  const event = keyDown(mount(), "Enter", target);
  expect(onAction).not.toHaveBeenCalled();
  expect(event.preventDefault).not.toHaveBeenCalled();
  expect(event.stopPropagation).toHaveBeenCalledOnce();
});
